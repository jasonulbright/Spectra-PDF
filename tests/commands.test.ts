// The command system (Phase 4 M1): registry totality, enablement
// predicates, invokeCommand gating, and the escape-interceptor stack.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMANDS,
  COMMAND_IDS,
  canRedo,
  canUndo,
  hasSelection,
  hasActiveFile,
  isActiveFileDirty,
  type CommandId,
} from '../src/renderer/commands/registry';
import {
  appModalCount,
  escapeInterceptorCount,
  getCommandContext,
  invokeCommand,
  pushAppModal,
  pushEscapeInterceptor,
  registerAppCommandHandlers,
  registerCanvasServices,
  runEscapeInterceptors,
  setCommandStateSource,
} from '../src/renderer/commands/context';
import { showableDoc, showableFile, tabFiles } from '../src/renderer/state/selectors';
import { KEY_BINDINGS } from '../src/renderer/commands/acrobat-keys';
import { resetPendingFind } from '../src/renderer/commands/find-intent';
import type { AppCommandHandlers } from '../src/renderer/commands/types';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { dispatchKeyEvent, dispatchKeyUpEvent, dispatchWindowBlur } from '../src/renderer/commands/keymap';
import type { AppAction, AppState, CanvasTool, OpenFile, PdfBuffer } from '../src/renderer/state/types';

function makeFile(path: string, extra: Partial<OpenFile> = {}): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: 1,
    buffer: [1],
    dirty: false,
    undoStack: [],
    redoStack: [],
    ...extra,
  };
}

function stateWith(partial: Partial<AppState>): AppState {
  return { ...initialState, ...partial, ui: { ...initialState.ui, ...(partial.ui ?? {}) } };
}

const noopHandlers = (): AppCommandHandlers => ({
  openFiles: vi.fn(async () => true),
  openFilesInPlace: vi.fn(async () => {}),
  openPath: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
  saveAs: vi.fn(async () => {}),
  closeFile: vi.fn(async () => {}),
  closeAll: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  redo: vi.fn(async () => {}),
  applyPageEdits: vi.fn(async () => {}),
  openPreferences: vi.fn(),
  openProperties: vi.fn(),
  openPrint: vi.fn(),
  openBatchOcr: vi.fn(),
  openCreatePdf: vi.fn(),
  insertBlankPage: vi.fn(async () => {}),
  insertPagesFromFile: vi.fn(async () => {}),
  combineFiles: vi.fn(async () => {}),
  openLicenses: vi.fn(),
  openAbout: vi.fn(),
  checkForUpdates: vi.fn(),
  exit: vi.fn(async () => {}),
  minimizeToTray: vi.fn(async () => {}),
});

afterEach(() => {
  // Module-level Space-hold state: a case that arms without releasing must
  // not leak into the next (blur is the designated force-release).
  dispatchWindowBlur();
  setCommandStateSource(null);
  registerAppCommandHandlers(null);
  registerCanvasServices(null);
  // Module-level slot: a case that parks a Find must not leak into the next.
  resetPendingFind();
});

describe('registry totality', () => {
  it('every declared id has a command with a namespace prefix and a title', () => {
    const namespaces = ['file.', 'edit.', 'view.', 'document.', 'tools.', 'window.', 'help.'];
    for (const id of COMMAND_IDS) {
      const cmd = COMMANDS[id];
      expect(cmd, id).toBeDefined();
      expect(cmd.title.length, id).toBeGreaterThan(0);
      expect(namespaces.some((ns) => id.startsWith(ns)), id).toBe(true);
    }
  });

  it('the record carries no ids outside the declared union', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...COMMAND_IDS].sort());
  });
});

describe('enablement helpers', () => {
  it('canUndo/canRedo: page tier first, then the active file snapshots', () => {
    expect(canUndo(initialState)).toBe(false);
    const pageTier = stateWith({
      pageUndoStack: [{ documents: [], dirtyPaths: [] }],
    });
    expect(canUndo(pageTier)).toBe(true);
    const snapshots = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf', { undoStack: ['s1'], redoStack: ['s2'] })]]),
    });
    expect(canUndo(snapshots)).toBe(true);
    expect(canRedo(snapshots)).toBe(true);
    expect(canRedo(initialState)).toBe(false);
  });

  it('isActiveFileDirty covers whole-file dirt and pending page edits', () => {
    const clean = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf')]]),
    });
    expect(isActiveFileDirty(clean)).toBe(false);
    const dirty = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf', { dirty: true })]]),
    });
    expect(isActiveFileDirty(dirty)).toBe(true);
    const pageDirty = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf')]]),
      pageDirtyPaths: ['a.pdf'],
    });
    expect(isActiveFileDirty(pageDirty)).toBe(true);
  });

  it('hasSelection reads the ui slice', () => {
    expect(hasSelection(initialState)).toBe(false);
    expect(hasSelection(stateWith({ ui: { ...initialState.ui, selectedPageIds: new Set(['x']) } }))).toBe(true);
  });

  it('hasActiveFile ignores a GHOST import-only active file', () => {
    // CLOSE_FILE's active-id fallback can land on a byte-only import source:
    // it lives in `files` but has no tab and is never shown. It backs File ▸
    // Save As / Close, so counting it left those enabled against a file the
    // user isn't looking at — Save As would open a native dialog named after
    // it, Close would silently discard it.
    const ghost = stateWith({
      activeFileId: 'src.pdf',
      files: new Map([['src.pdf', makeFile('src.pdf', { importOnly: true })]]),
    });
    expect(hasActiveFile(ghost)).toBe(false);
    const real = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf')]]),
    });
    expect(hasActiveFile(real)).toBe(true);
  });
});

