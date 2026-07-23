import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { computeLayout, computeDropTarget, betweenSlotY, BASE_PAGE_HEIGHT, MIN_DOC_WIDTH } from '../../canvas/layout';
import { usePageDrag } from '../../canvas/usePageDrag';
import { uniqueDocName } from '../../lib/doc-names';
import { getDocumentProxy } from '../../lib/pdfDocCache';
import { buildRedactionRegions } from '../../lib/redaction';
import type { PageGeometry, RedactionMark, RedactionRegion } from '../../lib/redaction';
import { buildSignatureAppearance } from '../../lib/signature-placement';
import type { SignaturePlacement } from '../../lib/signature-placement';
import { useEngine } from '../../hooks/useEngine';
import { app, dialog } from '../../lib/tauri-bridge';
import { SignerSourceFields, EMPTY_SIGNER_SOURCE, signerSourceParams } from '../SignerSourceFields';
import type { SignerSource } from '../SignerSourceFields';
import { sourceKeyOf } from '../../search/useSearchIndex';
import { useSearchContext } from '../../search/SearchProvider';
import { useFind } from '../../search/useFind';
import { normalizeQuery, highlightWords } from '../../search/normalize';
import { FindBar } from './FindBar';
import { DocumentView } from './DocumentView';
import { buildOcrApplyPayload } from '../../lib/ocr-apply';
import type { OcrApplyPage } from '../../lib/ocr-apply';
import type { OcrWord } from '../../ocr/types';
import { fetchEditPlacements } from '../../lib/edit-images';
import { fetchEditVectors, type EditVectorObject } from '../../lib/edit-vectors';
import type { EditImagePlacement } from '../../lib/edit-images';
import { EDIT_DECLINED } from '../../lib/edit-text';
import { pageIdAtSourceIndex } from '../../lib/durable-identity';
import { computeEditSpans, fetchEditTextListing, hexToRgb } from '../../lib/edit-paragraphs';
import type { EditTextListing, ParagraphEditOpts } from '../../lib/edit-paragraphs';
import { applyRotate } from '../../lib/image-transform';
import { workspacePageNumber } from '../../lib/workspace-commit';
import { runCommitGate } from '../../lib/commit-gate';

import { buildMergedPageRefs, pathBlockedFromClose } from '../../lib/merge-docs';
import { useWorkspaceForms } from '../../hooks/useWorkspaceForms';
import { placementDocsCurrent, pruneFormValues, valueShapeMatches } from '../../lib/form-overlay';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { NewFieldSpec, NewFieldType } from '../../lib/form-authoring';
import { TEST_HARNESS_ENABLED, registerCanvasRedaction, registerCanvasSignature, registerCanvasOcr, registerCanvasSelection, registerCanvasForms, registerCanvasMerge, registerCanvasEditImages } from '../../testHarness';
import { invokeCommand, registerCanvasServices } from '../../commands/context';
import { buildPageContextMenu } from '../../lib/page-context-menu';
import { ContextMenu } from '../ContextMenu';
import type { MenuItem } from '../ContextMenu';
import { Canvas } from './Canvas';
import { DocLayer } from './DocLayer';
import { HeaderLayer } from './HeaderLayer';
import { AddDocGhost, GhostRow } from './DropGhost';
import { deriveDropGhosts } from './ghost-size';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import type { PageAnnotation, PdfBuffer } from '../../state/types';
import type { CanvasTool, StampPreset } from './PageCell';
import { SecondaryToolbar } from './SecondaryToolbar';
import { CommentSidebar } from './CommentSidebar';

interface WorkspaceCanvasViewProps {
  onOpenFiles: () => void;
  onCloseFile: (path: string) => void;
  // Jump to the extract-text panel with the page pre-selected (same
  // workspace-position numbering; the engine gate commits before reading).
  onExtractText: (path: string, pageNumber: number) => void;
  // Run the engine's redact on one file — App routes this through
  // performOperation, so the commit gate flushes pending page edits, a
  // snapshot lands on the undo chain, and the buffer reloads after.
  onRedactFile: (path: string, regions: RedactionRegion[]) => Promise<void>;
  // Persist OCR text layers into one file — same performOperation routing as
  // onRedactFile (gate flush -> snapshot -> engine apply_ocr_layer -> reload).
  onApplyOcrLayer: (path: string, pages: OcrApplyPage[]) => Promise<void>;
  // Edit ▸ Images (7.1): one handler, three actions, all App-routed (delete/
  // replace via the snapshot→engine→reload shape — undoable; extract = gated
  // read + save, resolving to a user-facing notice naming the real output).
  // `opts` is the harness's dialog bypass.
  onEditImage: (
    kind: 'delete' | 'replace' | 'extract' | 'transform' | 'crop' | 'opacity',
    path: string,
    page: number,
    index: number,
    opts?: {
      source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 };
      outputPrefix?: string;
      matrix?: number[];
      rect?: [number, number, number, number];
      opacity?: number;
    },
  ) => Promise<string | void>;
  // Edit ▸ Vectors (9.D1/D2/D3): delete, transform, or restyle one vector path
  // object — same undoable App routing. EDIT_DECLINED on a refused signed-doc
  // warning, like the image/text handlers.
  onEditVector: (
    kind: 'delete' | 'transform' | 'restyle',
    path: string,
    page: number,
    index: number,
    opts?: {
      matrix?: number[];
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    },
  ) => Promise<string | void>;
  // Edit ▸ Text (7.2+7.3): replace one run's text — same one-snapshot,
  // undoable App routing (engine replace_text_run). Resolves EDIT_DECLINED
  // when the signed-doc warning was refused (the canvas restores its
  // listing and says so).
  onEditText: (
    path: string,
    page: number,
    index: number,
    newText: string,
    opts?: { convert?: boolean },
  ) => Promise<string | void>;
  // Edit ▸ Paragraphs (7.5): replace a paragraph's text and re-lay-out
  // inside its box — same one-snapshot, undoable App routing (engine
  // replace_paragraph_text), same EDIT_DECLINED contract. The canvas
  // supplies the fingerprint (member runs + logical text) and the
  // renderer-computed span mapping.
  onEditParagraph: (
    path: string,
    page: number,
    para: { index: number; runs: number[]; text: string },
    newText: string,
    spans: { start: number; end: number; run: number }[],
    opts?: ParagraphEditOpts,
  ) => Promise<string | void>;
  // A4 merge: the engine validates BOTH fingerprints and refuses stale
  // views / cross-stream pairs; EDIT_DECLINED on the signed-doc refusal.
  onMergeParagraph: (
    path: string,
    page: number,
    prev: { index: number; runs: number[]; text: string },
    cur: { index: number; runs: number[]; text: string },
  ) => Promise<string | void>;
  // Author a NEW text object (9.A2): a rubber-band box + entered text become a
  // fresh Type0 run via the engine's add_text_box. `rect` is PDF user-space
  // points; the return mirrors onEditParagraph (EDIT_DECLINED on a signed-doc
  // refusal). Undoable.
  onAddText: (
    path: string,
    page: number,
    rect: [number, number, number, number],
    text: string,
    opts?: {
      size?: number;
      color?: [number, number, number];
      family?: 'serif' | 'sans' | 'mono';
      rotate?: 0 | 90 | 180 | 270;
      bold?: boolean;
      italic?: boolean;
      kern?: boolean;
      // 9.K2 OpenType features — ['small_caps'] and/or ['salt']; alt_index
      // picks the salt alternate.
      features?: string[];
      alt_index?: number;
    },
  ) => Promise<string | void>;
  // Embed a NEW image (9.C2) at a user-space rect. `source` is optional — the
  // App handler PICKS the file when it's absent; the harness injects it (the
  // native picker is undrivable). Undoable; EDIT_DECLINED on a signed-doc
  // refusal.
  onAddImage: (
    path: string,
    page: number,
    rect: [number, number, number, number],
    source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 },
  ) => Promise<string | void>;
  // Add-page ghost (2n.3): pick file(s) and import their pages into a document
  // at an index (byte-only import machinery, undoable via the page tier).
  onAddPages: (docId: string, toIndex: number) => void;
  // Bake pending on-canvas form values into one file (2n.4b) — App implements
  // the FormsPanel shape (snapshot(gate) → engine fill_form_fields → reload →
  // UPDATE_FILE), so it lands on the snapshot-undo chain.
  onFillFormValues: (path: string, values: Record<string, FormFieldValue>) => Promise<void>;
  // Author a new form field into one file (2n.4c) — same whole-file-op shape.
  onAddFormField: (path: string, spec: NewFieldSpec) => Promise<void>;
  // Per-position external drop (2n.3): the canvas publishes a resolver here so
  // App's drop handler can map a drop point to the document + index under it
  // (returns null for a between/empty drop → App falls back to appending).
  dropResolverRef: React.MutableRefObject<CanvasDropResolver | null>;
}

export interface CanvasDropTarget {
  docId: string;
  index: number;
}
// clientX/clientY are webview CSS pixels (App converts the Tauri physical drop
// position). Returns the doc + insertion index under the point, or null when
// the point isn't over a document card.
export type CanvasDropResolver = (clientX: number, clientY: number) => CanvasDropTarget | null;

// Stable empties so the "no pending marks" hot path never breaks the layer
// components' memoization when unrelated state changes.
// Hand mode (M6.2): a press on a page must NOT pick it up — and by not
// stopping propagation, the pointer falls through to the board's d3 pan, so
// hand drags the whole board from anywhere, page or background.
const HAND_SUPPRESSES_PICKUP = (): void => {};
const NO_MARKS: RedactionMark[] = [];
const NO_MARKS_BY_PAGE: ReadonlyMap<string, RedactionMark[]> = new Map();
const NO_EDIT_IMAGES: ReadonlyMap<string, EditImagePlacement[]> = new Map();
const NO_EDIT_VECTORS: ReadonlyMap<string, EditVectorObject[]> = new Map();
const NO_EDIT_GEOM: ReadonlyMap<string, PageGeometry> = new Map();
const NO_EDIT_TEXT: ReadonlyMap<string, EditTextListing> = new Map();
const NO_PAGE_IDS: ReadonlySet<string> = new Set();
const NO_WORDS_BY_PAGE: ReadonlyMap<string, OcrWord[]> = new Map();
const NO_WIDGETS_BY_PAGE: ReadonlyMap<string, OverlayWidget[]> = new Map();
const NO_FORM_VALUES: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>> = new Map();

