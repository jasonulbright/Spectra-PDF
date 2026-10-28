import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, PageAnnotation, PageRef } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { FieldCandidate } from '../../lib/form-candidates';
import type { TableRegion, TableReviewHandlers } from '../../lib/table-review';
import type { A11yFinding, A11yFindingHandlers } from '../../lib/a11y-findings';
import type { AnnotationTransform } from '../../lib/annotation-manipulation';
import type { EditImagePlacement, EditImageTransformCtx } from '../../lib/edit-images';
import type { EditVectorObject } from '../../lib/edit-vectors';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import type { SignaturePlacement } from '../../lib/signature-placement';
import { groupLinksByPage, type LinkRegion } from '../../lib/links';
import type { SnapshotPlacement } from '../../lib/snapshot-capture';
import type { OcrWord } from '../../ocr/types';
import type { PageReadAloud } from '../../lib/read-aloud';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue, FormValuePhase } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import type { ShapeType, SpreadDirection } from '../../state/types';
import type { MeasureScale } from '../../lib/measure';
import type { CanvasHandle, LinkedZoom } from '../../canvas/canvas-handle';
import { displayWidthAt } from '../../canvas/layout';
import { isEditable } from '../../commands/keymap';
import { pushEscapeInterceptor } from '../../commands/context';
import {
  actualSizeZoom,
  clampReadingZoom,
  readingZoomRange,
  realTopFor,
  renderableMaxZoom,
  scrollMapFor,
  virtualTopOf,
  visibleRange,
  READING_BASE_HEIGHT,
  ZOOM_SETTLE_MS,
  ZOOM_STEP,
  type JumpAnchor,
} from '../../canvas/reading-page';
import {
  anchoredScroll,
  fitAvailable,
  fitZoom,
  gridGeometry,
  hitTest,
  fitAvailableHeight,
  pagedRowAt,
  pagedTarget,
  pageInView,
  pageRect,
  OVERFLOW_EPS,
  jumpTop,
  pagesInRowOf,
  rowOfPage as gridRowOfPage,
  steppedZoom,

  viewportCentre,


  wheelDeltaPx,
  wheelStep,
  widestOf,
  zoomForColumns,
  type FitBasis,
  type GridGeometry,
  type GridInput,
  type LinkedGeometry,
  type PageHit,
  type WheelStepState,
} from '../../canvas/reading-layout';
import { wheelZoomFactor } from '../../canvas/zoom-constants';
import {
  initialReadingViewFor,
  publishReadingView,
  subscribeReadingViewSeed,
  takeReadingViewSeed,
} from '../../lib/reading-view-store';
import type {
  LayoutMode,
  ReadingPaneId,
  ReadingViewSeed,
  ReadingViewSnapshot,
  ScrollMode,
  ZoomMode,
} from '../../lib/reading-view-types';
import { PageCell } from './PageCell';
import { TextSelectionMenu } from './TextSelectionMenu';
import type { PageQuads } from '../../lib/text-selection-markup';
import type { GuideAxis, PageGuide } from '../../lib/guides';
import { rulerTicks, type RulerTick } from '../../lib/rulers';
import { DEFAULT_MEASURE_SCALE, measureUnitsPerPoint } from '../../lib/measure';
import { tChrome, tNumber } from '../../i18n';
import { pointerScope } from '../../lib/pointer-scope';

// The reading view: one document laid out in rows of the SAME PageCells the
// board uses (the reuse seam) — one page per row, or a responsive grid whose
// column count follows the pane width — by a plain scroller with a scalar
// zoom instead of the d3 world transform. Every tool works here because the
// cells are identical; the d3 camera and page-reorder drag stay
// Organize-view-only. Virtualized: only rows within the viewport (± overscan)
// are mounted, so a 1,000-page doc is a handful of live cells. Zoom drives
// `pageHeight` (PageCell sizes the whole cell — raster, overlays, font — off
// it), so the reading `CanvasHandle` is pure scroll + a scale number, no
// world matrix. All geometry is the pure `canvas/reading-layout.ts`.

const OVERSCAN = 2; // rows rendered beyond each viewport edge
// ZOOM_STEP and the zoom range (`clampReadingZoom`: the percent bounds of a
// reference page, capped by renderability) live in canvas/reading-page.ts,
// tested there. Every stored zoom enters through `clampReadingZoom`.

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
  /** Which split pane this view is; the reading-view store keys its live
   * view by (path, pane). */
  paneId: ReadingPaneId;
  /** 0-based position of `doc` among its file's documents (.pdfx
   * partitions); 0 otherwise. */
  docIndex: number;
  /** Author link regions over a text selection (reading view only). */
  onCreateLinks?: (selection: PageQuads[], url: string) => Promise<void>;
  /** Reading order across a row, from the open document's
   * /ViewerPreferences /Direction: right-to-left mirrors the grid's column
   * order. A single-page column has no facing order, so it is inert there. */
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
  a11yFindingsByPage: ReadonlyMap<string, A11yFinding[]>;
  a11yFindings?: A11yFindingHandlers;
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
  onCheckSpelling: (text: string) => Promise<Array<{ start: number; end: number }>>;
  spellLang: string | undefined;
  onCancelParagraphEdit: () => void;
  onMergeParagraphPrev: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  onMergeParagraphNext: (pageId: string, index: number, editedText?: string, restyle?: import('../../lib/edit-paragraphs').MergeRestyle) => void;
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  readAloudByPage: ReadonlyMap<string, PageReadAloud>;
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (
    path: string,
    fieldName: string,
    value: FormFieldValue,
    phase?: FormValuePhase,
    previous?: string,
  ) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  onWidgetAction: (
    path: string,
    fieldName: string,
    action: import('../../lib/field-actions').WidgetAction | null,
  ) => void;
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
  onSetCropRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** An article bead band; the Articles panel appends it. */
  onSetBeadRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** A snapshot band; the region is captured to the clipboard. REQUIRED for
   * the crop band's reason — an optional callback silently unwires a tool
   * in whichever render path forgets to pass it. */
  onSetSnapshotRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** A link band; the rect reaches the Links panel, which owns Create.
   * REQUIRED for the crop band's reason — an optional callback silently
   * unwires a tool in whichever render path forgets to pass it. */
  onSetLinkRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  /** The file's existing links, projected onto the canvas, and the pick that
   * opens one in the panel (Links tool) or follows it (Select tool). */
  linkRegions: readonly LinkRegion[];
  /** View-tier scanned-page recognition for the Select tool; null when the
   *  preference is off. Reading view only — the board has no text layer. */
  ocrSelection?: import('./PageTextLayer').OcrSelectionContext | null;
  onPickLink: (region: LinkRegion) => void;
  /** True when a press on a region FOLLOWS the link (reading, Select tool)
   * rather than picking it for the Links tool's editor. */
  linkFollow?: boolean;
  selectedLink: LinkRegion | null;
  /** The captured snapshot's card, and its two actions. */
  snapshotPlacement: SnapshotPlacement | null;
  onClearSnapshotPlacement: () => void;
  onSaveSnapshot: () => void;
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
  // Click-selection for the properties bar. null clears.
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
  /** Quad split only: every zoom this pane applies, for the split layer to
   * hand to the sibling panes (`CanvasHandle.followZoom`). */
  onZoomLinked?: (zoom: LinkedZoom) => void;
  /** Quad split only: the geometry the four panes share, so the mirrored
   * scroll offsets name the same document point (see `linkQuadGeometry`). */
  linkedGeometry?: LinkedGeometry;
  /** Quad split only: this pane's own measurement, from which the split
   * layer derives `linkedGeometry`. */
  onFitBasis?: (basis: FitBasis) => void;
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