describe('showableDoc / showableFile / tabFiles (state/selectors)', () => {
  // The ONE answer to "which document can the user act on?", shared by the
  // menus (hasActiveFile / isActiveFileDirty), the Tools tab's file picker,
  // useActiveFile's getter, and tools.open.*. Testing it here is what makes
  // those four guards tested — they have no implementation of their own to get
  // wrong, which is the point of the consolidation.
  const ghost = stateWith({
    activeFileId: 'src.pdf',
    files: new Map([
      ['src.pdf', makeFile('src.pdf', { importOnly: true })],
      ['a.pdf', makeFile('a.pdf')],
    ]),
  });

  it('refuses a ghost, resolves a real file, and answers null for neither', () => {
    expect(showableDoc(ghost)).toBeNull();
    expect(showableFile(ghost)).toBeNull();
    const real = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf')]]),
    });
    expect(showableDoc(real)).toBe('a.pdf');
    expect(showableFile(real)?.path).toBe('a.pdf');
    expect(showableDoc(initialState)).toBeNull();
    // An id naming a file that isn't open resolves to nothing, not a throw.
    expect(showableDoc(stateWith({ activeFileId: 'gone.pdf' }))).toBeNull();
  });

  it('tabFiles omits ghosts — they are never offered to the user', () => {
    // Feeds Compare's "compare against" list. A ghost has no window, so naming
    // it there offers a document the user never opened and cannot look at.
    expect(tabFiles(ghost).map((f) => f.path)).toEqual(['a.pdf']);
  });
});

describe('the ghost import-source hazard (2n.3)', () => {
  // A byte-only import source is an entry in `files` with no tab, no strip, and
  // no way to become a real document on its own — nothing ever flips the flag.
  // Every consumer that means "a document the user can see" must exclude it;
  // several meant `activeFileId !== null`, which is a different question.
  it('CLOSE_FILE lands on neither a ghost tab nor a ghost active file', () => {
    // Both fallbacks, checked together. The tab fallback was ghost-aware from
    // the start; the ACTIVE-ID fallback wasn't, and M5.2's review showed why
    // that mattered — see the two cases below. Now that the active id can't be
    // a ghost either, the tab guard is belt-and-braces rather than the thing
    // holding the invariant up, and both must stay true.
    let s = appReducer(initialState, {
      type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf',
      pageCount: 1, buffer: [1],
    });
    s = appReducer(s, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'src.pdf', workingPath: 'src.w',
      name: 'src.pdf', pageCount: 1, buffer: [2],
    });
    // Be ON a.pdf's tab when it closes — otherwise CLOSE_FILE's focusedClosed
    // branch never runs and the tab-fallback assertion below passes vacuously
    // (it did: the whole suite stayed green with that guard deleted).
    s = appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    expect(s.ui.focusedTab).toEqual({ doc: 'a.pdf' });
    s = appReducer(s, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(s.files.get('src.pdf')?.importOnly).toBe(true); // the ghost survives
    expect(s.activeFileId).toBeNull();
    expect(s.ui.focusedTab).toBe('home');
    expect(hasActiveFile(s)).toBe(false);
  });

  it('CLOSE_FILE never falls back onto a ghost when a REAL file remains', () => {
    // The Map's first remaining key can be a ghost while real files sit behind
    // it (open A, import from C, open B — insertion order is A, C, B). Closing
    // A used to make C — invisible, tab-less — the active file, which handed
    // every Tools panel an unseeable target while the tab quietly went Home.
    // The Tools tab's document picker lists only real files, so it couldn't
    // match C: React resolves a controlled <select> with no matching option by
    // selecting the FIRST one, so it would have confidently displayed B while
    // the panels operated on C. The old rail degraded honestly (nothing looked
    // selected); a <select> degrades to a lie, which is worse.
    let s = appReducer(initialState, {
      type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf',
      pageCount: 1, buffer: [1],
    });
    s = appReducer(s, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'ghost.pdf', workingPath: 'g.w',
      name: 'ghost.pdf', pageCount: 1, buffer: [2],
    });
    s = appReducer(s, {
      type: 'OPEN_FILE', path: 'b.pdf', workingPath: 'b.w', name: 'b.pdf',
      pageCount: 1, buffer: [3],
    });
    // The ghost really is ahead of b.pdf in the Map — otherwise this passes for
    // the wrong reason.
    expect([...s.files.keys()]).toEqual(['a.pdf', 'ghost.pdf', 'b.pdf']);
    // Go BACK to a.pdf before closing it. Without this the fallback never runs
    // at all (`OPEN_FILE b.pdf` already made b active, so closing a doesn't
    // touch activeFileId) and the case passes against the unfixed code —
    // it did, until the mutation check caught it.
    s = appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    expect(s.activeFileId).toBe('a.pdf');

    s = appReducer(s, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(s.activeFileId).toBe('b.pdf'); // the real file, not the ghost ahead of it
    expect(hasActiveFile(s)).toBe(true);
    expect(s.ui.focusedTab).toEqual({ doc: 'b.pdf' });
  });

  it('CLOSE_FILE’s TAB fallback refuses a ghost that was already active', () => {
    // The tab guard survives its own belt-and-braces status: the active-id
    // fallback only runs when the CLOSED file was the active one, so a ghost
    // that is already active when an unrelated file closes flows straight
    // through — and the tab must still not try to focus it. The reviewer showed
    // no test reached this clause (it could be deleted with the suite green);
    // this is that test.
    let s = appReducer(initialState, {
      type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf',
      pageCount: 1, buffer: [1],
    });
    s = appReducer(s, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'ghost.pdf', workingPath: 'g.w',
      name: 'ghost.pdf', pageCount: 1, buffer: [2],
    });
    s = appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } });
    // Force the state SET_ACTIVE_FILE now refuses, to prove the downstream
    // guard independently rather than leaning on the upstream one.
    s = { ...s, activeFileId: 'ghost.pdf' };
    s = appReducer(s, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(s.ui.focusedTab).toBe('home'); // not { doc: 'ghost.pdf' }
  });

  it('CLOSE_FILE leaves NO active file when only ghosts remain', () => {
    // Nothing the user can see is open, so there is nothing to be active. null
    // is the honest answer — better than naming bytes with no window.
    let s = appReducer(initialState, {
      type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf',
      pageCount: 1, buffer: [1],
    });
    s = appReducer(s, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'ghost.pdf', workingPath: 'g.w',
      name: 'ghost.pdf', pageCount: 1, buffer: [2],
    });
    s = appReducer(s, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(s.activeFileId).toBeNull();
    expect(s.ui.focusedTab).toBe('home');
  });

  it('SET_ACTIVE_FILE REFUSES a ghost — Save would overwrite the real file', () => {
    // The worst reachable path this milestone found. A ghost's `path` is the
    // ORIGINAL file the user imported from, and File ▸ Save writes the working
    // copy back over `activeFile.path` with no dialog. So a ghost active file
    // is not a cosmetic mix-up: it is a silent overwrite of a real file on
    // disk, with no tab and no dirty marker anywhere to connect it to.
    let s = appReducer(initialState, {
      type: 'OPEN_FILE', path: 'main.pdf', workingPath: 'm.w', name: 'main.pdf',
      pageCount: 1, buffer: [1],
    });
    s = appReducer(s, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'appendix.pdf', workingPath: 'a.w',
      name: 'appendix.pdf', pageCount: 1, buffer: [2],
    });
    const before = s.activeFileId;
    s = appReducer(s, { type: 'SET_ACTIVE_FILE', path: 'appendix.pdf' });
    expect(s.activeFileId).toBe(before); // refused, not coerced elsewhere
  });

  it('Save stays disabled for a dirty ghost, like Save As and Close already were', () => {
    // Belt-and-braces for the same hazard, one layer down: even if some future
    // writer got a ghost into activeFileId, the gate on the DESTRUCTIVE command
    // must not open. `hasActiveFile` refused all along; `isActiveFileDirty` —
    // which gates Save — didn't, which is the wrong way round.
    const ghost = stateWith({
      activeFileId: 'appendix.pdf',
      files: new Map([['appendix.pdf', makeFile('appendix.pdf', { importOnly: true, dirty: true })]]),
    });
    expect(isActiveFileDirty(ghost)).toBe(false);
    expect(hasActiveFile(ghost)).toBe(false);
    // ...and a real dirty file still enables it.
    const real = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf', { dirty: true })]]),
    });
    expect(isActiveFileDirty(real)).toBe(true);
  });

  it('OPEN_FILE upgrades a ghost into a real document', () => {
    // What App.openByPaths relies on: its "already open → just re-activate"
    // shortcut must NOT fire for a ghost (focusTab rejects a doc tab for one,
    // so File ▸ Open on a file you had imported pages from was a permanent
    // no-op). Falling through to OPEN_FILE has to actually fix it.
    let s = appReducer(initialState, {
      type: 'REGISTER_IMPORT_SOURCE', path: 'src.pdf', workingPath: 'src.w',
      name: 'src.pdf', pageCount: 1, buffer: [2],
    });
    expect(s.files.get('src.pdf')?.importOnly).toBe(true);
    s = appReducer(s, {
      type: 'OPEN_FILE', path: 'src.pdf', workingPath: 'src.w2', name: 'src.pdf',
      pageCount: 1, buffer: [3],
    });
    expect(s.files.get('src.pdf')?.importOnly).toBeFalsy();
    // …and now a doc tab for it is accepted, where before it was rejected.
    s = appReducer(s, { type: 'UI_FOCUS_TAB', tab: { doc: 'src.pdf' } });
    expect(s.ui.focusedTab).toEqual({ doc: 'src.pdf' });
  });
});

