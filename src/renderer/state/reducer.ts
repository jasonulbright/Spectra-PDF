import { AppState, AppAction, CanvasTool, FocusedTab, OpenDocument, OpenFile, PageAnnotation, PageRef, PdfBuffer, UiState, isDocTab, NAV_PANE_MIN_WIDTH, NAV_PANE_MAX_WIDTH, NAV_PANE_DEFAULT_WIDTH } from './types';
import { carriesManifest } from '../lib/doc-names';
// Safe from the reducer: commands/tools has type-only imports, so it carries no
// runtime dependency back into the state or component layers.
import { toolById, toolForOp, armedModeOf, type ToolDef } from '../commands/tools';

// Re-project a display-normalized annotation rect when its page's display
// rotates by `delta` quarter-turns clockwise: annotation coords always live
// in the page's CURRENT display space (that's what the overlay renders and
// what the commit builder maps through the final rotation), so they must
// turn with the page to keep covering the same content.
// Re-project a single display-normalized point through the same quarter-turn
// (derived from, and consistent with, the bbox corner mapping below: applying
// this to a rect's two corners and re-deriving min/max reproduces it exactly).
function rotatePoint(u: number, v: number, d: number): [number, number] {
  if (d === 90) return [1 - v, u];
  if (d === 180) return [1 - u, 1 - v];
  if (d === 270) return [v, 1 - u];
  return [u, v];
}

export function rotateAnnotationRect(a: PageAnnotation, delta: number): PageAnnotation {
  const d = ((delta % 360) + 360) % 360;
  if (d === 0) return a;
  let points: number[] | undefined;
  if (a.points) {
    points = [];
    for (let i = 0; i < a.points.length; i += 2) {
      const [px, py] = rotatePoint(a.points[i], a.points[i + 1], d);
      points.push(px, py);
    }
  }
  if (d === 90) return { ...a, x: 1 - (a.y + a.h), y: a.x, w: a.h, h: a.w, ...(points ? { points } : {}) };
  if (d === 180) return { ...a, x: 1 - (a.x + a.w), y: 1 - (a.y + a.h), ...(points ? { points } : {}) };
  return { ...a, x: a.y, y: 1 - (a.x + a.w), w: a.h, h: a.w, ...(points ? { points } : {}) }; // 270
}

const NO_SELECTION: ReadonlySet<string> = new Set();

export const initialUiState: UiState = {
  focusedTab: 'home',
  activeOp: 'split',
  activeToolId: null,
  tool: 'select',
  // A document opens in the READING view (M4.1g, the end of M4). This is the
  // Acrobat model and § 6.1's stated default: a PDF is something you read; the
  // strips board is the tool you switch to when you want to REARRANGE it — which
  // is also why the board survives untouched as an equal, one-click peer rather
  // than being replaced.
  //
  // The flip was deliberately held until every § "gates before the default flip"
  // item closed (cross-document Find, text selection, zoom presets, Pages-panel
  // sync, horizontal reach, e2e) — the flip is the moment the reading view
  // becomes the experience, so the completeness rule binds here at the latest.
  docViewMode: 'document',
  focusedDocId: null,
  currentPageId: null,
  selectedPageIds: NO_SELECTION,
  selectionAnchor: null,
  recentFiles: [],
  navPane: { open: false, panel: 'pages', width: NAV_PANE_DEFAULT_WIDTH },
};

// Leaving doc-tab-land re-applies the board's parked-state semantics: the
// tool disarms and the selection clears (pre-M2 this was the canvas
// component's unmount; the commit-on-leave effect stays in App). Doc→doc
// switches keep both — same board, different active file (§ 6.6).
function focusTab(state: AppState, tab: FocusedTab): AppState {
  const prev = state.ui.focusedTab;
  const same =
    prev === tab || (isDocTab(prev) && isDocTab(tab) && prev.doc === tab.doc);
  if (same) return state;
  // A doc tab must reference an open, tab-bearing file — a stale focus
  // request (file closed underneath a queued dispatch) is rejected rather
  // than rendered, and byte-only import sources (2n.3) never get tabs.
  if (isDocTab(tab)) {
    const f = state.files.get(tab.doc);
    if (!f || f.importOnly) return state;
  }
  const leftDocLand = isDocTab(prev) && !isDocTab(tab);
  return {
    ...state,
    // Focusing a doc tab IS activating that file (§ 4.3: focusedTab doubles
    // as the SET_ACTIVE_FILE driver). Home/Tools leave the active file alone.
    activeFileId: isDocTab(tab) ? tab.doc : state.activeFileId,
    ui: leftDocLand
      ? {
          ...state.ui,
          focusedTab: tab,
          // A per-doc focus names a partition of the file being left — it can't
          // survive the move (it would strand the reading view on a document
          // the new tab doesn't own). Back to "that file's first document".
          focusedDocId: null,
          // ...and the reading position belonged to that document too.
          currentPageId: null,
          tool: 'select',
          selectedPageIds: NO_SELECTION,
          selectionAnchor: null,
        }
      : { ...state.ui, focusedTab: tab, focusedDocId: null, currentPageId: null },
  };
}

export const initialState: AppState = {
  files: new Map(),
  activeFileId: null,
  ui: initialUiState,
  workspace: { documents: [] },
  pageUndoStack: [],
  pageRedoStack: [],
  pageDirtyPaths: [],
};

// Selection holds positional PageRef ids (`path#pN`) that the indexer
// rebuilds from the new on-disk order after any buffer-identity change. A
// stale id would silently re-bind to a DIFFERENT physical page and get
// deleted or rotated by the batched actions. Selection is view-only (no
// data), so clearing it whenever a file's bytes change (or a file closes)
// is the safe answer — formerly a WorkspaceCanvasView buffer-watching
// effect; folded into the reducer cases that change buffers now that the
// selection lives in the ui slice (Phase 4 M1).
function clearSelection(state: AppState): AppState {
  if (state.ui.selectedPageIds.size === 0 && state.ui.selectionAnchor === null) return state;
  return { ...state, ui: { ...state.ui, selectedPageIds: NO_SELECTION, selectionAnchor: null } };
}

// Workspace-flattened page order (doc order, then page order) — the basis
// for shift-range selection and select-all.
function flatPageOrder(state: AppState): string[] {
  return state.workspace.documents.flatMap((d) => d.pages.map((p) => p.id));
}