/** A page at its EFFECTIVE rotation: its own pending turn plus Rotate View. */
function effectivePage(p: PageRef, viewRotation: 0 | 90 | 180 | 270): PageRef {
  if (viewRotation === 0) return p;
  return { ...p, rotation: ((((p.rotation + viewRotation) % 360) + 360) % 360) as 0 | 90 | 180 | 270 };
}

/** The view's internal zoom for a stored mode: `custom` and `actual` are
 * percentages of the reference page's actual size; the fits resolve at
 * render and need no stored value. */
function storedZoomFor(mode: ZoomMode, percent: number, refPage: PageRef | undefined): number {
  if (!refPage) return 1;
  const actual = actualSizeZoom(refPage, READING_BASE_HEIGHT);
  if (mode === 'actual') return actual;
  if (mode === 'custom' && Number.isFinite(percent) && percent > 0) {
    return clampReadingZoom((actual * percent) / 100, refPage);
  }
  return 1;
}

/** Percent of actual size of `page` at internal zoom `z`, to 0.01. */
function percentFor(z: number, page: PageRef | undefined): number {
  if (!page) return 100;
  const actual = actualSizeZoom(page, READING_BASE_HEIGHT);
  return actual > 0 ? Math.round((z / actual) * 10_000) / 100 : 100;
}

function isFitMode(mode: ZoomMode): mode is 'fitPage' | 'fitWidth' | 'fitHeight' {
  return mode === 'fitPage' || mode === 'fitWidth' || mode === 'fitHeight';
}

/** A scroll position the next layout must establish. `gAt` is the geometry
 * the request was made against: when the next render still has that
 * geometry, the request changed nothing and is dropped, its horizontal
 * centring with it, so it can never fire late against a later scroll.
 * `null` applies at the first measured layout. Every request forces that
 * next render, so a request whose state write was a no-op is still consumed
 * at once. */
type PendingView =
  | {
      kind: 'anchor';
      /** The page points kept under `pointer` on each axis. They differ only
       * for a quad pane following a sibling's zoom (`followZoom`). */
      hitX: PageHit;
      hitY: PageHit;
      pointer: { x: number; y: number };
      zTarget: number;
      gAt: GridGeometry | null;
      hCenter: boolean;
    }
  | { kind: 'page'; index: number; gAt: GridGeometry | null; hCenter: boolean };

/** Wheel-step and line-scroll distances for paged keys (CSS px). */
const PAGED_LINE_PX = 40;
const PAGED_PAGE_FRACTION = 0.9;