describe('invokeCommand', () => {
  function wire(state: AppState): {
    dispatched: AppAction[];
    handlers: AppCommandHandlers;
    /** State after every dispatch — for invariants the reducer derives. */
    finalState: () => AppState;
    dispatchRaw: (a: AppAction) => void;
  } {
    const dispatched: AppAction[] = [];
    // Reducer-backed dispatch so multi-dispatch commands see evolving state.
    let current = state;
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => {
        dispatched.push(a);
        current = appReducer(current, a);
      },
    }));
    const handlers = noopHandlers();
    registerAppCommandHandlers(handlers);
    return {
      dispatched,
      handlers,
      finalState: () => current,
      // Dispatch straight at the wired reducer — for UI that dispatches without
      // going through a command (the ‹ Tools back button).
      dispatchRaw: (a) => {
        dispatched.push(a);
        current = appReducer(current, a);
      },
    };
  }

  it('returns false with no registered context', () => {
    expect(invokeCommand('file.open')).toBe(false);
  });

  it('runs an enabled command through the registered app handlers', () => {
    const { handlers } = wire(initialState);
    expect(invokeCommand('file.open')).toBe(true);
    expect(handlers.openFiles).toHaveBeenCalledOnce();
  });

  it('file.openInPlace is a DIFFERENT handler to file.open, not a copy of it', () => {
    // The panels' "Open a PDF" button routes here rather than re-implementing
    // "open some files" — the hand-rolled copy it replaces diverged four times,
    // the last leaving password-protected PDFs unopenable from any panel.
    // Both must reach App's one openByPaths; they differ only in the tab jump.
    const { handlers } = wire(initialState);
    expect(invokeCommand('file.openInPlace')).toBe(true);
    expect(handlers.openFilesInPlace).toHaveBeenCalledOnce();
    expect(handlers.openFiles).not.toHaveBeenCalled();
  });

  it('refuses a command whose predicate fails (save with nothing dirty)', () => {
    const { handlers } = wire(initialState);
    expect(invokeCommand('file.save')).toBe(false);
    expect(handlers.save).not.toHaveBeenCalled();
  });

  it('tools.* toggle like the pills: re-invoking the active tool exits to Select', () => {
    const { dispatched } = wire(stateWith({ ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } } }));
    expect(invokeCommand('tools.highlight')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_SET_TOOL', tool: 'highlight' });
    expect(invokeCommand('tools.highlight')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_SET_TOOL', tool: 'select' });
  });

  it('tools.* are scoped to a focused document tab', () => {
    wire(initialState); // Home focused
    expect(invokeCommand('tools.highlight')).toBe(false);
  });

  it('tools.panel.* focuses the Tools tab with the op armed, inside its owning tool', () => {
    const { dispatched , finalState } = wire(initialState);
    expect(invokeCommand('tools.panel.compress')).toBe(true);
    expect(dispatched).toEqual([
      { type: 'UI_FOCUS_TAB', tab: 'tools' },
      { type: 'UI_SET_ACTIVE_OP', op: 'compress' },
    ]);
    // Compress lives under Optimize (M5 § 7), and arming the op must OPEN that
    // tool — otherwise the Tools tab renders the tile grid with the op
    // invisibly "active" and the menu item looks like it did nothing.
    expect(finalState().ui.activeToolId).toBe('optimize');
  });

  it('tools.open.* opens a form-backed tool on the Tools tab at its first op', () => {
    const { dispatched, finalState } = wire(initialState);
    expect(invokeCommand('tools.open.protect')).toBe(true);
    expect(dispatched).toContainEqual({ type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(dispatched).toContainEqual({ type: 'UI_SET_ACTIVE_OP', op: 'encrypt' });
    expect(finalState().ui.activeToolId).toBe('protect');
  });

  it('opening a tool with no canvas mode DISARMS the last tool’s mode', () => {
    // Nothing else clears `ui.tool`: focusTab only resets it when LEAVING a doc
    // tab, so Tools→Tools never qualifies. Without a disarm, Prepare Form →
    // Protect leaves the form mode live on the canvas under a tool that never
    // asked for it (PageCell branches on ui.tool, so it changes clicks).
    const { finalState } = wire(stateWith({
        files: new Map([['a.pdf', makeFile('a.pdf')]]),
        activeFileId: 'a.pdf',
        ui: { ...initialState.ui, focusedTab: { doc: 'a.pdf' } },
      }));
    invokeCommand('tools.open.prepareform');
    expect(finalState().ui.tool).toBe('formfields');
    invokeCommand('tools.open.protect'); // no mode of its own
    expect(finalState().ui.tool).toBe('select');
  });

  it('tools.open.* for a canvas-mode tool opens the DOCUMENT and arms the mode', () => {
    // Comment has no ops — its work is a mode on the page, so parking the user
    // on the Tools tab would show them an empty pane. It must route to the doc.
    // Asserted on the resulting STATE, not the dispatch sequence: the order is
    // an implementation detail, "you end up on the page with Highlight live"
    // is the behavior.
    const { finalState } = wire(
      stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }),
    );
    expect(invokeCommand('tools.open.comment')).toBe(true);
    expect(finalState().ui.focusedTab).toEqual({ doc: 'a.pdf' });
    expect(finalState().ui.tool).toBe('highlight');
  });

  it('a canvas-mode tool opens the ACTIVE file, not the focused tab’s file', () => {
    // The tab and the active file can disagree; the tool acts on the active
    // file, so it must bring THAT document forward and arm the mode there.
    const { finalState } = wire(
      stateWith({
        files: new Map([
          ['a.pdf', makeFile('a.pdf')],
          ['b.pdf', makeFile('b.pdf')],
        ]),
        activeFileId: 'b.pdf',
        ui: { ...initialState.ui, focusedTab: { doc: 'a.pdf' } },
      }),
    );
    expect(invokeCommand('tools.open.redact')).toBe(true);
    expect(finalState().ui.focusedTab).toEqual({ doc: 'b.pdf' });
    expect(finalState().ui.tool).toBe('redact');
  });

  it('tools.open.* for a canvas-mode tool is disabled with no document open', () => {
    wire(initialState);
    // There is nothing to comment on / redact / OCR without a document, and the
    // tool has no pane of its own to fall back to.
    expect(invokeCommand('tools.open.comment')).toBe(false);
    expect(invokeCommand('tools.open.redact')).toBe(false);
    expect(invokeCommand('tools.open.ocr')).toBe(false);
    // A tool with its own pane stays reachable — the panels prompt for a file.
    expect(invokeCommand('tools.open.protect')).toBe(true);
  });

  it('a tool that WORKS ON THE PAGE is disabled with no document — including the ones that also have a pane', () => {
    wire(initialState);
    // Fill & Sign and Prepare Form have ops AND modes. The old ops-first test
    // made them reachable with nothing open; they'd land on the Tools tab and
    // show their panel's "Open a PDF" prompt. They own canvas modes, so their
    // work is on the page, so they need one — and the tile/menu grey out rather
    // than pretending. This assertion is the fact; the test edits elsewhere in
    // this file merely stopped tripping over it.
    for (const id of ['comment', 'redact', 'ocr', 'fillsign', 'prepareform']) {
      expect(invokeCommand(`tools.open.${id}` as CommandId), `${id} ran with no document`).toBe(false);
    }
    // A tool whose work is a FORM stays reachable — its panel prompts for a file.
    for (const id of ['protect', 'optimize', 'organize', 'watermark', 'export', 'repair', 'compare']) {
      expect(invokeCommand(`tools.open.${id}` as CommandId), `${id} was blocked`).toBe(true);
    }
  });

  it('tools.open.* for a canvas-mode tool refuses a GHOST import-only active file', () => {
    // Closing the last real file can leave a byte-only import source as the
    // active id. focusTab rejects a doc tab for it, so arming the mode anyway
    // would strand Highlight on a document the user cannot see — and it would
    // then be live on the next real doc they open.
    const { dispatched } = wire(
      stateWith({
        files: new Map([['src.pdf', makeFile('src.pdf', { importOnly: true })]]),
        activeFileId: 'src.pdf',
      }),
    );
    expect(invokeCommand('tools.open.comment')).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('tools.open.ocr opens Find once the canvas mounts — not at invoke time', () => {
    // The REAL precondition: the tile lives on the Tools tab, where the canvas
    // is unmounted, so no find service exists when the command runs. It must
    // park the intent and let the mount drain it, or the tool is a dead click.
    const open = vi.fn();
    wire(stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }));
    expect(invokeCommand('tools.open.ocr')).toBe(true);
    expect(open).not.toHaveBeenCalled(); // nothing to call it on yet

    registerCanvasServices({
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a parked Find is consumed once, not re-opened on every later mount', () => {
    const open = vi.fn();
    wire(stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }));
    invokeCommand('tools.open.ocr');
    const services = {
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    };
    registerCanvasServices(services);
    registerCanvasServices(null); // leave the doc tab
    registerCanvasServices(services); // come back to it
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a parked Find is DISCARDED if a different document comes up instead', () => {
    // The park names the doc it was taken for. Without that, asking for OCR on
    // a.pdf, changing your mind, and opening b.pdf later would spring the find
    // bar open on b.pdf for no reason the user can see.
    const open = vi.fn();
    const { finalState } = wire(
      stateWith({
        files: new Map([
          ['a.pdf', makeFile('a.pdf')],
          ['b.pdf', makeFile('b.pdf')],
        ]),
        activeFileId: 'a.pdf',
      }),
    );
    expect(invokeCommand('tools.open.ocr')).toBe(true); // parks for a.pdf
    expect(finalState().ui.focusedTab).toEqual({ doc: 'a.pdf' });

    // The user goes to b.pdf instead; ITS canvas is what mounts.
    invokeCommand('window.nextTab');
    expect(finalState().ui.focusedTab).toEqual({ doc: 'b.pdf' });
    registerCanvasServices({
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('tools.open.ocr opens Find immediately when the canvas IS mounted', () => {
    const open = vi.fn();
    wire(stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }));
    registerCanvasServices({
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    expect(invokeCommand('tools.open.ocr')).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('arming an op from OUTSIDE the registry still opens its tool', () => {
    // The e2e harness (and any future caller) dispatches UI_SET_ACTIVE_OP raw.
    // The re-homing lives in the reducer precisely so it cannot be forgotten:
    // without it the Tools tab shows the tile grid while `watermark` is armed.
    const next = appReducer(
      stateWith({ ui: { ...initialState.ui, focusedTab: 'tools' } }),
      { type: 'UI_SET_ACTIVE_OP', op: 'watermark' },
    );
    expect(next.ui.activeOp).toBe('watermark');
    expect(next.ui.activeToolId).toBe('watermark');
    // …and switching to an op owned by a DIFFERENT tool re-homes, so the pane
    // header can never name one tool while showing another's panel.
    const moved = appReducer(next, { type: 'UI_SET_ACTIVE_OP', op: 'encrypt' });
    expect(moved.ui.activeToolId).toBe('protect');
  });

  it('tools.open.* arms the canvas mode for a tool that has BOTH a pane and a mode', () => {
    // Prepare Form hosts the `forms` panel AND wants widget mode live (§ 7:
    // activating a tool arms its interaction mode — for every tool that names
    // one, not only the ops-less ones).
    const { finalState } = wire(stateWith({
        files: new Map([['a.pdf', makeFile('a.pdf')]]),
        activeFileId: 'a.pdf',
        ui: { ...initialState.ui, focusedTab: { doc: 'a.pdf' } },
      }));
    expect(invokeCommand('tools.open.prepareform')).toBe(true);
    expect(finalState().ui.tool).toBe('formfields');
    // ...and it stays ON the document: its work is there, and the pill that
    // used to let you re-arm from the canvas is gone.
    expect(finalState().ui.focusedTab).toEqual({ doc: 'a.pdf' });
  });

  it('the ‹ Tools back button disarms the closed tool’s mode', () => {
    // The fourth door onto the same bug. Prepare Form arms `forms`; closing to
    // the tile grid left it armed, and it went live the moment the user clicked
    // back onto a document — every widget interactive, plain drags swallowed,
    // with nothing on screen saying why.
    const { finalState, dispatchRaw } = wire(
      stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }),
    );
    invokeCommand('tools.open.prepareform');
    expect(finalState().ui.tool).toBe('formfields');
    dispatchRaw({ type: 'UI_OPEN_TOOL', toolId: null }); // the ‹ Tools button
    expect(finalState().ui.activeToolId).toBeNull();
    expect(finalState().ui.tool).toBe('select');
  });

  it('Scan & OCR does NOT disarm the canvas tool — it only opens Find', () => {
    // It has no mode because it isn't one. A Tools-tab tool replaces what you
    // were doing; this lands you on the page, so taking away the user's
    // Highlight to show a search box would be gratuitous.
    const { finalState } = wire(
      stateWith({
        files: new Map([['a.pdf', makeFile('a.pdf')]]),
        activeFileId: 'a.pdf',
        ui: { ...initialState.ui, focusedTab: { doc: 'a.pdf' }, tool: 'highlight' },
      }),
    );
    expect(invokeCommand('tools.open.ocr')).toBe(true);
    expect(finalState().ui.tool).toBe('highlight');
  });

  it('picking an op from the RAIL or the Tools menu re-arms that op’s tool mode', () => {
    // The gap that made the reducer own this: `tools.panel.*` (the rail and the
    // Tools menu, both shipped and reachable) never touched `ui.tool`, and a
    // Tools→Tools focus doesn't trip focusTab's reset. So Prepare Form → rail ▸
    // Encrypt left `forms` armed under a pane headed "Encrypt PDF", live on the
    // canvas the moment the user went back to a document.
    const { finalState } = wire(stateWith({
        files: new Map([['a.pdf', makeFile('a.pdf')]]),
        activeFileId: 'a.pdf',
        ui: { ...initialState.ui, focusedTab: { doc: 'a.pdf' } },
      }));
    invokeCommand('tools.open.prepareform');
    expect(finalState().ui.tool).toBe('formfields');
    invokeCommand('tools.panel.encrypt'); // the Tools menu / op-switcher path
    expect(finalState().ui.activeToolId).toBe('protect');
    expect(finalState().ui.tool).toBe('select');
  });

  it('document.deleteSelection deletes the batch then clears — even when the reducer rejects', () => {
    const { dispatched } = wire(
      stateWith({ ui: { ...initialState.ui, selectedPageIds: new Set(['stale#p0']), focusedTab: { doc: 'x.pdf' } } }),
    );
    expect(invokeCommand('document.deleteSelection')).toBe(true);
    expect(dispatched.map((a) => a.type)).toEqual(['DELETE_PAGE_REFS', 'UI_CLEAR_SELECTION']);
  });

  it('view.home / view.tools focus their tabs', () => {
    const { dispatched } = wire(stateWith({ ui: { ...initialState.ui, focusedTab: 'tools' } }));
    expect(invokeCommand('view.home')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'home' });
    expect(invokeCommand('view.tools')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'tools' });
  });

  it('window.nextTab / prevTab cycle Home → Tools → docs', () => {
    // Home + Tools always present; with no docs, next from Home → Tools.
    const { dispatched } = wire(initialState);
    expect(invokeCommand('window.nextTab')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(invokeCommand('window.prevTab')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'home' }); // wraps
  });

  it('file.clearRecent is disabled when the recent list is empty', () => {
    wire(initialState); // recentFiles: []
    expect(invokeCommand('file.clearRecent')).toBe(false);
  });

  it('file.clearRecent clears a non-empty recent list', () => {
    const { dispatched } = wire(stateWith({ ui: { ...initialState.ui, recentFiles: [{ path: 'a.pdf', openedAt: null }] } }));
    expect(invokeCommand('file.clearRecent')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_SET_RECENT_FILES', files: [] });
  });

  it('zoom commands require a mounted canvas handle', () => {
    wire(stateWith({ ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } } }));
    expect(invokeCommand('view.zoomIn')).toBe(false);
    const zoomIn = vi.fn();
    registerCanvasServices({
      canvas: () => ({
        zoomIn,
        zoomOut: vi.fn(),
        reset: vi.fn(),
        clientToWorld: () => null,
        centerOn: vi.fn(),
      }),
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      goToPage: () => false,
      find: { isOpen: () => false, open: vi.fn(), openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    expect(invokeCommand('view.zoomIn')).toBe(true);
    expect(zoomIn).toHaveBeenCalledOnce();
  });

  it('edit.find opens the registered find bar', () => {
    wire(initialState);
    const open = vi.fn();
    registerCanvasServices({
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    expect(invokeCommand('edit.find')).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
});

describe('escape interceptors', () => {
  it('runs LIFO and stops at the first consumer', () => {
    const calls: string[] = [];
    const un1 = pushEscapeInterceptor(() => {
      calls.push('first');
      return true;
    });
    const un2 = pushEscapeInterceptor(() => {
      calls.push('second');
      return true;
    });
    expect(runEscapeInterceptors()).toBe(true);
    expect(calls).toEqual(['second']);
    un2();
    expect(runEscapeInterceptors()).toBe(true);
    expect(calls).toEqual(['second', 'first']);
    un1();
    expect(runEscapeInterceptors()).toBe(false);
    expect(escapeInterceptorCount()).toBe(0);
  });

  it('a non-consuming interceptor falls through', () => {
    const un = pushEscapeInterceptor(() => false);
    expect(runEscapeInterceptors()).toBe(false);
    un();
  });
});

describe('getCommandContext', () => {
  it('exposes registered services and null before registration', () => {
    expect(getCommandContext()).toBeNull();
    setCommandStateSource(() => ({ state: initialState, dispatch: () => {} }));
    const ctx = getCommandContext();
    expect(ctx?.state).toBe(initialState);
    expect(ctx?.app).toBeNull();
    expect(ctx?.canvas).toBeNull();
  });
});

// Exhaustive smoke: every command either refuses cleanly or runs without
// throwing against a registered context (no handler may assume unchecked
// state). Guards the total record against a run() that dereferences state
// its when() didn't check.
describe('registry smoke', () => {
  it('every command invokes or refuses without throwing, on every tab', () => {
    const tabs = ['home', 'tools', { doc: 'x.pdf' }] as const;
    for (const tab of tabs) {
      let current = stateWith({ ui: { ...initialState.ui, focusedTab: tab } });
      setCommandStateSource(() => ({
        state: current,
        dispatch: (a: AppAction) => {
          current = appReducer(current, a);
        },
      }));
      registerAppCommandHandlers(noopHandlers());
      for (const id of COMMAND_IDS as readonly CommandId[]) {
        expect(() => invokeCommand(id), `${id} on ${JSON.stringify(tab)}`).not.toThrow();
      }
      setCommandStateSource(null);
      registerAppCommandHandlers(null);
    }
  });
});

// M4.2 — Ctrl+A selects PAGES in BOTH views, and must NOT fall through to the
// browser's select-all in the reading view. § 9.2 originally specified TEXT
// there (Acrobat's behaviour); it was tried and reverted, because the reading
// view is VIRTUALIZED — only mounted pages have text spans — so native
// select-all can reach only the on-screen pages and Ctrl+C would silently copy
// a fraction of the document. These pin the reverted decision so it isn't
// "restored" from the plan without re-reading why.
describe('edit.selectAll selects pages in BOTH views (virtualization)', () => {
  const enabledOn = (mode: 'organize' | 'document'): boolean => {
    const state = stateWith({
      files: new Map([['x.pdf', makeFile('x.pdf')]]),
      activeFileId: 'x.pdf',
      ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' }, docViewMode: mode },
    });
    setCommandStateSource(() => ({ state, dispatch: () => {} }));
    registerAppCommandHandlers(noopHandlers());
    const ctx = getCommandContext()!;
    return COMMANDS['edit.selectAll'].when?.(ctx) ?? true;
  };

  it('selects pages on the Organize board', () => {
    expect(enabledOn('organize')).toBe(true);
  });

  it('ALSO selects pages in the reading view — never a partial text select-all', () => {
    expect(enabledOn('document')).toBe(true);
  });

  it('always preventDefaults, so the browser can never run a partial select-all', () => {
    const b = KEY_BINDINGS.find((k) => k.command === 'edit.selectAll' && k.ctrl && k.key === 'a');
    expect(b).toBeDefined();
    expect(b!.preventDefault).toBe('always');
  });
});

describe('Space temporary hand (M6.2)', () => {
  function docTabState(tool: CanvasTool = 'highlight'): AppState {
    const f = { path: 'x.pdf', workingPath: 'x.pdf.w', name: 'x.pdf', pageCount: 1, buffer: [1] as unknown as PdfBuffer, dirty: false, undoStack: [], redoStack: [] };
    return stateWith({
      activeFileId: 'x.pdf',
      files: new Map([['x.pdf', f as OpenFile]]),
      ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' }, tool },
    });
  }
  function key(down: boolean, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
      key: ' ', repeat: false, target: null,
      ctrlKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false,
      preventDefault() { (this as { defaultPrevented: boolean }).defaultPrevented = true; },
      ...init,
    } as unknown as KeyboardEvent;
  }

  function wireState(state: AppState): { finalState: () => AppState } {
    let current = state;
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => { current = appReducer(current, a); },
    }));
    return { finalState: () => current };
  }

  it('hold arms hand; release restores the prior mode', () => {
    const { finalState } = wireState(docTabState('highlight'));
    dispatchKeyEvent(key(true));
    expect(finalState().ui.tool).toBe('hand');
    dispatchKeyUpEvent(key(false));
    expect(finalState().ui.tool).toBe('highlight');
  });

  it('release does NOT resurrect the prior mode over a mid-hold change', () => {
    // Escape (or any explicit pick) mid-hold wins; keyup must not undo it.
    const { finalState } = wireState(docTabState('highlight'));
    dispatchKeyEvent(key(true));
    expect(finalState().ui.tool).toBe('hand');
    dispatchKeyEvent({ ...key(true), key: 'Escape' } as KeyboardEvent); // disarms to select
    expect(finalState().ui.tool).toBe('select');
    dispatchKeyUpEvent(key(false));
    expect(finalState().ui.tool).toBe('select');
  });

  it('auto-repeat keydowns keep suppressing the browser default', () => {
    // The OS repeats keydown while held; each one must preventDefault or the
    // native Space scroll fights the pan (review-caught).
    wireState(docTabState('select'));
    const first = key(true);
    dispatchKeyEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const repeat = key(true, { repeat: true });
    dispatchKeyEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it('does not arm from a text field, and window blur releases the hold', () => {
    const { finalState } = wireState(docTabState('ink'));
    const inField = key(true, { target: { tagName: 'INPUT' } as unknown as EventTarget });
    dispatchKeyEvent(inField);
    expect(finalState().ui.tool).toBe('ink');

    dispatchKeyEvent(key(true));
    expect(finalState().ui.tool).toBe('hand');
    dispatchWindowBlur(); // alt-tab eats the keyup; blur is the release
    expect(finalState().ui.tool).toBe('ink');
  });

  it('holding Space while ALREADY hand is a no-op hold', () => {
    const { finalState } = wireState(docTabState('hand'));
    dispatchKeyEvent(key(true));
    expect(finalState().ui.tool).toBe('hand');
    dispatchKeyUpEvent(key(false));
    expect(finalState().ui.tool).toBe('hand'); // no stale prior to restore
  });
});

describe('single-key accelerators at the DISPATCHER (M6.4)', () => {
  // resolveBinding is pure and never consults settings; THIS is the gate the
  // milestone is about, and deleting it passed the whole suite before these
  // (review-caught). localStorage stub = the workbench-ui.test idiom.
  function letter(key: string, repeat = false): KeyboardEvent {
    return {
      key, repeat, target: null,
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      preventDefault() {},
    } as unknown as KeyboardEvent;
  }
  function docTab(): AppState {
    const f = { path: 'x.pdf', workingPath: 'x.pdf.w', name: 'x.pdf', pageCount: 1, buffer: [1] as unknown as PdfBuffer, dirty: false, undoStack: [], redoStack: [] };
    return stateWith({
      activeFileId: 'x.pdf',
      files: new Map([['x.pdf', f as OpenFile]]),
      ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } },
    });
  }
  function wireState(state: AppState): { finalState: () => AppState } {
    let current = state;
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => { current = appReducer(current, a); },
    }));
    return { finalState: () => current };
  }
  const stubPref = (on: boolean): void => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ singleKeyAccelerators: on }),
      setItem: () => {},
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('the letters are DEAD with the pref off (the default)', () => {
    stubPref(false);
    const { finalState } = wireState(docTab());
    dispatchKeyEvent(letter('h'));
    expect(finalState().ui.tool).toBe('select');
  });

  it('the pref brings them alive', () => {
    stubPref(true);
    const { finalState } = wireState(docTab());
    dispatchKeyEvent(letter('h'));
    expect(finalState().ui.tool).toBe('hand');
    dispatchKeyEvent(letter('u'));
    expect(finalState().ui.tool).toBe('highlight');
    dispatchKeyEvent(letter('v'));
    expect(finalState().ui.tool).toBe('select');
  });

  it('a HELD key does not parity-toggle the mode (auto-repeat refused)', () => {
    // The tool commands are toggles; without the repeat gate a held H flips
    // hand on/off at the OS repeat rate (review-caught HIGH).
    stubPref(true);
    const { finalState } = wireState(docTab());
    dispatchKeyEvent(letter('h'));
    expect(finalState().ui.tool).toBe('hand');
    dispatchKeyEvent(letter('h', true));
    dispatchKeyEvent(letter('h', true));
    dispatchKeyEvent(letter('h', true));
    expect(finalState().ui.tool).toBe('hand');
  });
});

