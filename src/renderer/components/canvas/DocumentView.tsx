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
import type { FieldCandidate } from '../../lib/form-candidates';
import type { TableRegion, TableReviewHandlers } from '../../lib/table-review';
import type { AnnotationTransform } from '../../lib/annotation-manipulation';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import type { EditVectorObject } from '../../lib/edit-vectors';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OcrWord } from '../../ocr/types';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import type { ShapeType, SpreadDirection } from '../../state/types';
import type { MeasureScale } from '../../lib/measure';
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
  realTopFor,
  scrollMapFor,
  virtualTopOf,
  visibleRange,
  READING_BASE_HEIGHT,
  READING_PAGE_GAP as PAGE_GAP,
  ZOOM_SETTLE_MS,
  ZOOM_STEP,
  type JumpAnchor,
} from '../../canvas/reading-page';
import { PageCell } from './PageCell';
import { pagesInRow, rowCountOf, rowOfPage, type PageLayout } from '../../canvas/spread-layout';
import { TextSelectionMenu } from './TextSelectionMenu';
import type { PageQuads } from '../../lib/text-selection-markup';
import type { GuideAxis, PageGuide } from '../../lib/guides';
import { rulerTicks, type RulerTick } from '../../lib/rulers';
import { DEFAULT_MEASURE_SCALE, measureUnitsPerPoint } from '../../lib/measure';
import { tChrome, tNumber } from '../../i18n';

// The continuous reading view: one document, a single
// vertical column of the SAME PageCells the board uses (the reuse
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

// The ruler strips' thickness, in CSS pixels. Published to CSS as
// `--ruler-size` on the frame so the grid tracks and the drag preview's offset
// cannot drift apart — one number, one owner.
const RULER_PX = 18;