function mapDocument(
  documents: OpenDocument[],
  docId: string,
  update: (doc: OpenDocument) => OpenDocument,
): OpenDocument[] {
  return documents.map((d) => (d.id === docId ? update(d) : d));
}

// Every in-memory page mutation goes through here: push the previous state
// onto the page-edit undo tier, clear redo, and mark the touched files dirty
// for the commit bridge. Callers return the current documents array unchanged
// (by reference) to signal a rejected/no-op edit.
function applyPageEdit(state: AppState, documents: OpenDocument[], touchedPaths: string[]): AppState {
  if (documents === state.workspace.documents) return state;
  const pageDirtyPaths = [
    ...state.pageDirtyPaths,
    ...touchedPaths.filter((p) => !state.pageDirtyPaths.includes(p)),
  ];
  return {
    ...state,
    workspace: { documents },
    pageUndoStack: [
      ...state.pageUndoStack,
      { documents: state.workspace.documents, dirtyPaths: state.pageDirtyPaths },
    ],
    pageRedoStack: [],
    pageDirtyPaths,
  };
}

// Total pages an open file would have across all its workspace documents —
// used to reject edits that would materialize a 0-page (invalid) PDF.
function pagesForPath(documents: OpenDocument[], path: string): number {
  return documents.filter((d) => d.path === path).reduce((sum, d) => sum + d.pages.length, 0);
}

// After a cross-doc move, drop documents left with no pages (matching PDFx),
// but never a path's last document — file-level lifecycle stays with CLOSE_FILE.
function pruneEmptyDocs(documents: OpenDocument[]): OpenDocument[] {
  const pruned = documents.filter(
    (d) => d.pages.length > 0 || documents.filter((o) => o.path === d.path).length === 1,
  );
  return pruned.length === documents.length ? documents : pruned;
}

// Drop byte-only import sources (2n.3) that no workspace page references any
// more — but only once the page tier is empty, since an undoable/redoable
// import still needs its source bytes. After a commit bakes imported pages into
// the target file and the indexer reindexes them back to sourceDocId=target,
// the source is unreferenced and safe to evict.
function evictUnreferencedImportSources(
  files: Map<string, OpenFile>,
  documents: OpenDocument[],
  pageUndoStack: unknown[],
  pageRedoStack: unknown[],
): Map<string, OpenFile> {
  if (pageUndoStack.length > 0 || pageRedoStack.length > 0) return files;
  const hasImportOnly = [...files.values()].some((f) => f.importOnly);
  if (!hasImportOnly) return files;
  const referenced = new Set<string>();
  for (const d of documents) for (const p of d.pages) referenced.add(p.sourceDocId);
  let changed = false;
  const next = new Map(files);
  for (const [path, f] of files) {
    if (f.importOnly && !referenced.has(path)) {
      next.delete(path);
      changed = true;
    }
  }
  return changed ? next : files;
}

// After stripping a closed file's pages out of other documents, a still-open
// path can be left with zero total pages — an uncommittable composition.
// Dropping its documents (and its dirty mark) lets the indexer restore that
// file's pristine composition from its unchanged buffer.
function resetEmptiedPaths(
  documents: OpenDocument[],
  dirtyPaths: string[],
): { documents: OpenDocument[]; dirtyPaths: string[] } {
  const emptied = new Set(
    documents.map((d) => d.path).filter((path) => pagesForPath(documents, path) === 0),
  );
  if (emptied.size === 0) return { documents, dirtyPaths };
  return {
    documents: documents.filter((d) => !emptied.has(d.path)),
    dirtyPaths: dirtyPaths.filter((p) => !emptied.has(p)),
  };
}

function applyFileUpdate(
  files: Map<string, OpenFile>,
  update: { path: string; pageCount: number; buffer: PdfBuffer; snapshotPath: string },
): Map<string, OpenFile> {
  const existing = files.get(update.path);
  if (!existing) return files;
  const next = new Map(files);
  next.set(update.path, {
    ...existing,
    pageCount: update.pageCount,
    buffer: update.buffer,
    dirty: true,
    undoStack: [...existing.undoStack, update.snapshotPath],
    redoStack: [], // new action clears redo
  });
  return next;
}

/**
 * Open (or close, with null) a Tools-tab tool, and put the canvas mode where
 * that tool says it belongs.
 *
 * THE ONE PLACE `activeToolId` CHANGES. Both actions that open a tool route
 * here, because the two are not independent: `ui.tool` is live on the canvas
 * (PageCell branches on it), nothing else clears it — `focusTab` only resets on
 * LEAVING a doc tab, so Tools→Tools and Tools→doc never qualify — and so a mode
 * left armed by a tool the user has since closed goes silently live the moment
 * they click back onto a document: every form widget interactive, plain drags
 * swallowed, with no chrome saying why. A tool whose mode is "none", and the
 * tile grid (`toolId: null`, no tool open at all), must DISARM the last one.
 *
 * This bug was fixed FOUR times before landing here — once at each dispatcher
 * that happened to be under review that round (`tools.open.*`, then again for a
 * second variable, then `tools.panel.*` via the rail and the Tools menu, then
 * the ‹ Tools back button, which an earlier round's own notes had already named
 * as a door and left open). Every one of those fixes was correct and none of
 * them was enough, because the rule isn't about any dispatcher: opening a tool
 * DETERMINES the canvas mode, so the code that changes the tool must be the code
 * that sets the mode. Anything else is a rule that survives only as long as the
 * next author remembers it.
 */
function openTool(ui: UiState, toolId: string | null): UiState {
  const owner = toolId ? toolById(toolId) : undefined;
  const tool = canvasModeAfterOpening(ui, owner);
  if (toolId === ui.activeToolId && tool === ui.tool) return ui;
  return { ...ui, activeToolId: toolId, tool };
}

