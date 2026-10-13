import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { OPS, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { logRenderError } from './raster';
import { ZOOM_SETTLE_MS } from '../../canvas/reading-page';
import { tChrome } from '../../i18n';
import { recognizeRaster } from '../../lib/ocr-recognize';
import type { EngineCall } from '../../lib/engine-call';
import { textLayerScaleVars } from '../../lib/text-layer-scale';
import { applyReadingOrder } from '../../lib/text-layer-order';
import { clearTextLayer, swapTextLayer } from '../../lib/text-layer-selection';
import { subscribeTextLayerRebuild, textLayerRebuildRevision } from '../../lib/text-layer-rebuild';
import { contentKeyOf, replacementOf } from '../../lib/pdfDocCache';
import { renderPageUpright } from '../../lib/upright-stamps';
import {
  peekSelectionCache,
  rasterScaleFor,
  RecognitionCancelled,
  recognizeForSelection,
  releaseOcrSelection,
  wordSpanBox,
  type OcrSelectPage,
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
  callRaw: EngineCall;
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
async function renderPageToPng(pdf: PDFDocumentProxy, page: PDFPageProxy, spin: number): Promise<Uint8Array | null> {
  const base = page.getViewport({ scale: 1, rotation: spin });
  const viewport = page.getViewport({ scale: rasterScaleFor(base.width, base.height), rotation: spin });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await renderPageUpright(pdf, page, { canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
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
  // The page, rotation and size the spans in the container were laid out for,
  // the content key of the bytes they came from, and, for recognised word
  // boxes, the cache answer they were laid out from. Spans of an older proxy
  // stand only while the build for the new one runs: its swap replaces them,
  // and its failure removes them. Word boxes over equal bytes stay, because
  // the build of a scan finds no text to replace them with.
  const builtRef = useRef<{
    /** The document the shown spans were built or kept from. */
    pdf: PDFDocumentProxy;
    pageNumber: number;
    rotation: number;
    w: number;
    h: number;
    key: string | null;
    ocr: OcrSelectPage | null;
  } | null>(null);
  const revision = useSyncExternalStore(subscribeTextLayerRebuild, textLayerRebuildRevision, textLayerRebuildRevision);
  // The content key of `pdf`'s bytes, once its hash is done. Null while it is
  // pending: a new proxy says nothing about its bytes until then.
  const [keyed, setKeyed] = useState<{ pdf: PDFDocumentProxy; key: string } | null>(null);
  useEffect(() => {
    const pending = pdf ? contentKeyOf(pdf) : null;
    if (!pdf || !pending) return;
    let cancelled = false;
    void pending.then((key) => {
      if (!cancelled) setKeyed({ pdf, key });
    });
    return () => {
      cancelled = true;
    };
  }, [pdf]);
  const contentKey = keyed !== null && keyed.pdf === pdf ? keyed.key : null;
  // Has a selection gesture actually begun on THIS page? See the OCR arm below
  // — this is the trigger, not the armed tool. The gesture is recorded with
  // the page and the bytes it was made over, so it holds for a new proxy over
  // equal bytes and never for other bytes or another page, including in the
  // render that first sees them.
  const [gesture, setGesture] = useState<{
    pageNumber: number;
    key: string | null;
    pdf: PDFDocumentProxy | null;
  } | null>(null);
  const gestured = gesture !== null && gesture.pageNumber === pageNumber
    && ((gesture.key !== null && gesture.key === contentKey) || gesture.pdf === pdf);
  // Other bytes end the gesture: bytes that later return to its key (an undo)
  // were not gestured over since, and their recognition was released.
  useEffect(() => {
    if (contentKey === null) return;
    setGesture((g) => {
      if (g === null || g.key === contentKey) return g;
      return g.key === null && g.pdf === pdf ? { ...g, key: contentKey } : null;
    });
  }, [contentKey, pdf]);

  // Rebuilding is EXPENSIVE - a worker round-trip (`getTextContent`) plus a
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
    if (!container) return;
    // A new proxy over the same page geometry keeps the spans it finds until
    // the new ones are built, and the swap carries the selection across. Spans
    // laid out for another page, rotation or size select the wrong glyphs and
    // go at once.
    const built = builtRef.current;
    const sameGeometry = built !== null && built.pageNumber === pageNumber && built.rotation === rotation
      && built.w === layoutW && built.h === layoutH;
    const sized = layoutW > 0 && layoutH > 0;
    if (!sized || !sameGeometry) {
      clearTextLayer(container);
      delete container.dataset.ocrLayer;
      builtRef.current = null;
    }
    if (!sized) return;
    let cancelled = false;
    if (!pdf) {
      // A file whose buffer changed shows no document until the new bytes
      // load. The spans stand over that gap, so a selection reaches the new
      // document's build; a failed load of the new bytes takes them down.
      const shown = builtRef.current;
      if (!shown) return;
      // A load superseded by a newer one rejects (pdf.js aborts it), so a
      // rejection clears only when no newer load stands behind it.
      const watch = (load: Promise<PDFDocumentProxy>): Promise<void> => load.then(() => {}, () => {
        if (cancelled || builtRef.current !== shown) return;
        const newer = replacementOf(shown.pdf);
        if (newer && newer !== load) return watch(newer);
        clearTextLayer(container);
        delete container.dataset.ocrLayer;
        builtRef.current = null;
      });
      // The replacing load is requested by the canvas's own effect, which runs
      // after this one in the same flush.
      void Promise.resolve().then(() => {
        const next = cancelled ? null : replacementOf(shown.pdf);
        return next ? watch(next) : undefined;
      });
      return () => {
        cancelled = true;
      };
    }
    let layer: TextLayer | null = null;
    const keyOfBuild = contentKeyOf(pdf) ?? Promise.resolve(null);

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
        // The layer is built detached and swapped in whole, so the container
        // never shows a half-built layer and never stands empty between two
        // builds. pdf.js measures glyphs on its own canvas, not in the page.
        const staged = document.createElement('div');
        // pdf.js's span CSS is expressed in terms of --scale-factor; nothing
        // sets it for us because we construct TextLayer directly instead of
        // going through its viewer's setLayerDimensions.
        for (const [name, value] of Object.entries(textLayerScaleVars(viewport))) {
          staged.style.setProperty(name, value);
        }
        const content = await page.getTextContent();
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: content,
          container: staged,
          viewport,
        });
        await layer.render();
        if (cancelled) return;
        // Selection and copy follow DOM order; this puts rotated and
        // mixed-orientation text in the order search reads it.
        const items = content.items.flatMap((it) => ('str' in it ? [it] : []));
        applyReadingOrder(staged, layer.textDivs, items, page.rotate, () => {
          const br = document.createElement('br');
          br.setAttribute('role', 'presentation');
          return br;
        });
        const key = await keyOfBuild;
        if (cancelled) return;
        const hasText = (staged.textContent ?? '').trim().length > 0;
        const shown = builtRef.current;
        // The build of a scan finds no text. Word boxes recognised from equal
        // bytes over this geometry are still true of the page; swapping the
        // empty layer in would drop them and the selection over them.
        const keepBoxes = !hasText && key !== null && shown !== null && shown.ocr !== null
          && shown.key === key && shown.pageNumber === pageNumber && shown.rotation === rotation
          && shown.w === layoutW && shown.h === layoutH;
        if (!keepBoxes) {
          swapTextLayer(container, staged);
          builtRef.current = { pdf, pageNumber, rotation, w: layoutW, h: layoutH, key, ocr: null };
        } else {
          builtRef.current = { ...shown, pdf };
        }
        setNative({ version: ++nativeVersionRef.current, hasText });
      } catch (e) {
        if (cancelled) return;
        // Kept spans may spell bytes the page no longer holds.
        clearTextLayer(container);
        builtRef.current = null;
        logRenderError(`Failed to render text layer for page ${pageNumber}`)(e);
      }
    })();

    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [pdf, pageNumber, rotation, layoutW, layoutH, revision]);

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
      // Boxes standing between two loads of the file keep their status.
      if (!pdf && ocrSelection && container?.dataset.ocrLayer === 'true') return;
      setOcrStatus(null);
      // The preference going OFF is the one case that must also take back what
      // is already on screen; disarming the tool leaves the page alone.
      if (!ocrSelection && container) {
        releaseOcrSelection(contentKey, {
          hasOcrSpans: container.dataset.ocrLayer === 'true',
          clear: () => {
            clearTextLayer(container);
            delete container.dataset.ocrLayer;
            const shown = builtRef.current;
            if (shown) builtRef.current = { ...shown, ocr: null };
          },
        });
      }
      return;
    }
    // The cache is keyed by the bytes; until their key is known there is
    // nothing to look up, and the page on screen stays as it is.
    if (contentKey === null) return;
    const key = contentKey;
    const build = native.version;
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
        const known = peekSelectionCache(key, pageNumber, spin, ocrSelection.lang);
        // No answer yet and no gesture yet: stay out of the recognizer.
        if (!known && !gestured) {
          setOcrStatus(null);
          return;
        }
        // Nothing already known means work is about to start; a cached answer
        // resolves without ever flashing a busy badge.
        if (!known) setOcrStatus('pending');
        const recognised = await recognizeForSelection(
          key,
          pageNumber,
          spin,
          ocrSelection.lang,
          async () => {
            // A request to a destroyed document never settles, and a render in
            // flight when it is destroyed rejects: either one is a cancellation,
            // never a verdict on the bytes another document still shows.
            const destroyed = () => pdf.loadingTask.destroyed || page.destroyed;
            if (destroyed()) throw new RecognitionCancelled();
            let png: Uint8Array | null;
            try {
              png = await renderPageToPng(pdf, page, spin);
            } catch (error) {
              if (destroyed()) throw new RecognitionCancelled();
              throw error;
            }
            if (!png) return null;
            return recognizeRaster(ocrSelection.callRaw, png, ocrSelection.lang);
          },
        );
        if (cancelled) return;
        setOcrStatus(recognised.status);
        if (recognised.status !== 'ready') return;
        const shown = builtRef.current;
        // The same cache answer over the same bytes and geometry is already
        // on screen: reinstalling it would only replace the spans under the
        // selection.
        if (shown !== null && shown.ocr === recognised && shown.key === key
            && shown.pageNumber === pageNumber && shown.rotation === rotation
            && shown.w === layoutW && shown.h === layoutH && container.dataset.ocrLayer === 'true') return;
        // Staged inside the live layer (as a box-less `markedContent`) so each
        // span measures in the layer's own font and frame, then moved out
        // before the swap; no paint falls between.
        // The staged div carries no `data-main-rotation`, so the swap removes
        // pdf.js's rotation rule, which would turn these displayed-frame
        // boxes a second time.
        const staged = document.createElement('div');
        staged.className = 'markedContent';
        container.append(staged);
        for (const word of recognised.words) {
          const box = wordSpanBox(word, layoutW, layoutH);
          const span = document.createElement('span');
          span.textContent = word.text;
          span.style.cssText =
            'position:absolute;white-space:pre;transform-origin:0 0;' +
            `left:${box.left}px;top:${box.top}px;font-size:${box.fontSize}px;line-height:1;`;
          staged.append(span);
          // Measure, then squeeze the glyph run onto the recognised box -
          // pdf.js's own trick. Without it a word whose face is wider than the
          // scan's overhangs its box and a mid-word selection lands past the
          // glyph the pointer is over.
          const natural = span.offsetWidth;
          if (natural > 0) span.style.transform = `scaleX(${box.width / natural})`;
        }
        staged.remove();
        swapTextLayer(container, staged);
        container.dataset.ocrLayer = 'true';
        builtRef.current = { pdf, pageNumber, rotation, w: layoutW, h: layoutH, key, ocr: recognised };
      } catch (e) {
        // A failed recognition is a QUIET fallback to freehand, never an error
        // dialog: the user asked to select text, and the honest answer is that
        // this page has none to snap to.
        if (!cancelled) setOcrStatus('failed');
        logRenderError(`Recognition for selection failed on page ${pageNumber}`)(e);
      } finally {
        // The native build this arm last settled for, whatever it decided.
        if (!cancelled) container.dataset.ocrBuild = String(build);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdf, contentKey, pageNumber, rotation, layoutW, layoutH, ocrSelection, active, native, gestured]);

  return (
    <>
      <div
        ref={containerRef}
        className="textLayer"
        data-testid="text-layer"
        data-text-build={native?.version}
        data-ocr-status={ocrStatus ?? undefined}
        // The selection gesture's own first event, and the OCR arm's trigger.
        // The layer is inert unless `active`, so this can only fire while the
        // Select tool is armed.
        onPointerDown={() => setGesture({ pageNumber, key: contentKey, pdf })}
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
