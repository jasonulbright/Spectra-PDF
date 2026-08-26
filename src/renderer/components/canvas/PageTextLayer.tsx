import { useEffect, useRef, useState } from 'react';
import { OPS, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { logRenderError } from './raster';
import { ZOOM_SETTLE_MS } from '../../canvas/reading-page';
import { tChrome } from '../../i18n';
import { recognizeRaster, type RawEngineCall } from '../../lib/ocr-recognize';
import {
  peekSelectionCache,
  rasterScaleFor,
  recognizeForSelection,
  releaseOcrSelection,
  wordSpanBox,
  type OcrSelectStatus,
} from '../../lib/ocr-selection';

// Settle a zoom burst before rebuilding — ONE shared constant with the raster
// (canvas/reading-page.ts ZOOM_SETTLE_MS), so text and pixels rebuild on the
// same beat rather than storming the one pdf.js worker twice per burst.
const SETTLE_MS = ZOOM_SETTLE_MS;

// Selectable text over a rendered page.
//
// pdf.js's own TextLayer: it lays transparent, correctly-positioned spans over
// the raster so the browser's native selection does the work — real
// click-drag-select, double-click-word, triple-click-line, Ctrl+A, and Ctrl+C,
// none of which we implement or could implement as well by hand.
//
// READING VIEW ONLY. The board is a thumbnail arrangement surface, not
// a reading surface: text at 280px-tall thumbnails isn't selectable in any
// useful sense, and the spans would fight the page-drag. So this mounts only
// where PageCell is told to.
//
// Bonus that falls out for free: a page made searchable by our OCR pass carries
// an invisible (`Tr 3`) text layer, which pdf.js reports like any other text —
// so scanned pages become selectable here too, with no extra work.
//
// SECOND GEOMETRY SOURCE. A scanned page that has NOT been through that pass
// has no text at all, and the paragraph above then produces an empty layer.
// When one is offered, this mounts word boxes recognised from the page's own
// pixels instead (lib/ocr-selection) — same DOM shape, same browser selection,
// same downstream markup path, and nothing written to the file.

/** What the OCR arm needs from the workspace. Absent (or null) keeps this
 *  component behaving exactly as it did before recognition existed, which is
 *  what the preference turns it back into. */
export interface OcrSelectionContext {
  /** Non-workspace engine door — see `lib/ocr-recognize.recognizeRaster`. */
  callRaw: RawEngineCall;
  /** '+'-joined Tesseract language string. */
  lang: string;
}

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
  /** Recognise this page for selection when it carries no text. */
  ocrSelection?: OcrSelectionContext | null;
}

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintSolidColorImageMask,
]);

/**
 * Does this page DRAW anything raster? Recognition's precondition is images
 * AND no extractable text — without the image half, a genuinely blank page
 * would be handed to the recognizer on every sweep for a guaranteed nothing.
 *
 * The operator list is the honest answer and is cheap on exactly the pages
 * that reach here: a scan's list is a handful of operators.
 */
async function pageDrawsImages(page: PDFPageProxy): Promise<boolean> {
  const list = await page.getOperatorList();
  return list.fnArray.some((fn) => IMAGE_OPS.has(fn));
}

/** The page's own pixels as PNG bytes, rendered off-screen at the recognition
 *  scale (bounded — see `rasterScaleFor`) and at the orientation the layer is
 *  laid out at, so the boxes that come back are already normalised to the page
 *  AS DISPLAYED. */