export const DocumentView = forwardRef<CanvasHandle, DocumentViewProps>(function DocumentView(
  props,
  ref,
): React.JSX.Element {
  const {
    doc,
    proxies,
    viewRotation = 0,
    spreadDirection = 'l2r',
    paneId,
    docIndex,
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  // The pane's height without a horizontal scrollbar, and the scrollbar's
  // thickness: the fits solve against these, so their answer does not depend
  // on the scrollbar their own result shows or hides.
  const [frame, setFrame] = useState({ fullH: 0, bar: 0 });

  // The view this pane opens with — its own live snapshot, a sibling's, the
  // saved record or the defaults — resolved ONCE per mount.
  const [opening] = useState(() =>
    initialReadingViewFor(doc.path, paneId, docIndex, doc.pages.length),
  );
  const [zoomMode, setZoomModeState] = useState<ZoomMode>(opening.state.zoomMode);
  // The internal zoom for `custom` and `actual`. The fit modes resolve every
  // render from the viewport (sticky) and ignore it, except before the pane is
  // measured.
  const [zStored, setZStored] = useState(() =>
    storedZoomFor(
      opening.state.zoomMode,
      opening.state.zoomPercent,
      doc.pages[opening.state.page - 1]
        ? effectivePage(doc.pages[opening.state.page - 1], viewRotation)
        : undefined,
    ),
  );
  const [layoutMode, setLayoutModeState] = useState<LayoutMode>(opening.state.layoutMode);
  const [coverAlone, setCoverAloneState] = useState(opening.state.coverAlone);
  const [scrollMode, setScrollModeState] = useState<ScrollMode>(opening.state.scrollMode);
  const [page, setPage] = useState(opening.state.page);
  const [, forceLayout] = useReducer((n: number) => n + 1, 0);

  // Rotate View: every DISPLAY read in this component sees the page at
  // its EFFECTIVE rotation — (page.rotation + viewRotation), composed once
  // here. The page-tier `doc.pages` stays what commits; only what renders and
  // captures turns. Sizing MUST read these too (the row wrapper, the widest
  // page, both zoom presets): a 90° page whose cell swapped aspect under an
  // unswapped row clips and mis-centers.
  const viewPages = useMemo(
    () => (viewRotation === 0 ? doc.pages : doc.pages.map((p) => effectivePage(p, viewRotation))),
    [doc.pages, viewRotation],
  );

  const pageCount = doc.pages.length;
  // Each page's width at zoom 1 and the widest of them — properties of the
  // document, so memoised on the page list. The widest page is the fit basis
  // (a sticky fit never changes while scrolling and no page overflows Fit
  // Width), the grid's column width, and the width-axis bound of the zoom
  // range (the spacer's width can blow the element cap just as its height can).
  const pageWidthsAt1 = useMemo(
    () => viewPages.map((p) => displayWidthAt(p, READING_BASE_HEIGHT)),
    [viewPages],
  );
  const widestW1 = useMemo(() => widestOf(pageWidthsAt1), [pageWidthsAt1]);

  // The EFFECTIVE zoom, re-derived every render — the document's page count is
  // half of what makes a zoom valid (see maxZoomFor), and it changes UNDER a
  // stable zoom: an Undo/Import/merge grows the doc without remounting this view
  // (`OpenDocument.id` survives page-tier edits, and the view is keyed on it), so
  // clamping only where zoom is WRITTEN left the existing zoom stale and the
  // spacer over the browser's element cap with no zoom press at all — and the
  // next Ctrl+= then visibly zoomed OUT. Deriving makes "the zoom is renderable"
  // true by construction rather than something every writer must remember; it
  // also covers the initial state, which no write site ever sees.
  const { availW } = fitAvailable(viewportW, viewportH);
  const availH = fitAvailableHeight(frame.fullH, viewportW, widestW1, frame.bar);
  // A quad pane solves against the geometry the four panes share.
  const linked = props.linkedGeometry;
  const fitW = linked ? linked.availW : availW;
  const fitH = linked ? linked.availH : availH;
  const fitted = isFitMode(zoomMode) ? fitZoom(zoomMode, fitW, fitH, widestW1) : 0;
  // The stored zoom was bounded to the percent range at its entry point; only
  // the renderability cap is re-derived here (the widest page can change).
  const zoom = fitted > 0 ? fitted : Math.min(zStored, renderableMaxZoom(widestW1));
  const linkedAvailW = linked?.availW;
  const linkedSlotH = linked?.slotViewportH;

  const onFitBasisRef = useRef(props.onFitBasis);
  onFitBasisRef.current = props.onFitBasis;
  const fitBasisRef = useRef<FitBasis | null>(null);
  useLayoutEffect(() => {
    const report = onFitBasisRef.current;
    if (!report || viewportW <= 0 || viewportH <= 0) return;
    const prev = fitBasisRef.current;
    if (prev && prev.availW === availW && prev.availH === availH && prev.viewportH === viewportH) return;
    const basis = { availW, availH, viewportH };
    fitBasisRef.current = basis;
    report(basis);
  });

  const gridInput = useMemo<GridInput>(
    () => ({
      pageWidthsAt1,
      zoom,
      layoutMode,
      coverAlone,
      direction: spreadDirection,
      scrollMode,
      viewportW,
      viewportH,
      linked:
        linkedAvailW !== undefined && linkedSlotH !== undefined
          ? { availW: linkedAvailW, slotViewportH: linkedSlotH }
          : undefined,
    }),
    [
      pageWidthsAt1,
      zoom,
      layoutMode,
      coverAlone,
      spreadDirection,
      scrollMode,
      viewportW,
      viewportH,
      linkedAvailW,
      linkedSlotH,
    ],
  );
  const g = useMemo(() => gridGeometry(gridInput), [gridInput]);
  const pageHeight = g.pageH;
  const rowCount = g.rowCount;
  // A row's vertical pitch: the row itself when continuous, at least one
  // viewport when paged. Every row-space consumer (virtualizer, current page,
  // jump anchor) reads slots, so paged scrolling needs no second code path.
  const slotH = g.slotH;

  // PageView's detail raster captures only the part visible when it runs.
  // Coalesce every geometry change and scroll burst into one final render so
  // zooms, pans, resizes and layout changes all sharpen at the settled view.
  const [detailVersion, setDetailVersion] = useState(0);
  const detailSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDetailRender = useCallback(() => {
    if (detailSettleTimerRef.current !== null) clearTimeout(detailSettleTimerRef.current);
    detailSettleTimerRef.current = setTimeout(() => {
      detailSettleTimerRef.current = null;
      setDetailVersion((v) => v + 1);
    }, ZOOM_SETTLE_MS);
  }, []);
  useEffect(() => {
    scheduleDetailRender();
    return () => {
      if (detailSettleTimerRef.current !== null) {
        clearTimeout(detailSettleTimerRef.current);
        detailSettleTimerRef.current = null;
      }
    };
  }, [g, scheduleDetailRender]);

  const contentHeight = g.contentH;
  // The scaled-spacer scroll map. The DOM spacer caps at
  // SAFE_ELEMENT_EXTENT and rows translate under it; every document-space
  // consumer below reads VIRTUAL offsets, and only the DOM write/read
  // converts. k === 1 (any doc under the cap) is the bit-for-bit identity.
  // Paged slots inflate the extent, so the map must see the slotted height.
  const smap = useMemo(() => scrollMapFor(contentHeight, viewportH), [contentHeight, viewportH]);
  const virtualTop = virtualTopOf(scrollTop, smap);

  // Track the scroll position + the viewport box (drives virtualization, the
  // fits, the column count and the current-page report). WIDTH is observed
  // too: a side panel opening narrows the pane without changing its height,
  // and the fits and the grid must re-resolve. `scrollbar-gutter: stable` on
  // the scroller keeps clientWidth independent of overflow, so a fit that
  // adds a scrollbar cannot shrink its own basis and oscillate.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      setViewportH(el.clientHeight);
      setViewportW(el.clientWidth);
      // `scrollbar-gutter: stable` keeps the vertical gutter, so its width is
      // the scrollbar thickness at all times; the horizontal scrollbar is
      // whatever the box loses below clientHeight.
      const bar = Math.max(0, el.offsetWidth - el.clientWidth - 2 * el.clientLeft);
      const hBar = Math.max(0, el.offsetHeight - el.clientHeight - 2 * el.clientTop);
      const fullH = el.clientHeight + hBar;
      setFrame((f) => (f.fullH === fullH && f.bar === bar ? f : { fullH, bar }));
    };
    measure();
    const ro = new ResizeObserver(measure);
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

  // Imperative paths (the handle, the native wheel listener, the paged keys)
  // read the LAST RENDERED geometry through refs, so their identity is stable.
  const geomRef = useRef(g);
  geomRef.current = g;
  const inputRef = useRef(gridInput);
  inputRef.current = gridInput;
  const smapRef = useRef(smap);
  smapRef.current = smap;
  const viewportHRef = useRef(viewportH);
  viewportHRef.current = viewportH;
  // The scroll position as of the last scroll event or programmatic write, in
  // (real left, VIRTUAL top) — what an implicit re-anchor measures against.
  const posRef = useRef({ left: 0, virtualTop: 0 });

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    posRef.current = { left: el.scrollLeft, virtualTop: virtualTopOf(el.scrollTop, smapRef.current) };
    setScrollTop(el.scrollTop);
    scheduleDetailRender();
  }, [scheduleDetailRender]);

  // Visible page range [first, last], padded by OVERSCAN — pure + tested
  // (canvas/reading-page.ts), because an unclamped `first` could exceed `last`
  // after a page-tier delete and the row loop would emit no cells at all.
  // visibleRange/currentPageFor are pure ROW math — `pageCount` in their
  // metrics is the row count and `rowH` the slot pitch (single continuous
  // layout: rows == pages and slots == rows, so the shipped inputs are
  // bit-identical).
  const { first, last } = visibleRange(
    { scrollTop: virtualTop, viewportH, rowH: slotH, pageHeight, pageCount: rowCount, contentHeight },
    OVERSCAN,
  );

  // A jump's recorded intent — see JumpAnchor's header for why scroll position
  // alone cannot answer this at the extremes.
  const jumpAnchorRef = useRef<JumpAnchor | null>(null);
  // A page-layout switch remaps rows under a STATIONARY scrollTop — the slot
  // pitch and viewportH can both survive it, so anchorHolds' geometry checks
  // cannot see the change and a pre-switch anchor would keep reporting a page
  // the pane no longer shows (regression: jump to 5, switch two-up → the box
  // said "5" over pages 8-9, durably). Treat a layout change exactly like a
  // resize: drop the anchor. Render-time ref write, so it lands before the
  // reporter effect (whose deps include the layout) re-runs and lets the view
  // speak for itself.
  const layoutKey = `${layoutMode}:${coverAlone}:${g.columns}:${scrollMode}`;
  const prevLayoutKeyRef = useRef(layoutKey);
  if (prevLayoutKeyRef.current !== layoutKey) {
    prevLayoutKeyRef.current = layoutKey;
    jumpAnchorRef.current = null;
  }
  // The page the reader is on, mirrored for the zoom presets. Actual Size and
  // the percent setter act on the current page because pages in one file can
  // differ in size and rotation, and the presets are imperative-handle calls,
  // not renders, so they need it off a ref rather than through the parent.
  const currentPageRef = useRef(opening.state.page);

  // Report the current page. Debounced to a rAF-ish cadence by React's
  // batching; the parent dedupes.
  const onCurrentPageChange = props.onCurrentPageChange;
  const onCurrentPageChangeRef = useRef(onCurrentPageChange);
  onCurrentPageChangeRef.current = onCurrentPageChange;
  const reportPage = useCallback((p: number) => {
    currentPageRef.current = p;
    setPage(p);
    onCurrentPageChangeRef.current?.(p);
  }, []);
  useEffect(() => {
    if (pageCount === 0 || viewportH === 0) return;
    // A jump wins until the user scrolls away from where it landed; then the
    // anchor is dropped and the view speaks for itself. Both halves are pure
    // (`pageInView`; the tie-break and the extremes live in
    // canvas/reading-page.ts). Document math reads VIRTUAL offsets (identity
    // for docs under the element cap); anchors record virtual too.
    // `doc.pages` is the composition guard: a page-tier edit renumbers pages
    // without remounting this view, so the anchor must re-prove that the page
    // it meant still sits in that slot.
    const a = jumpAnchorRef.current;
    const res = pageInView(g, gridInput, virtualTop, a, a ? doc.pages[a.page - 1]?.id : null);
    if (!res.anchored) jumpAnchorRef.current = null;
    reportPage(res.page);
  }, [scrollTop, virtualTop, pageCount, g, gridInput, viewportH, doc.pages, reportPage]);

  // Lands a page's row in view: a paged row at its slot, a continuous row
  // centred when shorter than the pane, else top-aligned. Records the jump's
  // intent (see JumpAnchor) and reports immediately — a jump that doesn't
  // move the view fires no scroll event, so the reporter would never re-run.
  const jumpToIndex = useCallback(
    (idx: number) => {
      const el = scrollRef.current;
      const pages = doc.pages;
      if (!el || idx < 0 || idx >= pages.length) return;
      const geo = geomRef.current;
      const inp = inputRef.current;
      const map = smapRef.current;
      // The target is VIRTUAL; the DOM write converts (identity for docs under
      // the element cap).
      const top = jumpTop(geo, inp, idx, el.clientHeight);
      el.scrollTo({ top: realTopFor(top, map), behavior: 'auto' });
      // Record where it actually LANDED (behavior:'auto' settles scrollTop
      // synchronously, so this is the browser's own clamp applied) together with
      // what it meant, so the scroll event this fires can't "correct" a jump to
      // a boundary-adjacent page into the boundary page itself. `viewportH` is
      // the STATE the reporter compares against — not the live `el.clientHeight`
      // used for the offset above — so the two can never disagree and silently
      // stop the anchor from ever holding. Recorded VIRTUAL, the space
      // the reporter's metrics carry.
      jumpAnchorRef.current = {
        scrollTop: virtualTopOf(el.scrollTop, map),
        page: idx + 1,
        pageId: pages[idx].id,
        rowH: geo.slotH,
        viewportH: viewportHRef.current,
      };
      posRef.current = { left: el.scrollLeft, virtualTop: virtualTopOf(el.scrollTop, map) };
      reportPage(idx + 1);
    },
    [doc.pages, reportPage],
  );

  // A user act on this pane (a zoom, a mode, a wheel, a key, a press, a jump).
  // A document's own initial view applies only while this is false.
  const touchedRef = useRef(false);
  const markTouched = useCallback(() => {
    touchedRef.current = true;
  }, []);
  // A discrete command (a mode, a preset, a stepper) publishes in the commit
  // that applies it, so the controls reflecting the store never lag the pane.
  // Continuous input (wheel bursts, scrolling, re-fits on resize) keeps the
  // settle beat.
  const publishNowRef = useRef(false);
  const discrete = useCallback(() => {
    touchedRef.current = true;
    publishNowRef.current = true;
  }, []);
  // Requests the next measured layout settles; see PendingView.
  const pendingRef = useRef<PendingView | null>(
    opening.state.page > 1 ? { kind: 'page', index: opening.state.page - 1, gAt: null, hCenter: false } : null,
  );
  // Centre the current page horizontally at the first measured layout when
  // the content is wider than the pane, so an open or a restore never leaves
  // the horizontal position at 0. A mode change asks through its request.
  const hCenterRef = useRef(true);
  // A seeded two-column request waits for the first measured layout: the zoom
  // that yields N columns is a function of the pane width.
  const seedColumnsRef = useRef<number | null>(null);
  const prevGeomRef = useRef<{ g: GridGeometry; input: GridInput } | null>(null);

  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const centre = useCallback((): { x: number; y: number } => {
    const el = scrollRef.current;
    return el ? viewportCentre(el.clientWidth, el.clientHeight, linkedRef.current) : { x: 0, y: 0 };
  }, []);

  /** The page under a scroller-relative point, in the last rendered geometry. */
  const hitNow = useCallback((pointer: { x: number; y: number }): PageHit | null => {
    const el = scrollRef.current;
    if (!el) return null;
    return hitTest(
      geomRef.current,
      inputRef.current,
      el.scrollLeft + pointer.x,
      virtualTopOf(el.scrollTop, smapRef.current) + pointer.y,
    );
  }, []);

  // The page tier, the widest page and the effective zoom, for imperative
  // callers. The steppers must step from the EFFECTIVE zoom, not the raw
  // state: stepping from a state the derivation has already clamped down
  // would move the wrong way (or not at all).
  const pagesRef = useRef(viewPages);
  pagesRef.current = viewPages;
  const widestRef = useRef(widestW1);
  widestRef.current = widestW1;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const currentPage = useCallback((): PageRef | null => {
    const pages = pagesRef.current;
    return pages[Math.min(pages.length, Math.max(1, currentPageRef.current)) - 1] ?? null;
  }, []);

  /**
   * Zoom to `zTarget` (custom mode) keeping `hit` — by default the page point
   * under `pointer` — under `pointer`. A burst (several wheel events or key
   * repeats before the next render) continues from the pending target and
   * keeps the burst's original hit, which was measured in the geometry the
   * user actually saw.
   */
  // `z` arrives bounded to the percent range by the caller, which names the
  // reference page; the renderability cap applies here. In the quad every
  // zoom is handed on, so the four panes keep one zoom.
  const onZoomLinkedRef = useRef(props.onZoomLinked);
  onZoomLinkedRef.current = props.onZoomLinked;
  const zoomTo = useCallback(
    (
      z: number,
      pointer: { x: number; y: number },
      opts: { hit?: PageHit | null; mode?: 'custom' | 'actual'; hCenter?: boolean } = {},
    ) => {
      const z1 = Math.min(z, renderableMaxZoom(widestRef.current));
      const mode = opts.mode ?? 'custom';
      const hCenter = opts.hCenter ?? false;
      const pend = pendingRef.current;
      const burst = pend?.kind === 'anchor' && pend.gAt === geomRef.current ? pend : null;
      const hit = opts.hit !== undefined ? opts.hit : burst ? burst.hitX : hitNow(pointer);
      pendingRef.current = hit
        ? { kind: 'anchor', hitX: hit, hitY: hit, pointer, zTarget: z1, gAt: geomRef.current, hCenter }
        : null;
      setZStored(z1);
      setZoomModeState(mode);
      forceLayout();
      onZoomLinkedRef.current?.({ zoom: z1, mode, hit, pointer, hCenter });
    },
    [hitNow],
  );
  const zoomBy = useCallback(
    (factor: number, pointer: { x: number; y: number }) => {
      const pend = pendingRef.current;
      const base = pend?.kind === 'anchor' && pend.gAt === geomRef.current ? pend.zTarget : zoomRef.current;
      zoomTo(steppedZoom(base, factor, readingZoomRange(currentPage(), widestRef.current)), pointer);
    },
    [zoomTo, currentPage],
  );
  // The sibling half of the quad link. The zoom is the origin's, bounded
  // against the origin's reference page and not re-bounded against this
  // pane's, so the four panes stay equal; nothing is handed on.
  const followZoom = useCallback(
    (l: LinkedZoom, axes: { x: boolean; y: boolean }) => {
      touchedRef.current = true;
      const c = centre();
      const pointer = { x: axes.x ? l.pointer.x : c.x, y: axes.y ? l.pointer.y : c.y };
      const z1 = Math.min(l.zoom, renderableMaxZoom(widestRef.current));
      const pend = pendingRef.current;
      const burst = pend?.kind === 'anchor' && pend.gAt === geomRef.current ? pend : null;
      const own = burst ? null : hitNow(pointer);
      const hitX = axes.x ? l.hit : burst ? burst.hitX : own;
      const hitY = axes.y ? l.hit : burst ? burst.hitY : own;
      pendingRef.current =
        hitX && hitY
          ? { kind: 'anchor', hitX, hitY, pointer, zTarget: z1, gAt: geomRef.current, hCenter: l.hCenter }
          : null;
      setZStored(z1);
      setZoomModeState(l.mode);
      forceLayout();
    },
    [centre, hitNow],
  );

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

  /** Paged: settle on the slot that holds the viewport centre, unless the
   * viewport already lies wholly inside one (tall) slot. */
  const snapPaged = useCallback(() => {
    const el = scrollRef.current;
    const geo = geomRef.current;
    if (!el || inputRef.current.scrollMode !== 'paged' || geo.rowCount === 0) return;
    const map = smapRef.current;
    const vh = el.clientHeight;
    const vt = virtualTopOf(el.scrollTop, map);
    const r = pagedRowAt(geo, vt, vh);
    const slotTop = r * geo.slotH;
    const slotEnd = slotTop + Math.max(0, geo.slotH - vh);
    // One real pixel of slack, in virtual units.
    const eps = map.k;
    if (vt >= slotTop - eps && vt <= slotEnd + eps) return;
    const target = Math.min(slotEnd, Math.max(slotTop, vt));
    el.scrollTo({ top: realTopFor(target, map), behavior: 'auto' });
  }, []);
  const snapPagedRef = useRef(snapPaged);
  snapPagedRef.current = snapPaged;

  const handleHandDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    touchedRef.current = true;
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
      pointers.remove('pointermove', onMove);
      pointers.remove('pointerup', teardown);
      pointers.remove('pointercancel', teardown);
      pointers.remove('blur', teardown);
      popEscape();
      handDragTeardown.current = null;
      // Back to the steady-state grab — '' would also clear React's own
      // inline cursor until the next render (regression). The
      // tool-change effect above tears down BEFORE React re-renders the
      // style prop away, so 'grab' never outlives hand mode visibly.
      el.style.cursor = 'grab';
      // Paged snapping waits for the release: every move above fires its
      // own scrollend, and a snap mid-drag would yank the paper away.
      snapPagedRef.current();
    };
    handDragTeardown.current = teardown;
    const popEscape = pushEscapeInterceptor(() => {
      teardown();
      return true;
    });
    const pointers = pointerScope(e.pointerId);
    pointers.add('pointermove', onMove);
    pointers.add('pointerup', teardown);
    pointers.add('pointercancel', teardown);
    pointers.add('blur', teardown);
  }, []);

  // ── Paged stepping ────────────────────────────────────────────────────
  /** Move within a tall paged row first; at its edge (or for `step`) go to
   * the neighbouring row. Stepping back into a tall row lands on its end, so
   * reading backwards continues where the reader left it. */
  const pagedMove = useCallback(
    (dir: -1 | 1 | 'home' | 'end', within: 'step' | 'line' | 'page') => {
      const el = scrollRef.current;
      const geo = geomRef.current;
      if (!el || geo.rowCount === 0) return;
      const map = smapRef.current;
      const vh = el.clientHeight;
      const vt = virtualTopOf(el.scrollTop, map);
      const scrollBy = within === 'step' ? 0 : within === 'line' ? PAGED_LINE_PX : vh * PAGED_PAGE_FRACTION;
      const target = pagedTarget(geo, vt, vh, dir, scrollBy, map.k);
      if (target === null) return;
      el.scrollTo({ top: realTopFor(target, map), behavior: 'auto' });
    },
    [],
  );

  const wheelRef = useRef<WheelStepState>({ acc: 0, lockedUntil: 0 });
  const pagedWheel = useCallback(
    (dy: number, now: number) => {
      const el = scrollRef.current;
      const geo = geomRef.current;
      if (!el || geo.rowCount === 0) return;
      const map = smapRef.current;
      const vh = el.clientHeight;
      const vt = virtualTopOf(el.scrollTop, map);
      const r = pagedRowAt(geo, vt, vh);
      const slotTop = r * geo.slotH;
      const slotEnd = slotTop + Math.max(0, geo.slotH - vh);
      const eps = map.k;
      // A row taller than the viewport scrolls inside its slot first.
      if ((dy > 0 && vt < slotEnd - eps) || (dy < 0 && vt > slotTop + eps)) {
        const target = Math.min(slotEnd, Math.max(slotTop, vt + dy));
        el.scrollTop = realTopFor(target, map);
        wheelRef.current = { acc: 0, lockedUntil: wheelRef.current.lockedUntil, lastAt: now };
        return;
      }
      const res = wheelStep(wheelRef.current, dy, now);
      wheelRef.current = res.s;
      if (res.step !== 0) pagedMove(res.step, 'step');
    },
    [pagedMove],
  );

  // Native, NON-passive wheel listener: React's root wheel listener is
  // passive, so it cannot preventDefault. Ctrl/Meta+wheel zooms at the
  // pointer; Alt+wheel pans horizontally; Shift+wheel stays the native
  // horizontal scroll; a plain wheel is native when continuous and steps one
  // row when paged.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const vh = el.clientHeight;
      const dy = wheelDeltaPx(e.deltaY, e.deltaMode, vh);
      const dx = wheelDeltaPx(e.deltaX, e.deltaMode, vh);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        touchedRef.current = true;
        const box = el.getBoundingClientRect();
        const pointer = { x: e.clientX - box.left - el.clientLeft, y: e.clientY - box.top - el.clientTop };
        zoomBy(wheelZoomFactor(dy), pointer);
        return;
      }
      if (e.altKey) {
        e.preventDefault();
        touchedRef.current = true;
        el.scrollLeft += dy !== 0 ? dy : dx;
        return;
      }
      if (e.shiftKey || inputRef.current.scrollMode !== 'paged') return;
      e.preventDefault();
      touchedRef.current = true;
      if (dx !== 0) el.scrollLeft += dx;
      if (dy !== 0) pagedWheel(dy, e.timeStamp);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy, pagedWheel]);

  // Paged: a scrollbar drag, a programmatic jump or a quad-link mirror ends
  // between slots; settle on the slot under the viewport centre. Hand drags
  // snap at their release instead (see handleHandDown).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onEnd = (): void => {
      if (handDragTeardown.current) return;
      snapPaged();
    };
    el.addEventListener('scrollend', onEnd);
    return () => el.removeEventListener('scrollend', onEnd);
  }, [snapPaged]);

  // Paged keys on the scroller. Skipped for editable targets (PageDown in the
  // paragraph editor or a form widget must not turn the page), for chords,
  // and for the arrows while an annotation or edit selection owns them as
  // nudges. Space is not here: app-wide it is the temporary Hand.
  const selectionOwnsArrows =
    props.selectedAnnotationIds.length > 0 || props.editSelection !== null;
  const selectionOwnsArrowsRef = useRef(selectionOwnsArrows);
  selectionOwnsArrowsRef.current = selectionOwnsArrows;
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (inputRef.current.scrollMode !== 'paged') return;
      if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = scrollRef.current;
      if (!el) return;
      const arrowsFree = !selectionOwnsArrowsRef.current;
      const hOverflow = el.scrollWidth > el.clientWidth + 1;
      let dir: -1 | 1 | 'home' | 'end';
      let within: 'line' | 'page' = 'page';
      switch (e.key) {
        case 'PageDown':
          dir = 1;
          break;
        case 'PageUp':
          dir = -1;
          break;
        case 'ArrowDown':
          if (!arrowsFree) return;
          dir = 1;
          within = 'line';
          break;
        case 'ArrowUp':
          if (!arrowsFree) return;
          dir = -1;
          within = 'line';
          break;
        case 'ArrowRight':
          if (!arrowsFree || hOverflow) return;
          dir = 1;
          break;
        case 'ArrowLeft':
          if (!arrowsFree || hOverflow) return;
          dir = -1;
          break;
        case 'Home':
          dir = 'home';
          break;
        case 'End':
          dir = 'end';
          break;
        default:
          return;
      }
      e.preventDefault();
      touchedRef.current = true;
      pagedMove(dir, within);
    },
    [pagedMove],
  );

  // ── Mode setters ──────────────────────────────────────────────────────
  // A mode change keeps the reader's place: zoom modes anchor at the
  // viewport centre, layout and scroll modes re-land the current page.
  const setZoomMode = useCallback(
    (mode: ZoomMode) => {
      discrete();
      const pointer = centre();
      const hit = hitNow(pointer);
      if (mode === 'custom' || mode === 'actual') {
        // A stored zoom: through zoomTo, so the quad siblings follow it.
        let z = zoomRef.current;
        if (mode === 'actual') {
          const p = currentPage();
          if (!p) return;
          z = clampReadingZoom(actualSizeZoom(p, READING_BASE_HEIGHT), p, widestRef.current);
        }
        zoomTo(z, pointer, { hit, mode, hCenter: true });
        return;
      }
      pendingRef.current = hit
        ? { kind: 'anchor', hitX: hit, hitY: hit, pointer, zTarget: zoomRef.current, gAt: geomRef.current, hCenter: true }
        : null;
      setZoomModeState(mode);
      forceLayout();
    },
    [centre, hitNow, currentPage, discrete, zoomTo],
  );
  const relandCurrentPage = useCallback(() => {
    discrete();
    pendingRef.current = { kind: 'page', index: currentPageRef.current - 1, gAt: geomRef.current, hCenter: true };
    forceLayout();
  }, [discrete]);
  const setLayoutMode = useCallback(
    (mode: LayoutMode) => {
      relandCurrentPage();
      setLayoutModeState(mode);
    },
    [relandCurrentPage],
  );
  const setCoverAlone = useCallback(
    (on: boolean) => {
      relandCurrentPage();
      setCoverAloneState(on);
    },
    [relandCurrentPage],
  );
  const setScrollMode = useCallback(
    (mode: ScrollMode) => {
      relandCurrentPage();
      setScrollModeState(mode);
    },
    [relandCurrentPage],
  );

  const setZoomPercent = useCallback(
    (percent: number) => {
      const p = currentPage();
      if (!p || !Number.isFinite(percent) || percent <= 0) return;
      discrete();
      zoomTo(clampReadingZoom(actualSizeZoom(p, READING_BASE_HEIGHT) * (percent / 100), p, widestRef.current), centre());
    },
    [currentPage, zoomTo, centre, discrete],
  );

  // Marquee zoom: zoom so the banded page region fills the pane, with the
  // band's centre landing on the viewport centre — the cursor-anchored zoom
  // with the band centre as the hit, so it is grid-aware by construction.
  // Returns the applied zoom.
  const zoomToPageRect = useCallback(
    (pageId: string, rect: { x: number; y: number; w: number; h: number }): number | null => {
      const el = scrollRef.current;
      const idx = doc.pages.findIndex((p) => p.id === pageId);
      if (!el || idx < 0 || rect.w <= 0 || rect.h <= 0) return null;
      const z0 = zoomRef.current;
      const bandW = rect.w * (pagesRef.current[idx] ? displayWidthAt(pagesRef.current[idx], READING_BASE_HEIGHT) : 0) * z0;
      const bandH = rect.h * READING_BASE_HEIGHT * z0;
      if (bandW <= 0 || bandH <= 0) return null;
      discrete();
      const factor = Math.min(el.clientWidth / bandW, el.clientHeight / bandH);
      // The banded page is the reference: it is the page the zoom lands on.
      const z = clampReadingZoom(z0 * factor, pagesRef.current[idx], widestRef.current);
      zoomTo(z, centre(), { hit: { pageIndex: idx, u: rect.x + rect.w / 2, v: rect.y + rect.h / 2 } });
      return z;
    },
    [doc.pages, zoomTo, centre, discrete],
  );

  // The snapshot this pane publishes: the zoom as a percent of the CURRENT
  // page's actual size, and the resolved column count.
  const pathRef = useRef(doc.path);
  pathRef.current = doc.path;
  const docIndexRef = useRef(docIndex);
  docIndexRef.current = docIndex;
  const viewRef = useRef({ zoomMode, layoutMode, coverAlone, scrollMode, measured: false });
  viewRef.current = { zoomMode, layoutMode, coverAlone, scrollMode, measured: viewportW > 0 && viewportH > 0 };
  const snapshotNow = useCallback((): ReadingViewSnapshot => {
    const v = viewRef.current;
    const pages = pagesRef.current;
    const pg = Math.min(Math.max(1, pages.length), Math.max(1, currentPageRef.current));
    return {
      zoomMode: v.zoomMode,
      zoomPercent: percentFor(zoomRef.current, pages[pg - 1]),
      layoutMode: v.layoutMode,
      coverAlone: v.coverAlone,
      scrollMode: v.scrollMode,
      page: pg,
      columns: geomRef.current.columns,
      pageCount: pages.length,
      docIndex: docIndexRef.current,
    };
  }, []);

  const centerOn = useCallback(
    (pageId: string) => {
      const idx = doc.pages.findIndex((p) => p.id === pageId);
      if (idx < 0) return;
      touchedRef.current = true;
      // Before the first measured layout the geometry is not the one the view
      // will show: a fit has not resolved, so a row offset computed now lands
      // on another page once it does. The jump waits for that layout, and it
      // replaces the opening page and any seed re-land.
      if (!viewRef.current.measured) {
        pendingRef.current = { kind: 'page', index: idx, gAt: null, hCenter: false };
        forceLayout();
        return;
      }
      jumpToIndex(idx);
    },
    [doc.pages, jumpToIndex],
  );

  useImperativeHandle(
    ref,
    (): CanvasHandle => ({
      // Every stored zoom goes through clampReadingZoom: the percent range of
      // its reference page plus the WIDTH-axis element bound. The height axis
      // does not bound zoom: the spacer caps and rows translate under it
      // (scrollMapFor), so presets are honest at any page count.

      zoomIn: () => {
        discrete();
        zoomBy(ZOOM_STEP, centre());
      },
      zoomOut: () => {
        discrete();
        zoomBy(1 / ZOOM_STEP, centre());
      },
      reset: () => setZoomMode('fitPage'),
      actualSize: () => setZoomMode('actual'),
      fitWidth: () => setZoomMode('fitWidth'),
      // The reading view has no world transform; tools resolve coordinates
      // element-relative (PageCell reads its own getBoundingClientRect), so the
      // camera-space projection the board exposes for its drop math isn't
      // meaningful here.
      clientToWorld: () => null,
      centerOn,
      zoomToPageRect,
      setZoomAbsolute: (z: number) => {
        discrete();
        zoomTo(clampReadingZoom(z, currentPage(), widestRef.current), centre());
      },
      followZoom,
      setZoomPercent,
      setZoomMode,
      setLayoutMode,
      setCoverAlone,
      setScrollMode,
      viewState: () => (viewRef.current.measured ? snapshotNow() : null),
    }),
    [
      centerOn,
      zoomToPageRect,
      setZoomPercent,
      setZoomMode,
      setLayoutMode,
      setCoverAlone,
      setScrollMode,
      zoomBy,
      zoomTo,
      followZoom,
      currentPage,
      centre,
      snapshotNow,
      discrete,
    ],
  );

  // ── Settling the scroll position after a layout change ────────────────
  // Runs after EVERY render, before paint. It consumes at most one pending
  // request (an anchored zoom or a page re-land), re-anchors at the top
  // centre when the geometry moved with no request (a fit re-resolving on a
  // resize or a panel toggle, a column count changing), and centres the
  // current page horizontally when asked. Writing state here re-renders
  // synchronously, so the virtualized window never paints one frame of the
  // old scroll position. Every render, deliberately: a request must be
  // consumed or dropped on the render right after it is made, and the one
  // state write is guarded (it fires only when the DOM moved), so it settles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || viewportW <= 0 || viewportH <= 0) return;
    const viewport = { w: viewportW, h: viewportH };

    // A seeded column count resolves once the pane width is known; its zoom
    // change re-renders, and the pending re-land applies on that render.
    const cols = seedColumnsRef.current;
    if (cols !== null) {
      seedColumnsRef.current = null;
      const z = zoomForColumns(cols, fitW, widestW1);
      if (z > 0) {
        setZStored(clampReadingZoom(z, currentPage(), widestW1));
        setZoomModeState('custom');
        return;
      }
    }

    const prev = prevGeomRef.current;
    prevGeomRef.current = { g, input: gridInput };
    const pending = pendingRef.current;
    let pendingLive = false;
    if (pending) {
      // Consumed either way: a request whose render left the geometry where
      // it was asked against changed nothing and must not fire later.
      pendingRef.current = null;
      pendingLive = pending.gAt === null || pending.gAt !== g;
    }

    let left: number | null = null;
    let topVirtual: number | null = null;
    const keepPagedRow = (pageIndex: number, t: number): number =>
      scrollMode === 'paged' && g.rowH <= viewportH ? gridRowOfPage(g, pageIndex, coverAlone) * g.slotH : t;

    if (pendingLive && pending?.kind === 'anchor') {
      const resX = anchoredScroll(g, gridInput, pending.hitX, pending.pointer, viewport);
      const resY =
        pending.hitY === pending.hitX ? resX : anchoredScroll(g, gridInput, pending.hitY, pending.pointer, viewport);
      left = resX.left;
      topVirtual = keepPagedRow(pending.hitY.pageIndex, resY.topVirtual);
    } else if (pendingLive && pending?.kind === 'page') {
      jumpToIndex(Math.min(pageCount - 1, Math.max(0, pending.index)));
    } else if (
      prev &&
      prev.input.pageWidthsAt1 === pageWidthsAt1 &&
      (prev.input.zoom !== zoom || prev.g.columns !== g.columns || prev.g.slotH !== g.slotH)
    ) {
      const pointer = { x: viewportW / 2, y: 0 };
      const pos = posRef.current;
      const hit = hitTest(prev.g, prev.input, pos.left + pointer.x, pos.virtualTop + pointer.y);
      if (hit) {
        const res = anchoredScroll(g, gridInput, hit, pointer, viewport);
        left = res.left;
        topVirtual = keepPagedRow(hit.pageIndex, res.topVirtual);
      }
    }

    const centreNow = hCenterRef.current || (pendingLive && pending !== null && pending.hCenter);
    hCenterRef.current = false;
    if (centreNow && g.contentW > viewportW && pageCount > 0) {
      if (linked) {
        // Quad panes centre the content, not their own current page: the
        // panes of one column share horizontal offsets but not the current
        // page, and only the content width is common to them.
        left = (g.contentW - viewportW) / 2;
      } else {
        const r = pageRect(g, gridInput, Math.min(pageCount, Math.max(1, currentPageRef.current)) - 1);
        left = Math.min(g.contentW - viewportW, Math.max(0, r.left + r.width / 2 - viewportW / 2));
      }
    }

    if (topVirtual !== null) el.scrollTop = realTopFor(topVirtual, smap);
    if (left !== null) el.scrollLeft = left;
    posRef.current = { left: el.scrollLeft, virtualTop: virtualTopOf(el.scrollTop, smap) };
    if (el.scrollTop !== scrollTop) setScrollTop(el.scrollTop);
  });

  // Declared after the settle effect, and reads the page off the scroll
  // position that effect just wrote: the passive reporter runs later, and a
  // snapshot taken before it would carry the page the view was on BEFORE the
  // command (a split opened in that window would clone it).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !publishNowRef.current || viewportW <= 0 || viewportH <= 0) return;
    publishNowRef.current = false;
    if (pageCount > 0) {
      const a = jumpAnchorRef.current;
      const vt = virtualTopOf(el.scrollTop, smap);
      reportPage(pageInView(g, gridInput, vt, a, a ? doc.pages[a.page - 1]?.id : null).page);
    }
    publishReadingView(pathRef.current, paneId, snapshotNow());
  });

  // ── The document's own initial view (seed) ────────────────────────────
  // Every fresh open parks a seed without knowing how the view will resolve,
  // so pane a always consumes it and applies it only when this mount opened
  // from the DEFAULTS and the user has not acted on the pane yet; otherwise
  // it is discarded. It overrides only the axes the document states. Split
  // panes never take it: they clone pane a, and a seed is consumed once.
  useEffect(() => {
    if (paneId !== 'a') return;
    const path = doc.path;
    const apply = (seed: ReadingViewSeed): void => {
      const st = seed.state;
      const pages = pagesRef.current;
      const n = pages.length;
      const target = st.page !== undefined && n > 0 ? Math.min(n, Math.max(1, Math.floor(st.page))) - 1 : currentPageRef.current - 1;
      if (st.layoutMode) setLayoutModeState(st.layoutMode);
      if (st.coverAlone !== undefined) setCoverAloneState(st.coverAlone);
      if (st.scrollMode) setScrollModeState(st.scrollMode);
      if (st.zoomMode) {
        const z = storedZoomFor(st.zoomMode, st.zoomPercent ?? 100, pages[target]);
        setZStored(clampReadingZoom(z, pages[target], widestRef.current));
        setZoomModeState(st.zoomMode);
      } else if (seed.columnsHint !== null && seed.columnsHint > 1) {
        seedColumnsRef.current = seed.columnsHint;
      }
      if (n > 0) pendingRef.current = { kind: 'page', index: target, gAt: null, hCenter: true };
      else hCenterRef.current = true;
      // The page re-land must run even when the seed changed no state.
      forceLayout();
    };
    const tryTake = (): void => {
      const seed = takeReadingViewSeed(path);
      if (!seed || opening.source !== 'defaults' || touchedRef.current) return;
      touchedRef.current = true;
      apply(seed);
    };
    tryTake();
    return subscribeReadingViewSeed(path, tryTake);
    // Mount-only: the opening source and the path are fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Publishing the view ───────────────────────────────────────────────
  // On the settle beat, so a wheel burst publishes once; and on unmount, so a
  // remount after a document switch reopens exactly where this one left off.
  const zoomPercent = percentFor(zoom, viewPages[Math.min(viewPages.length, Math.max(1, page)) - 1]);
  useEffect(() => {
    if (viewportW <= 0 || viewportH <= 0) return;
    const t = setTimeout(() => publishReadingView(pathRef.current, paneId, snapshotNow()), ZOOM_SETTLE_MS);
    return () => clearTimeout(t);
  }, [
    zoomMode,
    zoomPercent,
    layoutMode,
    coverAlone,
    scrollMode,
    page,
    g.columns,
    pageCount,
    viewportW,
    viewportH,
    paneId,
    snapshotNow,
  ]);
  // Pane a only. An unmount cannot tell a split close from a document
  // switch or close: a split pane keeps its settled entry, so a switch back
  // restores it, and the split layer forgets it when the split itself closes.
  useEffect(
    () => () => {
      // `final`: the store keeps this snapshot even when the active path has
      // already moved to the next document (a switch changes it in a layout
      // effect, before this passive cleanup runs).
      if (paneId === 'a' && viewRef.current.measured) {
        publishReadingView(pathRef.current, paneId, snapshotNow(), { final: true });
      }
    },
    // Unmount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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
  }, [showRulers, scrollTop, virtualTop, zoom, viewportH, viewportW, first, last, g.contentW, pageHeight]);

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
  const linksOnPage = useMemo(() => groupLinksByPage(props.linkRegions), [props.linkRegions]);
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
      pointers.remove('pointermove', onMove);
      pointers.remove('pointerup', onUp);
      pointers.remove('pointercancel', onCancel);
      pointers.remove('blur', onCancel);
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
    const pointers = pointerScope(e.pointerId);
    pointers.add('pointermove', onMove);
    pointers.add('pointerup', onUp);
    pointers.add('pointercancel', onCancel);
    pointers.add('blur', onCancel);
  };

  // Rows are computed inline each render (PageCell is memo'd, so unchanged
  // cells skip re-render; the per-page overlay maps come pre-grouped from WCV).
  const rows: React.JSX.Element[] = [];
  for (let r = first; r <= last; r++) {
    const rowPageIdxs = pagesInRowOf(g, r, coverAlone, viewPages.length);
    if (rowPageIdxs.length === 0) continue;
    // Every box comes from pageRect — the same geometry the hit test, the
    // anchored zoom and the fits solve against — and its widths are the
    // widths PageCell renders (exact aspect — `textLayer` is set below). A
    // divergent formula offsets the row in the pane and over-reports the
    // scrollable width (regression).
    const rects = rowPageIdxs.map((i) => pageRect(g, gridInput, i));
    const rowLeft = Math.min(...rects.map((b) => b.left));
    const rowRight = Math.max(...rects.map((b) => b.left + b.width));
    const multi = rowPageIdxs.length > 1;
    const cells = rowPageIdxs.map((i, k) => {
      const page = viewPages[i];
      const cell = (
        <PageCell
          key={page.id}
          docId={doc.id}
          page={page}
          viewRotation={viewRotation}
          pdf={proxies.get(page.sourceDocId) ?? null}
          pageHeight={pageHeight}
          renderVersion={props.renderVersion + detailVersion}
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
          a11yFindings={props.a11yFindingsByPage.get(page.id)}
          a11yFindingHandlers={props.a11yFindings}
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
          onCheckSpelling={props.onCheckSpelling}
          spellLang={props.spellLang}
          onCancelParagraphEdit={props.onCancelParagraphEdit}
          onMergeParagraphPrev={props.onMergeParagraphPrev}
          onMergeParagraphNext={props.onMergeParagraphNext}
          signaturePlacement={props.signaturePlacement?.pageId === page.id ? props.signaturePlacement : null}
          findMatch={props.findMatchPageIds.has(page.id)}
          findWords={props.findWordsByPage.get(page.id)}
          readAloud={props.readAloudByPage.get(page.id)}
          formWidgets={props.formWidgetsByPage.get(page.id)}
          formValues={props.formValuesByPath.get(page.sourceDocId)}
          onSetFormValue={props.onSetFormValue}
          onSignFieldRequest={props.onSignFieldRequest}
          onWidgetAction={props.onWidgetAction}
          newFieldPlacement={props.newFieldPlacement?.pageId === page.id ? props.newFieldPlacement : null}
          onSetNewFieldRect={props.onSetNewFieldRect}
          onClearNewFieldPlacement={props.onClearNewFieldPlacement}
          addTextPlacement={props.addTextPlacement?.pageId === page.id ? props.addTextPlacement : null}
          cropPlacement={props.cropPlacement?.pageId === page.id ? props.cropPlacement : null}
          onClearCropPlacement={props.onClearCropPlacement}
          onSetAddTextRect={props.onSetAddTextRect}
          onSetCropRect={props.onSetCropRect}
          onSetBeadRect={props.onSetBeadRect}
          onSetSnapshotRect={props.onSetSnapshotRect}
          onSetLinkRect={props.onSetLinkRect}
          linkRegions={linksOnPage(page.id)}
          onPickLink={props.onPickLink}
          linkFollow={props.linkFollow}
          selectedLink={props.selectedLink}
          snapshotPlacement={props.snapshotPlacement?.pageId === page.id ? props.snapshotPlacement : null}
          onClearSnapshotPlacement={props.onClearSnapshotPlacement}
          onSaveSnapshot={props.onSaveSnapshot}
          onAddImageRect={props.onAddImageRect}
          onClearAddTextPlacement={props.onClearAddTextPlacement}
          onPageContextMenu={props.onPageContextMenu}
          onPagePointerDown={NO_PAGE_POINTER}
          textLayer
          ocrSelection={props.ocrSelection}
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
            zoomToPageRect(pid, r);
          }}

          onAddRedactionMark={props.onAddRedactionMark}
          onRemoveRedactionMark={props.onRemoveRedactionMark}
          onSetSignaturePlacement={props.onSetSignaturePlacement}
          onClearSignaturePlacement={props.onClearSignaturePlacement}
        />
      );
      if (!multi) return cell;
      // Several pages share the row: the paper look moves from the row to
      // each page, so the gaps between them show the pane, not white.
      return (
        <div
          key={page.id}
          style={{
            position: 'absolute',
            left: rects[k].left - rowLeft,
            top: 0,
            width: rects[k].width,
            height: pageHeight,
            background: '#ffffff',
            boxShadow: 'var(--page-shadow)',
            forcedColorAdjust: 'none',
          }}
        >
          {cell}
        </div>
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
          // EXACTLY 0 (k = 1), so this is `r * rowH` bit-for-bit; past it,
          // the rendered window rides with the real scroll position while the
          // virtual offset slides the document under it.
          top: rects[0].top - (virtualTop - scrollTop),
          height: pageHeight,
          left: rowLeft,
          width: rowRight - rowLeft,
          display: 'flex',
          alignItems: 'flex-start',
          ...(multi ? { background: 'transparent', boxShadow: 'none' } : null),
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
        data-zoom-mode={zoomMode}
        data-zoom-percent={Math.round(zoomPercent)}
        data-layout-mode={layoutMode}
        data-columns={g.columns}
        data-scroll-mode={scrollMode}
        data-current-page={page}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        style={{
          // clientWidth must not depend on overflow, or a fit that adds a
          // scrollbar shrinks its own basis and the columns oscillate.
          scrollbarGutter: 'stable',
          // Every scroll position is set explicitly (anchors, re-lands,
          // snaps); browser anchoring would move it a second time.
          overflowAnchor: 'none',
          ...(props.tool === 'hand' ? { cursor: 'grab' } : null),
        }}
        // Hand: drag-scroll the reading pane. CAPTURE phase, so the
        // press never reaches a page cell — hand must not select, band, or
        // start an edit; it only holds the paper.
        onPointerDownCapture={props.tool === 'hand' ? handleHandDown : markTouched}
      >
        <div
          className="docview-spacer"
          style={{
            height: smap.spacerHeight,
            // Wider than the pane only when the content is: CSS min-width keeps
            // it at least the pane, and a fractional clientWidth must never
            // open a scrollbar over nothing (regression — a ~0.2px band of
            // pane widths, reachable under display scaling).
            width: g.contentW > viewportW + OVERFLOW_EPS ? g.contentW : undefined,
            position: 'relative',
          }}
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
