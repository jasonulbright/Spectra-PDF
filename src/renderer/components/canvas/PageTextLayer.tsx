import { useEffect, useRef } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { logRenderError } from './raster';

// Selectable text over a rendered page (Phase 4 M4.2, § 6.3).
//
// pdf.js's own TextLayer: it lays transparent, correctly-positioned spans over
// the raster so the browser's native selection does the work — real
// click-drag-select, double-click-word, triple-click-line, Ctrl+A, and Ctrl+C,
// none of which we implement or could implement as well by hand.
//
// READING VIEW ONLY (§ 6.3). The board is a thumbnail arrangement surface, not
// a reading surface: text at 280px-tall thumbnails isn't selectable in any
// useful sense, and the spans would fight the page-drag. So this mounts only
// where PageCell is told to.
//
// Bonus that falls out for free: a page made searchable by our OCR pass carries
// an invisible (`Tr 3`) text layer, which pdf.js reports like any other text —
// so scanned pages become selectable here too, with no extra work.

export interface PageTextLayerProps {
  pdf: PDFDocumentProxy | null;
  /** 1-based index into the SOURCE file. */
  pageNumber: number;
  /** Pending in-memory quarter-turns, not yet baked into the file. */
  rotation: 0 | 90 | 180 | 270;
  /** The cell's rendered size (already rotation-swapped by the caller). */
  displayWidth: number;
  displayHeight: number;
  /** Whether text is selectable right now — see the pointer-events note below. */
  active: boolean;
}

export function PageTextLayer({
  pdf,
  pageNumber,
  rotation,
  displayWidth,
  displayHeight,
  active,
}: PageTextLayerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!pdf || !container || displayWidth <= 0 || displayHeight <= 0) return;
    let cancelled = false;
    let layer: TextLayer | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        // Bake the rotation into the VIEWPORT rather than CSS-rotating the
        // container (which is how PageView handles the raster). pdf.js then
        // positions every span in the rotated frame itself, so the text lines up
        // with the pixels at 90/270 without us re-projecting anything — and
        // `page.rotate` (the file's own rotation) has to be added, since our
        // in-memory quarter-turns are relative to it, not absolute.
        const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
        // Uniform scale: the cell keeps the page's aspect, so either axis gives
        // the same factor. Height is the one the reading view drives.
        const scale = displayHeight / base.height;
        const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        // pdf.js's span CSS is expressed in terms of --scale-factor; nothing
        // sets it for us because we construct TextLayer directly instead of
        // going through its viewer's setLayerDimensions.
        container.style.setProperty('--scale-factor', String(scale));
        container.replaceChildren();
        layer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container,
          viewport,
        });
        await layer.render();
      } catch (e) {
        if (!cancelled) logRenderError(`Failed to render text layer for page ${pageNumber}`)(e);
      }
    })();

    return () => {
      cancelled = true;
      layer?.cancel();
      // Drop the spans: a cancelled render can otherwise leave a half-built
      // layer behind, and a stale one would put selectable text at the wrong
      // place for the new zoom/rotation.
      container.replaceChildren();
    };
  }, [pdf, pageNumber, rotation, displayWidth, displayHeight]);

  return (
    <div
      ref={containerRef}
      className="textLayer"
      data-testid="text-layer"
      // Only the Select tool selects text. Every other tool draws on the page
      // (annotate/redact/sign rubber-bands, form widgets), and a layer that ate
      // those pointers would break them — so it stays inert unless selecting.
      // `user-select` follows too, or a drag with another tool active would
      // still paint a selection highlight under the band.
      style={{ pointerEvents: active ? 'auto' : 'none', userSelect: active ? 'text' : 'none' }}
    />
  );
}