async function renderPageToPng(page: PDFPageProxy, spin: number): Promise<Uint8Array | null> {
  const base = page.getViewport({ scale: 1, rotation: spin });
  const viewport = page.getViewport({ scale: rasterScaleFor(base.width, base.height), rotation: spin });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

export function PageTextLayer({
  pdf,
  pageNumber,
  rotation,
  displayWidth,
  displayHeight,
  active,
  ocrSelection,
}: PageTextLayerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ocrStatus, setOcrStatus] = useState<OcrSelectStatus | null>(null);
  // Bumped when a native (pdf.js) render COMPLETES, carrying whether it found
  // any text. The OCR arm keys off this rather than re-reading the container:
  // once it has installed its own spans the container is no longer empty, so
  // "did pdf.js find text" has to be remembered rather than re-observed.
  const [native, setNative] = useState<{ version: number; hasText: boolean } | null>(null);
  const nativeVersionRef = useRef(0);
  // Has a selection gesture actually begun on THIS page? See the OCR arm below
  // — this is the trigger, not the armed tool.
  const [gestured, setGestured] = useState(false);
  useEffect(() => setGestured(false), [pdf, pageNumber]);

  // Rebuilding is EXPENSIVE - a worker round-trip (`streamTextContent`) plus a
  // full span rebuild, per mounted page. Zoom changes arrive as a burst (OS key
  // repeat on a held Ctrl+=), so settle first, exactly as the raster's own
  // `zoomVersion` does and for the same reason. Seeded with the initial size so
  // first paint is immediate; only CHANGES wait. A layer that is briefly stale
  // during a burst costs nothing visible - the spans are transparent, so only
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
        // for rotation - `PageViewport.rawDims` comes from the viewBox alone, so
        // every span's left/top is identical at 0deg and 90deg. The rotation
        // reaches the DOM only as the `data-main-rotation` attribute that
        // TextLayer's constructor stamps on the container, and pdf.js's OWN
        // stylesheet rotates it (we carry those rules - see
        // `.textLayer[data-main-rotation]` in styles.css; without them the text
        // sits unrotated over a rotated raster and selection grabs the wrong
        // glyphs - regression).
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
        if (cancelled) return;
        setNative({
          version: ++nativeVersionRef.current,
          hasText: (container.textContent ?? '').trim().length > 0,
        });
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
      delete container.dataset.ocrLayer;
    };
  }, [pdf, pageNumber, rotation, layoutW, layoutH]);

  // -- The OCR arm ---------------------------------------------------------
  // Only where pdf.js found nothing: a page with real text (including one our
  // own OCR pass has already made searchable) is served by the layer above and
  // must never be second-guessed by a recognizer.
  //
  // Gated on an actual SELECTION GESTURE - a pointer going down in this page's
  // text layer. `active` alone does not gate: Select is the default tool, so
  // every scanned page would be recognised the moment it scrolled into view and
  // opening a 900-page scan would run Tesseract 900 times unasked. A page the
  // cache already answers for skips the gate, so spans survive a zoom or a
  // rotate rebuild without demanding a second pointer-down.
  useEffect(() => {
    const container = containerRef.current;
    // Disarming the tool (or turning the preference off) must not leave a busy
    // badge standing over a page nothing is working on any more.
    if (!pdf || !container || !ocrSelection || !active || !native || native.hasText) {
      setOcrStatus(null);
      // The preference going OFF is the one case that must also take back what
      // is already on screen; disarming the tool leaves the page alone.
      if (!ocrSelection && container) {
        releaseOcrSelection(pdf, {
          hasOcrSpans: container.dataset.ocrLayer === 'true',
          clear: () => {
            container.replaceChildren();
            delete container.dataset.ocrLayer;
          },
        });
      }
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        // Images AND no extractable text. Without the image half a genuinely
        // blank page would be handed to the recognizer on every sweep for a
        // guaranteed nothing.
        if (!(await pageDrawsImages(page))) {
          if (!cancelled) setOcrStatus('none');
          return;
        }
        if (cancelled) return;
        const spin = (page.rotate + rotation) % 360;
        const known = peekSelectionCache(pdf, pageNumber, spin, ocrSelection.lang);
        // No answer yet and no gesture yet: stay out of the recognizer.
        if (!known && !gestured) return;
        // Nothing already known means work is about to start; a cached answer
        // resolves without ever flashing a busy badge.
        if (!known) setOcrStatus('pending');
        const recognised = await recognizeForSelection(
          pdf,
          pageNumber,
          spin,
          ocrSelection.lang,
          async () => {
            const png = await renderPageToPng(page, spin);
            if (!png) return null;
            return recognizeRaster(ocrSelection.callRaw, png, ocrSelection.lang);
          },
        );
        if (cancelled) return;
        setOcrStatus(recognised.status);
        if (recognised.status !== 'ready') return;
        // pdf.js's rotation CSS keys off `data-main-rotation`, which its
        // constructor stamped on the container. These boxes are already in the
        // displayed frame, so that rule would rotate them a second time.
        container.removeAttribute('data-main-rotation');
        container.replaceChildren();
        container.dataset.ocrLayer = 'true';
        for (const word of recognised.words) {
          const box = wordSpanBox(word, layoutW, layoutH);
          const span = document.createElement('span');
          span.textContent = word.text;
          span.style.cssText =
            'position:absolute;white-space:pre;transform-origin:0 0;' +
            `left:${box.left}px;top:${box.top}px;font-size:${box.fontSize}px;line-height:1;`;
          container.append(span);
          // Measure, then squeeze the glyph run onto the recognised box -
          // pdf.js's own trick. Without it a word whose face is wider than the
          // scan's overhangs its box and a mid-word selection lands past the
          // glyph the pointer is over.
          const natural = span.offsetWidth;
          if (natural > 0) span.style.transform = `scaleX(${box.width / natural})`;
        }
      } catch (e) {
        // A failed recognition is a QUIET fallback to freehand, never an error
        // dialog: the user asked to select text, and the honest answer is that
        // this page has none to snap to.
        if (!cancelled) setOcrStatus('failed');
        logRenderError(`Recognition for selection failed on page ${pageNumber}`)(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, rotation, layoutW, layoutH, ocrSelection, active, native, gestured]);

  return (
    <>
      <div
        ref={containerRef}
        className="textLayer"
        data-testid="text-layer"
        data-ocr-status={ocrStatus ?? undefined}
        // The selection gesture's own first event, and the OCR arm's trigger.
        // The layer is inert unless `active`, so this can only fire while the
        // Select tool is armed.
        onPointerDown={() => setGestured(true)}
        // Only the Select tool selects text. Every other tool draws on the page
        // (annotate/redact/sign rubber-bands, form widgets), and a layer that ate
        // those pointers would break them — so it stays inert unless selecting.
        // `user-select` follows too, or a drag with another tool active would
        // still paint a selection highlight under the band.
        style={{ pointerEvents: active ? 'auto' : 'none', userSelect: active ? 'text' : 'none' }}
      />
      {ocrStatus === 'pending' && (
        <div className="page-ocr-busy" data-testid="page-ocr-busy" role="status">
          {tChrome('canvas.ocrSelect.busy')}
        </div>
      )}
    </>
  );
}