/** What `ui.tool` becomes when `owner` is opened (undefined owner = closed). */
function canvasModeAfterOpening(ui: UiState, owner: ToolDef | undefined): CanvasTool {
  // No tool open at all (the tile grid) — nothing may be armed.
  if (!owner) return 'select';
  // It drives the canvas: arm the first mode it owns.
  const mode = armedModeOf(owner);
  if (mode) return mode;
  // It has a form to fill on the TOOLS TAB and no canvas mode, so it replaces
  // whatever you were doing — and you left the document to reach it anyway.
  if (owner.ops.length > 0) return 'select';
  // Neither: it lives on the document but isn't a mode (Scan & OCR — it just
  // opens Find). It has no opinion about the canvas, so it doesn't get one:
  // taking away the user's Highlight to show them a search box would be
  // gratuitous. Left alone deliberately; this is the third distinct answer and
  // the reason this isn't a one-liner.
  return ui.tool;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'OPEN_FILE': {
      // A REOPEN replaces the path's buffer — stale positional selection ids
      // must not survive it (a fresh open leaves the selection alone).
      const base = state.files.has(action.path) ? clearSelection(state) : state;
      const files = new Map(state.files);
      files.set(action.path, {
        path: action.path,
        workingPath: action.workingPath,
        name: action.name,
        pageCount: action.pageCount,
        buffer: action.buffer,
        dirty: false,
        undoStack: [],
        redoStack: [],
      });
      return {
        ...base,
        files,
        activeFileId: action.path,
        // OPEN_FILE stays pure (just registers the file + sets it active).
        // Landing on the opened doc's tab is the CALLER's decision — openByPaths
        // focuses it, importFilesIntoDoc does not — so a background register
        // (e.g. a page-import source) never yanks the user onto the board.
        // A REOPENED path's old workspace composition is stale the moment
        // the new bytes land — serving it until the async indexer catches up
        // briefly resurrects pre-reopen state (possibly already-edited docs;
        // the 2p known-bug fix, surfaced while writing 06-annotations). Drop
        // this path's docs (the indexer rebuilds them from the fresh buffer)
        // and its now-meaningless page-tier dirt; other files' compositions
        // and dirt stay — an open invalidates only its own path.
        workspace: {
          documents: state.workspace.documents.filter((d) => d.path !== action.path),
        },
        pageDirtyPaths: state.pageDirtyPaths.filter((p) => p !== action.path),
        // Page-edit history recorded before this file existed (or before its
        // buffer was refreshed) can't be replayed against the new workspace —
        // undoing it would drop the file's strip.
        pageUndoStack: [],
        pageRedoStack: [],
      };
    }
    case 'REGISTER_IMPORT_SOURCE': {
      // Byte-only source for IMPORT_PAGES (2n.3): register its bytes so imported
      // pages render and the commit builder can resolve them, but WITHOUT a
      // strip (the indexer skips importOnly) and WITHOUT touching the active
      // file or the page-edit tier (unlike OPEN_FILE). Idempotent — if the path
      // is already open (as a real file or a prior import source), reuse it.
      if (state.files.has(action.path)) return state;
      const files = new Map(state.files);
      files.set(action.path, {
        path: action.path,
        workingPath: action.workingPath,
        name: action.name,
        pageCount: action.pageCount,
        buffer: action.buffer,
        dirty: false,
        undoStack: [],
        redoStack: [],
        importOnly: true,
      });
      return { ...state, files };
    }
    case 'CLOSE_FILE': {
      // A later reopen reuses the same positional page ids — clear selection.
      const base = clearSelection(state);
      const files = new Map(state.files);
      files.delete(action.path);
      // Fall back to the next file the user can actually SEE — never a
      // byte-only import source. Ghosts have no tab and are never shown, so
      // making one "the active file" hands every panel an invisible target:
      // the Tools tab's document picker (which lists only real files) then
      // can't match it and, being a native <select>, confidently highlights a
      // DIFFERENT file while the panels operate on the ghost.
      //
      // The tab fallback below already skipped ghosts; only the tab. Fixing the
      // active id at the source makes that guard belt-and-braces instead of the
      // thing holding the invariant up — the M5.1 lesson (see CLAUDE.md § Design
      // invariants: activeFileId !== null is NOT "a document the user can see").
      // All ghosts left = nothing to be active; null is the honest answer.
      const nextActive =
        [...files.values()].find((f) => !f.importOnly)?.path ?? null;
      const activeFileId = state.activeFileId === action.path
        ? nextActive
        : state.activeFileId;
      // Drop the file's documents, and strip its pages out of every other
      // document — pending cross-file moves referencing it could never be
      // committed once the source bytes are gone. Page-edit history may
      // reference those pages too, so the tier resets. Paths stripped all the
      // way to zero pages are reset to their on-disk composition instead of
      // keeping an uncommittable empty strip.
      const stripped = pruneEmptyDocs(
        state.workspace.documents
          .filter((d) => d.path !== action.path)
          .map((d) =>
            d.pages.some((p) => p.sourceDocId === action.path)
              ? { ...d, pages: d.pages.filter((p) => p.sourceDocId !== action.path) }
              : d,
          ),
      );
      const { documents, dirtyPaths } = resetEmptiedPaths(
        stripped,
        state.pageDirtyPaths.filter((p) => p !== action.path),
      );
      // Closing the focused tab falls back to the next open doc's tab (the
      // activeFileId fallback computed above), else Home. Closing an
      // unfocused file leaves the strip alone.
      const focusedClosed =
        isDocTab(base.ui.focusedTab) && base.ui.focusedTab.doc === action.path;
      // The activeFileId fallback can land on a byte-only import source
      // (first remaining Map key) — such files never get tabs, so fall back
      // to Home instead of focusing a ghost.
      const fallbackTab: FocusedTab =
        activeFileId && !files.get(activeFileId)?.importOnly ? { doc: activeFileId } : 'home';
      const ui = focusedClosed ? { ...base.ui, focusedTab: fallbackTab } : base.ui;
      return {
        ...base,
        files,
        activeFileId,
        ui,
        workspace: { documents },
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: dirtyPaths,
      };
    }
    case 'SET_ACTIVE_FILE': {
      // A byte-only import source can never be the ACTIVE file. It has no tab
      // and is never rendered, so making it active hands every panel an
      // invisible target — and the damage isn't cosmetic: `isActiveFileDirty`
      // would light up File ▸ Save, whose handler writes the working copy back
      // to `activeFile.path`, which for an import source is the ORIGINAL file
      // the user picked. That is a silent overwrite of a real file on disk,
      // with no dialog and no dirty indicator anywhere (no tab to show one).
      //
      // Reject rather than coerce: the caller asked for something incoherent,
      // and a reducer that quietly substitutes a different file is its own bug.
      // This is what makes "the active file is never a ghost" TRUE — the other
      // writers were already safe (OPEN_FILE upgrades the entry in the same
      // dispatch; REGISTER_IMPORT_SOURCE deliberately doesn't touch the active
      // file; CLOSE_FILE's fallback skips ghosts), and this was the hole.
      if (state.files.get(action.path)?.importOnly) return state;
      // A per-doc focus names a partition of the file being left — like
      // focusTab, drop it so the reading view can't keep rendering the old
      // file's document while the tab strip says another file is active
      // (review-caught: reopening an already-open file dispatches only
      // SET_ACTIVE_FILE, so the stale id survived and won the resolution).
      const cleared =
        action.path !== state.activeFileId &&
        (state.ui.focusedDocId !== null || state.ui.currentPageId !== null)
          ? { ...state.ui, focusedDocId: null, currentPageId: null }
          : state.ui;
      return {
        ...state,
        activeFileId: action.path,
        // In doc-land the focused tab IS the active file — follow it (a
        // strip click activates that document's tab). Elsewhere the tab
        // strip stays put, exactly like the old rail-list selection.
        ui:
          isDocTab(state.ui.focusedTab) && state.files.has(action.path)
            ? { ...cleared, focusedTab: { doc: action.path } }
            : cleared,
      };
    }
    case 'UPDATE_FILE': {
      const files = applyFileUpdate(state.files, action);
      if (files === state.files) return state;
      const base = clearSelection(state); // buffer replaced — positional selection ids are stale
      const tierEmpty =
        state.pageUndoStack.length === 0 &&
        state.pageRedoStack.length === 0 &&
        state.pageDirtyPaths.length === 0;
      if (tierEmpty) return { ...base, files };
      // Defense-in-depth: the file's bytes were replaced while page edits
      // were pending — a caller bypassed the commit gate. In-memory history
      // and dirty compositions now reference stale buffers (cross-file moves
      // entangle every dirty path with each other), so the whole tier resets
      // and the dirty paths' documents are dropped for the indexer to
      // re-derive from the current buffers.
      const invalidated = new Set([...state.pageDirtyPaths, action.path]);
      return {
        ...base,
        files,
        workspace: {
          documents: state.workspace.documents.filter((d) => !invalidated.has(d.path)),
        },
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: [],
      };
    }
    case 'COMMIT_PAGE_EDITS': {
      // The commit bridge's atomic landing: every rebuilt file joins the
      // snapshot undo chain and the page-edit tier resets in one step. The
      // workspace is left alone — the indexer re-derives each updated path
      // from its new buffer.
      let files = state.files;
      for (const update of action.updates) {
        files = applyFileUpdate(files, update);
      }
      // Buffers replaced — stale positional selection ids must not survive.
      const base = files === state.files ? state : clearSelection(state);
      return {
        ...base,
        files,
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: [],
      };
    }
    case 'UNDO': {
      const files = new Map(state.files);
      const existing = files.get(action.path);
      if (!existing || existing.undoStack.length === 0) return state;
      files.set(action.path, {
        ...existing,
        undoStack: existing.undoStack.slice(0, -1), // caller restored this snapshot
        redoStack: [...existing.redoStack, action.redoSnapshot],
        dirty: existing.undoStack.length > 1,
      });
      return { ...state, files };
    }
    case 'REDO': {
      const files = new Map(state.files);
      const existing = files.get(action.path);
      if (!existing || existing.redoStack.length === 0) return state;
      files.set(action.path, {
        ...existing,
        redoStack: existing.redoStack.slice(0, -1), // caller restored this snapshot
        undoStack: [...existing.undoStack, action.undoSnapshot],
        dirty: true,
      });
      return { ...state, files };
    }
    case 'REFRESH_BUFFER': {
      // Buffer/pageCount swap that leaves undo/redo history alone — used
      // after an undo/redo restore. Callers drain the page tier first, but if
      // one ever doesn't, invalidate it like UPDATE_FILE does.
      const existing = state.files.get(action.path);
      if (!existing) return state;
      const base = clearSelection(state); // buffer replaced — positional selection ids are stale
      const files = new Map(state.files);
      files.set(action.path, { ...existing, pageCount: action.pageCount, buffer: action.buffer });
      const tierEmpty =
        state.pageUndoStack.length === 0 &&
        state.pageRedoStack.length === 0 &&
        state.pageDirtyPaths.length === 0;
      if (tierEmpty) return { ...base, files };
      const invalidated = new Set([...state.pageDirtyPaths, action.path]);
      return {
        ...base,
        files,
        workspace: {
          documents: state.workspace.documents.filter((d) => !invalidated.has(d.path)),
        },
        pageUndoStack: [],
        pageRedoStack: [],
        pageDirtyPaths: [],
      };
    }
    case 'MARK_SAVED': {
      const files = new Map(state.files);
      const existing = files.get(action.path);
      if (!existing) return state;
      files.set(action.path, { ...existing, dirty: false, undoStack: [], redoStack: [] });
      return { ...state, files };
    }
    case 'SET_WORKSPACE_DOCUMENTS': {
      // Indexing is async — the file may have been closed while it ran.
      if (!state.files.has(action.path)) return state;
      const prev = state.workspace.documents;
      const firstIndex = prev.findIndex((d) => d.path === action.path);
      const kept = prev.filter((d) => d.path !== action.path);
      // Replace this file's documents in place; new files append at the end.
      const insertAt = firstIndex === -1
        ? kept.length
        : prev.slice(0, firstIndex).filter((d) => d.path !== action.path).length;
      const documents = [...kept.slice(0, insertAt), ...action.documents, ...kept.slice(insertAt)];
      // Reindexing bakes any just-committed imports into the target's own pages,
      // so their byte-only sources may now be unreferenced — evict them (gated
      // on an empty page tier).
      const files = evictUnreferencedImportSources(
        state.files,
        documents,
        state.pageUndoStack,
        state.pageRedoStack,
      );
      // A per-doc focus into THIS path is stale the moment its documents are
      // re-derived: `OpenDocument.id` is positional (`path#docIndex`), so the
      // same id string can come back naming a DIFFERENT partition — reorder two
      // `.pdfx` strips, commit, and `book.pdfx#1` means the other one, which the
      // reading view would show with no signal (the positional-id re-binding
      // class CLAUDE.md records for redaction marks). Dropping to null
      // re-resolves to the active file's first document.
      //
      // DO NOT "optimise" this into a check for whether the content actually
      // moved — that was tried and is UNSOUND (review-caught). Page ids are
      // `path#p{ABSOLUTE page index}` (`partitionPages` walks a cumulative
      // cursor), so they encode a partition's POSITION, not its identity:
      // swapping two partitions of EQUAL page count re-derives a bit-identical
      // page-id array for each slot while the content is completely different,
      // so a comparison sees "unchanged" and keeps a focus that now names the
      // wrong partition. Partition NAMES aren't a sound key either (nothing
      // guarantees a manifest's names are unique — `uniqueDocName` is applied at
      // rename time, not to arbitrary/older manifests). As with the reading
      // view's jump anchor, there is no identity across a rebuild, so this fails
      // SAFE and pays for it. Be honest about the size of that bill: this fires
      // on ANY buffer-identity change for the path, which is more than "engine
      // whole-file ops" — committing ANY page-tier edit (an annotation counts),
      // file-level Undo/Redo (`REFRESH_BUFFER`), and — because the commit gate
      // flushes EVERY dirty path atomically — an engine op run on a COMPLETELY
      // DIFFERENT file will reindex this one too. Each of those resets a `.pdfx`
      // reader to the file's first partition. Always safe, never wrong content,
      // and re-navigable; preserving the position needs real cross-commit
      // identity (see `canvas/reading-page.ts`'s JumpAnchor note).
      //
      // Ownership is tested against the real documents, NOT a string prefix:
      // paths may contain '#' (raw OS paths from the file dialog), so
      // `id.startsWith(path + '#')` would let "a.pdf" match a doc of the
      // distinct open file "a.pdf#draft.pdf" and clear its focus (review-caught;
      // over-clear only, but it is not what the code claims to do). The second
      // clause covers a focus whose doc has since left `prev` (its file was
      // closed) while the incoming set re-claims that id — it must not silently
      // re-bind to whatever now holds it.
      const focusedId = state.ui.focusedDocId;
      const ownedByThisPath =
        !!focusedId &&
        (prev.some((d) => d.id === focusedId && d.path === action.path) ||
          action.documents.some((d) => d.id === focusedId));
      // The reading position is positional too, and re-derived ids are REUSED —
      // so a surviving `currentPageId` could highlight a different physical page
      // in the Pages panel. Same trigger, same reasoning (roadmap § F).
      const currentOfThisPath =
        !!state.ui.currentPageId &&
        (prev.some((d) => d.path === action.path && d.pages.some((p) => p.id === state.ui.currentPageId)) ||
          action.documents.some((d) => d.pages.some((p) => p.id === state.ui.currentPageId)));
      const ui =
        ownedByThisPath || currentOfThisPath
          ? {
              ...state.ui,
              focusedDocId: ownedByThisPath ? null : state.ui.focusedDocId,
              currentPageId: currentOfThisPath ? null : state.ui.currentPageId,
            }
          : state.ui;
      return { ...state, files, ui, workspace: { documents } };
    }
    case 'REORDER_PAGES': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      if (!doc) return state;
      const byId = new Map(doc.pages.map((p) => [p.id, p]));
      const valid =
        action.order.length === doc.pages.length &&
        action.order.every((id) => byId.has(id)) &&
        action.order.some((id, i) => doc.pages[i].id !== id);
      if (!valid) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: action.order.map((id) => byId.get(id)!),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'MOVE_PAGE': {
      const from = state.workspace.documents.find((d) => d.id === action.fromDocId);
      const to = state.workspace.documents.find((d) => d.id === action.toDocId);
      const page = from?.pages.find((p) => p.id === action.pageId);
      if (!from || !to || !page) return state;
      let documents = state.workspace.documents.map((d) => {
        if (d.id !== from.id && d.id !== to.id) return d;
        // Remove from source, then insert at the target index (a same-document
        // move hits both branches, so toIndex counts positions after removal).
        let pages = d.id === from.id ? d.pages.filter((p) => p.id !== page.id) : d.pages;
        if (d.id === to.id) {
          const at = Math.max(0, Math.min(action.toIndex, pages.length));
          pages = [...pages.slice(0, at), page, ...pages.slice(at)];
        }
        return { ...d, pages, pageCount: pages.length };
      });
      if (from.id === to.id && documents.every((d, i) => {
        const prev = state.workspace.documents[i];
        return d.pages.length === prev.pages.length && d.pages.every((p, j) => p === prev.pages[j]);
      })) {
        return state; // same-document move that landed where it started
      }
      if (pagesForPath(documents, from.path) === 0) return state; // would empty the file
      documents = pruneEmptyDocs(documents);
      return applyPageEdit(state, documents, from.path === to.path ? [from.path] : [from.path, to.path]);
    }
    case 'MOVE_PAGE_TO_NEW_DOC': {
      const sourceIndex = state.workspace.documents.findIndex((d) => d.id === action.fromDocId);
      const source = sourceIndex === -1 ? undefined : state.workspace.documents[sourceIndex];
      const page = source?.pages.find((p) => p.id === action.pageId);
      if (!source || !page) return state;
      // The new document is a new partition of the page's source file — it
      // keeps that file's path/buffer (the file never loses pages here), and
      // the commit bridge rebuilds the same file with one more manifest entry.
      const withoutPage = mapDocument(state.workspace.documents, source.id, (d) => {
        const pages = d.pages.filter((p) => p.id !== page.id);
        return { ...d, pages, pageCount: pages.length };
      });
      // An emptied source doc is always pruned here — the new document carries
      // the same path, so the file keeps at least one document.
      const emptied = source.pages.length === 1;
      let next = emptied ? withoutPage.filter((d) => d.id !== source.id) : withoutPage;
      let insertAt = action.docIndex;
      if (emptied && sourceIndex < action.docIndex) insertAt -= 1;
      insertAt = Math.max(0, Math.min(next.length, insertAt));
      const newDoc: OpenDocument = {
        ...source,
        id: action.newDocId,
        name: action.newName,
        pages: [page],
        pageCount: 1,
      };
      next = [...next.slice(0, insertAt), newDoc, ...next.slice(insertAt)];
      return applyPageEdit(state, next, [source.path]);
    }
    case 'MOVE_PAGES': {
      if (action.pageIds.length === 0) return state;
      const idSet = new Set(action.pageIds);
      const to = state.workspace.documents.find((d) => d.id === action.toDocId);
      if (!to) return state;
      // Collect the moving pages in workspace-flattened order (doc order, then
      // page order) so a selection spanning several docs keeps its visual order.
      const moving: PageRef[] = [];
      const touched = new Set<string>();
      for (const d of state.workspace.documents) {
        for (const p of d.pages) {
          if (idSet.has(p.id)) {
            moving.push(p);
            touched.add(d.path);
          }
        }
      }
      if (moving.length !== idSet.size) return state; // an id wasn't found — reject atomically
      touched.add(to.path);
      // Remove every moving page from its doc; insert them into the target at
      // the clamped index, counted against the target's post-removal length
      // (the drop-target math already excludes the moving pages).
      let documents = state.workspace.documents.map((d) => {
        if (d.id === to.id) {
          const kept = d.pages.filter((p) => !idSet.has(p.id));
          const at = Math.max(0, Math.min(action.toIndex, kept.length));
          const pages = [...kept.slice(0, at), ...moving, ...kept.slice(at)];
          return { ...d, pages, pageCount: pages.length };
        }
        if (d.pages.some((p) => idSet.has(p.id))) {
          const pages = d.pages.filter((p) => !idSet.has(p.id));
          return { ...d, pages, pageCount: pages.length };
        }
        return d;
      });
      // No-op guard: a drag that landed exactly where it started must not push
      // an undo entry (mirrors MOVE_PAGE's same-document no-op check).
      const unchanged =
        documents.length === state.workspace.documents.length &&
        documents.every((d, i) => {
          const prev = state.workspace.documents[i];
          return (
            d.pages.length === prev.pages.length && d.pages.every((p, j) => p === prev.pages[j])
          );
        });
      if (unchanged) return state;
      for (const path of touched) {
        if (pagesForPath(documents, path) === 0) return state; // would empty a file
      }
      documents = pruneEmptyDocs(documents);
      return applyPageEdit(state, documents, [...touched]);
    }
    case 'MOVE_PAGES_TO_NEW_DOC': {
      if (action.pageIds.length === 0) return state;
      const idSet = new Set(action.pageIds);
      const moving: PageRef[] = [];
      const touched = new Set<string>();
      let template: OpenDocument | undefined;
      for (const d of state.workspace.documents) {
        for (const p of d.pages) {
          if (idSet.has(p.id)) {
            moving.push(p);
            touched.add(d.path);
            if (!template) template = d;
          }
        }
      }
      if (moving.length !== idSet.size || !template) return state;
      // The new document is templated on the first selected page's document, so
      // it carries a real path/buffer for the commit builder (like the singular
      // MOVE_PAGE_TO_NEW_DOC). Pages sourced from other files ride along as
      // cross-file references, exactly as an "into" move already allows.
      const newDoc: OpenDocument = {
        ...template,
        id: action.newDocId,
        name: action.newName,
        pages: moving,
        pageCount: moving.length,
      };
      const stripped = state.workspace.documents.map((d) => {
        if (!d.pages.some((p) => idSet.has(p.id))) return d;
        const pages = d.pages.filter((p) => !idSet.has(p.id));
        return { ...d, pages, pageCount: pages.length };
      });
      // Insert in the pre-prune frame (same doc-slot count as the original list,
      // since removal only empties docs, never drops slots yet) then prune —
      // the new doc has pages so it's never pruned, and its position among the
      // survivors matches the single version's index-adjust-then-insert.
      const at = Math.max(0, Math.min(action.docIndex, stripped.length));
      const documents = pruneEmptyDocs([...stripped.slice(0, at), newDoc, ...stripped.slice(at)]);
      for (const path of touched) {
        if (pagesForPath(documents, path) === 0) return state; // would empty a file
      }
      return applyPageEdit(state, documents, [...touched]);
    }
    case 'IMPORT_PAGES': {
      if (action.pages.length === 0) return state;
      const to = state.workspace.documents.find((d) => d.id === action.toDocId);
      if (!to) return state;
      // Splice the imported page refs into the target at the clamped index.
      // Their sourceDocId points at a REGISTER_IMPORT_SOURCE byte-only file, so
      // they render (usePdfProxies) and commit (bytesFor) like any other page.
      const documents = mapDocument(state.workspace.documents, to.id, (d) => {
        const at = Math.max(0, Math.min(action.toIndex, d.pages.length));
        const pages = [...d.pages.slice(0, at), ...action.pages, ...d.pages.slice(at)];
        return { ...d, pages, pageCount: pages.length };
      });
      return applyPageEdit(state, documents, [to.path]);
    }
    case 'DELETE_PAGE_REF': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page) return state;
      // Deleting the file's last remaining page would materialize a 0-page
      // PDF at commit — closing the file is the right gesture for that.
      if (pagesForPath(state.workspace.documents, doc.path) <= 1) return state;
      const documents = pruneEmptyDocs(
        mapDocument(state.workspace.documents, action.docId, (d) => {
          const pages = d.pages.filter((p) => p.id !== action.pageId);
          return { ...d, pages, pageCount: pages.length };
        }),
      );
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'DELETE_PAGE_REFS': {
      if (action.pageIds.length === 0) return state;
      const idSet = new Set(action.pageIds);
      const touched = new Set<string>();
      let found = 0;
      for (const d of state.workspace.documents) {
        for (const p of d.pages) {
          if (idSet.has(p.id)) {
            touched.add(d.path);
            found++;
          }
        }
      }
      // Atomic on a partially-stale batch: if any requested id isn't present,
      // reject the whole delete rather than silently removing the subset that
      // matched (mirrors MOVE_PAGES). A stale id in the set otherwise means the
      // user deletes fewer/other pages than intended.
      if (found !== idSet.size) return state;
      const stripped = state.workspace.documents.map((d) => {
        if (!d.pages.some((p) => idSet.has(p.id))) return d;
        const pages = d.pages.filter((p) => !idSet.has(p.id));
        return { ...d, pages, pageCount: pages.length };
      });
      // Atomic: reject the whole batch if it would materialize a 0-page file
      // (closing the file is the right gesture for emptying one) — same guard
      // as the singular DELETE_PAGE_REF, applied per touched path.
      for (const path of touched) {
        if (pagesForPath(stripped, path) === 0) return state;
      }
      const documents = pruneEmptyDocs(stripped);
      return applyPageEdit(state, documents, [...touched]);
    }
    case 'SPLIT_DOC': {
      const index = state.workspace.documents.findIndex((d) => d.id === action.docId);
      const doc = index === -1 ? undefined : state.workspace.documents[index];
      if (!doc || action.atIndex <= 0 || action.atIndex >= doc.pages.length) return state;
      const head = doc.pages.slice(0, action.atIndex);
      const tail = doc.pages.slice(action.atIndex);
      const documents = [...state.workspace.documents];
      documents.splice(
        index,
        1,
        { ...doc, pages: head, pageCount: head.length },
        { ...doc, id: action.newDocId, name: action.newName, pages: tail, pageCount: tail.length },
      );
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'ADD_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? { ...p, annotations: [...(p.annotations ?? []), action.annotation] }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'UPDATE_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      const existing = page?.annotations?.find((a) => a.id === action.annotationId);
      if (!doc || !existing || existing.note === action.note) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? {
                ...p,
                annotations: p.annotations!.map((a) =>
                  a.id === action.annotationId ? { ...a, note: action.note } : a,
                ),
              }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'RECOLOR_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      const existing = page?.annotations?.find((a) => a.id === action.annotationId);
      if (!doc || !existing || existing.color === action.color) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? {
                ...p,
                annotations: p.annotations!.map((a) =>
                  a.id === action.annotationId ? { ...a, color: action.color } : a,
                ),
              }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'REMOVE_ANNOTATION': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      const removed = page?.annotations?.find((a) => a.id === action.annotationId);
      if (!doc || !removed) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? {
                ...p,
                annotations: p.annotations!.filter((a) => a.id !== action.annotationId),
                // Removing an imported annotation drops its importedOriginal
                // fingerprint along with it — without keeping the fingerprint
                // here, the commit-time strip has nothing left to match the
                // real PDF object against and leaves it in place, silently
                // undoing the removal. See PageRef.removedImportedOriginals.
                ...(removed.importedOriginal
                  ? { removedImportedOriginals: [...(p.removedImportedOriginals ?? []), removed.importedOriginal] }
                  : {}),
              }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'ROTATE_PAGE_REF': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const page = doc?.pages.find((p) => p.id === action.pageId);
      if (!doc || !page || page.rotation === action.rotation) return state;
      const delta = (action.rotation - page.rotation + 360) % 360;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        pages: d.pages.map((p) =>
          p.id === action.pageId
            ? {
                ...p,
                rotation: action.rotation,
                annotations: p.annotations?.map((a) => rotateAnnotationRect(a, delta)),
              }
            : p,
        ),
      }));
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'ROTATE_PAGE_REFS': {
      if (action.pageIds.length === 0) return state;
      const idSet = new Set(action.pageIds);
      const delta = (((action.delta % 360) + 360) % 360) as 0 | 90 | 180 | 270;
      if (delta === 0) return state;
      // Atomic on a partially-stale batch (mirrors MOVE_PAGES / DELETE_PAGE_REFS):
      // reject unless every requested id is present, rather than rotating the
      // matching subset.
      let found = 0;
      for (const d of state.workspace.documents) for (const p of d.pages) if (idSet.has(p.id)) found++;
      if (found !== idSet.size) return state;
      const touched = new Set<string>();
      const documents = state.workspace.documents.map((d) => {
        if (!d.pages.some((p) => idSet.has(p.id))) return d;
        touched.add(d.path);
        return {
          ...d,
          pages: d.pages.map((p) => {
            if (!idSet.has(p.id)) return p;
            const rotation = (((p.rotation + delta) % 360) as 0 | 90 | 180 | 270);
            // Re-project annotations by the same delta as the singular rotate.
            return { ...p, rotation, annotations: p.annotations?.map((a) => rotateAnnotationRect(a, delta)) };
          }),
        };
      });
      // found === idSet.size (checked above) guarantees at least one match, so
      // `documents` always carries a real change here.
      return applyPageEdit(state, documents, [...touched]);
    }
    case 'REORDER_DOCS': {
      const index = state.workspace.documents.findIndex((d) => d.id === action.docId);
      const target = index + action.direction;
      if (index === -1 || target < 0 || target >= state.workspace.documents.length) return state;
      const documents = [...state.workspace.documents];
      [documents[index], documents[target]] = [documents[target], documents[index]];
      // Cross-file strip order is view-only; swapping two partitions of the
      // same file changes that file's page order and must be committed.
      const samePath = documents[index].path === documents[target].path;
      return applyPageEdit(state, documents, samePath ? [documents[index].path] : []);
    }
    case 'RENAME_DOC': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      const name = action.name.trim();
      if (!doc || !name || name === doc.name) return state;
      const documents = mapDocument(state.workspace.documents, action.docId, (d) => ({
        ...d,
        name,
      }));
      // Persisted via the manifest only when the file commits with one —
      // same file-anchored predicate the commit planner uses, so a rename
      // never dirties a file that would then commit without a manifest (or
      // vice versa). Otherwise display-only until reindex.
      const partitionCount = state.workspace.documents.filter((d) => d.path === doc.path).length;
      const fileName = state.files.get(doc.path)?.name ?? doc.name;
      const persists = carriesManifest(fileName, partitionCount);
      return applyPageEdit(state, documents, persists ? [doc.path] : []);
    }
    case 'REMOVE_DOC': {
      const doc = state.workspace.documents.find((d) => d.id === action.docId);
      if (!doc) return state;
      const siblings = state.workspace.documents.filter((d) => d.path === doc.path);
      if (siblings.length === 1) return state; // last document of a file — close the file instead
      const documents = state.workspace.documents.filter((d) => d.id !== action.docId);
      return applyPageEdit(state, documents, [doc.path]);
    }
    case 'UNDO_PAGE_OP': {
      const last = state.pageUndoStack[state.pageUndoStack.length - 1];
      if (!last) return state;
      return {
        ...state,
        workspace: { documents: last.documents },
        pageDirtyPaths: last.dirtyPaths,
        pageUndoStack: state.pageUndoStack.slice(0, -1),
        pageRedoStack: [
          ...state.pageRedoStack,
          { documents: state.workspace.documents, dirtyPaths: state.pageDirtyPaths },
        ],
      };
    }
    case 'REDO_PAGE_OP': {
      const next = state.pageRedoStack[state.pageRedoStack.length - 1];
      if (!next) return state;
      return {
        ...state,
        workspace: { documents: next.documents },
        pageDirtyPaths: next.dirtyPaths,
        pageRedoStack: state.pageRedoStack.slice(0, -1),
        pageUndoStack: [
          ...state.pageUndoStack,
          { documents: state.workspace.documents, dirtyPaths: state.pageDirtyPaths },
        ],
      };
    }
    case 'CLEAR_PAGE_EDITS':
      // The commit bridge just materialized the edits to disk; the workspace
      // itself is left alone — the indexer re-derives it from the new buffers.
      return { ...state, pageUndoStack: [], pageRedoStack: [], pageDirtyPaths: [] };
    case 'UI_FOCUS_TAB':
      return focusTab(state, action.tab);
    case 'UI_SET_RECENT_FILES':
      return { ...state, ui: { ...state.ui, recentFiles: action.files } };
    case 'UI_SET_ACTIVE_OP': {
      // Arming an operation OPENS its owning tool: the Tools tab renders that
      // tool's header + op switcher around `panels[activeOp]`, so the two
      // disagreeing means the header names one tool while the body shows
      // another's panel (or the tile grid renders while an op is invisibly
      // active). Derived here rather than asked of every dispatcher.
      const owner = toolForOp(action.op);
      const ui = openTool(state.ui, owner?.id ?? null);
      if (action.op === state.ui.activeOp && ui === state.ui) return state;
      return { ...state, ui: { ...ui, activeOp: action.op } };
    }
    case 'UI_OPEN_TOOL': {
      const ui = openTool(state.ui, action.toolId);
      return ui === state.ui ? state : { ...state, ui };
    }
    case 'UI_SET_TOOL':
      if (action.tool === state.ui.tool) return state;
      return { ...state, ui: { ...state.ui, tool: action.tool } };
    case 'UI_SET_DOC_VIEW_MODE':
      if (action.mode === state.ui.docViewMode) return state;
      return { ...state, ui: { ...state.ui, docViewMode: action.mode } };
    case 'UI_SET_CURRENT_PAGE':
      if (action.pageId === state.ui.currentPageId) return state;
      return { ...state, ui: { ...state.ui, currentPageId: action.pageId } };
    case 'UI_FOCUS_DOC': {
      if (action.docId === state.ui.focusedDocId) return state;
      // Focusing a document also activates the FILE that owns it — the reading
      // view resolves through `activeFileId`, and the tab strip must follow, so
      // the two can't disagree about which file is in front.
      const owner = action.docId
        ? state.workspace.documents.find((d) => d.id === action.docId)
        : null;
      if (action.docId && !owner) return state; // unknown doc: reject, don't strand
      const ui = { ...state.ui, focusedDocId: action.docId };
      if (!owner || owner.path === state.activeFileId) return { ...state, ui };
      const f = state.files.get(owner.path);
      if (!f || f.importOnly) return state; // same guard focusTab applies
      return { ...state, activeFileId: owner.path, ui: { ...ui, focusedTab: { doc: owner.path } } };
    }
    case 'UI_SELECT_PAGE': {
      const { selectedPageIds, selectionAnchor } = state.ui;
      if (action.mode === 'toggle') {
        // Ctrl-click: toggle this page in/out of the selection.
        const next = new Set(selectedPageIds);
        if (next.has(action.pageId)) next.delete(action.pageId);
        else next.add(action.pageId);
        return {
          ...state,
          ui: { ...state.ui, selectedPageIds: next, selectionAnchor: action.pageId },
        };
      }
      if (action.mode === 'range' && selectionAnchor) {
        // Shift-click: range across workspace-flattened order from the anchor.
        // Keep the anchor so a further shift-click re-extends. An unresolvable
        // anchor/page falls through to single-select (the canvas's behavior).
        const order = flatPageOrder(state);
        const a = order.indexOf(selectionAnchor);
        const b = order.indexOf(action.pageId);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          return {
            ...state,
            ui: { ...state.ui, selectedPageIds: new Set(order.slice(lo, hi + 1)) },
          };
        }
      }
      if (action.mode === 'context' && selectedPageIds.has(action.pageId)) {
        // Right-click on a page already in the selection keeps the whole
        // selection (menu actions then apply to all); anchor moves to it.
        if (selectionAnchor === action.pageId) return state;
        return { ...state, ui: { ...state.ui, selectionAnchor: action.pageId } };
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          selectedPageIds: new Set([action.pageId]),
          selectionAnchor: action.pageId,
        },
      };
    }
    case 'UI_SELECT_ALL_PAGES': {
      const order = flatPageOrder(state);
      if (order.length === 0) return state;
      return {
        ...state,
        ui: { ...state.ui, selectedPageIds: new Set(order), selectionAnchor: order[0] },
      };
    }
    case 'UI_CLEAR_SELECTION':
      return clearSelection(state);
    case 'UI_SET_SELECTION':
      return {
        ...state,
        ui: {
          ...state.ui,
          selectedPageIds: new Set(action.pageIds),
          selectionAnchor: action.anchor,
        },
      };
    case 'UI_OPEN_NAV_PANEL': {
      // Icon-strip toggle: re-opening the active panel closes the pane;
      // otherwise open on the requested panel.
      const { navPane } = state.ui;
      const next =
        navPane.open && navPane.panel === action.panel
          ? { ...navPane, open: false }
          : { ...navPane, open: true, panel: action.panel };
      return { ...state, ui: { ...state.ui, navPane: next } };
    }
    case 'UI_TOGGLE_NAV_PANE':
      return {
        ...state,
        ui: { ...state.ui, navPane: { ...state.ui.navPane, open: !state.ui.navPane.open } },
      };
    case 'UI_SET_NAV_PANE_WIDTH': {
      // Clamp both ends — an overshooting drag (or a pointer leaving the window
      // mid-drag) must not set a width that buries the board off-screen and
      // then persists (review-caught).
      const width = Math.min(NAV_PANE_MAX_WIDTH, Math.max(NAV_PANE_MIN_WIDTH, Math.round(action.width)));
      if (width === state.ui.navPane.width) return state;
      return { ...state, ui: { ...state.ui, navPane: { ...state.ui.navPane, width } } };
    }
    default:
      return state;
  }
}
