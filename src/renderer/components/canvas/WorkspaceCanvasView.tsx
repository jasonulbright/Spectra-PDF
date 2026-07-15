import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { computeLayout, computeDropTarget, betweenSlotY, BASE_PAGE_HEIGHT, MIN_DOC_WIDTH } from '../../canvas/layout';
import { usePageDrag } from '../../canvas/usePageDrag';
import { uniqueDocName } from '../../lib/doc-names';
import { getDocumentProxy } from '../../lib/pdfDocCache';
import { buildRedactionRegions } from '../../lib/redaction';
import type { RedactionMark, RedactionRegion } from '../../lib/redaction';
import { buildSignatureAppearance } from '../../lib/signature-placement';
import type { SignaturePlacement } from '../../lib/signature-placement';
import { useEngine } from '../../hooks/useEngine';
import { dialog } from '../../lib/tauri-bridge';
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
import { workspacePageNumber } from '../../lib/workspace-commit';
import { buildMergedPageRefs, pathBlockedFromClose } from '../../lib/merge-docs';
import { useWorkspaceForms } from '../../hooks/useWorkspaceForms';
import { pruneFormValues, valueShapeMatches } from '../../lib/form-overlay';
import type { OverlayWidget } from '../../lib/form-overlay';
import type { FormFieldValue } from '../../lib/forms';
import type { NewFieldSpec, NewFieldType } from '../../lib/form-authoring';
import { TEST_HARNESS_ENABLED, registerCanvasRedaction, registerCanvasSignature, registerCanvasOcr, registerCanvasSelection, registerCanvasForms, registerCanvasMerge } from '../../testHarness';
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
import { STAMP_PRESETS, ANNOTATION_PALETTE } from './PageCell';
import { CommentSidebar } from './CommentSidebar';

