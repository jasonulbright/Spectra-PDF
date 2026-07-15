import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, PageAnnotation } from '../../state/types';
import type { RedactionMark } from '../../lib/redaction';
import type { SignaturePlacement } from '../../lib/signature-placement';
import type { OcrWord } from '../../ocr/types';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { CanvasTool, StampPreset } from './PageCell';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import { BASE_PAGE_HEIGHT, displayWidthOf } from '../../canvas/layout';
import { isEditable } from '../../commands/keymap';
import { anchorHolds, currentPageFor, type JumpAnchor } from '../../canvas/reading-page';
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

// One US-Letter page is ~this tall at zoom 1 (a comfortable reading size on a
// typical pane); zoom multiplies it. Independent of BASE_PAGE_HEIGHT (the
// board's thumbnail size).
const READING_BASE_HEIGHT = 960;
const PAGE_GAP = 24; // vertical px between pages, at zoom 1 (scales with zoom)
const OVERSCAN = 2; // pages rendered beyond each viewport edge
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;

// The reading view has no page-reorder drag (Organize-view-only), so a page
// press in select mode is a no-op; the annotate/redact/form tools handle their
// own pointer events inside PageCell. Stable identity preserves PageCell's memo.
const NO_PAGE_POINTER = (): void => {};

export interface DocumentViewProps {
  doc: OpenDocument;
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
  signaturePlacement: SignaturePlacement | null;
  findMatchPageIds: ReadonlySet<string>;
  findWordsByPage: ReadonlyMap<string, OcrWord[]>;
  formWidgetsByPage: ReadonlyMap<string, OverlayWidget[]>;
  formValuesByPath: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>;
  onSetFormValue: (path: string, fieldName: string, value: FormFieldValue) => void;
  onSignFieldRequest: (path: string, fieldName: string) => void;
  formsAddMode: boolean;
  newFieldPlacement: SignaturePlacement | null;
  onSetNewFieldRect: (
    docId: string,
    pageId: string,
    rect: { x: number; y: number; w: number; h: number },
    rotationAtDraw: 0 | 90 | 180 | 270,
  ) => void;
  onClearNewFieldPlacement: () => void;
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
  const { doc, proxies } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // A "settle" signal for the raster: PageView's detail layer only re-renders
  // when its `version` changes; on the board that comes from <Canvas onSettle>,
  // which isn't mounted here. So after a zoom, bump this a beat later (debounced
  // — a burst of Ctrl+= re-details once) and fold it into the version handed to
  // each PageCell, so the visible page re-rasters crisp at the new size instead
  // of staying a CSS-stretched (blurry) base raster (review-caught).
  const [zoomVersion, setZoomVersion] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setZoomVersion((v) => v + 1), 140);
    return () => clearTimeout(t);
  }, [zoom]);

  const pageHeight = pageHeightAt(zoom);
  const gap = PAGE_GAP * zoom;
  const rowH = pageHeight + gap;

  // Cumulative Y offset of each page (top of its row). Pages are uniform-height
  // (widths vary by aspect), so offsets are a simple arithmetic series — the
  // virtualizer needs only counts, and centerOn/current-page are O(1).
  const pageCount = doc.pages.length;
  const contentHeight = pageCount * rowH;

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

  // Visible page range [first, last], padded by OVERSCAN.
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(pageCount - 1, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN);

  // A jump's recorded intent — see JumpAnchor's header for why scroll position
  // alone cannot answer this at the extremes.
  const jumpAnchorRef = useRef<JumpAnchor | null>(null);

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
      onCurrentPageChange(a!.page);
      return;
    }
    jumpAnchorRef.current = null;
    onCurrentPageChange(currentPageFor(m));
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
      onCurrentPageChangeRef.current?.(idx + 1);
    },
    [doc.pages, rowH, pageHeight, viewportH],
  );

  useImperativeHandle(
    ref,
    (): CanvasHandle => ({
      zoomIn: () => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP)),
      zoomOut: () => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP)),
      reset: () => setZoom(1),
      // The reading view has no world transform; tools resolve coordinates
      // element-relative (PageCell reads its own getBoundingClientRect), so the
      // camera-space projection the board exposes for its drop math isn't
      // meaningful here.
      clientToWorld: () => null,
      centerOn,
    }),
    [centerOn],
  );

  // Rows are computed inline each render (PageCell is memo'd, so unchanged
  // cells skip re-render; the per-page overlay maps come pre-grouped from WCV).
  const rows: React.JSX.Element[] = [];
  for (let i = first; i <= last; i++) {
    const page = doc.pages[i];
    if (!page) continue;
    const width = displayWidthOf(page) * (pageHeight / BASE_PAGE_HEIGHT);
    rows.push(
      <div
        key={page.id}
        className="docview-row"
        style={{ position: 'absolute', top: i * rowH, height: pageHeight, width, left: '50%', marginLeft: -width / 2 }}
      >
        <PageCell
          docId={doc.id}
          page={page}
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
          signaturePlacement={props.signaturePlacement?.pageId === page.id ? props.signaturePlacement : null}
          findMatch={props.findMatchPageIds.has(page.id)}
          findWords={props.findWordsByPage.get(page.id)}
          formWidgets={props.formWidgetsByPage.get(page.id)}
          formValues={props.formValuesByPath.get(page.sourceDocId)}
          onSetFormValue={props.onSetFormValue}
          onSignFieldRequest={props.onSignFieldRequest}
          formsAddMode={props.formsAddMode}
          newFieldPlacement={props.newFieldPlacement?.pageId === page.id ? props.newFieldPlacement : null}
          onSetNewFieldRect={props.onSetNewFieldRect}
          onClearNewFieldPlacement={props.onClearNewFieldPlacement}
          onPageContextMenu={props.onPageContextMenu}
          onPagePointerDown={NO_PAGE_POINTER}
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
    >
      <div className="docview-spacer" style={{ height: contentHeight, position: 'relative' }}>
        {rows}
      </div>
    </div>
  );
});
