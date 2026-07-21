import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, PageAnnotation, PageRef } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import type { EditVectorObject } from '../../lib/edit-vectors';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OcrWord } from '../../ocr/types';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import { displayWidthAt } from '../../canvas/layout';
import { isEditable } from '../../commands/keymap';
import { pushEscapeInterceptor } from '../../commands/context';
import {
  actualSizeZoom,
  anchorHolds,
  clampZoom,
  currentPageFor,
  fitWidthZoom,
  visibleRange,
  READING_BASE_HEIGHT,
  READING_PAGE_GAP as PAGE_GAP,
  ZOOM_SETTLE_MS,
  ZOOM_STEP,
  type JumpAnchor,
} from '../../canvas/reading-page';
import { PageCell } from './PageCell';

// The continuous reading view (Phase 4 M4, § 6): one document, a single
// vertical column of the SAME PageCells the board uses (§ 6.2 — the reuse
// seam), laid out by a plain scroller with a scalar zoom instead of the d3
// world transform. Every tool works here because the cells are identical; the
// d3 camera and page-reorder drag stay Organize-view-only. Virtualized: only
// pages within the viewport (± overscan) are mounted, so a 1,000-page doc is a
// handful of live cells. Zoom drives `pageHeight` (PageCell sizes the whole
// cell — raster, overlays, font — off it), so the reading `CanvasHandle` is
// pure scroll + a scale number, no world matrix.

const OVERSCAN = 2; // pages rendered beyond each viewport edge
// Breathing room Fit Width leaves either side of the page. Exactly double the
// 8px custom scrollbar (styles.css), so if the fit's own zoom change flips the
// scrollbar's visibility the row can only come out narrower than the pane,
// never wider — the delta is absorbed rather than clipping.
const FIT_WIDTH_GUTTER = 16;
// MIN_ZOOM / MAX_ZOOM / ZOOM_STEP / clampZoom live in canvas/reading-page.ts —
// the range is load-bearing for the presets (see its header) and tested there.

// The reading view has no page-reorder drag (Organize-view-only), so a page
// press in select mode is a no-op; the annotate/redact/form tools handle their
// own pointer events inside PageCell. Stable identity preserves PageCell's memo.
const NO_PAGE_POINTER = (): void => {};

export interface DocumentViewProps {
  doc: OpenDocument;
  /** Rotate View's render-only quarter-turn for this file (M6.1); composed
   * with each page's own pending rotation for every display/capture read. */
  viewRotation?: 0 | 90 | 180 | 270;
  proxies: Map<string, PDFDocumentProxy>;
  renderVersion: number;
  selectedPageIds: ReadonlySet<string>;
  onSelectPage: (docId: string, pageId: string, e?: React.MouseEvent) => void;
  onOpenPage: (docId: string, pageId: string) => void;
  onPageContextMenu: (docId: string, pageId: string, e: React.MouseEvent) => void;
  tool: CanvasTool;
  annotationColor?: string;
  stampPreset?: StampPreset | null;
  redactionMarksByPage: ReadonlyMap<string, RedactionMark[]>;
  editImagesByPage: ReadonlyMap<string, EditImagePlacement[]>;
  editVectorsByPage: ReadonlyMap<string, EditVectorObject[]>;
  selectedVector: { pageId: string; index: number } | null;
  editImageTransform: EditImageTransformCtx | null;
  onCommitImageTransform: (pageId: string, index: number, matrix: number[]) => void;
  vectorTransform: EditImageTransformCtx | null;
  onCommitVectorTransform: (pageId: string, index: number, matrix: number[]) => void;
  /** 9.C3 crop mode: armed flag + unit-space rect commit. */
  imageCropArmed: boolean;
  onCommitImageCrop: (pageId: string, index: number, rect: [number, number, number, number]) => void;
  editTextByPage: ReadonlyMap<string, EditTextListing>;
  editSelection: { kind: 'image' | 'text' | 'para'; pageId: string; index: number } | null;
  editingText: { kind: 'text' | 'para'; pageId: string; index: number } | null;
  onSelectEditImage: (pageId: string, index: number) => void;
  onSelectEditVector: (pageId: string, index: number) => void;
  onDeleteVector: () => void;
  onSelectEditText: (pageId: string, index: number) => void;
  onOpenTextEditor: (pageId: string, index: number) => void;
  onCommitTextEdit: (pageId: string, index: number, newText: string, opts?: { convert?: boolean }) => void;
  onCancelTextEdit: () => void;
  onSelectEditParagraph: (pageId: string, index: number) => void;
  onOpenParagraphEditor: (pageId: string, index: number) => void;
  onCommitParagraphEdit: (pageId: string, index: number, newText: string, opts?: ParagraphEditOpts) => void;
  onCancelParagraphEdit: () => void;
  onMergeParagraphPrev: (pageId: string, index: number) => void;
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  newFieldPlacement: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
  // Add-text placement (9.A2).
  addTextPlacement: SignaturePlacement | null;
  onSetAddTextRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearAddTextPlacement: () => void;
  onAddImageRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onAddAnnotation: (docId: string, pageId: string, annotation: PageAnnotation) => void;
  onUpdateAnnotation: (docId: string, pageId: string, annotationId: string, note: string) => void;
  onRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  onRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  onAddRedactionMark: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onRemoveRedactionMark: (markId: string) => void;
  onSetSignaturePlacement: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearSignaturePlacement: () => void;
  /** Reports the 1-based page number nearest the viewport top (scroll tracking
   * → the toolbar page box + Pages-panel sync). */
  onCurrentPageChange?: (pageNumber: number) => void;
}

