import { useEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { logRenderError } from './raster';
import { ZOOM_SETTLE_MS } from '../../canvas/reading-page';

// Settle a zoom burst before rebuilding — ONE shared constant with the raster
// (canvas/reading-page.ts ZOOM_SETTLE_MS), so text and pixels rebuild on the
// same beat rather than storming the one pdf.js worker twice per burst.
const SETTLE_MS = ZOOM_SETTLE_MS;

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

  // Rebuilding is EXPENSIVE — a worker round-trip (`streamTextContent`) plus a
  // full span rebuild, per mounted page. Zoom changes arrive as a burst (OS key
  // repeat on a held Ctrl+=), so settle first, exactly as the raster's own
  // `zoomVersion` does and for the same reason. Seeded with the initial size so
  // first paint is immediate; only CHANGES wait. A layer that is briefly stale
  // during a burst costs nothing visible — the spans are transparent, so only
  // selection hit-boxes lag by a frame or two.
  const [settled, setSettled] = useState({ w: displayWidth, h: displayHeight });
  useEffect(() => {
    if (settled.w === displayWidth && settled.h === displayHeight) return;
    const t = setTimeout(() => setSettled({ w: displayWidth, h: displayHeight }), SETTLE_MS);
    return () => clearTimeout(t);
  }, [displayWidth, displayHeight, settled.w, settled.h]);
  const { w: layoutW, h: layoutH } = settled;

  useEffect(() => {
    const container = containerRef.current;
    if (!pdf || !container || layoutW <= 0 || layoutH <= 0) return;
    let cancelled = false;
    let layer: TextLayer | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        // `rotation` here is ABSOLUTE: our in-memory quarter-turns are relative
        // to the file's own `page.rotate`, so they add.
        //
        // Note what this does and does NOT do. pdf.js does NOT reposition spans
        // for rotation — `PageViewport.rawDims` comes from the viewBox alone, so
        // every span's left/top is identical at 0° and 90°. The rotation reaches
        // the DOM only as the `data-main-rotation` attribute that TextLayer's
        // constructor stamps on the container, and pdf.js's OWN stylesheet
        // rotates it (we carry those rules — see `.textLayer[data-main-rotation]`
        // in styles.css; without them the text sits unrotated over a rotated
        // raster and selection grabs the wrong glyphs — review-caught).
        const spin = (page.rotate + rotation) % 360;
        const base = page.getViewport({ scale: 1, rotation: spin });
        // Uniform scale: the cell keeps the page's aspect, so either axis gives
        // the same factor. Height is the one the reading view drives.
        const scale = layoutH / base.height;
        const viewport = page.getViewport({ scale, rotation: spin });
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
  }, [pdf, pageNumber, rotation, layoutW, layoutH]);

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