export interface DocumentViewProps {
  doc: OpenDocument;
  /** Author link regions over a text selection (reading view only). */
  onCreateLinks?: (selection: PageQuads[], url: string) => Promise<void>;
  /** Page layout (I.6): one page per row, or two-up facing spreads. */
  pageLayout?: PageLayout;
  /** Two-up only: show the first page alone (the book/cover convention). */
  twoUpCover?: boolean;
  /** Facing-page order, from the open document's /ViewerPreferences
   * /Direction. Reverses which side of a spread the leading page takes;
   * a single-page column has no facing order, so it is inert there. */
  spreadDirection?: SpreadDirection;
  /** Rotate View's render-only quarter-turn for this file; composed
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
  shapeType: ShapeType;
  measureScale?: MeasureScale;
  measureLeaveMarkup?: boolean;
  onMeasureResult?: (text: string) => void;
  redactionMarksByPage: ReadonlyMap<string, RedactionMark[]>;
  fieldCandidatesByPage: ReadonlyMap<string, FieldCandidate[]>;
  tableRegionsByPage: ReadonlyMap<string, TableRegion[]>;
  tableReview?: TableReviewHandlers;
  selectedCandidateId: string | null;
  onSelectCandidate: (candidateId: string) => void;
  onRemoveCandidate: (candidateId: string) => void;
  onMoveCandidate: (
    candidateId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  editImagesByPage: ReadonlyMap<string, EditImagePlacement[]>;
  editVectorsByPage: ReadonlyMap<string, EditVectorObject[]>;
  /** Per-page snap geometry + the live snap preferences. */
  snapGeomByPage: ReadonlyMap<string, import('../../lib/snap-geometry').PageSnapGeometry>;
  snapSettings: import('../../lib/snap-settings').SnapSettings;
  /** Ruler guides for this document, grouped by page. */
  guidesByPage: ReadonlyMap<string, PageGuide[]>;
  onAddGuide: (pageId: string, axis: GuideAxis, pos: number, rotationAtDraw: 0 | 90 | 180 | 270) => void;
  onMoveGuide: (guideId: string, axis: GuideAxis, pos: number, rotationAtDraw: 0 | 90 | 180 | 270) => void;
  onRemoveGuide: (guideId: string) => void;
  selectedVector: { pageId: string; index: number } | null;
  editImageTransform: EditImageTransformCtx | null;
  onCommitImageTransform: (pageId: string, index: number, matrix: number[]) => void;
  /** Multi-select: the group frame context (N>1) + its one-op commit. */
  editImageGroup: import('./ImageGroupOverlay').ImageGroupCtx | null;
  onCommitImageGroupTransform: (
    pageId: string,
    targets: { index: number; matrix: number[] }[],
  ) => void;
  vectorTransform: EditImageTransformCtx | null;
  onCommitVectorTransform: (pageId: string, index: number, matrix: number[]) => void;
  /** Crop mode: armed flag + unit-space rect commit. */
  imageCropArmed: boolean;
  onCommitImageCrop: (pageId: string, index: number, rect: [number, number, number, number]) => void;
  /** The overlay's gradient-mask dot commit. */
  onCommitImageMask: (
    pageId: string,
    index: number,
    mask: import('../../lib/edit-images').EditImageMaskParam,
  ) => void;
  editTextByPage: ReadonlyMap<string, EditTextListing>;
  editSelection:
    | { kind: 'image'; pageId: string; index: number; indexes: number[] }
    | { kind: 'text' | 'para'; pageId: string; index: number }
    | null;
  editingText: { kind: 'text' | 'para'; pageId: string; index: number } | null;
  onSelectEditImage: (pageId: string, index: number, additive?: boolean) => void;
  onSelectEditVector: (pageId: string, index: number) => void;
  onDeleteVector: () => void;
  onRestyleVector: (
    pageId: string,
    index: number,
    opts: {
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    },
  ) => void;
  onSelectEditText: (pageId: string, index: number) => void;
  onOpenTextEditor: (pageId: string, index: number) => void;
  onCommitTextEdit: (pageId: string, index: number, newText: string, opts?: { convert?: boolean }) => void;
  onRestyleTextEdit: (pageId: string, index: number, style: { size?: number; color?: [number, number, number] }) => void;
  onCancelTextEdit: () => void;
  onSelectEditParagraph: (pageId: string, index: number) => void;
  onOpenParagraphEditor: (pageId: string, index: number) => void;
  onCommitParagraphEdit: (pageId: string, index: number, newText: string, opts?: ParagraphEditOpts) => void;
  onCancelParagraphEdit: () => void;
  onMergeParagraphPrev: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  onMergeParagraphNext: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  onFormButton: (path: string, fieldName: string, action: import('../../lib/forms').ButtonAction | null) => void;
  newFieldPlacement: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
  // Add-text placement.
  addTextPlacement: SignaturePlacement | null;
  /** The pending crop rectangle, drawn on the page. */
  cropPlacement: SignaturePlacement | null;
  onClearCropPlacement: () => void;
  onSetCropRect?: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
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
  // Click-selection for the properties bar (I.6). null clears.
  selectedAnnotationIds: readonly string[];
  onSelectAnnotation: (
    docId: string,
    pageId: string,
    annotationId: string | null,
    additive: boolean,
  ) => void;
  onTransformAnnotations: (docId: string, edits: AnnotationTransform[]) => void;
  onCalibrate: (lengthPts: number) => void;
  onMeasureContextMenu: (docId: string, pageId: string, annotationId: string, x: number, y: number) => void;
  onMarqueeSelect: (docId: string, pageId: string, annotationIds: string[], additive: boolean) => void;
  onRegroupCountMarks: (docId: string, pageId: string, annotationIds: string[], group: import('../../lib/count-marks').CountGroup) => void;
  // Marquee zoom applied locally — the split layer syncs sibling panes'
  // zoom to the returned value (quad zoom must stay equal).
  onMarqueeZoomApplied?: (zoom: number) => void;
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
  const {
    doc,
    proxies,
    viewRotation = 0,
    pageLayout = 'single',
    twoUpCover = false,
    spreadDirection = 'l2r',
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoomState, setZoom] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Rotate View: every DISPLAY read in this component sees the page at
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
  // Two-up (I.6): pages tile into uniform-height ROWS — one per page in
  // single layout (identity: every formula below reduces to the shipped
  // math), two facing pages per row in two-up. All row↔page mapping is the
  // pure, tested spread-layout module.
  const rowCount = rowCountOf(pageCount, pageLayout, twoUpCover);
  // The widest ROW's rendered width at zoom 1 (single: the widest page; two-up:
  // the widest PAIR incl. the inner gap). Feeds the zoom ceiling AND the
  // spacer width — both axes must see the true row extent.
  const widestAtBase = useMemo(() => {
    let w = 0;
    for (let r = 0; r < rowCount; r++) {
      const idxs = pagesInRow(r, pageLayout, twoUpCover, viewPages.length);
      let rowW = 0;
      for (const i of idxs) rowW += displayWidthAt(viewPages[i], READING_BASE_HEIGHT);
      if (idxs.length > 1) rowW += PAGE_GAP * (idxs.length - 1);
      w = Math.max(w, rowW);
    }
    return w;
  }, [viewPages, rowCount, pageLayout, twoUpCover]);
  const zoom = clampZoom(zoomState, rowCount, widestAtBase);
  const pageHeight = pageHeightAt(zoom);
  const gap = PAGE_GAP * zoom;
  const rowH = pageHeight + gap;