/** The height (px) a page occupies in the column at the given zoom, aspect-
 * correct. Mirrors PageCell's own sizing so the virtualizer's offsets match
 * the DOM exactly. */
function pageHeightAt(zoom: number): number {
  return READING_BASE_HEIGHT * zoom;
}

export const DocumentView = forwardRef<CanvasHandle, DocumentViewProps>(function DocumentView(
  props,
  ref,
): React.JSX.Element {
  const { doc, proxies, viewRotation = 0 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoomState, setZoom] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Rotate View (M6.1): every DISPLAY read in this component sees the page at
  // its EFFECTIVE rotation — (page.rotation + viewRotation), composed once
  // here. The page-tier `doc.pages` stays what commits; only what renders and
  // captures turns. Sizing MUST read these too (the row wrapper, the widest
  // page, both zoom presets): a 90° page whose cell swapped aspect under an
  // unswapped row clips and mis-centers.
  const viewPages = useMemo(
    () =>
      viewRotation === 0
        ? doc.pages
        : doc.pages.map((p) => ({
            ...p,
            rotation: (((p.rotation + viewRotation) % 360) + 360) % 360 as 0 | 90 | 180 | 270,
          })),
    [doc.pages, viewRotation],
  );

  const pageCount = doc.pages.length;
  // The EFFECTIVE zoom, re-derived every render — the document's page count is
  // half of what makes a zoom valid (see maxZoomFor), and it changes UNDER a
  // stable zoom: an Undo/Import/merge grows the doc without remounting this view
  // (`OpenDocument.id` survives page-tier edits, and the view is keyed on it), so
  // clamping only where zoom is WRITTEN left the existing zoom stale and the
  // spacer over the browser's element cap with no zoom press at all — and the
  // next Ctrl+= then visibly zoomed OUT. Deriving makes "the zoom is renderable"
  // true by construction rather than something every writer must remember; it
  // also covers the initial state, which no write site ever sees.
  // The widest page's rendered width AT ZOOM 1 — a property of the document, so
  // memoised on the page list. Feeds BOTH the zoom ceiling (the spacer's width
  // can blow the element cap just as its height can) and the spacer's own width.
  const widestAtBase = useMemo(() => {
    let w = 0;
    for (const p of viewPages) w = Math.max(w, displayWidthAt(p, READING_BASE_HEIGHT));
    return w;
  }, [viewPages]);
  const zoom = clampZoom(zoomState, pageCount, widestAtBase);
  const pageHeight = pageHeightAt(zoom);
  const gap = PAGE_GAP * zoom;
  const rowH = pageHeight + gap;

  // A "settle" signal for the raster: PageView's detail layer only re-renders
  // when its `version` changes; on the board that comes from <Canvas onSettle>,
  // which isn't mounted here. So after a zoom, bump this a beat later (debounced
  // — a burst of Ctrl+= re-details once) and fold it into the version handed to
  // each PageCell, so the visible page re-rasters crisp at the new size instead
  // of staying a CSS-stretched (blurry) base raster (review-caught). Keyed on the
  // EFFECTIVE zoom, so a re-derived clamp re-details too.
  const [zoomVersion, setZoomVersion] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setZoomVersion((v) => v + 1), ZOOM_SETTLE_MS);
    return () => clearTimeout(t);
  }, [zoom]);

  // Cumulative Y offset of each page (top of its row). Pages are uniform-height
  // (widths vary by aspect), so offsets are a simple arithmetic series — the
  // virtualizer needs only counts, and centerOn/current-page are O(1).
  const contentHeight = pageCount * rowH;

  // The scrollable WIDTH (M4.1f). Without a real width the spacer is only as
  // wide as the pane, and a page wider than it — routine at Actual Size on
  // anything landscape or large-format — is clipped symmetrically by the
  // centring with no way to reach its edges, making "Actual Size" useless on
  // exactly the documents that need it. Paired with `min-width: 100%` in CSS so
  // a doc narrower than the pane still centres instead of hugging the left edge.
  // Widest-of-ALL-pages (not just the rendered window) so the width doesn't
  // jitter as you scroll past a wide page.
  // Exact, NOT ceil'd: CSS takes fractional widths, and rounding UP can make the
  // spacer a fraction of a pixel wider than a pane the page genuinely fits,
  // opening a scrollbar over nothing (review-caught — a ~0.2px band of pane
  // widths, reachable under display scaling).
  const contentWidth = widestAtBase * (pageHeight / READING_BASE_HEIGHT);

  // Track the scroll position + viewport height (drives virtualization + the
  // current-page report). ResizeObserver keeps viewportH live on pane resize.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Focus the scroller when the reading view appears so PageUp/PageDown/Home/End/
  // arrows/Space scroll it natively (those keys aren't in the keymap table, so
  // they fall through to the focused scroll region). But NEVER steal focus from
  // a field the user is editing — this mounts on every doc switch (keyed) and a
  // guard-exempt Ctrl+Tab can fire it while a nav-panel input or the page box
  // has focus (review-caught). A button/body focus (e.g. the toggle pill) is
  // fine to take over from. preventScroll: taking focus mustn't jump the page.
  useEffect(() => {
    // Reuse the ONE canonical inline-edit guard (commands/keymap.ts) rather than
    // re-deriving it — a hand-rolled copy here missed SELECT and would still
    // steal focus from a dropdown (e.g. the new-form-field Type select).
    if (!isEditable(document.activeElement)) scrollRef.current?.focus({ preventScroll: true });
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Visible page range [first, last], padded by OVERSCAN — pure + tested
  // (canvas/reading-page.ts), because an unclamped `first` could exceed `last`
  // after a page-tier delete and the row loop would emit no cells at all.
  const { first, last } = visibleRange(
    { scrollTop, viewportH, rowH, pageHeight, pageCount, contentHeight },
    OVERSCAN,
  );

  // A jump's recorded intent — see JumpAnchor's header for why scroll position
  // alone cannot answer this at the extremes.
  const jumpAnchorRef = useRef<JumpAnchor | null>(null);
  // The page the reader is on, mirrored for the zoom presets: Acrobat's Actual
  // Size / Fit Width act on the CURRENT page (pages in one file can differ in
  // size and rotation), and the presets are imperative-handle calls, not
  // renders, so they need it off a ref rather than through the parent.
  const currentPageRef = useRef(1);

  // Report the current page. Debounced to a rAF-ish cadence by React's
  // batching; the parent dedupes.
  const onCurrentPageChange = props.onCurrentPageChange;
  const onCurrentPageChangeRef = useRef(onCurrentPageChange);
  onCurrentPageChangeRef.current = onCurrentPageChange;
  useEffect(() => {
    if (!onCurrentPageChange || pageCount === 0 || viewportH === 0) return;
    const m = { scrollTop, viewportH, rowH, pageHeight, pageCount, contentHeight };
    // A jump wins until the user scrolls away from where it landed; then the
    // anchor is dropped and the view speaks for itself. Both halves are pure
    // (canvas/reading-page.ts) — the tie-break and the extremes are subtle
    // enough to own tests; see that module's header.
    const a = jumpAnchorRef.current;
    // `doc.pages` is the composition guard: a page-tier edit renumbers pages
    // without remounting this view, so the anchor must re-prove that the page it
    // meant still sits in that slot.
    if (anchorHolds(a, m, a ? doc.pages[a.page - 1]?.id : null)) {
      currentPageRef.current = a!.page;
      onCurrentPageChange(a!.page);
      return;
    }
    jumpAnchorRef.current = null;
    const p = currentPageFor(m);
    currentPageRef.current = p;
    onCurrentPageChange(p);
  }, [
    scrollTop,
    rowH,
    pageHeight,
    pageCount,
    viewportH,
    contentHeight,
    doc.pages,
    onCurrentPageChange,
  ]);

  // The reading CanvasHandle — pure scroll + scale, no world matrix.
  const centerOn = useCallback(
    (pageId: string) => {
      const idx = doc.pages.findIndex((p) => p.id === pageId);
      const el = scrollRef.current;
      if (idx < 0 || !el) return;
      // Center the page in the viewport when it's shorter than the pane;
      // otherwise align its top.
      const top = idx * rowH;
      const offset = Math.max(0, (el.clientHeight - pageHeight) / 2);
      el.scrollTo({ top: Math.max(0, top - offset), behavior: 'auto' });
      // Record where it actually LANDED (behavior:'auto' settles scrollTop
      // synchronously, so this is the browser's own clamp applied) together with
      // what it meant, so the scroll event this fires can't "correct" a jump to
      // a boundary-adjacent page into the boundary page itself. `viewportH` is
      // the STATE the reporter compares against — not the live `el.clientHeight`
      // used for the offset above — so the two can never disagree and silently
      // stop the anchor from ever holding.
      jumpAnchorRef.current = { scrollTop: el.scrollTop, page: idx + 1, pageId, rowH, viewportH };
      // Report immediately: a jump that doesn't move the view (already parked
      // there) fires no scroll event, so the effect above would never re-run.
      currentPageRef.current = idx + 1;
      onCurrentPageChangeRef.current?.(idx + 1);
    },
    [doc.pages, rowH, pageHeight, viewportH],
  );

  // Both presets act on the CURRENT page — pages within one file can differ in
  // size and rotation, so "actual size" and "fit width" are per-page answers,
  // exactly as they are in Acrobat.
  // The EFFECTIVE pages — currentPage() feeds the zoom presets' sizing math,
  // which must see the rotation the display shows.
  const pagesRef = useRef(viewPages);
  pagesRef.current = viewPages;
  // The zoom ceiling depends on the page COUNT (see maxZoomFor), and the
  // handle's zoom calls are imperative, so they read it off a ref.
  const widestAtBaseRef = useRef(widestAtBase);
  widestAtBaseRef.current = widestAtBase;
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;
  // The steppers must step from the EFFECTIVE zoom, not the raw state: stepping
  // from a state the derivation has already clamped down would move the wrong
  // way (or not at all).
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const currentPage = useCallback((): PageRef | null => {
    const pages = pagesRef.current;
    return pages[Math.min(pages.length, Math.max(1, currentPageRef.current)) - 1] ?? null;
  }, []);

  // Hand mode's drag-scroll (M6.2). Window-level move/up listeners — the
  // canvas pattern — with the full usePageDrag session hygiene, all
  // review-caught: a `blur` teardown (release outside the window otherwise
  // leaks the listeners), an unmount teardown (Ctrl+Tab mid-drag unmounts
  // this view with the listeners live), an Escape interceptor (the Escape
  // chain's first scope is "cancel the in-flight drag"), and a cancel when
  // the tool stops being hand.
  const handDragTeardown = useRef<(() => void) | null>(null);
  useEffect(() => () => handDragTeardown.current?.(), []);
  useEffect(() => {
    if (props.tool !== 'hand') handDragTeardown.current?.();
  }, [props.tool]);
  const handleHandDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    el.style.cursor = 'grabbing';
    const onMove = (ev: PointerEvent): void => {
      el.scrollLeft = startLeft - (ev.clientX - startX);
      el.scrollTop = startTop - (ev.clientY - startY);
    };
    const teardown = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', teardown);
      window.removeEventListener('pointercancel', teardown);
      window.removeEventListener('blur', teardown);
      popEscape();
      handDragTeardown.current = null;
      // Back to the steady-state grab — '' would also clear React's own
      // inline cursor until the next render (review-caught). The
      // tool-change effect above tears down BEFORE React re-renders the
      // style prop away, so 'grab' never outlives hand mode visibly.
      el.style.cursor = 'grab';
    };
    handDragTeardown.current = teardown;
    const popEscape = pushEscapeInterceptor(() => {
      teardown();
      return true;
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', teardown);
    window.addEventListener('pointercancel', teardown);
    window.addEventListener('blur', teardown);
  }, []);

  const actualSize = useCallback(() => {
    const page = currentPage();
    if (!page) return;
    setZoom(clampZoom(actualSizeZoom(page, READING_BASE_HEIGHT), pageCountRef.current, widestAtBaseRef.current));
  }, [currentPage]);

  const fitWidth = useCallback(() => {
    const page = currentPage();
    const el = scrollRef.current;
    if (!page || !el) return;
    // clientWidth already excludes a vertical scrollbar; the gutter keeps the
    // page off the pane's edges the way Acrobat's Fit Width does.
    const available = el.clientWidth - FIT_WIDTH_GUTTER;
    const z = fitWidthZoom(available, displayWidthAt(page, READING_BASE_HEIGHT));
    if (z <= 0) return; // pane not measured yet — leave the zoom alone
    setZoom(clampZoom(z, pageCountRef.current, widestAtBaseRef.current));
  }, [currentPage]);

  useImperativeHandle(
    ref,
    (): CanvasHandle => ({
      // Every zoom path goes through clampZoom, which bounds by the DOCUMENT's
      // size as well as the view's range — past that the spacer would exceed the
      // browser's element-height limit and the tail of the doc would stop being
      // reachable (see maxZoomFor). That includes `reset`: a document long
      // enough that even zoom 1 overflows must not be forced back to it.
      zoomIn: () => setZoom(clampZoom(zoomRef.current * ZOOM_STEP, pageCountRef.current, widestAtBaseRef.current)),
      zoomOut: () => setZoom(clampZoom(zoomRef.current / ZOOM_STEP, pageCountRef.current, widestAtBaseRef.current)),
      reset: () => setZoom(clampZoom(1, pageCountRef.current, widestAtBaseRef.current)),
      actualSize,
      fitWidth,
      // The reading view has no world transform; tools resolve coordinates
      // element-relative (PageCell reads its own getBoundingClientRect), so the
      // camera-space projection the board exposes for its drop math isn't
      // meaningful here.
      clientToWorld: () => null,
      centerOn,
    }),
    [centerOn, actualSize, fitWidth],
  );

  // Rows are computed inline each render (PageCell is memo'd, so unchanged
  // cells skip re-render; the per-page overlay maps come pre-grouped from WCV).
  const rows: React.JSX.Element[] = [];
  for (let i = first; i <= last; i++) {
    const page = viewPages[i];
    if (!page) continue;
    // MUST be the same width PageCell renders (it uses the exact aspect here —
    // `textLayer` is set below). This row is what CENTRES the page, so a
    // divergent formula offsets it in the pane and over-reports the scrollable
    // width — the round-2 drift, relocated one level up (review-caught).
    const width = displayWidthAt(page, pageHeight);
    rows.push(
      <div
        key={page.id}
        className="docview-row"
        style={{ position: 'absolute', top: i * rowH, height: pageHeight, width, left: '50%', marginLeft: -width / 2 }}
      >
        <PageCell
          docId={doc.id}
          page={page}
          viewRotation={viewRotation}
          pdf={proxies.get(page.sourceDocId) ?? null}
          pageHeight={pageHeight}
          renderVersion={props.renderVersion + zoomVersion}
          selected={props.selectedPageIds.has(page.id)}
          collapsed={false}
          visibleNumber={i + 1}
          onSelectPage={props.onSelectPage}
          onOpenPage={props.onOpenPage}
          tool={props.tool}
          annotationColor={props.annotationColor}
          stampPreset={props.stampPreset}
          redactionMarks={props.redactionMarksByPage.get(page.id)}
          editImages={props.editImagesByPage.get(page.id)}
          editVectors={props.editVectorsByPage.get(page.id)}
          selectedVectorIndex={
            props.selectedVector?.pageId === page.id ? props.selectedVector.index : null
          }
          editImageTransform={
            props.editImageTransform?.pageId === page.id ? props.editImageTransform : null
          }
          onCommitImageTransform={props.onCommitImageTransform}
          vectorTransform={
            props.vectorTransform?.pageId === page.id ? props.vectorTransform : null
          }
          onCommitVectorTransform={props.onCommitVectorTransform}
          imageCropArmed={props.imageCropArmed}
          onCommitImageCrop={props.onCommitImageCrop}
          editTextRuns={props.editTextByPage.get(page.id)?.runBoxes}
          editParagraphs={props.editTextByPage.get(page.id)?.paragraphs}
          editSelectedIndex={
            props.editSelection?.kind === 'image' && props.editSelection.pageId === page.id
              ? props.editSelection.index
              : null
          }
          editTextSelectedIndex={
            props.editSelection?.kind === 'text' && props.editSelection.pageId === page.id
              ? props.editSelection.index
              : null
          }
          editParaSelectedIndex={
            props.editSelection?.kind === 'para' && props.editSelection.pageId === page.id
              ? props.editSelection.index
              : null
          }
          editingTextIndex={
            props.editingText?.kind === 'text' && props.editingText.pageId === page.id
              ? props.editingText.index
              : null
          }
          editingParaIndex={
            props.editingText?.kind === 'para' && props.editingText.pageId === page.id
              ? props.editingText.index
              : null
          }
          onSelectEditImage={props.onSelectEditImage}
          onSelectEditVector={props.onSelectEditVector}
          onDeleteVector={props.onDeleteVector}
          onSelectEditText={props.onSelectEditText}
          onOpenTextEditor={props.onOpenTextEditor}
          onCommitTextEdit={props.onCommitTextEdit}
          onCancelTextEdit={props.onCancelTextEdit}
          onSelectEditParagraph={props.onSelectEditParagraph}
          onOpenParagraphEditor={props.onOpenParagraphEditor}
          onCommitParagraphEdit={props.onCommitParagraphEdit}
          onCancelParagraphEdit={props.onCancelParagraphEdit}
          onMergeParagraphPrev={props.onMergeParagraphPrev}
          signaturePlacement={props.signaturePlacement?.pageId === page.id ? props.signaturePlacement : null}
          findMatch={props.findMatchPageIds.has(page.id)}
          findWords={props.findWordsByPage.get(page.id)}
          formWidgets={props.formWidgetsByPage.get(page.id)}
          formValues={props.formValuesByPath.get(page.sourceDocId)}
          onSetFormValue={props.onSetFormValue}
          onSignFieldRequest={props.onSignFieldRequest}
          newFieldPlacement={props.newFieldPlacement?.pageId === page.id ? props.newFieldPlacement : null}
          onSetNewFieldRect={props.onSetNewFieldRect}
          onClearNewFieldPlacement={props.onClearNewFieldPlacement}
          addTextPlacement={props.addTextPlacement?.pageId === page.id ? props.addTextPlacement : null}
          onSetAddTextRect={props.onSetAddTextRect}
          onAddImageRect={props.onAddImageRect}
          onClearAddTextPlacement={props.onClearAddTextPlacement}
          onPageContextMenu={props.onPageContextMenu}
          onPagePointerDown={NO_PAGE_POINTER}
          textLayer
          onAddAnnotation={props.onAddAnnotation}
          onUpdateAnnotation={props.onUpdateAnnotation}
          onRecolorAnnotation={props.onRecolorAnnotation}
          onRemoveAnnotation={props.onRemoveAnnotation}
          onAddRedactionMark={props.onAddRedactionMark}
          onRemoveRedactionMark={props.onRemoveRedactionMark}
          onSetSignaturePlacement={props.onSetSignaturePlacement}
          onClearSignaturePlacement={props.onClearSignaturePlacement}
        />
      </div>,
    );
  }

  return (
    <div
      ref={scrollRef}
      className="docview-scroll"
      data-testid="document-view"
      tabIndex={0}
      onScroll={onScroll}
      style={props.tool === 'hand' ? { cursor: 'grab' } : undefined}
      // Hand (M6.2): drag-scroll the reading pane. CAPTURE phase, so the
      // press never reaches a page cell — hand must not select, band, or
      // start an edit; it only holds the paper.
      onPointerDownCapture={props.tool === 'hand' ? handleHandDown : undefined}
    >
      <div
        className="docview-spacer"
        style={{ height: contentHeight, width: contentWidth, position: 'relative' }}
      >
        {rows}
      </div>
    </div>
  );
});