export function WorkspaceCanvasView({
  onOpenFiles,
  onCloseFile,

  onExtractText,
  onRedactFile,
  onApplyOcrLayer,
  onEditImage,
  onEditVector,
  onEditText,
  onEditParagraph,
  onMergeParagraph,
  onAddText,
  onAddImage,
  onAddPages,
  onFillFormValues,
  onAddFormField,
  dropResolverRef,
}: WorkspaceCanvasViewProps): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const docs = state.workspace.documents;
  const proxies = usePdfProxies(state.files);
  const layout = useMemo(() => computeLayout(docs), [docs]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const canvasRef = useRef<CanvasHandle | null>(null);
  // Document view (M4): its reading-mode CanvasHandle, and a ref-mirror of the
  // mode so the registered `canvas()` getter routes to the active view.
  const documentViewRef = useRef<CanvasHandle | null>(null);
  const docViewMode = state.ui.docViewMode;
  const docViewModeRef = useRef(docViewMode);
  docViewModeRef.current = docViewMode;
  // The CanvasHandle of whichever view is active — the board's d3 camera, or the
  // reading view's scroller. EVERY camera caller (find navigation, the zoom
  // buttons, the registered canvasServices) must route through this: the
  // board-only `canvasRef` is null while the reading view is mounted, so a
  // direct `canvasRef.current?.…` silently no-ops in Document mode
  // (review-caught). Stable identity (reads refs).
  const activeCanvasHandle = useCallback(
    (): CanvasHandle | null =>
      docViewModeRef.current === 'document' ? documentViewRef.current : canvasRef.current,
    [],
  );
  // Which document the reading view shows (the board shows ALL docs, the
  // reading view exactly one). An explicit per-doc focus — set by a jump that
  // lands in another file or another `.pdfx` partition — wins; otherwise the
  // active file's FIRST document. The fallback is load-bearing: `focusedDocId`
  // holds a positional `OpenDocument.id`, so a reindex can retire it, and
  // resolving through the default then keeps the view on the active file
  // instead of blanking.
  // The `d.path === activeFileId` clause is a STRUCTURAL guard, not redundancy:
  // it makes "the reading view shows a document of the active file" true by
  // construction, so no future action can strand it on another file's document
  // by forgetting to clear the focus (review-caught via SET_ACTIVE_FILE, which
  // did exactly that — now also cleared, but the invariant no longer depends on
  // every writer remembering).
  const focusedDoc =
    (state.ui.focusedDocId
      ? docs.find((d) => d.id === state.ui.focusedDocId && d.path === state.activeFileId)
      : null) ??
    docs.find((d) => d.path === state.activeFileId) ??
    null;
  const focusedDocRef = useRef(focusedDoc);
  focusedDocRef.current = focusedDoc;
  // A jump whose target lives in a document the reading view isn't showing:
  // parked here until that document's view has mounted (see jumpToPage).
  const pendingJumpRef = useRef<string | null>(null);
  useEffect(() => {
    const pid = pendingJumpRef.current;
    if (!pid) return;
    // Only once the newly focused doc actually owns the target (refs are
    // populated during commit, so its handle is live by the time this runs).
    if (!focusedDoc?.pages.some((p) => p.id === pid)) return;
    pendingJumpRef.current = null;
    activeCanvasHandle()?.centerOn(pid);
  }, [focusedDoc, docViewMode, activeCanvasHandle]);
  // Reading-view page navigation (M4.1b): the current page (from DocumentView's
  // scroll tracking) + the editable page box. `pageBox` mirrors currentPage
  // except while the user is typing in it (so a scroll doesn't clobber a
  // half-typed number).
  const [currentPage, setCurrentPage] = useState(1);
  const [pageBox, setPageBox] = useState('1');
  const pageBoxRef = useRef<HTMLInputElement | null>(null);
  const pageBoxFocused = useRef(false);
  // Whether the box was actually EDITED since it gained focus — so a blur after
  // just focusing + wheel-scrolling (no typing) resyncs the readout instead of
  // teleporting back to the frozen number (review-caught).
  const pageBoxDirty = useRef(false);
  useEffect(() => {
    if (!pageBoxFocused.current) setPageBox(String(currentPage));
  }, [currentPage]);
  // Reset the readout when entering Read mode or switching the focused doc: a
  // fresh DocumentView starts at page 1, and until it reports back the box would
  // otherwise show the previous doc's page (e.g. "40 / 3") (review-caught).
  // useLayoutEffect, not useEffect: `page-nav-total` reads the NEW doc's page
  // count in the same render, so a passive effect would paint one frame of a
  // stale numerator against the new total — the very "40 / 3" this closes.
  // Unlike the mirror-effect above this deliberately writes even while the box
  // is FOCUSED: on a doc switch a half-typed number targets a document that is
  // no longer shown, so keeping it would be worse than replacing it. Clearing
  // `pageBoxDirty` with it is the load-bearing half — a guard-exempt Ctrl+Tab
  // can switch docs mid-edit without ever blurring the input, and a dirty flag
  // surviving that would make the next blur "navigate" on the stale edit.
  useLayoutEffect(() => {
    if (docViewMode === 'document') {
      setCurrentPage(1);
      setPageBox('1');
      pageBoxDirty.current = false;
    }
  }, [docViewMode, focusedDoc?.id]);

  // Publish the reading position so the Pages nav panel can highlight and
  // scroll-follow it (M4.1e). Resolved to a PageRef id here — the panel matches
  // ids, and reconstructing one from a number there would duplicate this view's
  // page-order knowledge. Null in Organize mode: the board shows every page at
  // once and has no "current" page, so the panel must not claim one.
  const currentPageId =
    docViewMode === 'document' ? (focusedDoc?.pages[currentPage - 1]?.id ?? null) : null;
  useEffect(() => {
    dispatch({ type: 'UI_SET_CURRENT_PAGE', pageId: currentPageId });
  }, [currentPageId, dispatch]);
  // ...and it belongs to this view: leaving it entirely must not strand a
  // highlight the panel would keep showing.
  useEffect(() => () => void dispatch({ type: 'UI_SET_CURRENT_PAGE', pageId: null }), [dispatch]);

  // Publish the external-drop resolver (2n.3) so App's drop handler can map a
  // drop point to the document + index under it. Reads live layout/canvas via
  // refs; an 'into' target imports, a 'between' target returns null so App
  // appends a new strip (today's behavior). The clientToWorld + computeDropTarget
  // path is the same tested math the page drag uses.
  useEffect(() => {
    dropResolverRef.current = (clientX, clientY) => {
      const w = canvasRef.current?.clientToWorld(clientX, clientY);
      if (!w) return null;
      const target = computeDropTarget(layoutRef.current, w.x, w.y, w.k, null, true);
      return target.kind === 'into' ? { docId: target.docId, index: target.index } : null;
    };
    return () => {
      dropResolverRef.current = null;
    };
  }, [dropResolverRef]);
  // Multi-select is view state (never the page-edit tier): a set of selected
  // page ids plus the anchor for shift-range selection. Batched page ops
  // (move/delete/rotate) act on the whole set as one undo step (2n.1). It
  // lives in the ui slice (Phase 4 M1) so command enablement can read it;
  // buffer-identity invalidation moved into the reducer with it.
  const selectedPageIds = state.ui.selectedPageIds;
  const [renderVersion, setRenderVersion] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; docId: string; pageId: string } | null>(
    null,
  );
  // The armed interaction tool — ui slice too (the keymap's Escape chain and
  // the tools.* commands drive it).
  const tool = state.ui.tool;
  const setTool = useCallback(
    (t: CanvasTool) => dispatch({ type: 'UI_SET_TOOL', tool: t }),
    [dispatch],
  );
  // Color picker for the annotation tools: null keeps each tool's own default
  // (yellow highlight, dark freetext, blue ink); a pick applies to whichever
  // tool creates the next annotation, across tool switches.
  const [toolColor, setToolColor] = useState<string | null>(null);
  const [stampPreset, setStampPreset] = useState<StampPreset | null>(null);
  const [showComments, setShowComments] = useState(false);
  // Pending redaction marks — transient view state, deliberately NOT the
  // page-edit tier (see lib/redaction.ts for why). They survive tool
  // switches and in-memory page edits, and die when their file's buffer
  // changes underneath them or the canvas unmounts.
  const [marks, setMarks] = useState<RedactionMark[]>([]);
  const [confirmRedact, setConfirmRedact] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [redactError, setRedactError] = useState<string | null>(null);
  // Pending visible-signature placement — single, transient, same lifecycle
  // as redaction marks (see lib/signature-placement.ts).
  const [sigPlacement, setSigPlacement] = useState<SignaturePlacement | null>(null);
  // Sign-into-an-existing-field target (2n.4d) — mutually exclusive with the
  // rubber-band placement; same transient lifecycle.
  const [sigFieldTarget, setSigFieldTarget] = useState<{ path: string; fieldName: string } | null>(
    null,
  );
  const [sigSource, setSigSource] = useState<SignerSource>(EMPTY_SIGNER_SOURCE);
  const [sigPassword, setSigPassword] = useState('');
  const [sigReason, setSigReason] = useState('');
  const [sigLocation, setSigLocation] = useState('');
  const [signingBusy, setSigningBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signDone, setSignDone] = useState<{ signer: string | null; output: string; ok: boolean } | null>(null);
  const { call: engineCall } = useEngine();
  // Find/OCR (2m): the ONE workspace search index, lifted to a provider so the
  // Search nav panel shares it (Phase 4 M3.3 — double-instantiating would
  // double the OCR work and desync results). Ctrl+F opens the bar.
  const searchIndex = useSearchContext();
  // A jump that lands in a document the current view isn't showing. The board
  // renders every doc, so it can always centre directly; the reading view shows
  // exactly ONE, so a match in another file (or another `.pdfx` partition) has
  // to bring that document to the front FIRST and centre once it has mounted —
  // otherwise `centerOn` finds no such page and returns silently while Find's
  // "N of M" counter has already advanced (review-caught).
  //
  // This is THE jump entry point for every caller that can name a page in any
  // open document — Find/Search, the comments sidebar, and the Pages/Bookmarks
  // nav panels (which list every partition of the active file, so they hit the
  // same blindness; review-caught: they were still calling `centerOn` directly
  // and silently no-oped into a partition the reading view wasn't showing).
  // Only the reading view's own page box may bypass it — it is scoped to the
  // shown document by definition.
  const jumpToPage = useCallback(
    (pageId: string) => {
      const owner = docsRef.current.find((d) => d.pages.some((p) => p.id === pageId));
      if (!owner) return;
      if (docViewModeRef.current === 'document' && owner.id !== focusedDocRef.current?.id) {
        pendingJumpRef.current = pageId;
        dispatch({ type: 'UI_FOCUS_DOC', docId: owner.id });
        return; // the flush effect centres once that doc's view is mounted
      }
      activeCanvasHandle()?.centerOn(pageId);
    },
    [activeCanvasHandle, dispatch],
  );
  const find = useFind(searchIndex.search, searchIndex.version, docs, jumpToPage);
  const [applyingOcr, setApplyingOcr] = useState(false);
  const [ocrApplyError, setOcrApplyError] = useState<string | null>(null);

  // On-canvas forms (2n.4b): per-file field reads + widget projections, and
  // the pending-values map. Pending values are NAME-keyed per file —
  // deliberately not the positional-id lifecycle of marks/selection: a field
  // name survives page edits and commits, so half-typed values survive an
  // Apply-changes; they are PRUNED against every settled re-read instead
  // (name gone / no longer editable / shape mismatch / file closed).
  const workspaceForms = useWorkspaceForms(state.files, engineCall);
  const [pendingFormValues, setPendingFormValues] =
    useState<ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>>(NO_FORM_VALUES);
  const [fillingForms, setFillingForms] = useState(false);
  const [formsError, setFormsError] = useState<string | null>(null);
  useEffect(() => {
    const formsByPath = new Map([...workspaceForms].map(([p, info]) => [p, info.fields]));
    setPendingFormValues((prev) => pruneFormValues(prev, formsByPath));
  }, [workspaceForms]);

  const onSetFormValue = useCallback((path: string, fieldName: string, value: FormFieldValue) => {
    setPendingFormValues((prev) => {
      const next = new Map(prev);
      const inner = new Map(next.get(path) ?? []);
      inner.set(fieldName, value);
      next.set(path, inner);
      return next;
    });
  }, []);

  const clearFormValues = useCallback(() => setPendingFormValues(NO_FORM_VALUES), []);

  // pageId -> widgets, resolved through (sourceDocId, sourcePageIndex) — an
  // in-memory moved page keeps its widgets because both travel with the ref.
  const formWidgetsByPage = useMemo(() => {
    if (workspaceForms.size === 0) return NO_WIDGETS_BY_PAGE;
    const map = new Map<string, OverlayWidget[]>();
    for (const doc of docs) {
      for (const page of doc.pages) {
        const widgets = workspaceForms.get(page.sourceDocId)?.widgetsByPage.get(page.sourcePageIndex);
        if (widgets && widgets.length > 0) map.set(page.id, widgets);
      }
    }
    return map.size > 0 ? map : NO_WIDGETS_BY_PAGE;
  }, [workspaceForms, docs]);

  const pendingFormCount = useMemo(() => {
    let n = 0;
    for (const [, values] of pendingFormValues) n += values.size;
    return n;
  }, [pendingFormValues]);

  // Add-field sub-mode (2n.4c): while armed, forms mode draws a placement
  // band. The placement itself is transient view state with the
  // signature-placement lifecycle: single (drawing again replaces), dies on
  // buffer-identity change or when its page leaves the workspace.
  const [newFieldPlacement, setNewFieldPlacement] = useState<SignaturePlacement | null>(null);
  const [nfName, setNfName] = useState('');
  const [nfType, setNfType] = useState<NewFieldType>('text');
  const [nfOptions, setNfOptions] = useState('');
  const [nfMultiline, setNfMultiline] = useState(false);
  const [creatingField, setCreatingField] = useState(false);
  const [nfError, setNfError] = useState<string | null>(null);
  const onSetNewFieldRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      // Anchor only to CURRENT ids (2n.4c / Phase 9): docs indexed from a
      // superseded buffer are about to be re-identified (fresh generation),
      // so a placement drawn against them is stillborn — refuse it rather
      // than arm a box that dies at SET_WORKSPACE_DOCUMENTS moments later.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      setNewFieldPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setSigPlacement(null); // one placement card at a time (see onSetSignaturePlacement)
      setAddTextPlacement(null); // …including the Add-Text card (9.A2)
      setNfError(null);
    },
    [docs, state.files],
  );
  const onClearNewFieldPlacement = useCallback(() => setNewFieldPlacement(null), []);

  // Placement whose page still exists (mirrors liveSigPlacement).
  const liveNewFieldPlacement = useMemo(() => {
    if (!newFieldPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === newFieldPlacement.pageId))
      ? newFieldPlacement
      : null;
  }, [newFieldPlacement, docs]);

  // Create the placed field via App's whole-file op. The display→PDF
  // conversion is buildSignatureAppearance verbatim — a placement is a
  // placement; it returns the file path, the 1-based committed-order page,
  // and the PDF user-space rect the authoring lib expects. Takes explicit
  // params (not the card's state) so the harness can drive the same path
  // without racing React batching; rejects on failure so callers see it.
  const creatingFieldRef = useRef(false);
  const createFieldFromPlacement = useCallback(
    async (params: {
      name: string;
      type: NewFieldType;
      options?: string[];
      multiline?: boolean;
    }): Promise<void> => {
      if (creatingFieldRef.current) return; // re-entry: the button is disabled while creating
      const placement = liveNewFieldPlacement;
      // The placement is transient view state that dies with its page id; a
      // buffer change between place and create kills it, and while that
      // change's reindex is still in flight the surviving ids are about to
      // rotate — converting sourcePageIndex against the new bytes could land
      // the field on the wrong page. Silently resolving here made a skipped
      // create indistinguishable from a done one (the 18-canvas-forms load
      // flake: a 30s wait for a field that was never created) — reject.
      if (!placement || !placementDocsCurrent(state.files, docs, placement.path)) {
        const msg = 'The page this field was placed on changed — draw the box again.';
        setNfError(msg);
        throw new Error(msg);
      }
      creatingFieldRef.current = true;
      setCreatingField(true);
      setNfError(null);
      try {
        const built = await buildSignatureAppearance(docs, placement, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        });
        if (!built) throw new Error('The page this field was placed on no longer exists.');
        await onAddFormField(built.path, {
          name: params.name.trim(),
          type: params.type,
          pageIndex: built.appearance.page - 1,
          rect: built.appearance.rect,
          ...(params.options && params.options.length > 0 ? { options: params.options } : {}),
          ...(params.type === 'text' && params.multiline ? { multiline: true } : {}),
        });
        // Created — reset the authoring surfaces; stay in forms mode so the
        // new field is immediately fillable.
        setNewFieldPlacement(null);
        setNfName('');
        setNfOptions('');
        setNfMultiline(false);
        // Stay in Prepare Form's own mode, ready to place the next field.
        //
        // NOT 'select' (the widget renders nothing outside a form mode, so the
        // field the user just placed would VANISH — the popup promises it is
        // "fillable right away"), and NOT 'forms': that is Fill & Sign's mode,
        // so the secondary toolbar's title would flip to another tool mid-task
        // and the rubber band would die — `formfields` is what draws it, so the
        // next field couldn't be placed at all, with nothing on screen saying
        // why. `showsFormWidgets` covers both modes, so the promise holds here.
        dispatch({ type: 'UI_SET_TOOL', tool: 'formfields' });
      } catch (err) {
        setNfError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        creatingFieldRef.current = false;
        setCreatingField(false);
      }
    },
    [liveNewFieldPlacement, docs, state.files, onAddFormField, dispatch],
  );
  const createPlacedField = useCallback(async (): Promise<void> => {
    const options =
      nfType === 'radio' || nfType === 'dropdown' || nfType === 'optionlist'
        ? nfOptions.split(/[\n,]/).map((o) => o.trim()).filter(Boolean)
        : undefined;
    await createFieldFromPlacement({
      name: nfName,
      type: nfType,
      ...(options ? { options } : {}),
      multiline: nfMultiline,
    }).catch(() => undefined); // surfaced via nfError; the card stays open
  }, [createFieldFromPlacement, nfName, nfType, nfOptions, nfMultiline]);

  // --- 9.A2 Add Text ------------------------------------------------------
  // Same placement lifecycle as the new-field card (single, transient, dies
  // when its page leaves). The band draws the box; this card collects the
  // text/size/colour/family; commit runs the display→PDF rect conversion
  // (buildSignatureAppearance, verbatim) and routes onAddText.
  const [addTextPlacement, setAddTextPlacement] = useState<SignaturePlacement | null>(null);
  const [atText, setAtText] = useState('');
  const [atSize, setAtSize] = useState(12);
  // A2-tail: authoring-time rotation (90-deg steps; sticky like size/family).
  const [atRotate, setAtRotate] = useState<0 | 90 | 180 | 270>(0);
  // A2-tail-2: whole-box style toggles (sticky) + the live fit result
  // (null = unknown/measuring; the notice shows only on a definite no).
  const [atBold, setAtBold] = useState(false);
  const [atItalic, setAtItalic] = useState(false);
  // 9.K2 OpenType features (sticky like the other style toggles). Authoring
  // renders in a bundled face, so a feature switches to Libertinus Serif;
  // alternates picks its glyph by index.
  const [atSmallCaps, setAtSmallCaps] = useState(false);
  const [atAlternates, setAtAlternates] = useState(false);
  const [atAltIndex, setAtAltIndex] = useState(0);
  // 9.K1: pair kerning, ON by default (correct typography is the right
  // default and is what the fit measurement assumes); the toggle is an
  // opt-OUT, and only that opt-out is ever sent.
  const [atKern, setAtKern] = useState(true);
  const [atFits, setAtFits] = useState<boolean | null>(null);
  const [atColor, setAtColor] = useState('#000000');
  const [atFamily, setAtFamily] = useState<'sans' | 'serif' | 'mono'>('sans');
  const [atError, setAtError] = useState<string | null>(null);
  const [creatingText, setCreatingText] = useState(false);
  const onSetAddTextRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      // Anchor only to CURRENT ids — the onSetNewFieldRect rule (2n.4c /
      // Phase 9, round 24 tail: the sibling flows shared the silent-no-op
      // pattern without the guard). A placement drawn against docs indexed
      // from a superseded buffer dies at SET_WORKSPACE_DOCUMENTS — refuse.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      setAddTextPlacement({
        id: crypto.randomUUID(),
        path: doc.path,
        pageId,
        rect,
        rotationAtDraw,
        rotate: atRotate,
      });
      setSigPlacement(null); // one placement card at a time…
      setNewFieldPlacement(null);
      setSigFieldTarget(null); // …including the sign-into-field card (renders on sigFieldTarget)
      setAtText('');
      setAtError(null);
    },
    [docs, state.files, atRotate],
  );
  const onClearAddTextPlacement = useCallback(() => {
    setAddTextPlacement(null);
    setAtError(null);
  }, []);

  // Placement whose page still exists (mirrors liveNewFieldPlacement).
  const liveAddTextPlacement = useMemo(() => {
    if (!addTextPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === addTextPlacement.pageId))
      ? addTextPlacement
      : null;
  }, [addTextPlacement, docs]);

  // Author the placed text via App's engine op. Display→PDF is
  // buildSignatureAppearance verbatim; explicit params so the harness can
  // drive the same path without racing React batching.
  const creatingTextRef = useRef(false);
  const commitAddText = useCallback(
    async (params: {
      text: string;
      size?: number;
      color?: [number, number, number];
      family?: 'sans' | 'serif' | 'mono';
      rotate?: 0 | 90 | 180 | 270;
      bold?: boolean;
      italic?: boolean;
      /** 9.K1: pair kerning — ON by default engine-side, so only `false`
       * travels. */
      kern?: boolean;
      /** 9.K2 OpenType features. */
      smallCaps?: boolean;
      alternates?: boolean;
      altIndex?: number;
    }): Promise<void> => {
      if (creatingTextRef.current) return; // re-entry: the button is disabled while creating
      const placement = liveAddTextPlacement;
      // Same reject-loudly rule as createFieldFromPlacement (round 24 tail):
      // a buffer change between place and commit kills the placement, and
      // while its reindex is in flight the surviving ids are about to rotate
      // — converting sourcePageIndex against the new bytes could land the
      // text on the wrong page. Silently resolving made a skipped commit
      // indistinguishable from a done one — reject.
      if (!placement || !placementDocsCurrent(state.files, docs, placement.path)) {
        const msg = 'The page this text was placed on changed — draw the box again.';
        setAtError(msg);
        throw new Error(msg);
      }
      if (!params.text.trim()) {
        setAtError('Enter some text to add.');
        return;
      }
      creatingTextRef.current = true;
      setCreatingText(true);
      setAtError(null);
      try {
        const built = await buildSignatureAppearance(docs, placement, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        });
        if (!built) throw new Error('The page this text was placed on no longer exists.');
        const result = await onAddText(
          built.path,
          built.appearance.page,
          built.appearance.rect,
          params.text,
          {
            ...(params.size !== undefined ? { size: params.size } : {}),
            ...(params.color !== undefined ? { color: params.color } : {}),
            ...(params.family !== undefined ? { family: params.family } : {}),
            // rotate=0 sends NOTHING — the engine's no-param path is pinned
            // byte-identical to shipped A2 (the A2-tail regression). The
            // style toggles share the rule (false sends nothing).
            ...(params.rotate ? { rotate: params.rotate } : {}),
            ...(params.bold ? { bold: true } : {}),
            ...(params.italic ? { italic: true } : {}),
            // 9.K1 inverts the send-nothing rule: kerning is ON by default,
            // so only an explicit opt-OUT travels.
            ...(params.kern === false ? { kern: false } : {}),
            // 9.K2 features (send-nothing when off, byte-identical no-feature
            // path). alt_index travels only with alternates.
            ...(params.smallCaps || params.alternates
              ? {
                  features: [
                    ...(params.smallCaps ? ['small_caps'] : []),
                    ...(params.alternates ? ['salt'] : []),
                  ],
                  ...(params.alternates ? { alt_index: params.altIndex ?? 0 } : {}),
                }
              : {}),
          },
        );
        // Signed-doc refusal — keep the card open (the user can cancel).
        if (result === EDIT_DECLINED) return;
        setAddTextPlacement(null);
        setAtText('');
      } catch (err) {
        setAtError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        creatingTextRef.current = false;
        setCreatingText(false);
      }
    },
    [liveAddTextPlacement, docs, state.files, onAddText],
  );
  // A2-tail-2: the live fit indicator — measure_text_box is the SAME
  // layout pass the author op runs (one shared engine function), called
  // debounced so the card can warn before commit. Non-blocking by design
  // (the box is a guide, not a clip); errors just clear the notice (the
  // commit path surfaces real failures).
  useEffect(() => {
    const placement = liveAddTextPlacement;
    if (!placement || !atText.trim()) {
      setAtFits(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const built = await buildSignatureAppearance(docs, placement, async (page) => {
            const f = state.files.get(page.sourceDocId);
            if (!f?.buffer) throw new Error('no buffer');
            const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
            const p = await proxy.getPage(page.sourcePageIndex + 1);
            const [vx0, vy0, vx1, vy1] = p.view;
            return {
              box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
              bakedRotate: p.rotate,
            };
          });
          if (!built || stale) return;
          const f = state.files.get(built.path);
          if (!f) return;
          const res = (await engineCall('measure_text_box', {
            file: f.workingPath,
            page: built.appearance.page,
            rect: built.appearance.rect,
            text: atText,
            size: atSize,
            font_path: await app.getEditFontPath(),
            family: atFamily,
            ...(atRotate ? { rotate: atRotate } : {}),
            ...(atBold ? { bold: true } : {}),
            ...(atItalic ? { italic: true } : {}),
            // The fit indicator MUST measure with the same kerning the commit
            // will use, or the card could promise a fit the commit breaks.
            ...(atKern ? {} : { kern: false }),
            // 9.K2: measure with the SAME features the commit applies — small
            // caps change advances, so a plain measurement could promise a fit
            // the small-caps commit then breaks (the K1 kerning discipline).
            ...(atSmallCaps || atAlternates
              ? {
                  features: [
                    ...(atSmallCaps ? ['small_caps'] : []),
                    ...(atAlternates ? ['salt'] : []),
                  ],
                  ...(atAlternates ? { alt_index: atAltIndex } : {}),
                }
              : {}),
          })) as { fits?: boolean };
          if (!stale) setAtFits(typeof res?.fits === 'boolean' ? res.fits : null);
        } catch {
          if (!stale) setAtFits(null);
        }
      })();
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [
    liveAddTextPlacement,
    atText,
    atSize,
    atFamily,
    atRotate,
    atBold,
    atItalic,
    atKern,
    atSmallCaps,
    atAlternates,
    atAltIndex,
    docs,
    state.files,
    engineCall,
  ]);

  const createPlacedText = useCallback(async (): Promise<void> => {
    await commitAddText({
      text: atText,
      size: atSize,
      color: hexToRgb(atColor) ?? [0, 0, 0],
      family: atFamily,
      rotate: atRotate,
      bold: atBold,
      italic: atItalic,
      kern: atKern,
      smallCaps: atSmallCaps,
      alternates: atAlternates,
      altIndex: atAltIndex,
    }).catch(() => undefined); // surfaced via atError; the card stays open
  }, [
    commitAddText,
    atText,
    atSize,
    atColor,
    atFamily,
    atRotate,
    atBold,
    atItalic,
    atKern,
    atSmallCaps,
    atAlternates,
    atAltIndex,
  ]);

  // Bake pending values file by file through App's fill op. Reentrancy-ref'd
  // like applyMarks (two clicks in one tick both read a stale busy flag).
  const fillingRef = useRef(false);
  const applyFormValues = useCallback(async (): Promise<string[]> => {
    if (fillingRef.current) return [];
    const snapshot = pendingFormValues;
    if (snapshot.size === 0) return [];
    fillingRef.current = true;
    setFillingForms(true);
    setFormsError(null);
    try {
      const failures: string[] = [];
      for (const [path, values] of snapshot) {
        try {
          await onFillFormValues(path, Object.fromEntries(values));
          // Applied — drop this file's pending values (the re-read will show
          // them as the fields' current values).
          setPendingFormValues((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
        } catch (err) {
          const name = path.split(/[\\/]/).pop() || path;
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        setFormsError(`Filling failed — ${failures.join('; ')}. Those values are still pending.`);
      }
      return failures;
    } finally {
      fillingRef.current = false;
      setFillingForms(false);
    }
  }, [pendingFormValues, onFillFormValues]);

  // Workspace-flattened page order (doc order, then page order) — the basis
  // for workspace-order group moves (selection semantics themselves moved
  // into the reducer with the ui slice). Refs keep the harness registration
  // stable while reading the latest order/selection.
  const flatOrder = useMemo(() => docs.flatMap((d) => d.pages.map((p) => p.id)), [docs]);
  const flatOrderRef = useRef(flatOrder);
  flatOrderRef.current = flatOrder;
  const selectionRef = useRef(selectedPageIds);
  selectionRef.current = selectedPageIds;

  // Keyboard shortcuts (Escape chain, Ctrl+F, select-all/delete/rotate/zoom)
  // are owned by the app-level keymap dispatcher now (commands/keymap.ts) —
  // the canvas registers its camera + find services for the commands instead
  // of its own window listeners (Phase 4 M1).
  const findRef = useRef(find);
  findRef.current = find;
  const jumpToPageRef = useRef(jumpToPage);
  jumpToPageRef.current = jumpToPage;
  const docsForJumpRef = useRef(docs);
  docsForJumpRef.current = docs;
  const openPageForReadingRef = useRef<(pageId: string) => void>(() => {});
  useEffect(() => {
    registerCanvasServices({
      canvas: () => activeCanvasHandle(),
      // Cross-document-aware jump. Panels MUST use this rather than
      // `canvas().centerOn` — the reading view shows one document, so centring
      // a page in another one silently does nothing.
      jumpToPage: (pageId) => jumpToPageRef.current(pageId),
      // Number → id resolution lives HERE, against live docs (§ F: ids
      // are opaque; only workspace state knows the page). Resolution is
      // by SOURCE identity — a bookmark's number addresses the file's
      // on-disk order, so the jump lands on that physical page even
      // while a reorder is pending (review-caught: array-order counting
      // silently jumped to the wrong page).
      jumpToFilePage: (path, pageNumber) => {
        const id = pageIdAtSourceIndex(docsForJumpRef.current, path, pageNumber);
        if (id) jumpToPageRef.current(id);
        return !!id;
      },
      openPageForReading: (pageId) => openPageForReadingRef.current(pageId),
      find: {
        isOpen: () => findRef.current.open,
        open: () => findRef.current.openFind(),
        openWith: (q, pageId, options) => findRef.current.openWith(q, pageId, options),
        close: () => findRef.current.closeFind(),
        next: () => findRef.current.next(),
        prev: () => findRef.current.prev(),
      },
      goToPage: () => {
        const el = pageBoxRef.current;
        if (!el) return false;
        el.focus();
        return true;
      },
    });
    return () => registerCanvasServices(null);
  }, [activeCanvasHandle]);

  const clearSelection = useCallback(
    () => dispatch({ type: 'UI_CLEAR_SELECTION' }),
    [dispatch],
  );

  // e2e harness for multi-select (2n.1): modifier-click selection and the
  // pointer-capture group drag aren't reliably WebDriver-drivable, so the
  // canvas registers selection setters/readers + the batched delete/rotate
  // command paths here, mirroring the redaction/signature/OCR hooks.
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasSelection({
      selectPageIds: (ids) =>
        dispatch({ type: 'UI_SET_SELECTION', pageIds: ids, anchor: ids[ids.length - 1] ?? null }),
      getSelectedPageIds: () => [...selectionRef.current],
      getWorkspacePageIds: () => [...flatOrderRef.current],
      deleteSelected: () => void invokeCommand('document.deleteSelection'),
      rotateSelected: (delta) =>
        void invokeCommand(
          delta === 90 ? 'document.rotateSelectionCW' : 'document.rotateSelectionCCW',
        ),
    });
    return () => registerCanvasSelection(null);
  }, [dispatch]);

  const onAddAnnotation = useCallback(
    (docId: string, pageId: string, annotation: PageAnnotation) =>
      dispatch({ type: 'ADD_ANNOTATION', docId, pageId, annotation }),
    [dispatch],
  );

  const onUpdateAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, note: string) =>
      dispatch({ type: 'UPDATE_ANNOTATION', docId, pageId, annotationId, note }),
    [dispatch],
  );

  const onRecolorAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, color: string) =>
      dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color }),
    [dispatch],
  );

  const onRemoveAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string) =>
      dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId }),
    [dispatch],
  );

  // Marks whose page still exists in the workspace — a deleted page's marks
  // drop out of the count and the apply payload rather than being guessed at.
  const liveMarks = useMemo(() => {
    if (marks.length === 0) return NO_MARKS;
    return marks.filter((m) => docs.some((d) => d.pages.some((p) => p.id === m.pageId)));
  }, [marks, docs]);

  const redactionMarksByPage = useMemo(() => {
    if (liveMarks.length === 0) return NO_MARKS_BY_PAGE;
    const map = new Map<string, RedactionMark[]>();
    for (const m of liveMarks) {
      const arr = map.get(m.pageId);
      if (arr) arr.push(m);
      else map.set(m.pageId, [m]);
    }
    return map;
  }, [liveMarks]);

  const onAddRedactionMark = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      setMarks((prev) => [
        ...prev,
        { id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw },
      ]);
    },
    [docs],
  );

  const onRemoveRedactionMark = useCallback(
    (markId: string) => setMarks((prev) => prev.filter((m) => m.id !== markId)),
    [],
  );

  // Single pending placement — drawing again anywhere replaces it. Placement
  // gestures are mutually exclusive: starting a signature placement clears a
  // pending new-field placement (and vice versa) so only one bottom-left
  // card is ever live.
  const onSetSignaturePlacement = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      // Anchor only to CURRENT ids — the onSetNewFieldRect rule (2n.4c /
      // Phase 9, round 24 tail): a placement drawn against docs indexed from
      // a superseded buffer is stillborn — refuse rather than arm it.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      setSigPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setNewFieldPlacement(null);
      setAddTextPlacement(null); // one placement card at a time (9.A2)
      setSigFieldTarget(null);
      setSignDone(null);
      setSignError(null);
    },
    [docs, state.files],
  );
  const onClearSignaturePlacement = useCallback(() => setSigPlacement(null), []);

  // Clicking an empty signature widget in forms mode targets it (2n.4d). The
  // early pending-page-edits notice mirrors the hard check in applySignature.
  const onSignFieldRequest = useCallback(
    (path: string, fieldName: string) => {
      setSigFieldTarget({ path, fieldName });
      setSigPlacement(null);
      setNewFieldPlacement(null);
      setAddTextPlacement(null); // one card at a time — incl. the Add-Text card (9.A2)
      setSignDone(null);
      setSignError(
        state.pageDirtyPaths.includes(path)
          ? 'Apply the pending page changes first, then sign the field.'
          : null,
      );
    },
    [state.pageDirtyPaths],
  );

  // Placement whose page still exists (a deleted page's placement is inert,
  // surfaced as such rather than guessed at).
  const liveSigPlacement = useMemo(() => {
    if (!sigPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === sigPlacement.pageId)) ? sigPlacement : null;
  }, [sigPlacement, docs]);

  // Invalidate marks when their file's bytes change underneath them (commit,
  // whole-file op, undo, reopen) or the file closes. PageRef ids are
  // positional (`path#pN`), so after a reindex a surviving mark could bind to
  // a DIFFERENT physical page — for a destructive tool, dropping the marks is
  // the only safe answer. Buffer identity is exactly what the indexer keys
  // on, so this fires precisely when the workspace is about to be rebuilt.
  const lastBuffersRef = useRef<Map<string, PdfBuffer | null>>(new Map());
  useEffect(() => {
    const current = new Map<string, PdfBuffer | null>();
    for (const [path, f] of state.files) current.set(path, f.buffer);
    const prev = lastBuffersRef.current;
    lastBuffersRef.current = current;
    const invalidated = new Set<string>();
    for (const [path, buf] of current) {
      if (prev.has(path) && prev.get(path) !== buf) invalidated.add(path);
    }
    for (const path of prev.keys()) {
      if (!current.has(path)) invalidated.add(path); // closed — a later reopen reuses the same positional ids
    }
    if (invalidated.size > 0) {
      setMarks((prevMarks) => prevMarks.filter((m) => !invalidated.has(m.path)));
      setSigPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // New-field placement shares the positional-id hazard — same lifecycle.
      setNewFieldPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // A buffer change can rename/remove fields — a name-keyed sign target
      // must not survive it (the user re-clicks the widget, which re-reads).
      setSigFieldTarget((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // Add-Text placement (9.A2): the SAME `bakedRotate + rotationAtDraw`
      // hazard the sig/new-field placements are cleared for. rotationAtDraw is
      // frozen at draw; bakedRotate is re-fetched fresh at commit. A page-tier
      // rotate that gets baked into /Rotate by a commit changes bakedRotate
      // underneath a placement whose rotationAtDraw is stale — so the authored
      // text would land at the wrong orientation. Durable identity keeps the
      // pageId alive across the authored commit (so `liveAddTextPlacement`'s
      // existence check does NOT drop it — this is the one placement that
      // survives), which is exactly why it must be force-cleared here.
      setAddTextPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // (Selection shares the positional-id hazard; it lives in the ui slice
      // now and the reducer clears it wherever buffers change.)
    }
  }, [state.files]);

  // Find overlays: matching pages, and per-word boxes where OCR words exist.
  const findMatchPageIds = find.active ? find.result.pageIds : NO_PAGE_IDS;
  const findWordsByPage = useMemo(() => {
    if (!find.active || find.result.pageIds.size === 0) return NO_WORDS_BY_PAGE;
    if (!normalizeQuery(find.matchedQuery)) return NO_WORDS_BY_PAGE;
    const map = new Map<string, OcrWord[]>();
    for (const doc of docs) {
      for (const page of doc.pages) {
        if (!find.result.pageIds.has(page.id)) continue;
        const words = searchIndex.getOcrWords(sourceKeyOf(page));
        if (!words) continue;
        // Per-token match (multi-word queries would never match a single
        // whitespace-free OCR word otherwise).
        const hits = highlightWords(words, find.matchedQuery, find.matchedOptions);
        if (hits.length > 0) map.set(page.id, hits);
      }
    }
    return map.size > 0 ? map : NO_WORDS_BY_PAGE;
  }, [find.active, find.result, find.matchedQuery, find.matchedOptions, docs, searchIndex]);

  const ocrReady = searchIndex.ocrReadySources();

  const applyingOcrRef = useRef(false);
  const handleApplyOcr = useCallback(async (): Promise<string[]> => {
    if (applyingOcrRef.current) return [];
    applyingOcrRef.current = true;
    setApplyingOcr(true);
    setOcrApplyError(null);
    try {
      const sources = searchIndex.ocrReadySources();
      const { files: payloads, skippedSources } = await buildOcrApplyPayload(
        docs,
        sources,
        searchIndex.getOcrWords,
        async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        },
      );
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          await onApplyOcrLayer(payload.path, payload.pages);
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // A source dropped between the ready-snapshot and its turn (page
      // closed/moved, or its OCR invalidated mid-run) must be surfaced, not
      // silently skipped — the user thinks every scanned page was persisted.
      if (skippedSources.length > 0) {
        failures.push(`${skippedSources.length} scanned page(s) skipped (no longer available)`);
      }
      if (payloads.length === 0 && skippedSources.length === 0) {
        failures.push('no OCR-ready pages to apply');
      }
      if (failures.length > 0) {
        setOcrApplyError(`Applying OCR text failed — ${failures.join('; ')}`);
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOcrApplyError(`Applying OCR text failed — ${msg}`);
      return [msg];
    } finally {
      applyingOcrRef.current = false;
      setApplyingOcr(false);
    }
  }, [docs, state.files, searchIndex, onApplyOcrLayer]);

  // --- Edit ▸ Images (7.1): placements + selection --------------------------
  // Placements come from the engine per page of the FOCUSED document (the
  // reading view's document; the board shows its outlines too — the
  // documented 7.1 scope). The mode's entry flushes pending page edits so the
  // engine's committed order matches what's displayed, then listings load
  // incrementally (one cheap engine call per page) under a token that drops
  // stale batches — the batch-OCR selectSource race lesson, applied here from
  // the start. Buffer identity in the deps refetches after every edit/undo.
  const [editImagesByPage, setEditImagesByPage] =
    useState<ReadonlyMap<string, EditImagePlacement[]>>(NO_EDIT_IMAGES);
  // 9.D1: per-page vector path objects, filled by the same edit-listing pass.
  const [editVectorsByPage, setEditVectorsByPage] =
    useState<ReadonlyMap<string, EditVectorObject[]>>(NO_EDIT_VECTORS);
  // The selected vector object (one at a time), or null. Its own state —
  // decoupled from the image transform selection (`editSel`).
  const [selectedVector, setSelectedVector] = useState<{ pageId: string; index: number } | null>(
    null,
  );
  // Per-page {box, bakedRotate} for the image pages — the C1 transform gesture
  // needs it to convert pointer↔user space; filled alongside editImagesByPage.
  const [editGeomByPage, setEditGeomByPage] =
    useState<ReadonlyMap<string, PageGeometry>>(NO_EDIT_GEOM);
  const [editTextByPage, setEditTextByPage] =
    useState<ReadonlyMap<string, EditTextListing>>(NO_EDIT_TEXT);
  // ONE selection across all edit-object kinds — the secondary toolbar's
  // actions key off the kind. 'para' (7.5) is the primary text surface;
  // 'text' survives for runs outside any editable paragraph.
  const [editSel, setEditSel] = useState<{
    kind: 'image' | 'text' | 'para';
    pageId: string;
    index: number;
  } | null>(null);
  // The ONE open inline editor — a run's or a paragraph's; the input
  // itself lives in PageCell (local value state, validated live).
  const [editingText, setEditingText] = useState<{
    kind: 'text' | 'para';
    pageId: string;
    index: number;
  } | null>(null);
  const editFetchTokenRef = useRef(0);
  const editBuffer = focusedDoc ? state.files.get(focusedDoc.path)?.buffer : undefined;
  // The DESTRUCTIVE clears (selection + the open editor with the user's
  // typed text) fire only when the edit context truly changed — tool,
  // focused document, or ITS buffer. `docs`/`state.files` are whole-
  // workspace identities that churn when ANY open file reindexes or
  // reloads; an unconditional clear on every rerun silently destroyed an
  // in-progress edit because of an unrelated file's op (review-caught
  // CRITICAL). Those reruns still refetch listings (ordering can shift);
  // they just stop closing the editor.
  const prevEditCtxRef = useRef<{ tool: unknown; docId: unknown; buffer: unknown; path: unknown }>(
    { tool: null, docId: null, buffer: null, path: null },
  );
  // C1-tail (keep selection across a transform): count-PRESERVING image
  // ops (transform/rotate/crop/opacity/replace) stash {pageNumber, index}
  // at commit; when the post-op refetch lands (page ids regenerated —
  // the non-authored-rebuild rule), the effect below re-selects the same
  // placement so chained nudges need no re-click. Delete/extract never
  // stash (the index dies / nothing changes); declines and failures
  // clear it.
  const imageReselectRef = useRef<{ pageNumber: number; index: number } | null>(null);
  // 9.D2 (round-37 MED): the same reselect stash for a vector transform — a
  // whole-file op regenerates every page id, so the pre-op selectedVector id
  // is dead; this re-selects the object on its page once the fresh listing
  // lands, so chained move/resize/rotate (and a follow-up delete) need no
  // re-click. Same lifecycle as imageReselectRef.
  const vectorReselectRef = useRef<{ pageNumber: number; index: number } | null>(null);
  useEffect(() => {
    const token = ++editFetchTokenRef.current;
    const prev = prevEditCtxRef.current;
    const ctxChanged =
      prev.tool !== tool || prev.docId !== (focusedDoc?.id ?? null) || prev.buffer !== editBuffer;
    // The reselect stash dies ONLY on a tool or FILE (path) change. Not
    // on buffer identity, not on doc id: a commit lands as TWO passes
    // here (bytes first with the old id, then the reindex's regenerated
    // id with the same bytes — instrumented, not assumed), so any rule
    // keyed on those terms kills the stash mid-flight (e2e-caught, three
    // designs deep — buffer term, docId term, then a bytes-vs-id
    // discriminator that the two-pass anatomy defeats). Path is the
    // durable file identity across generations (ids stay opaque — never
    // parsed); the manifest-partition corner this leaves open is safe
    // because `workspacePageNumber` is FILE-level — same-path partitions
    // occupy disjoint number ranges, so a lingering stash can only ever
    // re-match its own physical page.
    const toolOrPathChanged = prev.tool !== tool || prev.path !== (focusedDoc?.path ?? null);
    prevEditCtxRef.current = {
      tool,
      docId: focusedDoc?.id ?? null,
      buffer: editBuffer,
      path: focusedDoc?.path ?? null,
    };
    if (ctxChanged) {
      setEditSel(null);
      setEditingText(null);
      if (toolOrPathChanged) imageReselectRef.current = null;
    }
    if (toolOrPathChanged) {
      setSelectedVector(null);
      vectorReselectRef.current = null;
    }
    if (tool !== 'edit' || !focusedDoc || !editBuffer) {
      setEditImagesByPage(NO_EDIT_IMAGES);
      setEditVectorsByPage(NO_EDIT_VECTORS);
      setEditGeomByPage(NO_EDIT_GEOM);
      setEditTextByPage(NO_EDIT_TEXT);
      setSelectedVector(null);
      if (ctxChanged) setEditNotice(null);
      return;
    }
    const doc = focusedDoc;
    void (async () => {
      try {
        await runCommitGate();
      } catch {
        return; // gate failure surfaces on the commit banner; no overlays
      }
      if (editFetchTokenRef.current !== token) return;
      const f = state.files.get(doc.path);
      if (!f?.buffer) return;
      const proxy = await getDocumentProxy(doc.path, f.buffer);
      // Seed from the CURRENT listings when the context did NOT change:
      // rebuilding from empty published a gap window per page (two engine
      // round-trips each), during which an OPEN editor's page had no
      // listing — React unmounted the editor and re-seeded it from
      // pre-edit text, silently discarding the user's typing
      // (review-caught CRITICAL; the ctxChanged guard alone only stopped
      // the explicit clears). Stale-by-a-pass entries are safe here
      // precisely because ctxChanged=false means these bytes didn't
      // change; a REAL context change still starts empty (the 7.1
      // stale-index discipline). Per-page deletes below prune pages
      // whose fresh listing came back empty.
      const validIds = new Set(doc.pages.map((p) => p.id));
      const seed = <V,>(current: ReadonlyMap<string, V>): Map<string, V> => {
        const m = new Map<string, V>();
        for (const [k, v] of current) if (validIds.has(k)) m.set(k, v);
        return m;
      };
      const nextImages = ctxChanged
        ? new Map<string, EditImagePlacement[]>()
        : seed(editImagesRef.current);
      const nextVectors = ctxChanged
        ? new Map<string, EditVectorObject[]>()
        : seed(editVectorsRef.current);
      const nextText = ctxChanged
        ? new Map<string, EditTextListing>()
        : seed(editTextRef.current);
      // Geometry is derived (not user state), so it's rebuilt fresh each pass —
      // no seeding needed; a page's entry lands the moment its placements do.
      const nextGeom = new Map<string, PageGeometry>();
      for (const page of doc.pages) {
        if (editFetchTokenRef.current !== token) return;
        const pageNumber = workspacePageNumber(docs, doc, page.id);
        if (pageNumber == null) continue;
        try {
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          const geometry = {
            box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            bakedRotate: p.rotate,
          };
          const call = (m: string, params: Record<string, unknown>): Promise<unknown> =>
            engineCall(m, params);
          const placements = await fetchEditPlacements(call, f.workingPath, pageNumber, geometry);
          if (editFetchTokenRef.current !== token) return;
          const vectors = await fetchEditVectors(call, f.workingPath, pageNumber, geometry);
          if (editFetchTokenRef.current !== token) return;
          const listing = await fetchEditTextListing(call, f.workingPath, pageNumber, geometry);
          if (editFetchTokenRef.current !== token) return;
          if (placements.length > 0) {
            nextImages.set(page.id, placements);
            nextGeom.set(page.id, geometry);
          } else {
            nextImages.delete(page.id);
            nextGeom.delete(page.id);
          }
          if (vectors.length > 0) nextVectors.set(page.id, vectors);
          else nextVectors.delete(page.id);
          // Geometry is needed whenever EITHER images or vectors exist.
          if (vectors.length > 0) nextGeom.set(page.id, geometry);
          setEditImagesByPage(new Map(nextImages)); // incremental fill
          setEditVectorsByPage(new Map(nextVectors));
          setEditGeomByPage(new Map(nextGeom));
          // C1-tail: restore the stashed selection when ITS page's fresh
          // listing lands. Matched on sourcePageIndex, NOT the recomputed
          // tier position — a concurrent page-strip drag reorders tier
          // positions mid-flight while sourcePageIndex stays the physical
          // file slot (round 28 MEDIUM). The stash PERSISTS across passes
          // (round 28 HIGH: a commit's buffer pass and its reindex pass
          // each wipe editSel; a one-shot consume restored on the first
          // pass only for the second to wipe it) — restoring is idempotent
          // (the functional ?? keeps any user pick), and the stash dies on
          // tool/path change, decline/error, a USER selection (the
          // handleSelect*/open-editor/harness kills), or its target index
          // vanishing from its page.
          const stash = imageReselectRef.current;
          if (stash && page.sourcePageIndex === stash.pageNumber - 1) {
            if (placements.some((pl) => pl.index === stash.index)) {
              setEditSel(
                (prevSel) =>
                  prevSel ?? { kind: 'image' as const, pageId: page.id, index: stash.index },
              );
            } else {
              imageReselectRef.current = null;
            }
          }
          // 9.D2 (round-37 MED): the same idempotent reselect for a vector
          // transform — restore selectedVector to the moved object on its
          // fresh-id page (the functional ?? keeps any user pick).
          const vstash = vectorReselectRef.current;
          if (vstash && page.sourcePageIndex === vstash.pageNumber - 1) {
            if (vectors.some((v) => v.index === vstash.index)) {
              setSelectedVector((prev) => prev ?? { pageId: page.id, index: vstash.index });
            } else {
              vectorReselectRef.current = null;
            }
          }
          if (listing.runBoxes.length > 0 || listing.paragraphs.length > 0) {
            nextText.set(page.id, listing);
          } else {
            nextText.delete(page.id);
          }
          setEditTextByPage(new Map(nextText));
        } catch {
          // One page's listing failing (odd stream) must not kill the mode —
          // that page simply offers no outlines.
        }
      }
      if (editFetchTokenRef.current === token) {
        setEditImagesByPage(new Map(nextImages));
        setEditGeomByPage(new Map(nextGeom));
        setEditTextByPage(new Map(nextText));
      }
    })();
  }, [tool, focusedDoc, editBuffer, docs, state.files, engineCall]);

  // A mutation's status line (neutral notice or red error) + in-flight flag.
  // Renderer-side failures (decode, IO) would otherwise vanish as unhandled
  // rejections with zero UI — engine failures already surface via the op
  // queue, this covers the rest (review-caught).
  const [editNotice, setEditNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // Ref, not state: two commits in one tick (the unmount-blur refire when
  // React removes the focused input) both read a STALE editBusy closure —
  // the applyingRef/signingRef rule this file already follows everywhere
  // else (review-caught). Declared here because the OPEN handlers gate on
  // it too (no new editor while a commit is in flight).
  const committingTextRef = useRef(false);

  const handleSelectEditImage = useCallback((pageId: string, index: number) => {
    imageReselectRef.current = null; // a user pick owns selection now
    setEditNotice(null);
    setEditingText(null);
    setEditSel((prev) =>
      prev?.kind === 'image' && prev.pageId === pageId && prev.index === index
        ? null
        : { kind: 'image', pageId, index },
    );
  }, []);

  const handleSelectEditText = useCallback((pageId: string, index: number) => {
    imageReselectRef.current = null; // a user pick owns selection now
    setEditNotice(null);
    setEditingText(null);
    setEditSel((prev) =>
      prev?.kind === 'text' && prev.pageId === pageId && prev.index === index
        ? null
        : { kind: 'text', pageId, index },
    );
  }, []);

  // 9.D1: select a vector object (toggle off on re-click). Its own selection
  // state, independent of the image/text `editSel`.
  const handleSelectEditVector = useCallback((pageId: string, index: number) => {
    setEditNotice(null);
    vectorReselectRef.current = null; // a user pick owns selection now
    setSelectedVector((prev) =>
      prev && prev.pageId === pageId && prev.index === index ? null : { pageId, index },
    );
  }, []);

  // 9.D1: delete the selected vector object (undoable, App-routed). On success
  // the selection clears — the object is gone and the surviving ordinals
  // renumber, so a stale index must never linger.
  const handleDeleteVector = useCallback(async () => {
    if (!selectedVector || !focusedDoc || editBusy) return;
    const { pageId, index } = selectedVector;
    const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
    if (pageNumber == null) return;
    vectorReselectRef.current = null; // the object vanishes; ordinals renumber
    setEditBusy(true);
    setEditNotice(null);
    try {
      const notice = await onEditVector('delete', focusedDoc.path, pageNumber, index);
      if (notice === EDIT_DECLINED) {
        setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
      } else {
        setSelectedVector(null);
      }
    } catch (err) {
      setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setEditBusy(false);
    }
  }, [selectedVector, focusedDoc, docs, onEditVector, editBusy]);

  // 9.D2: commit a move/resize/rotate — the transform overlay produces the
  // target placement matrix M' (device space). The whole-file op rebuilds the
  // page, so re-fetch drops the selection like every other vector op; a second
  // gesture re-derives from the re-listed bbox (the C1 "rebuild → re-select"
  // shape). No committingTextRef churn — the overlay's own busy gate blocks a
  // second gesture mid-commit.
  const commitVectorTransform = useCallback(
    async (pageId: string, index: number, matrix: number[]): Promise<void> => {
      if (!focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      setEditBusy(true);
      setEditNotice(null);
      // Stash for the post-op reselect (the rebuild regenerates page ids).
      vectorReselectRef.current = { pageNumber, index };
      try {
        const notice = await onEditVector('transform', focusedDoc.path, pageNumber, index, {
          matrix,
        });
        if (notice === EDIT_DECLINED) {
          setEditNotice({
            text: 'Edit cancelled — the document was left unchanged.',
            error: false,
          });
        }
      } catch (err) {
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditVector, editBusy],
  );

  // 9.D3: recolour / re-width a vector object. The whole-file op rebuilds the
  // page, so it reselects like a transform (the same stash).
  const commitVectorRestyle = useCallback(
    async (
      pageId: string,
      index: number,
      opts: {
        fill?: [number, number, number];
        stroke?: [number, number, number];
        lineWidth?: number;
      },
    ): Promise<void> => {
      if (!focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      setEditBusy(true);
      setEditNotice(null);
      vectorReselectRef.current = { pageNumber, index };
      try {
        const notice = await onEditVector('restyle', focusedDoc.path, pageNumber, index, opts);
        if (notice === EDIT_DECLINED) {
          setEditNotice({
            text: 'Edit cancelled — the document was left unchanged.',
            error: false,
          });
        }
      } catch (err) {
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditVector, editBusy],
  );

  const handleOpenTextEditor = useCallback(
    (pageId: string, index: number) => {
      // Same busy gate as the paragraph editor (see its comment).
      if (editBusy || committingTextRef.current) return;
      const run = editTextByPage.get(pageId)?.runBoxes.find((r) => r.index === index);
      if (!run) return;
      imageReselectRef.current = null; // a user pick owns selection now
      if (!run.editable) {
        // The refusal SELECTS the run too — the toolbar must reflect what
        // was just clicked, not a previous image selection (review-caught).
        setEditSel({ kind: 'text', pageId, index });
        setEditNotice({ text: run.reason ?? 'This text is not editable.', error: true });
        return;
      }
      setEditNotice(null);
      setEditSel({ kind: 'text', pageId, index });
      setEditingText({ kind: 'text', pageId, index });
    },
    [editTextByPage, editBusy],
  );

  const handleSelectEditParagraph = useCallback((pageId: string, index: number) => {
    imageReselectRef.current = null; // a user pick owns selection now
    setEditNotice(null);
    setEditingText(null);
    setEditSel((prev) =>
      prev?.kind === 'para' && prev.pageId === pageId && prev.index === index
        ? null
        : { kind: 'para', pageId, index },
    );
  }, []);

  const handleOpenParagraphEditor = useCallback(
    (pageId: string, index: number) => {
      // While a commit is in flight a NEW editor's Enter would be
      // silently swallowed by committingTextRef — refuse to open one
      // instead (review-caught; the busy hint is already visible).
      if (editBusy || committingTextRef.current) return;
      const para = editTextByPage.get(pageId)?.paragraphs.find((p) => p.index === index);
      if (!para) return; // only editable paragraphs are listed
      imageReselectRef.current = null; // a user pick owns selection now
      setEditNotice(null);
      setEditSel({ kind: 'para', pageId, index });
      setEditingText({ kind: 'para', pageId, index });
    },
    [editTextByPage, editBusy],
  );

  const handleCancelTextEdit = useCallback(() => setEditingText(null), []);

  const handleCommitTextEdit = useCallback(
    async (
      pageId: string,
      index: number,
      newText: string,
      opts?: { convert?: boolean },
    ): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      // Same stale-window discipline as image mutations: this page's runs
      // are about to change identity — drop them synchronously, but keep
      // the old value so a DECLINED signed-doc warning (no buffer change,
      // no refetch) can put it back instead of leaving the run invisibly
      // gone (review-caught: indistinguishable from success).
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prev) => {
        const next = new Map(prev);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onEditText(focusedDoc.path, pageNumber, index, newText, opts);
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prev) => {
              const next = new Map(prev);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prev) => {
            const next = new Map(prev);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onEditText],
  );

  const handleCommitParagraphEdit = useCallback(
    async (
      pageId: string,
      index: number,
      newText: string,
      opts?: ParagraphEditOpts,
    ): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const para = editTextByPage.get(pageId)?.paragraphs.find((p) => p.index === index);
      if (!para) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      const spans = computeEditSpans(para.text, newText, para.spans);
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prev) => {
        const next = new Map(prev);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onEditParagraph(
          focusedDoc.path,
          pageNumber,
          { index: para.index, runs: para.runs, text: para.text },
          newText,
          spans,
          opts,
        );
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prev) => {
              const next = new Map(prev);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prev) => {
            const next = new Map(prev);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onEditParagraph],
  );

  // A4: merge the edited paragraph into the one above (fires only from an
  // unchanged editor at caret 0 — the editor enforces that). Same commit
  // shape as handleCommitParagraphEdit: close editor, drop the page's stale
  // listing synchronously, restore on decline/error.
  const handleMergeParagraphPrev = useCallback(
    async (pageId: string, index: number): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const listing = editTextByPage.get(pageId);
      const cur = listing?.paragraphs.find((p) => p.index === index);
      const prevPara = listing?.paragraphs.find((p) => p.index === index - 1);
      if (!cur || !prevPara) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prevMap) => {
        const next = new Map(prevMap);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onMergeParagraph(
          focusedDoc.path,
          pageNumber,
          { index: prevPara.index, runs: prevPara.runs, text: prevPara.text },
          { index: cur.index, runs: cur.runs, text: cur.text },
        );
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prevMap) => {
              const next = new Map(prevMap);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
        } else if (typeof result === 'string') {
          setEditNotice({ text: result, error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prevMap) => {
            const next = new Map(prevMap);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onMergeParagraph],
  );

  const runEditAction = useCallback(
    async (
      kind: 'delete' | 'replace' | 'extract' | 'crop' | 'opacity',
      opts?: Parameters<typeof onEditImage>[4],
    ): Promise<void> => {
      if (!editSel || editSel.kind !== 'image' || !focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, editSel.pageId);
      if (pageNumber == null) return;
      const target = editSel;
      setEditBusy(true);
      setEditNotice(null);
      // Count-preserving kinds re-select after the rebuild; delete's
      // index dies with the placement and extract changes nothing.
      imageReselectRef.current =
        kind === 'replace' || kind === 'crop' || kind === 'opacity'
          ? { pageNumber, index: target.index }
          : null;
      const previousPlacements = editImagesByPage.get(target.pageId);
      if (kind !== 'extract') {
        // Indexes shift under a delete; the refetch is a per-page engine
        // round-trip away. Drop this page's stale boxes SYNCHRONOUSLY so a
        // click in the window can't target the wrong image (review-caught:
        // delete index 0 of three, click the still-drawn old box for what
        // is now a different placement).
        setEditSel(null);
        setEditImagesByPage((prev) => {
          const next = new Map(prev);
          next.delete(target.pageId);
          return next;
        });
      }
      try {
        const notice = await onEditImage(kind, focusedDoc.path, pageNumber, target.index, opts);
        if (notice === EDIT_DECLINED) {
          imageReselectRef.current = null;
          // Declined signed-doc warning: no buffer change, no refetch —
          // restore the synchronously-dropped placements and say so
          // (review-caught: silence read as success).
          if (kind !== 'extract' && previousPlacements) {
            setEditImagesByPage((prev) => {
              const next = new Map(prev);
              next.set(target.pageId, previousPlacements);
              return next;
            });
          }
          setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
        } else if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
      } catch (err) {
        imageReselectRef.current = null;
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        setEditBusy(false);
      }
    },
    [editSel, focusedDoc, docs, onEditImage, editBusy, editImagesByPage],
  );

  // The selected image's transform context (9.C1): its user-space matrix + the
  // page geometry the gesture needs to convert pointer↔user space. Null unless
  // an image is selected AND its page geometry is loaded.
  const editImageTransform = useMemo(() => {
    if (!editSel || editSel.kind !== 'image') return null;
    const placement = editImagesByPage
      .get(editSel.pageId)
      ?.find((pl) => pl.index === editSel.index);
    const geom = editGeomByPage.get(editSel.pageId);
    if (!placement || !geom) return null;
    return {
      pageId: editSel.pageId,
      index: editSel.index,
      matrix: placement.matrix,
      crop: placement.crop,
      box: geom.box,
      bakedRotate: geom.bakedRotate,
      busy: editBusy,
    };
  }, [editSel, editImagesByPage, editGeomByPage, editBusy]);

  // 9.D2: the selected vector's transform context — the SAME shape the image
  // transform overlay consumes (reused directly), with the object's bbox as a
  // unit-square placement matrix [w,0,0,h,x0,y0] and no crop (vectors don't
  // crop). Null unless a vector is selected on a page with known geometry.
  const vectorTransform = useMemo(() => {
    if (!selectedVector) return null;
    const obj = editVectorsByPage
      .get(selectedVector.pageId)
      ?.find((v) => v.index === selectedVector.index);
    const geom = editGeomByPage.get(selectedVector.pageId);
    if (!obj || !geom) return null;
    const [x0, y0, x1, y1] = obj.userRect;
    return {
      pageId: selectedVector.pageId,
      index: selectedVector.index,
      matrix: [x1 - x0, 0, 0, y1 - y0, x0, y0] as [number, number, number, number, number, number],
      crop: null,
      box: geom.box,
      bakedRotate: geom.bakedRotate,
      busy: editBusy,
    };
  }, [selectedVector, editVectorsByPage, editGeomByPage, editBusy]);

  // Commit a transform gesture (9.C1). M' is user-space and /Rotate-invariant
  // (the redaction-mark rule), so the commit gate baking a pending page
  // rotation can't invalidate it — no re-projection needed, unlike A2's
  // signature placement. The whole-file op rebuilds the page (positional ids
  // regenerate); the reselect stash restores the selection when the fresh
  // listing lands, so chained nudges need no re-click (the shipped C-tail).
  const commitImageTransform = useCallback(
    async (pageId: string, index: number, matrix: number[]): Promise<void> => {
      if (!focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      setEditBusy(true);
      setEditNotice(null);
      imageReselectRef.current = { pageNumber, index };
      try {
        const notice = await onEditImage('transform', focusedDoc.path, pageNumber, index, {
          matrix,
        });
        if (notice === EDIT_DECLINED) {
          imageReselectRef.current = null;
          setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
        } else if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
      } catch (err) {
        imageReselectRef.current = null;
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditImage, editBusy],
  );

  // 9.C3: crop mode (toolbar toggle) — armed, the overlay's body drag draws
  // the crop band. Reset whenever the selection changes: a stale armed crop
  // on a fresh selection would surprise.
  const [imageCropArmed, setImageCropArmed] = useState(false);
  useEffect(() => {
    setImageCropArmed(false);
  }, [editSel]);

  // The overlay reports pageId/index explicitly; they always match the
  // selection (the overlay only renders for it) — verified, then routed
  // through runEditAction so busy/notice/stale-box handling is shared.
  const commitImageCrop = useCallback(
    (pageId: string, index: number, rect: [number, number, number, number]): void => {
      if (!editSel || editSel.kind !== 'image') return;
      if (editSel.pageId !== pageId || editSel.index !== index) return;
      setImageCropArmed(false);
      void runEditAction('crop', { rect });
    },
    [editSel, runEditAction],
  );

  // 9.C3: opacity commit (slider release) — same shared routing.
  const commitImageOpacity = useCallback(
    (value: number): void => {
      void runEditAction('opacity', { opacity: value });
    },
    [runEditAction],
  );

  // 9.C3: rotate-90 buttons — pure composition onto the committed matrix,
  // committed through the SHIPPED transform op (zero new engine surface).
  const rotateImage90 = useCallback(
    (dir: 1 | -1): void => {
      if (!editImageTransform || editImageTransform.busy) return;
      const m = applyRotate(
        editImageTransform.matrix as [number, number, number, number, number, number],
        (dir * Math.PI) / 2,
      );
      void commitImageTransform(editImageTransform.pageId, editImageTransform.index, [...m]);
    },
    [editImageTransform, commitImageTransform],
  );

  // C4: the selected placement's kind — replace/extract disable for an
  // inline draw (honest disable at the control, engine refusal as belt).
  const editImageKind = useMemo(() => {
    if (!editSel || editSel.kind !== 'image') return null;
    return (
      editImagesByPage.get(editSel.pageId)?.find((pl) => pl.index === editSel.index)?.kind ?? null
    );
  }, [editSel, editImagesByPage]);

  // The selected placement's current opacity — the slider's honest seed.
  const editImageOpacity = useMemo(() => {
    if (!editSel || editSel.kind !== 'image') return null;
    return (
      editImagesByPage.get(editSel.pageId)?.find((pl) => pl.index === editSel.index)?.opacity ?? 1
    );
  }, [editSel, editImagesByPage]);

  // 9.C2 Add Image: the band draws the box; convert display→user space
  // (buildSignatureAppearance, verbatim from A2) and hand it to App's
  // onAddImage, which picks the file and embeds. No card — the native picker
  // is the second step. Reentrancy-guarded (a modal pick blocks other edits
  // meanwhile; a cancelled pick just resets it).
  const addImageRef = useRef(false);
  const onAddImageRect = useCallback(
    async (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ): Promise<void> => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc || addImageRef.current || editBusy) return;
      addImageRef.current = true;
      setEditBusy(true);
      setEditNotice(null);
      try {
        const placement: SignaturePlacement = {
          id: crypto.randomUUID(),
          path: doc.path,
          pageId,
          rect,
          rotationAtDraw,
        };
        const built = await buildSignatureAppearance(docs, placement, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return {
            box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            bakedRotate: p.rotate,
          };
        });
        if (!built) throw new Error('The page this image was placed on no longer exists.');
        const notice = await onAddImage(built.path, built.appearance.page, built.appearance.rect);
        if (notice === EDIT_DECLINED) {
          setEditNotice({ text: 'Edit cancelled — the document was left unchanged.', error: false });
        } else if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
      } catch (err) {
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        addImageRef.current = false;
        setEditBusy(false);
      }
    },
    [docs, state.files, onAddImage, editBusy],
  );

  // Harness bridge for Edit ▸ Images + Text (7.1/7.2) — refs pattern.
  const editImagesRef = useRef(editImagesByPage);
  editImagesRef.current = editImagesByPage;
  const editVectorsRef = useRef(editVectorsByPage);
  editVectorsRef.current = editVectorsByPage;
  const selectedVectorRef = useRef(selectedVector);
  selectedVectorRef.current = selectedVector;
  const handleDeleteVectorRef = useRef(handleDeleteVector);
  handleDeleteVectorRef.current = handleDeleteVector;
  const commitVectorTransformRef = useRef(commitVectorTransform);
  commitVectorTransformRef.current = commitVectorTransform;
  const commitVectorRestyleRef = useRef(commitVectorRestyle);
  commitVectorRestyleRef.current = commitVectorRestyle;
  const editTextRef = useRef(editTextByPage);
  editTextRef.current = editTextByPage;
  const editSelRef = useRef(editSel);
  editSelRef.current = editSel;
  const runEditActionRef = useRef(runEditAction);
  runEditActionRef.current = runEditAction;
  const openTextEditorRef = useRef(handleOpenTextEditor);
  openTextEditorRef.current = handleOpenTextEditor;
  const openParagraphEditorRef = useRef(handleOpenParagraphEditor);
  openParagraphEditorRef.current = handleOpenParagraphEditor;
  const commitAddTextRef = useRef(commitAddText);
  commitAddTextRef.current = commitAddText;
  const commitImageTransformRef = useRef(commitImageTransform);
  commitImageTransformRef.current = commitImageTransform;
  const onAddImageRef = useRef(onAddImage);
  onAddImageRef.current = onAddImage;
  const focusedDocPathRef = useRef<string | null>(focusedDoc?.path ?? null);
  focusedDocPathRef.current = focusedDoc?.path ?? null;
  // Place an Add-Text box on the active file's first page (the band lives in
  // transformed canvas space, undrivable by WebDriver — the new-field harness
  // precedent).
  const harnessPlaceAddTextRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceAddTextRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    // Same currency rule as harnessPlaceFieldRef (round 24 tail) — the
    // harness polls this, so refusing while a reindex is in flight makes
    // place→commit atomic against the id rotation instead of arming a
    // doomed placement.
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    setAddTextPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasEditImages({
      pageIds: () => [...editImagesRef.current.keys()],
      placements: (pageId) =>
        (editImagesRef.current.get(pageId) ?? []).map((p) => ({
          index: p.index,
          nested: p.nested,
          matrix: [...p.matrix],
          opacity: p.opacity,
          kind: p.kind,
          crop: p.crop ? [...p.crop] : null,
        })),
      transformImage: (pageId, index, matrix) =>
        commitImageTransformRef.current(pageId, index, matrix),
      addImage: async (page, rect, source) => {
        const path = focusedDocPathRef.current;
        if (!path) throw new Error('addImage: no active document');
        await onAddImageRef.current(path, page, rect, source);
      },
      select: (pageId, index) => {
        imageReselectRef.current = null; // harness picks are user picks
        setEditSel({ kind: 'image', pageId, index });
      },
      selection: () => editSelRef.current,
      textPageIds: () => [...editTextRef.current.keys()],
      textRuns: (pageId) =>
        (editTextRef.current.get(pageId)?.runBoxes ?? []).map((r) => ({
          index: r.index,
          text: r.text,
          editable: r.editable,
          reason: r.reason,
        })),
      openTextEditor: (pageId, index) => openTextEditorRef.current(pageId, index),
      paragraphs: (pageId) =>
        (editTextRef.current.get(pageId)?.paragraphs ?? []).map((p) => ({
          index: p.index,
          text: p.text,
          lineCount: p.lineCount,
          alignment: p.alignment,
          vertical: p.vertical,
          // 9.A5a: the distinct per-span colours (seed hexes) — an e2e can
          // assert a recoloured range survives the round-trip.
          colors: Array.from(
            new Set(p.spans.map((sp) => sp.color).filter((c): c is string => !!c)),
          ),
          // 9.A5c: the distinct member-run font sizes.
          sizes: p.runSizes,
        })),
      openParagraphEditor: (pageId, index) => openParagraphEditorRef.current(pageId, index),
      act: (kind, opts) => runEditActionRef.current(kind, opts),
      placeAddText: (rect) => harnessPlaceAddTextRef.current(rect),
      commitAddText: (params) => commitAddTextRef.current(params),
      // 9.D1 vector objects.
      vectorPageIds: () => [...editVectorsRef.current.keys()],
      vectors: (pageId) =>
        (editVectorsRef.current.get(pageId) ?? []).map((v) => ({
          index: v.index,
          kind: v.kind,
          fill: v.fill ? [...v.fill] : null,
          stroke: v.stroke ? [...v.stroke] : null,
          lineWidth: v.lineWidth,
          nested: v.nested,
          userRect: [...v.userRect] as [number, number, number, number],
        })),
      selectVector: (pageId, index) => setSelectedVector({ pageId, index }),
      selectedVector: () => selectedVectorRef.current,
      deleteSelectedVector: () => handleDeleteVectorRef.current(),
      transformVector: (pageId, index, matrix) =>
        commitVectorTransformRef.current(pageId, index, matrix),
      restyleVector: (pageId, index, opts) =>
        commitVectorRestyleRef.current(pageId, index, opts),
    });
    return () => registerCanvasEditImages(null);
  }, []);

  // Harness bridge for on-canvas forms (2n.4b): the overlay inputs live
  // inside transformed canvas space (flaky to drive via WebDriver), so the
  // canvas registers value-setting + apply against the REAL pending-map and
  // fill paths. Refs keep the registration stable across renders.
  const workspaceFormsRef = useRef(workspaceForms);
  workspaceFormsRef.current = workspaceForms;
  const pendingFormValuesRef = useRef(pendingFormValues);
  pendingFormValuesRef.current = pendingFormValues;
  const applyFormValuesRef = useRef(applyFormValues);
  applyFormValuesRef.current = applyFormValues;
  const setFormValueRef = useRef(onSetFormValue);
  setFormValueRef.current = onSetFormValue;
  const createFieldRef = useRef(createFieldFromPlacement);
  createFieldRef.current = createFieldFromPlacement;
  const harnessPlaceFieldRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceFieldRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    // Same currency rule as onSetNewFieldRect — the harness polls this, so
    // refusing while a reindex is in flight makes place→create atomic
    // against the id rotation instead of arming a doomed placement.
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    setNewFieldPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  // Sign-into-field for the harness (2n.4d): the same engine call the sign
  // card's field branch makes, with the native save dialog's output injected.
  const harnessSignFieldRef = useRef<
    (params: {
      fieldName: string;
      pfxPath?: string;
      keyPath?: string;
      certPath?: string;
      password: string;
      output: string;
      reason?: string;
      location?: string;
    }) => Promise<{ signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean }>
  >(async () => {
    throw new Error('canvas not ready');
  });
  harnessSignFieldRef.current = async (params) => {
    const path = state.activeFileId;
    const f = path ? state.files.get(path) : undefined;
    if (!path || !f) throw new Error('signCanvasField: no active file');
    if (state.pageDirtyPaths.includes(path)) {
      throw new Error('signCanvasField: apply pending page changes first');
    }
    return (await engineCall('sign_pdf', {
      file: f.workingPath,
      output: params.output,
      ...(params.pfxPath ? { pfx_path: params.pfxPath } : {}),
      ...(params.keyPath ? { key_path: params.keyPath } : {}),
      ...(params.certPath ? { cert_path: params.certPath } : {}),
      password: params.password,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.location ? { location: params.location } : {}),
      existing_field: params.fieldName,
    })) as unknown as { signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean };
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasForms({
      setFieldValue: (path, fieldName, value) => {
        // Mirror exactly what the overlay controls can produce (review note:
        // a looser harness could "pass" scenarios no real user can trigger):
        // right shape for the type, and choice values within the options.
        const info = workspaceFormsRef.current.get(path);
        const field = info?.fields.find((f) => f.name === fieldName);
        if (!field || !field.editable) return false;
        if (!valueShapeMatches(field.type, value)) return false;
        if (
          (field.type === 'radio' || field.type === 'dropdown') &&
          typeof value === 'string' &&
          value !== '' &&
          !(field.options ?? []).includes(value)
        ) {
          return false;
        }
        if (
          field.type === 'optionlist' &&
          Array.isArray(value) &&
          !value.every((v) => (field.options ?? []).includes(v))
        ) {
          return false;
        }
        setFormValueRef.current(path, fieldName, value);
        return true;
      },
      pendingCount: () => {
        let n = 0;
        for (const [, values] of pendingFormValuesRef.current) n += values.size;
        return n;
      },
      apply: () => applyFormValuesRef.current(),
      widgetCountFor: (path) => {
        const info = workspaceFormsRef.current.get(path);
        if (!info) return 0;
        let n = 0;
        for (const [, arr] of info.widgetsByPage) n += arr.length;
        return n;
      },
      placeNewFieldOnFirstPage: (rect) => harnessPlaceFieldRef.current(rect),
      createPlacedField: (params) => createFieldRef.current(params),
      signField: (params) => harnessSignFieldRef.current(params),
    });
    return () => registerCanvasForms(null);
  }, []);

  // Harness bridge (e2e): drive OCR-apply without depending on the FindBar
  // button's async-gated visibility (same pattern as redaction/signature).
  const applyOcrRef = useRef(handleApplyOcr);
  applyOcrRef.current = handleApplyOcr;
  const ocrReadyCountRef = useRef(0);
  ocrReadyCountRef.current = ocrReady.length;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasOcr({
      readyCount: () => ocrReadyCountRef.current,
      apply: () => applyOcrRef.current(),
    });
    return () => registerCanvasOcr(null);
  }, []);

  // Convert every live mark into engine regions and redact file by file.
  // Geometry (crop-intersected box + baked /Rotate) is read from the CURRENT
  // buffer's pdf.js proxy — the same bytes the marks were drawn against; the
  // commit gate then materializes pending page edits before the engine reads
  // the file, so workspace page numbers and composed rotations line up with
  // what lands on disk. Resolves with per-file failure messages (empty =
  // success) — the confirm button surfaces them in the error banner, the test
  // harness rethrows them.
  // Ref, not just state: two clicks in the same tick both read a stale
  // `redacting === false` (same failure mode as the commit-race double-click,
  // see the punchlist's reentrancy tripwire note).
  const applyingRef = useRef(false);
  const applyMarks = useCallback(async (): Promise<string[]> => {
    const toApply = liveMarks;
    if (toApply.length === 0 || applyingRef.current) return [];
    applyingRef.current = true;
    setRedacting(true);
    setRedactError(null);
    try {
      const { files: payloads } = await buildRedactionRegions(docs, toApply, async (page) => {
        const f = state.files.get(page.sourceDocId);
        if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
        const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        return {
          box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
          bakedRotate: p.rotate,
        };
      });
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          await onRedactFile(payload.path, payload.regions);
          const applied = new Set(payload.markIds);
          setMarks((prev) => prev.filter((m) => !applied.has(m.id)));
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        setRedactError(`Redaction failed — ${failures.join('; ')}. Those marks are still pending.`);
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRedactError(`Redaction failed — ${msg}. The marks are still pending.`);
      return [msg];
    } finally {
      applyingRef.current = false;
      setRedacting(false);
    }
  }, [liveMarks, docs, state.files, onRedactFile]);

  // Sign the placement's file (visible stamp at the drawn box) or fill the
  // targeted existing empty signature field (2n.4d — the field's own widget
  // rect is the stamp box). Geometry for a placement is read from the
  // CURRENT buffer's proxy (same contract as applyMarks); the engine gate
  // then flushes pending page edits before sign_pdf reads the file, so the
  // output contains what the user sees. The input file itself is NEVER
  // modified — signing writes a new file.
  const signingRef = useRef(false);
  const applySignature = useCallback(async (): Promise<void> => {
    const placement = liveSigPlacement;
    const fieldTarget = sigFieldTarget;
    if ((!placement && !fieldTarget) || signingRef.current) return;
    // Synchronous validation only above this line. The reentrancy ref MUST be
    // taken before the FIRST await (review-caught; same double-click class as
    // the punchlist's applyMarks tripwire) — a second click during
    // buildSignatureAppearance or the native save dialog would otherwise
    // start an overlapping sign flow.
    const resolved = signerSourceParams(sigSource);
    if (resolved.error) {
      setSignError(resolved.error);
      return;
    }
    if (!sigPassword && sigSource.mode === 'pfx') {
      setSignError('Enter the signer password.');
      return;
    }
    if (fieldTarget && state.pageDirtyPaths.includes(fieldTarget.path)) {
      // The gate-commit inside sign_pdf could rename fields (a pending
      // import's name collision, 2n.4(a)) out from under a name-only target.
      // Unlike the value fill — which re-resolves renames by fingerprint —
      // a signature is not silently re-appliable, so refuse until the page
      // edits are applied and the target re-clicked against the fresh read.
      setSignError('Apply the pending page changes first, then sign the field.');
      return;
    }
    if (placement && !placementDocsCurrent(state.files, docs, placement.path)) {
      // Same stale-docs rule as createFieldFromPlacement (round 24 tail): a
      // placement whose docs were indexed from a superseded buffer converts
      // sourcePageIndex against ids that are about to rotate — the stamp
      // could land on the wrong page. The invalidation effect clears the
      // placement when the buffer change lands; this covers the in-flight
      // window where it hasn't yet. Loud, not silent — the card stays open.
      setSignError('The page this signature was placed on changed — draw the box again.');
      return;
    }
    signingRef.current = true;
    setSigningBusy(true);
    setSignError(null);
    try {
      let filePath: string;
      let placementParams: Record<string, unknown>;
      if (fieldTarget) {
        filePath = fieldTarget.path;
        placementParams = { existing_field: fieldTarget.fieldName };
      } else {
        const built = await buildSignatureAppearance(docs, placement!, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        });
        if (!built) {
          setSignError('The page this signature was placed on no longer exists.');
          return;
        }
        filePath = built.path;
        placementParams = { appearance: built.appearance };
      }
      const file = state.files.get(filePath);
      if (!file) {
        setSignError('The file this signature was placed on is no longer open.');
        return;
      }
      const baseName = (filePath.split(/[\\/]/).pop() ?? 'document').replace(/\.pdfx?$/i, '');
      const dest = await dialog.saveFile({ defaultPath: `${baseName}-signed.pdf` });
      if (!dest) return; // cancelled — the finally still clears the password
      const res = (await engineCall('sign_pdf', {
        file: file.workingPath,
        output: dest,
        ...resolved.params!,
        password: sigPassword,
        ...(sigReason.trim() ? { reason: sigReason.trim() } : {}),
        ...(sigLocation.trim() ? { location: sigLocation.trim() } : {}),
        ...placementParams,
      })) as unknown as { signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean };
      setSignDone({ signer: res.signer, output: res.output, ok: res.valid && res.intact && res.covers_whole_document });
      setSigPlacement(null);
      setSigFieldTarget(null);
      setTool('select');
    } catch (err) {
      setSignError(err instanceof Error ? err.message : String(err));
    } finally {
      // Clear the secret from state on EVERY exit — success, failure, or a
      // cancelled save dialog (review-caught: a cancel used to strand the
      // typed password in state, pre-filling later unrelated attempts).
      setSigPassword('');
      signingRef.current = false;
      setSigningBusy(false);
    }
  }, [liveSigPlacement, sigFieldTarget, sigSource, sigPassword, sigReason, sigLocation, docs, state.files, state.pageDirtyPaths, engineCall, setTool]);

  // Harness bridge (e2e builds only): redaction marks live here, out of the
  // reducer's reach, so the canvas registers its own handlers while mounted.
  // Refs keep the registration stable across renders.
  const applyMarksRef = useRef(applyMarks);
  applyMarksRef.current = applyMarks;
  const harnessAddMarkRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => { markId: string; docId: string; pageId: string } | null
  >(() => null);
  harnessAddMarkRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return null;
    const id = crypto.randomUUID();
    setMarks((prev) => [
      ...prev,
      { id, path: doc.path, pageId: page.id, rect, rotationAtDraw: page.rotation },
    ]);
    return { markId: id, docId: doc.id, pageId: page.id };
  };
  const liveMarksRef = useRef(liveMarks);
  liveMarksRef.current = liveMarks;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasRedaction({
      addMarkToFirstPage: (rect) => harnessAddMarkRef.current(rect),
      apply: () => applyMarksRef.current(),
      clear: () => setMarks([]),
      count: () => liveMarksRef.current.length,
    });
    return () => registerCanvasRedaction(null);
  }, []);

  // Same bridge for the visible-signature placement (rubber band + native
  // dialogs aren't WebDriver-drivable). The harness places on the first page
  // and reads back the CONVERTED appearance via the real conversion path.
  const liveSigRef = useRef(liveSigPlacement);
  liveSigRef.current = liveSigPlacement;
  const harnessPlaceSigRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceSigRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    // Same currency rule as harnessPlaceFieldRef (round 24 tail) — the
    // harness polls this, so a transient refusal during a reindex
    // self-heals instead of arming a doomed placement.
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    setSigPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  const harnessBuildSigRef = useRef<
    () => Promise<{ path: string; appearance: { page: number; rect: [number, number, number, number] } } | null>
  >(async () => null);
  harnessBuildSigRef.current = async () => {
    const placement = liveSigPlacement;
    if (!placement) return null;
    return buildSignatureAppearance(docs, placement, async (page) => {
      const f = state.files.get(page.sourceDocId);
      if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
      const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
      const p = await proxy.getPage(page.sourcePageIndex + 1);
      const [vx0, vy0, vx1, vy1] = p.view;
      return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
    });
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasSignature({
      placeOnFirstPage: (rect) => harnessPlaceSigRef.current(rect),
      buildAppearance: () => harnessBuildSigRef.current(),
      clear: () => setSigPlacement(null),
      has: () => liveSigRef.current != null,
    });
    return () => registerCanvasSignature(null);
  }, []);

  // Which pages travel with a drag that grabs `grabbedPageId`: the whole
  // selection (in workspace order) when the grabbed page is part of a
  // multi-selection, otherwise just that page. MUST be a pure query — it runs
  // on pointer-down, before we know whether this is a drag or a click, so it
  // must not mutate the selection (that would corrupt a following Ctrl/Shift
  // click's modifier logic). A drag re-selects its moved pages on drop;
  // a plain click selects via onSelectPage.
  const getMovingPageIds = useCallback(
    (grabbedPageId: string): string[] => {
      if (selectedPageIds.size > 1 && selectedPageIds.has(grabbedPageId)) {
        return flatOrder.filter((id) => selectedPageIds.has(id));
      }
      return [grabbedPageId];
    },
    [selectedPageIds, flatOrder],
  );

  const movePagesInto = useCallback(
    (movingIds: string[], targetDocId: string, index: number) => {
      if (movingIds.length === 0) return;
      if (movingIds.length === 1) {
        // Keep the exact single-page semantics (same-doc no-op guard, etc.).
        const src = docs.find((d) => d.pages.some((p) => p.id === movingIds[0]));
        if (!src) return;
        dispatch({
          type: 'MOVE_PAGE',
          fromDocId: src.id,
          toDocId: targetDocId,
          pageId: movingIds[0],
          toIndex: index,
        });
      } else {
        dispatch({ type: 'MOVE_PAGES', pageIds: movingIds, toDocId: targetDocId, toIndex: index });
      }
      // A drag re-selects its moved pages on drop.
      dispatch({
        type: 'UI_SET_SELECTION',
        pageIds: movingIds,
        anchor: movingIds[movingIds.length - 1],
      });
    },
    [dispatch, docs],
  );

  const movePagesToNewDoc = useCallback(
    (movingIds: string[], docIndex: number) => {
      if (movingIds.length === 0) return;
      // Template on the first moving page's document (matches the reducer).
      const first = docs.find((d) => d.pages.some((p) => p.id === movingIds[0]));
      if (!first) return;
      const movingSet = new Set(movingIds);
      const newDocId = crypto.randomUUID();
      // Free a fully-emptied source doc's name for reuse by the new doc.
      const taken = new Set(
        docs.filter((d) => !d.pages.every((p) => movingSet.has(p.id))).map((d) => d.name),
      );
      const newName = uniqueDocName(first.name, taken);
      if (movingIds.length === 1) {
        dispatch({
          type: 'MOVE_PAGE_TO_NEW_DOC',
          fromDocId: first.id,
          pageId: movingIds[0],
          docIndex,
          newDocId,
          newName,
        });
      } else {
        dispatch({ type: 'MOVE_PAGES_TO_NEW_DOC', pageIds: movingIds, docIndex, newDocId, newName });
      }
      dispatch({
        type: 'UI_SET_SELECTION',
        pageIds: movingIds,
        anchor: movingIds[movingIds.length - 1],
      });
    },
    [dispatch, docs],
  );

  const drag = usePageDrag({
    layout,
    canvasRef,
    getMovingPageIds,
    movePagesInto,
    movePagesToNewDoc,
  });

  const onSelectPage = useCallback(
    (docId: string, pageId: string, e?: React.MouseEvent) => {
      // Modifier semantics (toggle / shift-range / single) live in the
      // reducer now — it has the workspace-flattened order and the anchor.
      const mode = e && (e.metaKey || e.ctrlKey) ? 'toggle' : e && e.shiftKey ? 'range' : 'single';
      dispatch({ type: 'UI_SELECT_PAGE', pageId, mode });
    },
    [dispatch],
  );

  // Double-click a page = READ it (M6.2, the M4.3 plan): the reading pane is
  // the "look closely" surface, so the PageInspector retired in its favor —
  // its rotate/delete were commands already.
  //
  // NOT `jumpToPage` after the mode dispatch: dispatch is async, so jumpToPage
  // would read the STALE mode ref, take its synchronous same-view fast path,
  // center the about-to-unmount BOARD, and the fresh DocumentView would open
  // at page 1 — on the WRONG document when the page belongs to a non-active
  // one (review-caught, HIGH). The pending-jump slot exists for exactly this:
  // park the target, flip the mode (and the owning doc if needed), and the
  // consuming effect centers once the new view's handle is live.
  const openPageForReading = useCallback(
    (pageId: string) => {
      pendingJumpRef.current = pageId;
      dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' });
      const owner = docsRef.current.find((d) => d.pages.some((p) => p.id === pageId));
      if (owner && owner.id !== focusedDocRef.current?.id) {
        dispatch({ type: 'UI_FOCUS_DOC', docId: owner.id });
      }
    },
    [dispatch],
  );
  openPageForReadingRef.current = openPageForReading;
  const onOpenPage = useCallback(
    (_docId: string, pageId: string) => openPageForReading(pageId),
    [openPageForReading],
  );

  const onPageContextMenu = useCallback(
    (docId: string, pageId: string, e: React.MouseEvent) => {
      // Right-clicking a page already in the selection keeps the whole
      // selection (menu actions then apply to all); otherwise select just it.
      dispatch({ type: 'UI_SELECT_PAGE', pageId, mode: 'context' });
      setMenu({ x: e.clientX, y: e.clientY, docId, pageId });
    },
    [dispatch],
  );

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return [];
    // Shared with the nav-pane Pages panel — one menu definition (M3, § 3.2).
    return buildPageContextMenu({
      docs,
      docId: menu.docId,
      pageId: menu.pageId,
      selectedPageIds,
      dispatch,
      onOpen: onOpenPage,
      onExtractText,
    });
  }, [menu, docs, selectedPageIds, dispatch, onOpenPage, onExtractText]);

  const onMoveDoc = useCallback(
    (docId: string, direction: -1 | 1) => dispatch({ type: 'REORDER_DOCS', docId, direction }),
    [dispatch],
  );

  // Canvas whole-document merge (2o): append a COPY of this document's pages
  // to the document above — one IMPORT_PAGES dispatch = one undo step. Copy,
  // not move (the zero-page guard forbids emptying a file); the source strip
  // stays until the user removes it, and after Apply changes the copies
  // re-bake to the target's own file. Fresh ids + deep-copied annotations:
  // lib/merge-docs.ts.
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const onMergeUp = useCallback(
    (docId: string) => {
      const index = docs.findIndex((d) => d.id === docId);
      if (index <= 0) return; // first document has nothing above it
      const from = docs[index];
      const to = docs[index - 1];
      if (from.pages.length === 0) return;
      dispatch({
        type: 'IMPORT_PAGES',
        toDocId: to.id,
        toIndex: to.pages.length,
        pages: buildMergedPageRefs(from),
      });
    },
    [dispatch, docs],
  );

  const onRemoveDoc = useCallback(
    (docId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const siblings = docs.filter((d) => d.path === doc.path);
      if (siblings.length === 1) {
        // Close-guard (2o): a STAGED merge copy still reads its bytes from
        // this file — closing it would orphan the refs and fail every later
        // commit of the target. Scoped to dirty referencing paths: after
        // Apply changes the lingering (reindex-pending) refs are hazardless
        // and refusing would be spurious. Leaving the canvas commits (the
        // gate), so this canvas-side guard is the only one needed.
        if (pathBlockedFromClose(docs, state.pageDirtyPaths, doc.path)) {
          setMergeNotice(
            `"${doc.name}" is merged into another document — Apply changes first, then close it.`,
          );
          return;
        }
        onCloseFile(doc.path);
      } else {
        dispatch({ type: 'REMOVE_DOC', docId });
      }
    },
    [dispatch, docs, state.pageDirtyPaths, onCloseFile],
  );

  const onRenameDoc = useCallback(
    (docId: string, name: string) => {
      const taken = new Set(docs.filter((d) => d.id !== docId).map((d) => d.name));
      dispatch({ type: 'RENAME_DOC', docId, name: uniqueDocName(name.trim(), taken) });
    },
    [dispatch, docs],
  );

  // e2e harness for the canvas merge (2o): the header hover actions sit in
  // the transformed overlay, so the doc listing + the REAL merge-up and
  // guarded-remove paths register here. Refs keep the registration stable.
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const mergeUpRef = useRef(onMergeUp);
  mergeUpRef.current = onMergeUp;
  const removeDocRef = useRef(onRemoveDoc);
  removeDocRef.current = onRemoveDoc;
  const mergeNoticeRef = useRef(mergeNotice);
  mergeNoticeRef.current = mergeNotice;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasMerge({
      getDocs: () =>
        docsRef.current.map((d) => ({ id: d.id, path: d.path, name: d.name, pages: d.pages.length })),
      mergeUp: (docId) => mergeUpRef.current(docId),
      removeDoc: (docId) => removeDocRef.current(docId),
      noticeText: () => mergeNoticeRef.current,
    });
    return () => registerCanvasMerge(null);
  }, []);

  const { intoDocId, intoIndex, betweenIndex, ghostSize, betweenPages } = deriveDropGhosts(
    docs,
    drag.draggingPage,
    drag.dropTarget,
  );

  const dirty = state.pageDirtyPaths.length > 0;

  if (docs.length === 0) {
    return (
      <div className="canvas-view flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-neutral-400 mb-1">No documents open</p>
          <p className="text-sm text-neutral-500 mb-4">
            Drop PDF files anywhere, or open them to lay them out here
          </p>
          <button
            onClick={onOpenFiles}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            Open PDF
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'canvas-view flex-1 flex flex-col relative overflow-hidden' +
        (drag.committing ? ' committing' : '') +
        (drag.draggingPage ? ' dragging' : '') +
        (tool !== 'select' && tool !== 'forms' ? ' annotating' : '') +
        (tool === 'forms' ? ' forms-mode' : '')
      }
    >
      {/* § 3.1: the contextual strip, at the top of the document pane. It shows
          the tool that owns the armed mode; nothing armed ⇒ nothing here. */}
      <SecondaryToolbar
        tool={tool}
        activeToolId={state.ui.activeToolId}
        toolColor={toolColor}
        onSetToolColor={setToolColor}
        stampPreset={stampPreset}
        onSetStampPreset={setStampPreset}
        editHasSelection={editSel !== null}
        editSelectionKind={editSel?.kind ?? null}
        editTextEditable={
          editSel?.kind === 'text'
            ? (editTextByPage
                .get(editSel.pageId)
                ?.runBoxes.find((r) => r.index === editSel.index)?.editable ?? false)
            : editSel?.kind === 'para' // only editable paragraphs are listed
        }
        editTextReason={
          editSel?.kind === 'text'
            ? (editTextByPage
                .get(editSel.pageId)
                ?.runBoxes.find((r) => r.index === editSel.index)?.reason ?? null)
            : null
        }
        editBusy={editBusy}
        editNotice={editNotice}
        onEditAction={(kind) => void runEditAction(kind)}
        editImageOpacity={editImageOpacity}
        editImageKind={editImageKind}
        onSetImageOpacity={commitImageOpacity}
        imageCropArmed={imageCropArmed}
        onToggleImageCrop={() => setImageCropArmed((a) => !a)}
        onRotateImage={rotateImage90}
        onEditTextOpen={() => {
          if (editSel?.kind === 'text') handleOpenTextEditor(editSel.pageId, editSel.index);
          else if (editSel?.kind === 'para')
            handleOpenParagraphEditor(editSel.pageId, editSel.index);
        }}
      />
      {docViewMode === 'document' && focusedDoc ? (
        <DocumentView
          key={focusedDoc.id}
          ref={documentViewRef}
          doc={focusedDoc}
          viewRotation={state.ui.viewRotationByPath[focusedDoc.path] ?? 0}
          proxies={proxies}
          onCurrentPageChange={setCurrentPage}
          renderVersion={renderVersion}
          selectedPageIds={selectedPageIds}
          onSelectPage={onSelectPage}
          onOpenPage={onOpenPage}
          onPageContextMenu={onPageContextMenu}
          tool={tool}
          annotationColor={toolColor ?? undefined}
          stampPreset={stampPreset}
          redactionMarksByPage={redactionMarksByPage}
          editImagesByPage={editImagesByPage}
          editVectorsByPage={editVectorsByPage}
          selectedVector={selectedVector}
          editImageTransform={editImageTransform}
          onCommitImageTransform={commitImageTransform}
          vectorTransform={vectorTransform}
          onCommitVectorTransform={(pageId, index, matrix) =>
            void commitVectorTransform(pageId, index, matrix)
          }
          imageCropArmed={imageCropArmed}
          onCommitImageCrop={commitImageCrop}
          editTextByPage={editTextByPage}
          editSelection={editSel}
          editingText={editingText}
          onSelectEditImage={handleSelectEditImage}
          onSelectEditVector={handleSelectEditVector}
          onDeleteVector={() => void handleDeleteVector()}
          onRestyleVector={(pageId, index, opts) => void commitVectorRestyle(pageId, index, opts)}
          onSelectEditText={handleSelectEditText}
          onOpenTextEditor={handleOpenTextEditor}
          onCommitTextEdit={(pageId, index, text, opts) =>
            void handleCommitTextEdit(pageId, index, text, opts)
          }
          onCancelTextEdit={handleCancelTextEdit}
          onSelectEditParagraph={handleSelectEditParagraph}
          onOpenParagraphEditor={handleOpenParagraphEditor}
          onCommitParagraphEdit={(pageId, index, text, opts) =>
            void handleCommitParagraphEdit(pageId, index, text, opts)
          }
          onCancelParagraphEdit={handleCancelTextEdit}
          onMergeParagraphPrev={(pageId, index) => void handleMergeParagraphPrev(pageId, index)}
          signaturePlacement={liveSigPlacement}
          findMatchPageIds={findMatchPageIds}
          findWordsByPage={findWordsByPage}
          formWidgetsByPage={formWidgetsByPage}
          formValuesByPath={pendingFormValues}
          onSetFormValue={onSetFormValue}
          onSignFieldRequest={onSignFieldRequest}
          newFieldPlacement={liveNewFieldPlacement}
          onSetNewFieldRect={onSetNewFieldRect}
          onClearNewFieldPlacement={onClearNewFieldPlacement}
          addTextPlacement={liveAddTextPlacement}
          onSetAddTextRect={onSetAddTextRect}
          onAddImageRect={onAddImageRect}
          onClearAddTextPlacement={onClearAddTextPlacement}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onAddRedactionMark={onAddRedactionMark}
          onRemoveRedactionMark={onRemoveRedactionMark}
          onSetSignaturePlacement={onSetSignaturePlacement}
          onClearSignaturePlacement={onClearSignaturePlacement}
        />
      ) : (
      <Canvas
        ref={canvasRef}
        contentWidth={layout.contentWidth}
        contentHeight={layout.contentHeight}
        slotHeight={layout.slotHeight}
        dragging={drag.draggingPage !== null}
        handMode={tool === 'hand'}
        onSettle={() => setRenderVersion((v) => v + 1)}
        onBackgroundClick={clearSelection}
        overlay={
          <HeaderLayer
            items={layout.items}
            betweenIndex={betweenIndex}
            onMove={onMoveDoc}
            onRemove={onRemoveDoc}
            onRename={onRenameDoc}
            onMergeUp={onMergeUp}
          />
        }
      >
        <DocLayer
          items={layout.items}
          proxies={proxies}
          renderVersion={renderVersion}
          selectedPageIds={selectedPageIds}
          collapsedIds={drag.collapsedIds}
          intoDocId={intoDocId}
          intoIndex={intoIndex}
          intoGhostWidth={ghostSize.width}
          intoGhostHeight={ghostSize.height}
          betweenIndex={betweenIndex}
          onSelectPage={onSelectPage}
          onOpenPage={onOpenPage}
          tool={tool}
          annotationColor={toolColor ?? undefined}
          stampPreset={stampPreset}
          redactionMarksByPage={redactionMarksByPage}
          editImagesByPage={editImagesByPage}
          editVectorsByPage={editVectorsByPage}
          selectedVector={selectedVector}
          editImageTransform={editImageTransform}
          onCommitImageTransform={commitImageTransform}
          vectorTransform={vectorTransform}
          onCommitVectorTransform={(pageId, index, matrix) =>
            void commitVectorTransform(pageId, index, matrix)
          }
          imageCropArmed={imageCropArmed}
          onCommitImageCrop={commitImageCrop}
          editTextByPage={editTextByPage}
          editSelection={editSel}
          editingText={editingText}
          onSelectEditImage={handleSelectEditImage}
          onSelectEditVector={handleSelectEditVector}
          onDeleteVector={() => void handleDeleteVector()}
          onRestyleVector={(pageId, index, opts) => void commitVectorRestyle(pageId, index, opts)}
          onSelectEditText={handleSelectEditText}
          onOpenTextEditor={handleOpenTextEditor}
          onCommitTextEdit={(pageId, index, text, opts) =>
            void handleCommitTextEdit(pageId, index, text, opts)
          }
          onCancelTextEdit={handleCancelTextEdit}
          onSelectEditParagraph={handleSelectEditParagraph}
          onOpenParagraphEditor={handleOpenParagraphEditor}
          onCommitParagraphEdit={(pageId, index, text, opts) =>
            void handleCommitParagraphEdit(pageId, index, text, opts)
          }
          onCancelParagraphEdit={handleCancelTextEdit}
          onMergeParagraphPrev={(pageId, index) => void handleMergeParagraphPrev(pageId, index)}
          signaturePlacement={liveSigPlacement}
          findMatchPageIds={findMatchPageIds}
          findWordsByPage={findWordsByPage}
          formWidgetsByPage={formWidgetsByPage}
          formValuesByPath={pendingFormValues}
          onSetFormValue={onSetFormValue}
          onSignFieldRequest={onSignFieldRequest}
          newFieldPlacement={liveNewFieldPlacement}
          onSetNewFieldRect={onSetNewFieldRect}
          onClearNewFieldPlacement={onClearNewFieldPlacement}
          addTextPlacement={liveAddTextPlacement}
          onSetAddTextRect={onSetAddTextRect}
          onAddImageRect={onAddImageRect}
          onClearAddTextPlacement={onClearAddTextPlacement}
          onPageContextMenu={onPageContextMenu}
          onPagePointerDown={tool === 'hand' ? HAND_SUPPRESSES_PICKUP : drag.onPagePointerDown}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onAddRedactionMark={onAddRedactionMark}
          onRemoveRedactionMark={onRemoveRedactionMark}
          onSetSignaturePlacement={onSetSignaturePlacement}
          onClearSignaturePlacement={onClearSignaturePlacement}
          onAddPages={onAddPages}
        />
        {drag.dropTarget?.kind === 'between' && (
          <div
            className="canvas-doc ghost-doc"
            style={{
              left: 0,
              top: betweenSlotY(layout, drag.dropTarget.docIndex),
              width: MIN_DOC_WIDTH,
            }}
          >
            <GhostRow width={MIN_DOC_WIDTH} pageHeight={BASE_PAGE_HEIGHT} pages={betweenPages} />
          </div>
        )}
        <div
          className="canvas-doc"
          style={{ left: 0, top: betweenSlotY(layout, layout.items.length), width: MIN_DOC_WIDTH }}
        >
          <AddDocGhost width={MIN_DOC_WIDTH} onClick={onOpenFiles} />
        </div>
      </Canvas>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {/* Floating controls. The tool pill and its mode OPTIONS (stamp presets,
          annotation colour) moved to the secondary toolbar — they belong to the
          tool. What's left is deliberately NOT tool-scoped: the view toggles,
          and the PENDING-STATE buttons (Fill N / Redact N / Apply changes),
          which report queued work. The canvas invariant is that pending state is
          never invisible, so those must not vanish when a tool closes. */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 z-30">
        <button
          data-testid="toggle-doc-view"
          title={docViewMode === 'document' ? 'Switch to the page organizer' : 'Switch to the reading view'}
          onClick={() =>
            dispatch({
              type: 'UI_SET_DOC_VIEW_MODE',
              mode: docViewMode === 'document' ? 'organize' : 'document',
            })
          }
          className="px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700"
        >
          {docViewMode === 'document' ? 'Organize' : 'Read'}
        </button>
        <button
          data-testid="toggle-find"
          title="Find in documents (Ctrl+F)"
          onClick={() => (find.open ? find.closeFind() : find.openFind())}
          className={`px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border ${find.open ? 'bg-blue-600 text-white border-blue-600' : 'bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
        >
          Find
        </button>
        <button
          data-testid="toggle-comments"
          title="Show annotation notes"
          onClick={() => setShowComments((v) => !v)}
          className={`px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border ${showComments ? 'bg-blue-600 text-white border-blue-600' : 'bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}
        >
          Comments
        </button>
        {pendingFormCount > 0 && (
          <>
            <button
              data-testid="forms-fill-btn"
              disabled={fillingForms}
              onClick={() => void applyFormValues()}
              className="px-3 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-full font-medium shadow-lg"
            >
              {fillingForms
                ? 'Filling…'
                : `Fill ${pendingFormCount} field${pendingFormCount === 1 ? '' : 's'}`}
            </button>
            <button
              data-testid="forms-clear-btn"
              disabled={fillingForms}
              onClick={clearFormValues}
              title="Discard all pending form values"
              className="px-3 py-1.5 text-xs bg-neutral-800/90 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded-full font-medium shadow-lg"
            >
              Clear
            </button>
          </>
        )}
        {liveMarks.length > 0 && (
          <>
            <button
              data-testid="redact-apply-btn"
              disabled={redacting}
              onClick={() => setConfirmRedact(true)}
              className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-full font-medium shadow-lg"
            >
              {redacting
                ? 'Redacting…'
                : `Redact ${liveMarks.length} region${liveMarks.length === 1 ? '' : 's'}`}
            </button>
            <button
              data-testid="redact-clear-btn"
              disabled={redacting}
              onClick={() => setMarks([])}
              title="Clear all pending redaction marks"
              className="px-3 py-1.5 text-xs bg-neutral-800/90 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded-full font-medium shadow-lg"
            >
              Clear
            </button>
          </>
        )}
        {dirty && (
          <button
            data-testid="apply-page-edits-btn"
            onClick={() => invokeCommand('document.applyPageEdits')}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-full font-medium shadow-lg"
          >
            Apply changes
          </button>
        )}
        {docViewMode === 'document' && focusedDoc && (
          <div className="flex items-center gap-1 px-3 py-1.5 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg text-xs text-neutral-300">
            <input
              data-testid="page-nav-box"
              ref={pageBoxRef}
              value={pageBox}
              onChange={(e) => {
                setPageBox(e.target.value.replace(/[^0-9]/g, ''));
                pageBoxDirty.current = true;
              }}
              onFocus={(e) => {
                pageBoxFocused.current = true;
                pageBoxDirty.current = false;
                e.target.select();
              }}
              onBlur={() => {
                pageBoxFocused.current = false;
                // Only navigate if the user actually typed a new page — a blur
                // after just focusing + scrolling must not snap back.
                if (pageBoxDirty.current) {
                  const max = focusedDoc.pages.length;
                  const n = Math.max(1, Math.min(max, parseInt(pageBox, 10) || currentPage));
                  activeCanvasHandle()?.centerOn(focusedDoc.pages[n - 1].id);
                  setPageBox(String(n));
                } else {
                  setPageBox(String(currentPage));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-9 text-center bg-neutral-900 border border-neutral-700 rounded"
              aria-label="Current page"
            />
            <span data-testid="page-nav-total">/ {focusedDoc.pages.length}</span>
          </div>
        )}
        <div className="flex bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg overflow-hidden">
          <button
            title="Zoom out"
            onClick={() => activeCanvasHandle()?.zoomOut()}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            −
          </button>
          <button
            title="Fit to view"
            onClick={() => activeCanvasHandle()?.reset()}
            className="px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            Fit
          </button>
          <button
            title="Zoom in"
            onClick={() => activeCanvasHandle()?.zoomIn()}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            +
          </button>
        </div>
      </div>

      {showComments && (
        <CommentSidebar
          docs={docs}
          onSelectPage={onSelectPage}
          onJumpToPage={jumpToPage}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onClose={() => setShowComments(false)}
        />
      )}

      {find.open && (
        <FindBar
          query={find.query}
          result={find.result}
          matchCount={find.matchPages.length}
          current={find.current}
          options={find.options}
          onToggleOption={find.toggleOption}
          ocrRemaining={searchIndex.ocrRemaining}
          hasScanned={searchIndex.hasScanned}
          ocrLanguage={searchIndex.ocrLanguage}
          canApplyOcr={ocrReady.length > 0}
          applyingOcr={applyingOcr}
          onQuery={find.setQuery}
          onOcrLanguage={searchIndex.setOcrLanguage}
          onNext={find.next}
          onPrev={find.prev}
          onApplyOcr={() => void handleApplyOcr()}
          onClose={find.closeFind}
        />
      )}
      {ocrApplyError && (
        <div
          data-testid="ocr-apply-error"
          className="absolute top-16 right-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{ocrApplyError}</span>
          <button onClick={() => setOcrApplyError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}
      {formsError && (
        <div
          data-testid="forms-fill-error"
          className="absolute top-28 right-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{formsError}</span>
          <button onClick={() => setFormsError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}
      {mergeNotice && (
        <div
          data-testid="merge-notice"
          className="absolute top-40 right-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-amber-500/15 border border-amber-500/40 rounded text-xs text-amber-200 shadow-lg"
        >
          <span className="flex-1">{mergeNotice}</span>
          <button onClick={() => setMergeNotice(null)} className="text-amber-300 hover:text-amber-100">×</button>
        </div>
      )}

      {(liveSigPlacement || sigFieldTarget) && (
        <div
          data-testid="sign-canvas-form"
          className="absolute bottom-4 left-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">
            {sigFieldTarget
              ? `Sign field "${sigFieldTarget.fieldName}"`
              : 'Sign with a visible stamp'}
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            {sigFieldTarget
              ? 'The signature fills this existing field (its own box is the stamp); the signed copy is written to a NEW file — this file is left unchanged.'
              : 'The stamp is drawn at the box you placed; the signed copy is written to a NEW file — this file is left unchanged.'}
          </p>
          <SignerSourceFields value={sigSource} onChange={setSigSource} idPrefix="canvas-sign" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Password</span>
            <input
              data-testid="canvas-sign-password"
              type="password"
              value={sigPassword}
              onChange={(e) => setSigPassword(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Reason</span>
            <input
              type="text"
              value={sigReason}
              placeholder="optional"
              onChange={(e) => setSigReason(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Location</span>
            <input
              type="text"
              value={sigLocation}
              placeholder="optional"
              onChange={(e) => setSigLocation(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          {signError && <div data-testid="canvas-sign-error" className="text-xs text-red-400">{signError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setSigPlacement(null);
                setSigFieldTarget(null);
                setSigPassword('');
                setSignError(null);
              }}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid="canvas-sign-apply"
              onClick={() => void applySignature()}
              disabled={signingBusy}
              className="px-2.5 py-1 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded font-medium"
            >
              {signingBusy ? 'Signing…' : 'Sign & Save…'}
            </button>
          </div>
        </div>
      )}

      {liveNewFieldPlacement && (
        <div
          data-testid="new-field-form"
          className="absolute bottom-4 left-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">New form field</div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            The field is created at the box you placed and is fillable right away.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Name</span>
            <input
              data-testid="new-field-name"
              type="text"
              value={nfName}
              onChange={(e) => setNfName(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">Type</span>
            <select
              data-testid="new-field-type"
              value={nfType}
              onChange={(e) => setNfType(e.target.value as NewFieldType)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
            >
              <option value="text">Text</option>
              <option value="checkbox">Checkbox</option>
              <option value="radio">Radio group</option>
              <option value="dropdown">Dropdown</option>
              <option value="optionlist">Option list</option>
              <option value="signature">Signature (empty)</option>
            </select>
          </div>
          {nfType === 'text' && (
            <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={nfMultiline}
                onChange={() => setNfMultiline((v) => !v)}
                className="rounded bg-neutral-800 border-neutral-700"
              />
              Multiline
            </label>
          )}
          {(nfType === 'radio' || nfType === 'dropdown' || nfType === 'optionlist') && (
            <div className="flex items-start gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0 pt-1">Options</span>
              <textarea
                data-testid="new-field-options"
                value={nfOptions}
                rows={3}
                placeholder="one per line (or comma-separated)"
                onChange={(e) => setNfOptions(e.target.value)}
                className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500 resize-y"
              />
            </div>
          )}
          {nfError && <div data-testid="new-field-error" className="text-xs text-red-400">{nfError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setNewFieldPlacement(null);
                setNfError(null);
              }}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid="new-field-create"
              onClick={() => void createPlacedField()}
              disabled={creatingField}
              className="px-2.5 py-1 text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded font-medium"
            >
              {creatingField ? 'Creating…' : 'Create field'}
            </button>
          </div>
        </div>
      )}

      {liveAddTextPlacement && (
        <div
          data-testid="add-text-form"
          className="absolute bottom-4 left-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">Add text</div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            Text fills the box you drew and wraps to its width. It stays searchable and editable.
          </p>
          <textarea
            data-testid="add-text-input"
            value={atText}
            rows={3}
            autoFocus
            placeholder="Type the text to add…"
            onChange={(e) => setAtText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClearAddTextPlacement();
              }
            }}
            className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500 resize-y"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-16 shrink-0">Font</span>
            <select
              data-testid="add-text-family"
              value={atFamily}
              onChange={(e) => setAtFamily(e.target.value as 'sans' | 'serif' | 'mono')}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
            >
              <option value="sans">Sans-serif</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-16 shrink-0">Size</span>
            <input
              data-testid="add-text-size"
              type="number"
              min={1}
              max={1638}
              step={1}
              // parseFloat + skip-on-NaN (NOT Number(), where '' → 0 → clamps
              // to 1 and fights a clear-and-retype: "125" instead of "25").
              // Mirrors ParagraphEditor's size input — the review-caught fix.
              value={Number.isFinite(atSize) ? Math.round(atSize) : ''}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) setAtSize(Math.max(1, Math.min(1638, v)));
              }}
              className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              data-testid="add-text-rotate"
              title="Rotation — the text reads at this angle (90° steps)"
              onClick={() =>
                setAtRotate((r) => {
                  const next = ((r + 90) % 360) as 0 | 90 | 180 | 270;
                  // The box preview's direction arrow tracks the card live.
                  setAddTextPlacement((pl) => (pl ? { ...pl, rotate: next } : pl));
                  return next;
                })
              }
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:border-emerald-500"
            >
              <span
                className="inline-block"
                style={{ transform: `rotate(${-atRotate}deg)` }}
                aria-hidden
              >
                →
              </span>{' '}
              {atRotate}°
            </button>
            <button
              type="button"
              data-testid="add-text-bold"
              aria-pressed={atBold}
              title="Bold — authors in the bundled bold face"
              onClick={() => setAtBold((b) => !b)}
              className={`px-2 py-1 text-xs font-bold border rounded ${
                atBold
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              B
            </button>
            <button
              type="button"
              data-testid="add-text-kern"
              aria-pressed={atKern}
              title="Kerning — tightens pairs like AV and To using the face's own metrics"
              onClick={() => setAtKern((k) => !k)}
              className={`px-2 py-1 text-xs border rounded ${
                atKern
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              AV
            </button>
            <button
              type="button"
              data-testid="add-text-italic"
              aria-pressed={atItalic}
              title="Italic — authors in the bundled italic face"
              onClick={() => setAtItalic((i) => !i)}
              className={`px-2 py-1 text-xs italic border rounded ${
                atItalic
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              I
            </button>
            {/* 9.K2 OpenType features. Authoring always renders a bundled face,
                so a feature switches to Libertinus Serif (Liberation has none). */}
            <button
              type="button"
              data-testid="add-text-smallcaps"
              aria-pressed={atSmallCaps}
              title="Small caps — authors in Libertinus Serif (carries real small caps)"
              onClick={() => setAtSmallCaps((s) => !s)}
              className={`px-2 py-1 text-xs border rounded ${
                atSmallCaps
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
              style={{ fontVariantCaps: 'all-small-caps' }}
            >
              Sc
            </button>
            <button
              type="button"
              data-testid="add-text-alternates"
              aria-pressed={atAlternates}
              title="Stylistic alternates (salt) — authors in Libertinus Serif"
              onClick={() => setAtAlternates((a) => !a)}
              className={`px-2 py-1 text-xs border rounded ${
                atAlternates
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              Alt
            </button>
            {atAlternates && (
              <input
                type="number"
                data-testid="add-text-altindex"
                min={0}
                max={99}
                step={1}
                value={atAltIndex}
                title="Which stylistic alternate to use, when the face offers several"
                onChange={(e) =>
                  setAtAltIndex(Math.max(0, Math.min(99, Math.trunc(parseFloat(e.target.value) || 0))))
                }
                className="w-12 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
              />
            )}
            <span className="text-xs text-neutral-400 flex-1 text-right shrink-0">Colour</span>
            <input
              data-testid="add-text-color"
              type="color"
              value={atColor}
              onChange={(e) => setAtColor(e.target.value)}
              className="h-6 w-8 bg-neutral-800 border border-neutral-700 rounded"
            />
          </div>
          {atFits === false && (
            <div data-testid="add-text-overflow" className="text-xs text-amber-400">
              The text extends below the box — it will continue past it.
            </div>
          )}
          {atError && <div data-testid="add-text-error" className="text-xs text-red-400">{atError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => onClearAddTextPlacement()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid="add-text-create"
              onClick={() => void createPlacedText()}
              disabled={creatingText}
              className="px-2.5 py-1 text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded font-medium"
            >
              {creatingText ? 'Adding…' : 'Add text'}
            </button>
          </div>
        </div>
      )}

      {signDone && (
        <div
          data-testid="canvas-sign-done"
          className={`absolute bottom-4 left-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 rounded text-xs shadow-lg border ${
            signDone.ok
              ? 'bg-green-600/15 border-green-600/40 text-green-200'
              : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
          }`}
        >
          <span className="flex-1">
            Signed as <strong>{signDone.signer ?? '(unknown)'}</strong>
            {signDone.ok
              ? ' — valid, covers the whole document. '
              : ' — but the signature did not verify as expected. '}
            Saved to {signDone.output}
          </span>
          <button onClick={() => setSignDone(null)} className="hover:text-white">×</button>
        </div>
      )}

      {redactError && (
        <div
          data-testid="redact-error"
          className="absolute bottom-16 right-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{redactError}</span>
          <button
            onClick={() => setRedactError(null)}
            className="text-red-300 hover:text-red-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Redaction is the one canvas action that destroys file content, so it
          alone gets an explicit confirm step. */}
      {confirmRedact && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={() => setConfirmRedact(false)}
        >
          <div
            className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[420px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-neutral-800">
              <h3 className="text-sm font-semibold">Redact content</h3>
            </div>
            <div className="px-5 py-4 text-sm text-neutral-300 space-y-2">
              <p>
                Permanently remove the content under {liveMarks.length} marked region
                {liveMarks.length === 1 ? '' : 's'} across{' '}
                {new Set(liveMarks.map((m) => m.pageId)).size} page
                {new Set(liveMarks.map((m) => m.pageId)).size === 1 ? '' : 's'}?
              </p>
              <p className="text-xs text-neutral-400">
                Text and images under each region are removed from the file's content, not just
                covered. Undo can restore the file while it stays open; once saved, the content is
                gone for good.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-neutral-800">
              <button
                data-testid="redact-cancel-btn"
                onClick={() => setConfirmRedact(false)}
                className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                Cancel
              </button>
              <button
                data-testid="redact-confirm-btn"
                onClick={() => {
                  setConfirmRedact(false);
                  void applyMarks();
                }}
                className="px-3 py-1 text-xs text-white bg-red-600 hover:bg-red-500 rounded font-medium"
              >
                Redact
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