  // A "settle" signal for the raster: PageView's detail layer only re-renders
  // when its `version` changes; on the board that comes from <Canvas onSettle>,
  // which isn't mounted here. So after a zoom, bump this a beat later (debounced
  // — a burst of Ctrl+= re-details once) and fold it into the version handed to
  // each PageCell, so the visible page re-rasters crisp at the new size instead
  // of staying a CSS-stretched (blurry) base raster (regression). Keyed on the
  // EFFECTIVE zoom, so a re-derived clamp re-details too.
  const [zoomVersion, setZoomVersion] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setZoomVersion((v) => v + 1), ZOOM_SETTLE_MS);
    return () => clearTimeout(t);
  }, [zoom]);

  // Cumulative Y offset of each row. Rows are uniform-height (widths vary by
  // aspect), so offsets are a simple arithmetic series — the virtualizer needs
  // only counts, and centerOn/current-page are O(1).
  const contentHeight = rowCount * rowH;
  // The scaled-spacer scroll map. The DOM spacer caps at
  // SAFE_ELEMENT_EXTENT and rows translate under it; every document-space
  // consumer below reads VIRTUAL offsets, and only the DOM write/read
  // converts. k === 1 (any doc under the cap) is the bit-for-bit identity.
  const smap = useMemo(() => scrollMapFor(contentHeight, viewportH), [contentHeight, viewportH]);
  const virtualTop = virtualTopOf(scrollTop, smap);

  // The scrollable WIDTH. Without a real width the spacer is only as
  // wide as the pane, and a page wider than it — routine at Actual Size on
  // anything landscape or large-format — is clipped symmetrically by the
  // centring with no way to reach its edges, making "Actual Size" useless on
  // exactly the documents that need it. Paired with `min-width: 100%` in CSS so
  // a doc narrower than the pane still centres instead of hugging the left edge.
  // Widest-of-ALL-pages (not just the rendered window) so the width doesn't
  // jitter as you scroll past a wide page.
  // Exact, NOT ceil'd: CSS takes fractional widths, and rounding UP can make the
  // spacer a fraction of a pixel wider than a pane the page genuinely fits,
  // opening a scrollbar over nothing (regression — a ~0.2px band of pane
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
  // has focus (regression). A button/body focus (e.g. the toggle pill) is
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
  // visibleRange/currentPageFor are pure ROW math — `pageCount` in their
  // metrics is the row count (single layout: rows == pages, so the shipped
  // inputs are bit-identical).
  const { first, last } = visibleRange(
    { scrollTop: virtualTop, viewportH, rowH, pageHeight, pageCount: rowCount, contentHeight },
    OVERSCAN,
  );

  // A jump's recorded intent — see JumpAnchor's header for why scroll position
  // alone cannot answer this at the extremes.
  const jumpAnchorRef = useRef<JumpAnchor | null>(null);
  // A page-layout switch remaps rows under a STATIONARY scrollTop — rowH and
  // viewportH both survive it, so anchorHolds' geometry checks cannot see the
  // change and a pre-switch anchor would keep reporting a page the pane no
  // longer shows (regression: jump to 5, switch two-up → the box said
  // "5" over pages 8-9, durably, and fitWidth sized the wrong spread). Treat a
  // layout change exactly like a resize: drop the anchor. Render-time ref
  // write, so it lands before the reporter effect (whose deps include the
  // layout) re-runs and lets the view speak for itself.
  const layoutKey = `${pageLayout}:${twoUpCover}`;
  const prevLayoutKeyRef = useRef(layoutKey);
  if (prevLayoutKeyRef.current !== layoutKey) {
    prevLayoutKeyRef.current = layoutKey;
    jumpAnchorRef.current = null;
  }
  // The page the reader is on, mirrored for the zoom presets. Actual Size and
  // Fit Width act on the current page because pages in one file can differ in
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
    // Row metrics for the geometric half; the anchor's bounds check needs the
    // REAL page count (anchor.page is a PAGE number, which in two-up exceeds
    // the row count for most of the document).
    // Document math reads VIRTUAL offsets (identity for docs under the
    // element cap). Anchors record virtual too, so the comparison is uniform.
    const mRows = {
      scrollTop: virtualTop,
      viewportH,
      rowH,
      pageHeight,
      pageCount: rowCount,
      contentHeight,
    };
    const mAnchor = { ...mRows, pageCount };
    // A jump wins until the user scrolls away from where it landed; then the
    // anchor is dropped and the view speaks for itself. Both halves are pure
    // (canvas/reading-page.ts) — the tie-break and the extremes are subtle
    // enough to own tests; see that module's header.
    const a = jumpAnchorRef.current;
    // `doc.pages` is the composition guard: a page-tier edit renumbers pages
    // without remounting this view, so the anchor must re-prove that the page it
    // meant still sits in that slot.
    if (anchorHolds(a, mAnchor, a ? doc.pages[a.page - 1]?.id : null)) {
      currentPageRef.current = a!.page;
      onCurrentPageChange(a!.page);
      return;
    }
    jumpAnchorRef.current = null;
    // Current ROW → its first page (a spread reports its leading page, the
    // usual normalization for facing-page readers).
    const row = currentPageFor(mRows);
    const rowPages = pagesInRow(row - 1, pageLayout, twoUpCover, pageCount);
    const p = rowPages.length > 0 ? rowPages[0] + 1 : 1;
    currentPageRef.current = p;
    onCurrentPageChange(p);
  }, [
    scrollTop,
    virtualTop,
    rowH,
    pageHeight,
    pageCount,
    rowCount,
    pageLayout,
    twoUpCover,
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
      // Center the page's ROW in the viewport when it's shorter than the pane;
      // otherwise align its top. The target is VIRTUAL; the DOM write converts
      // (identity for docs under the element cap).
      const top = rowOfPage(idx, pageLayout, twoUpCover) * rowH;
      const offset = Math.max(0, (el.clientHeight - pageHeight) / 2);
      el.scrollTo({ top: realTopFor(Math.max(0, top - offset), smap), behavior: 'auto' });
      // Record where it actually LANDED (behavior:'auto' settles scrollTop
      // synchronously, so this is the browser's own clamp applied) together with
      // what it meant, so the scroll event this fires can't "correct" a jump to
      // a boundary-adjacent page into the boundary page itself. `viewportH` is
      // the STATE the reporter compares against — not the live `el.clientHeight`
      // used for the offset above — so the two can never disagree and silently
      // stop the anchor from ever holding. Recorded VIRTUAL, the space
      // the reporter's metrics carry.
      jumpAnchorRef.current = {
        scrollTop: virtualTopOf(el.scrollTop, smap),
        page: idx + 1,
        pageId,
        rowH,
        viewportH,
      };
      // Report immediately: a jump that doesn't move the view (already parked
      // there) fires no scroll event, so the effect above would never re-run.
      currentPageRef.current = idx + 1;
      onCurrentPageChangeRef.current?.(idx + 1);
    },
    [doc.pages, rowH, pageHeight, viewportH, pageLayout, twoUpCover, smap],
  );

  // Both presets act on the CURRENT page — pages within one file can differ in
  // size and rotation, so "actual size" and "fit width" are per-page answers.
  // The EFFECTIVE pages — currentPage() feeds the zoom presets' sizing math,
  // which must see the rotation the display shows.
  const pagesRef = useRef(viewPages);
  pagesRef.current = viewPages;
  // The zoom ceiling depends on the page COUNT (see maxZoomFor), and the
  // handle's zoom calls are imperative, so they read it off a ref.
  const widestAtBaseRef = useRef(widestAtBase);
  widestAtBaseRef.current = widestAtBase;
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;
  const layoutRef = useRef({ pageLayout, twoUpCover });
  layoutRef.current = { pageLayout, twoUpCover };
  // The steppers must step from the EFFECTIVE zoom, not the raw state: stepping
  // from a state the derivation has already clamped down would move the wrong
  // way (or not at all).
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const currentPage = useCallback((): PageRef | null => {
    const pages = pagesRef.current;
    return pages[Math.min(pages.length, Math.max(1, currentPageRef.current)) - 1] ?? null;
  }, []);

  // Hand mode's drag-scroll. Window-level move/up listeners — the
  // canvas pattern — with the full usePageDrag session hygiene, all
  // regression: a `blur` teardown (release outside the window otherwise
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
      // inline cursor until the next render (regression). The
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
    setZoom(clampZoom(actualSizeZoom(page, READING_BASE_HEIGHT), rowCountRef.current, widestAtBaseRef.current));
  }, [currentPage]);

  const setZoomPercent = useCallback((percent: number) => {
    const page = currentPage();
    if (!page || !Number.isFinite(percent) || percent <= 0) return;
    setZoom(
      clampZoom(
        actualSizeZoom(page, READING_BASE_HEIGHT) * (percent / 100),
        rowCountRef.current,
        widestAtBaseRef.current,
      ),
    );
  }, [currentPage]);

  const fitWidth = useCallback(() => {
    const page = currentPage();
    const el = scrollRef.current;
    if (!page || !el) return;
    // clientWidth already excludes a vertical scrollbar; the gutter keeps the
    // page off the pane's edges. In two-up the
    // unit being fitted is the current SPREAD (both widths + the inner gap).
    const available = el.clientWidth - FIT_WIDTH_GUTTER;
    const { pageLayout: lay, twoUpCover: cover } = layoutRef.current;
    const pages = pagesRef.current;
    // Clamp like currentPage() does — after a page-tier delete the ref can
    // briefly exceed the list; pagesInRow would answer [] (safe fallback), but
    // fitting the page's ACTUAL row is strictly better than degrading.
    const pageIdx = Math.min(pages.length, Math.max(1, currentPageRef.current)) - 1;
    const row = rowOfPage(pageIdx, lay, cover);
    const idxs = pagesInRow(row, lay, cover, pages.length);
    let rowW = 0;
    for (const i of idxs) rowW += displayWidthAt(pages[i], READING_BASE_HEIGHT);
    if (idxs.length > 1) rowW += PAGE_GAP * (idxs.length - 1);
    const z = fitWidthZoom(available, rowW > 0 ? rowW : displayWidthAt(page, READING_BASE_HEIGHT));
    if (z <= 0) return; // pane not measured yet — leave the zoom alone
    setZoom(clampZoom(z, rowCountRef.current, widestAtBaseRef.current));
  }, [currentPage]);

  // Marquee zoom: zoom so the banded page region fills the pane, then
  // scroll it centered. The scroll runs after the new layout exists (double
  // rAF), computed analytically from the applied zoom — same row math the
  // virtualizer uses. Returns the applied zoom so the split layer can sync
  // sibling panes (quad zoom must stay equal; their scroll follows the
  // frozen-pane DOM links on their own).
  const zoomToPageRect = useCallback(
    (pageId: string, rect: { x: number; y: number; w: number; h: number }): number | null => {
      const el = scrollRef.current;
      const idx = doc.pages.findIndex((p) => p.id === pageId);
      if (!el || idx < 0 || rect.w <= 0 || rect.h <= 0) return null;
      const page = viewPages[idx];
      const z0 = zoomRef.current;
      const bandW = rect.w * displayWidthAt(page, READING_BASE_HEIGHT) * z0;
      const bandH = rect.h * pageHeightAt(z0);
      if (bandW <= 0 || bandH <= 0) return null;
      const factor = Math.min(el.clientWidth / bandW, el.clientHeight / bandH);
      const z = clampZoom(z0 * factor, rowCountRef.current, widestAtBaseRef.current);
      setZoom(z);
      const cxNorm = rect.x + rect.w / 2;
      const cyNorm = rect.y + rect.h / 2;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const elc = scrollRef.current;
          if (!elc) return;
          const pageH = pageHeightAt(z);
          const rowHz = pageH + PAGE_GAP * z;
          const row = rowOfPage(idx, pageLayout, twoUpCover);
          const rowTop = row * rowHz;
          // The target is VIRTUAL — convert through the map AT THE NEW
          // ZOOM (this runs two frames later, but the map depends only on the
          // new extent and the live viewport, both known here).
          const mapZ = scrollMapFor(rowCountRef.current * rowHz, elc.clientHeight);
          elc.scrollTop = realTopFor(
            Math.max(0, rowTop + cyNorm * pageH - elc.clientHeight / 2),
            mapZ,
          );
          // Horizontal: rows centre in the spacer; walk the row for this
          // page's offset (two-up pairs included).
          const idxs = pagesInRow(row, pageLayout, twoUpCover, viewPages.length);
          let before = 0;
          let rowW = 0;
          for (const i of idxs) {
            const w = displayWidthAt(viewPages[i], READING_BASE_HEIGHT) * z;
            // Which pages lie to the LEFT of this one, which is the reading
            // order only while the row is not reversed.
            const leftOf = spreadDirection === 'r2l' ? i > idx : i < idx;
            if (leftOf) before += w + PAGE_GAP * z;
            rowW += w;
          }
          rowW += PAGE_GAP * z * (idxs.length - 1);
          const pageW = displayWidthAt(page, READING_BASE_HEIGHT) * z;
          const rowLeft = Math.max(0, (elc.scrollWidth - rowW) / 2);
          elc.scrollLeft = Math.max(0, rowLeft + before + cxNorm * pageW - elc.clientWidth / 2);
        }),
      );
      return z;
    },
    [doc.pages, viewPages, pageLayout, twoUpCover, spreadDirection],
  );

  useImperativeHandle(
    ref,
    (): CanvasHandle => ({
      // Every zoom path goes through clampZoom — the view's range plus the
      // WIDTH-axis element bound (maxZoomFor). The height axis no longer
      // bounds zoom at all — the spacer caps and rows translate under it
      // (scrollMapFor), so presets are honest at any page count.
      zoomIn: () => setZoom(clampZoom(zoomRef.current * ZOOM_STEP, rowCountRef.current, widestAtBaseRef.current)),
      zoomOut: () => setZoom(clampZoom(zoomRef.current / ZOOM_STEP, rowCountRef.current, widestAtBaseRef.current)),
      reset: () => setZoom(clampZoom(1, rowCountRef.current, widestAtBaseRef.current)),
      actualSize,
      fitWidth,
      // The reading view has no world transform; tools resolve coordinates
      // element-relative (PageCell reads its own getBoundingClientRect), so the
      // camera-space projection the board exposes for its drop math isn't
      // meaningful here.
      clientToWorld: () => null,
      centerOn,
      zoomToPageRect,
      setZoomAbsolute: (z: number) =>
        setZoom(clampZoom(z, rowCountRef.current, widestAtBaseRef.current)),
      setZoomPercent,
    }),
    [centerOn, actualSize, fitWidth, zoomToPageRect, setZoomPercent],
  );

  // ── Rulers and guides ─────────────────────────────────────────────────
  // The rulers read against the page nearest the top of the viewport, and
  // their origin is that page's own top-left corner — a ruler that measured
  // the SCROLLER would tell you where you are in a pane, which is not a
  // quantity anyone drafting cares about.
  //
  // The origin comes from a DOM rect, never from `row * rowH`. That is the
  // scaled-spacer rule taken at its word: past the element cap the spacer is scaled and rows
  // TRANSLATE under it, so a document-space offset is not where the page is —
  // whereas a rect is right at every scroll position, on every document, by
  // construction.
  const showRulers = props.snapSettings.showRulers;
  const [rulerGeom, setRulerGeom] = useState<{
    left: number;
    top: number;
    widthPx: number;
    heightPx: number;
    pageId: string;
    hostW: number;
    hostH: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!showRulers) {
      setRulerGeom(null);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const host = el.getBoundingClientRect();
    let best: { rect: DOMRect; id: string } | null = null;
    for (const cell of Array.from(el.querySelectorAll<HTMLElement>('[data-page-id]'))) {
      const r = cell.getBoundingClientRect();
      if (r.bottom <= host.top || r.top >= host.bottom) continue; // off screen
      const id = cell.getAttribute('data-page-id');
      if (!id) continue;
      if (!best || r.top < best.rect.top) best = { rect: r, id };
    }
    if (!best) {
      setRulerGeom(null);
      return;
    }
    const next = {
      left: best.rect.left - host.left,
      top: best.rect.top - host.top,
      widthPx: best.rect.width,
      heightPx: best.rect.height,
      pageId: best.id,
      hostW: host.width,
      hostH: host.height,
    };
    setRulerGeom((prev) =>
      prev &&
      prev.pageId === next.pageId &&
      Math.abs(prev.left - next.left) < 0.5 &&
      Math.abs(prev.top - next.top) < 0.5 &&
      Math.abs(prev.widthPx - next.widthPx) < 0.5 &&
      Math.abs(prev.hostW - next.hostW) < 0.5 &&
      Math.abs(prev.hostH - next.hostH) < 0.5
        ? prev
        : next,
    );
  }, [showRulers, scrollTop, virtualTop, zoom, viewportH, first, last, contentWidth, pageHeight]);

  const rulerPage = rulerGeom ? viewPages.find((p) => p.id === rulerGeom.pageId) ?? null : null;
  const unitsPerPt = measureUnitsPerPoint(props.measureScale ?? DEFAULT_MEASURE_SCALE);
  const rulerUnit = (props.measureScale ?? DEFAULT_MEASURE_SCALE).toUnit;
  // Pixels per PDF point, off the rect and the page's own displayed size in
  // points — so a rotated or oddly-sized page reads correctly without the
  // ruler knowing anything about zoom.
  const pxPerPt =
    rulerGeom && rulerPage
      ? rulerGeom.widthPx /
        (rulerPage.rotation === 90 || rulerPage.rotation === 270 ? rulerPage.height : rulerPage.width)
      : 0;
  const hTicks: RulerTick[] =
    rulerGeom && pxPerPt > 0
      ? rulerTicks({
          originPx: rulerGeom.left,
          extentPx: rulerGeom.hostW,
          pxPerPt,
          unitsPerPt,
        })
      : [];
  const vTicks: RulerTick[] =
    rulerGeom && pxPerPt > 0
      ? rulerTicks({
          originPx: rulerGeom.top,
          extentPx: rulerGeom.hostH,
          pxPerPt,
          unitsPerPt,
        })
      : [];

  // The cursor position markers on both rulers, in host coordinates.
  const [rulerCursor, setRulerCursor] = useState<{ x: number; y: number } | null>(null);
  // A live drag off a ruler: the guide-to-be, followed until release.
  const [guideDraft, setGuideDraft] = useState<{ axis: GuideAxis; x: number; y: number } | null>(
    null,
  );
  const guideDraftTeardown = useRef<(() => void) | null>(null);
  useEffect(() => () => guideDraftTeardown.current?.(), []);
  const onAddGuideRef = useRef(props.onAddGuide);
  onAddGuideRef.current = props.onAddGuide;
  const viewPagesRef = useRef(viewPages);
  viewPagesRef.current = viewPages;

  /** Press on a ruler → drag onto the page → a guide.
   *
   * Pointer events with WINDOW-level listeners, the canvas invariant: HTML5
   * DnD cannot complete in this webview, and the release routinely lands on a
   * different element than the press. */
  const handleRulerDown = (axis: GuideAxis, e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    if (!el) return;
    const host = el.getBoundingClientRect();
    let last = { x: e.clientX, y: e.clientY };
    setGuideDraft({ axis, x: last.x - host.left, y: last.y - host.top });
    const onMove = (ev: PointerEvent): void => {
      last = { x: ev.clientX, y: ev.clientY };
      setGuideDraft({ axis, x: last.x - host.left, y: last.y - host.top });
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      guideDraftTeardown.current = null;
      setGuideDraft(null);
      if (!commit) return;
      // Which page did it land on? Ask the DOM rather than inverting the
      // layout: the answer has to agree with what the user saw under the
      // pointer, and elementFromPoint is that answer by definition.
      const target = document.elementFromPoint(last.x, last.y) as HTMLElement | null;
      const cell = target?.closest('[data-page-id]') as HTMLElement | null;
      const pageId = cell?.getAttribute('data-page-id');
      if (!cell || !pageId) return; // released off the paper — nothing placed
      const r = cell.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const pos = axis === 'x' ? (last.x - r.left) / r.width : (last.y - r.top) / r.height;
      if (pos < 0 || pos > 1) return;
      const page = viewPagesRef.current.find((p) => p.id === pageId);
      if (!page) return;
      onAddGuideRef.current(pageId, axis, pos, page.rotation);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    guideDraftTeardown.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
  };

  // Rows are computed inline each render (PageCell is memo'd, so unchanged
  // cells skip re-render; the per-page overlay maps come pre-grouped from WCV).
  const rows: React.JSX.Element[] = [];
  const innerGap = PAGE_GAP * zoom; // between facing pages of a spread
  for (let r = first; r <= last; r++) {
    const rowPageIdxs = pagesInRow(r, pageLayout, twoUpCover, viewPages.length);
    if (rowPageIdxs.length === 0) continue;
    // MUST be the same widths PageCell renders (exact aspect — `textLayer` is
    // set below). This row is what CENTRES its content, so a divergent formula
    // offsets it in the pane and over-reports the scrollable width — the
    // same drift, relocated one level up (regression). Two-up: the row
    // width is both cells + the inner gap; cells sit flex-side-by-side inside.
    const width =
      rowPageIdxs.reduce((acc, i) => acc + displayWidthAt(viewPages[i], pageHeight), 0) +
      innerGap * (rowPageIdxs.length - 1);
    const cells = rowPageIdxs.map((i) => {
      const page = viewPages[i];
      return (
        <PageCell
          key={page.id}
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
          shapeType={props.shapeType}
          measureScale={props.measureScale}
          measureLeaveMarkup={props.measureLeaveMarkup}
          onMeasureResult={props.onMeasureResult}
          redactionMarks={props.redactionMarksByPage.get(page.id)}
          fieldCandidates={props.fieldCandidatesByPage.get(page.id)}
          tableRegions={props.tableRegionsByPage.get(page.id)}
          tableReview={props.tableReview}
          selectedCandidateId={props.selectedCandidateId}
          onSelectCandidate={props.onSelectCandidate}
          onRemoveCandidate={props.onRemoveCandidate}
          onMoveCandidate={props.onMoveCandidate}
          editImages={props.editImagesByPage.get(page.id)}
          editVectors={props.editVectorsByPage.get(page.id)}
          snapGeometry={props.snapGeomByPage.get(page.id)}
          snapSettings={props.snapSettings}
          guides={props.guidesByPage.get(page.id)}
          onMoveGuide={props.onMoveGuide}
          onRemoveGuide={props.onRemoveGuide}
          selectedVectorIndex={
            props.selectedVector?.pageId === page.id ? props.selectedVector.index : null
          }
          editImageTransform={
            props.editImageTransform?.pageId === page.id ? props.editImageTransform : null
          }
          onCommitImageTransform={props.onCommitImageTransform}
          editImageGroup={
            props.editImageGroup?.pageId === page.id ? props.editImageGroup : null
          }
          onCommitImageGroupTransform={props.onCommitImageGroupTransform}
          vectorTransform={
            props.vectorTransform?.pageId === page.id ? props.vectorTransform : null
          }
          onCommitVectorTransform={props.onCommitVectorTransform}
          imageCropArmed={props.imageCropArmed}
          onCommitImageCrop={props.onCommitImageCrop}
          onCommitImageMask={props.onCommitImageMask}
          editTextRuns={props.editTextByPage.get(page.id)?.runBoxes}
          editParagraphs={props.editTextByPage.get(page.id)?.paragraphs}
          editSelectedIndexes={
            props.editSelection?.kind === 'image' && props.editSelection.pageId === page.id
              ? props.editSelection.indexes
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
          onRestyleVector={props.onRestyleVector}
          onSelectEditText={props.onSelectEditText}
          onOpenTextEditor={props.onOpenTextEditor}
          onCommitTextEdit={props.onCommitTextEdit}
          onRestyleTextEdit={props.onRestyleTextEdit}
          onCancelTextEdit={props.onCancelTextEdit}
          onSelectEditParagraph={props.onSelectEditParagraph}
          onOpenParagraphEditor={props.onOpenParagraphEditor}
          onCommitParagraphEdit={props.onCommitParagraphEdit}
          onCancelParagraphEdit={props.onCancelParagraphEdit}
          onMergeParagraphPrev={props.onMergeParagraphPrev}
          onMergeParagraphNext={props.onMergeParagraphNext}
          signaturePlacement={props.signaturePlacement?.pageId === page.id ? props.signaturePlacement : null}
          findMatch={props.findMatchPageIds.has(page.id)}
          findWords={props.findWordsByPage.get(page.id)}
          formWidgets={props.formWidgetsByPage.get(page.id)}
          formValues={props.formValuesByPath.get(page.sourceDocId)}
          onSetFormValue={props.onSetFormValue}
          onSignFieldRequest={props.onSignFieldRequest}
          onFormButton={props.onFormButton}
          newFieldPlacement={props.newFieldPlacement?.pageId === page.id ? props.newFieldPlacement : null}
          onSetNewFieldRect={props.onSetNewFieldRect}
          onClearNewFieldPlacement={props.onClearNewFieldPlacement}
          addTextPlacement={props.addTextPlacement?.pageId === page.id ? props.addTextPlacement : null}
          cropPlacement={props.cropPlacement?.pageId === page.id ? props.cropPlacement : null}
          onClearCropPlacement={props.onClearCropPlacement}
          onSetAddTextRect={props.onSetAddTextRect}
          onSetCropRect={props.onSetCropRect}
          onAddImageRect={props.onAddImageRect}
          onClearAddTextPlacement={props.onClearAddTextPlacement}
          onPageContextMenu={props.onPageContextMenu}
          onPagePointerDown={NO_PAGE_POINTER}
          textLayer
          onAddAnnotation={props.onAddAnnotation}
          onUpdateAnnotation={props.onUpdateAnnotation}
          onRecolorAnnotation={props.onRecolorAnnotation}
          onRemoveAnnotation={props.onRemoveAnnotation}
          selectedAnnotationIds={props.selectedAnnotationIds}
          onSelectAnnotation={props.onSelectAnnotation}
          onTransformAnnotations={props.onTransformAnnotations}
          onCalibrate={props.onCalibrate}
          onMeasureContextMenu={props.onMeasureContextMenu}
          onMarqueeSelect={props.onMarqueeSelect}
          onRegroupCountMarks={props.onRegroupCountMarks}
          onZoomToRect={(pid, r) => {
            const z = zoomToPageRect(pid, r);
            if (z != null) props.onMarqueeZoomApplied?.(z);
          }}
          onAddRedactionMark={props.onAddRedactionMark}
          onRemoveRedactionMark={props.onRemoveRedactionMark}
          onSetSignaturePlacement={props.onSetSignaturePlacement}
          onClearSignaturePlacement={props.onClearSignaturePlacement}
        />
      );
    });
    rows.push(
      <div
        key={`row-${viewPages[rowPageIdxs[0]].id}`}
        className="docview-row"
        style={{
          position: 'absolute',
          // Rows sit at their virtual offset, corrected by the window's
          // slide (scrollTop − virtualTop). Under the cap the correction is
          // EXACTLY 0 (k = 1), so this is the shipped `r * rowH` bit-for-bit;
          // past it, the rendered window rides with the real scroll position
          // while the virtual offset slides the document under it.
          top: r * rowH - (virtualTop - scrollTop),
          height: pageHeight,
          width,
          left: '50%',
          marginLeft: -width / 2,
          display: 'flex',
          // Reversing the ROW reverses which side of a spread the leading
          // page takes without touching the row math: `pagesInRow` still
          // answers reading order and the row's total width is unchanged, so
          // the vertical virtualizer is untouched. The one HORIZONTAL
          // consumer (the marquee zoom's scroll-left) reads the same
          // direction and walks the row the matching way.
          flexDirection: spreadDirection === 'r2l' ? 'row-reverse' : 'row',
          alignItems: 'flex-start',
          gap: innerGap,
        }}
      >
        {cells}
      </div>,
    );
  }

  return (
    // The ruler frame. With rulers OFF it is `display: contents`, so the
    // scroller stays a direct child of the pane's flex column and the layout
    // is bit-for-bit what shipped — the reading view's geometry is not
    // something a drafting aid gets to perturb. With rulers ON it becomes a
    // grid whose first row/column are the rulers.
    <div
      className={'docview-frame' + (showRulers ? ' with-rulers' : '')}
      style={{ ['--ruler-size' as string]: `${RULER_PX}px` } as React.CSSProperties}
      onPointerMove={
        showRulers
          ? (e) => {
              const el = scrollRef.current;
              if (!el) return;
              const host = el.getBoundingClientRect();
              setRulerCursor({ x: e.clientX - host.left, y: e.clientY - host.top });
            }
          : undefined
      }
      onPointerLeave={showRulers ? () => setRulerCursor(null) : undefined}
    >
      {showRulers && (
        <>
          <div className="docview-ruler-corner" aria-hidden="true">
            {/* Notation, identical in every locale (the measure-unit rule). */}
            {rulerUnit}
          </div>
          <div
            className="docview-ruler docview-ruler-h"
            data-testid="ruler-h"
            role="presentation"
            aria-label={tChrome('canvas.rulers.horizontal')}
            title={tChrome('canvas.rulers.dragHint')}
            onPointerDown={(e) => handleRulerDown('y', e)}
          >
            {hTicks.map((t) => (
              <div
                key={`h${t.pos}`}
                className={'ruler-tick' + (t.major ? ' major' : '')}
                style={{ left: t.pos }}
              >
                {t.major && <span className="ruler-label">{tNumber(t.value)}</span>}
              </div>
            ))}
            {rulerCursor && (
              <div className="ruler-cursor" data-testid="ruler-cursor-h" style={{ left: rulerCursor.x }} />
            )}
          </div>
          <div
            className="docview-ruler docview-ruler-v"
            data-testid="ruler-v"
            role="presentation"
            aria-label={tChrome('canvas.rulers.vertical')}
            title={tChrome('canvas.rulers.dragHint')}
            onPointerDown={(e) => handleRulerDown('x', e)}
          >
            {vTicks.map((t) => (
              <div
                key={`v${t.pos}`}
                className={'ruler-tick' + (t.major ? ' major' : '')}
                style={{ top: t.pos }}
              >
                {t.major && <span className="ruler-label">{tNumber(t.value)}</span>}
              </div>
            ))}
            {rulerCursor && (
              <div className="ruler-cursor" data-testid="ruler-cursor-v" style={{ top: rulerCursor.y }} />
            )}
          </div>
        </>
      )}
      <div
        ref={scrollRef}
        className="docview-scroll"
        data-testid="document-view"
        tabIndex={0}
        onScroll={onScroll}
        style={props.tool === 'hand' ? { cursor: 'grab' } : undefined}
        // Hand: drag-scroll the reading pane. CAPTURE phase, so the
        // press never reaches a page cell — hand must not select, band, or
        // start an edit; it only holds the paper.
        onPointerDownCapture={props.tool === 'hand' ? handleHandDown : undefined}
      >
        <div
          className="docview-spacer"
          style={{ height: smap.spacerHeight, width: contentWidth, position: 'relative' }}
        >
          {rows}
        </div>
        <TextSelectionMenu
          scrollerRef={scrollRef}
          docId={doc.id}
          active={props.tool === 'select'}
          viewRotation={viewRotation}
          annotationColor={props.annotationColor}
          onAddAnnotation={props.onAddAnnotation}
          onCreateLinks={props.onCreateLinks}
        />
      </div>
      {/* The guide being dragged off a ruler, drawn across the pane so it is
          visible before it lands on a page. A FRAME child, not a scroller
          child: the scroller scrolls, and a preview that scrolled away from
          the pointer would be worse than none. Its coordinates are
          scroller-relative, so they carry the ruler's own offset. */}
      {guideDraft && (
        <div
          className={'docview-guide-draft ' + (guideDraft.axis === 'x' ? 'axis-x' : 'axis-y')}
          data-testid="guide-draft"
          style={
            guideDraft.axis === 'x'
              ? { left: guideDraft.x + RULER_PX }
              : { top: guideDraft.y + RULER_PX }
          }
        />
      )}
    </div>
  );
});