describe('the app-modal keyboard model (M6.5)', () => {
  function docTabWithFile(): AppState {
    const f = { path: 'x.pdf', workingPath: 'x.pdf.w', name: 'x.pdf', pageCount: 1, buffer: [1] as unknown as PdfBuffer, dirty: false, undoStack: [], redoStack: [] };
    return stateWith({
      activeFileId: 'x.pdf',
      files: new Map([['x.pdf', f as OpenFile]]),
      ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } },
    });
  }
  function evt(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent & { defaultPrevented: boolean } {
    const e = {
      repeat: false, target: null,
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false,
      preventDefault() { e.defaultPrevented = true; },
      ...init,
    };
    return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
  }

  it('Escape closes the TOP modal of the stack, once each', () => {
    let current = docTabWithFile();
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => { current = appReducer(current, a); },
    }));
    const closed: string[] = [];
    const popA = pushAppModal(() => closed.push('preferences'));
    const popB = pushAppModal(() => closed.push('print'));
    expect(appModalCount()).toBe(2);

    const esc = evt({ key: 'Escape' });
    dispatchKeyEvent(esc);
    expect(closed).toEqual(['print']); // the TOP one
    expect(esc.defaultPrevented).toBe(true);
    popB(); // the dialog unmounts in response
    dispatchKeyEvent(evt({ key: 'Escape' }));
    expect(closed).toEqual(['print', 'preferences']);
    popA();
    expect(appModalCount()).toBe(0);
  });

  it('while a modal is up, always-suppress chords preventDefault but never RUN', () => {
    let current = docTabWithFile();
    const dispatched: AppAction[] = [];
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => { dispatched.push(a); current = appReducer(current, a); },
    }));
    const handlers = noopHandlers();
    registerAppCommandHandlers(handlers);
    const pop = pushAppModal(() => {});

    // Ctrl+P is 'always' — the webview's own print UI must stay suppressed
    // over a modal (the M-P recorded gap)…
    const p = evt({ key: 'p', ctrlKey: true });
    dispatchKeyEvent(p);
    expect(p.defaultPrevented).toBe(true);
    expect(handlers.openPrint).not.toHaveBeenCalled();
    // …and Ctrl+W must not close a file behind the modal.
    const w = evt({ key: 'w', ctrlKey: true });
    dispatchKeyEvent(w);
    expect(handlers.closeFile).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    pop();
  });
});