interface WorkspaceCanvasViewProps {
  onOpenFiles: () => void;
  onCloseFile: (path: string) => void;
  // Open the PageInspector overlay. `pageNumber` is the page's workspace
  // position within its file (== the file's page order once pending edits
  // commit, which the opener does first).
  onInspectPage: (path: string, pageNumber: number) => void;
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
  // Add-page ghost (2n.3): pick file(s) and import their pages into a document
  // at an index (byte-only import machinery, undoable via the page tier).
  onAddPages: (docId: string, toIndex: number) => void;
  // Bake pending on-canvas form values into one file (2n.4b) — App implements
  // the FormsPanel shape (snapshot(gate) → readBuffer → fillFormFields →
  // writeBuffer → UPDATE_FILE), so it lands on the snapshot-undo chain.
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
const NO_MARKS: RedactionMark[] = [];
const NO_MARKS_BY_PAGE: ReadonlyMap<string, RedactionMark[]> = new Map();
const NO_PAGE_IDS: ReadonlySet<string> = new Set();
const NO_WORDS_BY_PAGE: ReadonlyMap<string, OcrWord[]> = new Map();
const NO_WIDGETS_BY_PAGE: ReadonlyMap<string, OverlayWidget[]> = new Map();
const NO_FORM_VALUES: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>> = new Map();

export function WorkspaceCanvasView({
  onOpenFiles,
  onCloseFile,
  onInspectPage,
  onExtractText,
  onRedactFile,
  onApplyOcrLayer,
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
  const focusedDoc =
    (state.ui.focusedDocId ? docs.find((d) => d.id === state.ui.focusedDocId) : null) ??
    docs.find((d) => d.path === state.activeFileId) ??
    null;
  const focusedDocRef = useRef(focusedDoc);
  focusedDocRef.current = focusedDoc;
  // A jump whose target lives in a document the reading view isn't showing:
  // parked here until that document's view has mounted (see onFindNavigate).
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
  const onFindNavigate = useCallback(
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
  const find = useFind(searchIndex.search, searchIndex.version, docs, onFindNavigate);
  const [applyingOcr, setApplyingOcr] = useState(false);
  const [ocrApplyError, setOcrApplyError] = useState<string | null>(null);

  // On-canvas forms (2n.4b): per-file field reads + widget projections, and
  // the pending-values map. Pending values are NAME-keyed per file —
  // deliberately not the positional-id lifecycle of marks/selection: a field
  // name survives page edits and commits, so half-typed values survive an
  // Apply-changes; they are PRUNED against every settled re-read instead
  // (name gone / no longer editable / shape mismatch / file closed).
  const workspaceForms = useWorkspaceForms(state.files, proxies);
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
  const [formsAddMode, setFormsAddMode] = useState(false);
  const [newFieldPlacement, setNewFieldPlacement] = useState<SignaturePlacement | null>(null);
  const [nfName, setNfName] = useState('');
  const [nfType, setNfType] = useState<NewFieldType>('text');
  const [nfOptions, setNfOptions] = useState('');
  const [nfMultiline, setNfMultiline] = useState(false);
  const [creatingField, setCreatingField] = useState(false);
  const [nfError, setNfError] = useState<string | null>(null);
  // Leaving the forms tool disarms add-field so re-entering starts inert.
  useEffect(() => {
    if (tool !== 'forms') setFormsAddMode(false);
  }, [tool]);

  const onSetNewFieldRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      setNewFieldPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setSigPlacement(null); // one placement card at a time (see onSetSignaturePlacement)
      setNfError(null);
    },
    [docs],
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
      const placement = liveNewFieldPlacement;
      if (!placement || creatingFieldRef.current) return;
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
        setFormsAddMode(false);
      } catch (err) {
        setNfError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        creatingFieldRef.current = false;
        setCreatingField(false);
      }
    },
    [liveNewFieldPlacement, docs, state.files, onAddFormField],
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
  useEffect(() => {
    registerCanvasServices({
      canvas: () => activeCanvasHandle(),
      find: {
        isOpen: () => findRef.current.open,
        open: () => findRef.current.openFind(),
        openWith: (q, pageId) => findRef.current.openWith(q, pageId),
        close: () => findRef.current.closeFind(),
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
      setSigPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setNewFieldPlacement(null);
      setSigFieldTarget(null);
      setSignDone(null);
      setSignError(null);
    },
    [docs],
  );
  const onClearSignaturePlacement = useCallback(() => setSigPlacement(null), []);

  // Clicking an empty signature widget in forms mode targets it (2n.4d). The
  // early pending-page-edits notice mirrors the hard check in applySignature.
  const onSignFieldRequest = useCallback(
    (path: string, fieldName: string) => {
      setSigFieldTarget({ path, fieldName });
      setSigPlacement(null);
      setNewFieldPlacement(null);
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
        const hits = highlightWords(words, find.matchedQuery);
        if (hits.length > 0) map.set(page.id, hits);
      }
    }
    return map.size > 0 ? map : NO_WORDS_BY_PAGE;
  }, [find.active, find.result, find.matchedQuery, docs, searchIndex]);

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

  const onOpenPage = useCallback(
    (docId: string, pageId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const pageNumber = workspacePageNumber(docs, doc, pageId);
      if (pageNumber != null) onInspectPage(doc.path, pageNumber);
    },
    [docs, onInspectPage],
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
      onOpen: onInspectPage,
      onExtractText,
    });
  }, [menu, docs, selectedPageIds, dispatch, onInspectPage, onExtractText]);

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
      {docViewMode === 'document' && focusedDoc ? (
        <DocumentView
          key={focusedDoc.id}
          ref={documentViewRef}
          doc={focusedDoc}
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
          signaturePlacement={liveSigPlacement}
          findMatchPageIds={findMatchPageIds}
          findWordsByPage={findWordsByPage}
          formWidgetsByPage={formWidgetsByPage}
          formValuesByPath={pendingFormValues}
          onSetFormValue={onSetFormValue}
          onSignFieldRequest={onSignFieldRequest}
          formsAddMode={formsAddMode}
          newFieldPlacement={liveNewFieldPlacement}
          onSetNewFieldRect={onSetNewFieldRect}
          onClearNewFieldPlacement={onClearNewFieldPlacement}
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
          signaturePlacement={liveSigPlacement}
          findMatchPageIds={findMatchPageIds}
          findWordsByPage={findWordsByPage}
          formWidgetsByPage={formWidgetsByPage}
          formValuesByPath={pendingFormValues}
          onSetFormValue={onSetFormValue}
          onSignFieldRequest={onSignFieldRequest}
          formsAddMode={formsAddMode}
          newFieldPlacement={liveNewFieldPlacement}
          onSetNewFieldRect={onSetNewFieldRect}
          onClearNewFieldPlacement={onClearNewFieldPlacement}
          onPageContextMenu={onPageContextMenu}
          onPagePointerDown={drag.onPagePointerDown}
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

      {/* Floating controls: tool toggle + zoom cluster + pending page-edit commit */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 z-30">
        <div className="flex bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg overflow-hidden">
          <button
            title="Select and drag pages"
            onClick={() => invokeCommand('tools.select')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'select' ? 'bg-neutral-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Select
          </button>
          <button
            data-testid="tool-highlight"
            title="Drag a box on a page to highlight (Esc to exit)"
            onClick={() => invokeCommand('tools.highlight')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'highlight' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Highlight
          </button>
          <button
            data-testid="tool-freetext"
            title="Drag a box on a page to add text (Esc to exit)"
            onClick={() => invokeCommand('tools.freetext')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'freetext' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Text
          </button>
          <button
            data-testid="tool-ink"
            title="Draw freehand on a page (Esc to exit)"
            onClick={() => invokeCommand('tools.ink')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'ink' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Draw
          </button>
          <button
            data-testid="tool-stamp"
            title="Click a page to place a stamp (Esc to exit)"
            onClick={() => invokeCommand('tools.stamp')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'stamp' ? 'bg-blue-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Stamp
          </button>
          <button
            data-testid="tool-redact"
            title="Drag a box on a page to mark it for redaction (Esc to exit)"
            onClick={() => invokeCommand('tools.redact')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'redact' ? 'bg-red-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Redact
          </button>
          <button
            data-testid="tool-signature"
            title="Drag a box on a page to place a visible signature (Esc to exit)"
            onClick={() => invokeCommand('tools.signature')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'signature' ? 'bg-violet-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Sign
          </button>
          <button
            data-testid="tool-forms"
            title="Fill form fields directly on the page (Esc to exit)"
            onClick={() => invokeCommand('tools.forms')}
            className={`px-3 py-1.5 text-xs font-medium ${tool === 'forms' ? 'bg-emerald-600 text-white' : 'text-neutral-300 hover:bg-neutral-700'}`}
          >
            Forms
          </button>
        </div>
        {tool === 'forms' && (
          <button
            data-testid="forms-add-field"
            title="Drag a box on a page to place a new form field"
            onClick={() => setFormsAddMode((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full shadow-lg border ${
              formsAddMode
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-neutral-800/90 text-neutral-300 border-neutral-700 hover:bg-neutral-700'
            }`}
          >
            + Add field
          </button>
        )}
        {tool === 'stamp' && (
          <div
            className="flex items-center gap-1 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg px-2 py-1"
            title="Stamp preset"
          >
            {STAMP_PRESETS.map((p) => (
              <button
                key={p.label}
                data-testid={`stamp-preset-${p.label.toLowerCase()}`}
                onClick={() => setStampPreset(stampPreset?.label === p.label ? null : p)}
                title={p.label}
                className="px-2 py-0.5 text-[10px] font-bold rounded-full"
                style={{
                  color: p.color,
                  border: `1px solid ${p.color}`,
                  backgroundColor: stampPreset?.label === p.label ? `${p.color}33` : 'transparent',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
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
        {tool !== 'select' && tool !== 'stamp' && (
          <div
            className="flex items-center gap-1 bg-neutral-800/90 border border-neutral-700 rounded-full shadow-lg px-2 py-1"
            title="Annotation color"
          >
            {ANNOTATION_PALETTE.map((c) => (
              <button
                key={c}
                data-testid={`annot-color-${c.slice(1)}`}
                onClick={() => setToolColor(toolColor === c ? null : c)}
                title={c}
                className="w-4 h-4 rounded-full"
                style={{
                  backgroundColor: c,
                  outline: toolColor === c ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        )}
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
          onJumpToPage={onFindNavigate}
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