describe('browser-default suppression (M6.5)', () => {
  function homeTab(): AppState {
    return stateWith({ ui: { ...initialState.ui, focusedTab: 'home' } });
  }
  function evt(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent & { defaultPrevented: boolean } {
    const e = {
      repeat: false, target: null,
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false,
      preventDefault() { e.defaultPrevented = true; },
      ...init,
    };
    return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
  }
  const wire = (s: AppState): AppAction[] => {
    const dispatched: AppAction[] = [];
    let current = s;
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => { dispatched.push(a); current = appReducer(current, a); },
    }));
    return dispatched;
  };

  it('reload chords never reach the webview — they would blank the app', () => {
    const dispatched = wire(homeTab());
    for (const k of [evt({ key: 'F5' }), evt({ key: 'r', ctrlKey: true }), evt({ key: 'F7' })]) {
      dispatchKeyEvent(k);
      expect(k.defaultPrevented, k.key).toBe(true);
    }
    expect(dispatched).toEqual([]);
  });

  it('a canvas-scoped zoom chord declined on Home still cannot zoom the WEBVIEW', () => {
    const dispatched = wire(homeTab());
    const plus = evt({ key: '=', ctrlKey: true });
    dispatchKeyEvent(plus);
    expect(plus.defaultPrevented).toBe(true);
    expect(dispatched).toEqual([]);
  });

  it('the editable guard keeps NATIVE field editing: Ctrl+Z in an input is untouched', () => {
    wire(stateWith({ ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } } }));
    const z = evt({ key: 'z', ctrlKey: true, target: { tagName: 'INPUT' } as unknown as EventTarget });
    dispatchKeyEvent(z);
    expect(z.defaultPrevented).toBe(false);
  });
});

describe('browser-default suppression from FIELDS (M6.5)', () => {
  it('Ctrl+= in a text input cannot zoom the webview; Ctrl+Z stays native', () => {
    let current = stateWith({ ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } } });
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => { current = appReducer(current, a); },
    }));
    const field = { tagName: 'INPUT' } as unknown as EventTarget;
    const mk = (key: string): KeyboardEvent & { defaultPrevented: boolean } => {
      const e = {
        key, repeat: false, target: field,
        ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
        defaultPrevented: false,
        preventDefault() { e.defaultPrevented = true; },
      };
      return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
    };
    const zoom = mk('=');
    dispatchKeyEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true); // app-hostile: suppressed
    const undo = mk('z');
    dispatchKeyEvent(undo);
    expect(undo.defaultPrevented).toBe(false); // field editing: native
  });
});
