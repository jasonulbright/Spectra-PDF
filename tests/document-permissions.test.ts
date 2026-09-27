// ISO 32000-2 7.6.4.1: a document opened with its user password allows only
// what its /P bits grant. The permission model, its one check per capability,
// the open loop, the close path, and where the typed password may live.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_NAMES,
  UNRESTRICTED,
  capabilityBlock,
  parseDocumentSecurity,
  type DocumentSecurity,
  type PermissionName,
} from '../src/renderer/lib/document-permissions';
import { capabilityBlockText } from '../src/renderer/lib/document-permission-text';
import { COMMANDS, commandBlock, type CommandId } from '../src/renderer/commands/registry';
import type { AppCommandHandlers, CommandContext } from '../src/renderer/commands/types';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { documentPermissions } from '../src/renderer/state/selectors';
import type { AppState, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';
import { openWithCredentials, type DocumentOpenIo } from '../src/renderer/lib/document-open';
import { droppedCredentials, releaseDocumentCredentials } from '../src/renderer/lib/credential-release';
import { documentPassword, rememberDocumentPassword } from '../src/renderer/lib/document-passwords';
import { releaseStageCredential, setStageCredentialCaller, shareStageCredential } from '../src/renderer/lib/stage-credentials';
import { opCapability } from '../src/renderer/lib/op-edit-class';
import { tChrome } from '../src/renderer/i18n';

const PATH = 'C:/docs/locked.pdf';
const USER_PASSWORD = 'reader-pw-7c1';

function allowing(granted: readonly PermissionName[], opener: DocumentSecurity['opener'] = 'user'): DocumentSecurity {
  return parseDocumentSecurity({
    opener,
    permissions: Object.fromEntries(PERMISSION_NAMES.map((name) => [name, granted.includes(name)])),
  });
}

function makeFile(path: string, security?: DocumentSecurity): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: 2,
    buffer: [1, 2, 3],
    dirty: false,
    undoStack: [],
    redoStack: [],
    ...(security ? { security } : {}),
  };
}

function pages(path: string): PageRef[] {
  return [0, 1].map((i) => ({
    id: `${path}#p${i}`,
    sourceDocId: path,
    sourcePageIndex: i,
    rotation: 0 as const,
    width: 300,
    height: 400,
  }));
}

function stateOf(security?: DocumentSecurity): AppState {
  const file = makeFile(PATH, security);
  const doc: OpenDocument = { ...file, id: `${PATH}#0`, pages: pages(PATH), pageCount: 2 };
  return {
    ...initialState,
    files: new Map([[PATH, file]]),
    activeFileId: PATH,
    workspace: { documents: [doc] },
    ui: { ...initialState.ui, focusedTab: { doc: PATH }, selectedPageIds: new Set([`${PATH}#p0`]) },
  };
}

function ctxOf(state: AppState): CommandContext {
  return { state, dispatch: () => {}, app: {} as AppCommandHandlers, canvas: null };
}

const enabled = (state: AppState, id: CommandId): boolean => COMMANDS[id].when?.(ctxOf(state)) ?? true;

describe('the permission record', () => {
  it('reads every permission of an unencrypted document as granted', () => {
    const state = stateOf();
    expect(documentPermissions(state, PATH)).toBe(UNRESTRICTED);
    for (const capability of ['print', 'copy', 'accessibility', 'modify', 'annotate', 'fill', 'assemble',
      'pageTier', 'commentTier', 'formAuthoring'] as const) {
      expect(capabilityBlock(documentPermissions(state, PATH), capability)).toBeNull();
    }
  });

  it('grants the owner opener everything whatever /P says', () => {
    const owner = allowing([], 'owner');
    expect(PERMISSION_NAMES.every((name) => owner.permissions[name])).toBe(true);
    expect(capabilityBlock(owner, 'pageTier')).toBeNull();
    expect(capabilityBlock(owner, 'formAuthoring')).toBeNull();
  });

  it('withholds every bit when the engine reply does not read', () => {
    const unread = parseDocumentSecurity({ opener: 'user' });
    expect(PERMISSION_NAMES.some((name) => unread.permissions[name])).toBe(false);
  });

  it('keeps no password in the record', () => {
    const security = parseDocumentSecurity({ opener: 'user', permissions: {}, password: USER_PASSWORD });
    expect(JSON.stringify(security)).not.toContain(USER_PASSWORD);
  });
});

describe('the command guards', () => {
  it('disables Print on a user-opened document whose /P denies printing, naming the permission', () => {
    const state = stateOf(allowing(['copy', 'modify', 'annotate', 'fill', 'accessibility', 'assemble']));
    expect(enabled(state, 'file.print')).toBe(false);
    const block = commandBlock(ctxOf(state), 'file.print');
    expect(block).toEqual({ kind: 'permission', permission: 'print' });
    expect(capabilityBlockText(block!)).toBe(
      tChrome('app.permissions.denied', { permission: tChrome('app.permissions.name.print') }),
    );
  });

  it('disables copy, extraction and snapshot where copying is denied, but not Read Out Loud', () => {
    const state = stateOf(allowing(['print', 'accessibility']));
    for (const id of ['file.exportText', 'tools.panel.extract_text', 'tools.open.snapshot', 'tools.snapshot'] as CommandId[]) {
      expect(commandBlock(ctxOf(state), id), id).toEqual({ kind: 'permission', permission: 'copy' });
    }
    expect(commandBlock(ctxOf(state), 'view.readAloud.page')).toBeNull();
  });

  it('gates Read Out Loud on the accessibility bit', () => {
    const state = stateOf(allowing(['copy']));
    expect(commandBlock(ctxOf(state), 'view.readAloud.document')).toEqual({ kind: 'permission', permission: 'accessibility' });
  });

  it('disables the page tier when modify and assemble are denied', () => {
    const state = stateOf(allowing(['print', 'copy']));
    for (const id of ['document.rotateSelectionCW', 'document.deleteSelection', 'document.insertBlankPage'] as CommandId[]) {
      expect(commandBlock(ctxOf(state), id), id).toEqual({ kind: 'permission', permission: 'assemble' });
    }
    expect(commandBlock(ctxOf(state), 'tools.panel.rotate')).toEqual({ kind: 'permission', permission: 'assemble' });
  });

  it('lets assemble permit the engine page operations with modify denied', () => {
    const state = stateOf(allowing(['assemble']));
    expect(commandBlock(ctxOf(state), 'tools.panel.rotate')).toBeNull();
    expect(commandBlock(ctxOf(state), 'tools.panel.delete')).toBeNull();
    expect(capabilityBlock(documentPermissions(state, PATH), opCapability('rotate'))).toBeNull();
    expect(capabilityBlock(documentPermissions(state, PATH), opCapability('delete'))).toBeNull();
    expect(capabilityBlock(documentPermissions(state, PATH), opCapability('watermark')))
      .toEqual({ kind: 'permission', permission: 'modify' });
  });

  it('permits the renderer-built tiers on a user-opened document where /P allows them', () => {
    const state = stateOf(allowing([...PERMISSION_NAMES]));
    expect(commandBlock(ctxOf(state), 'document.rotateSelectionCW')).toBeNull();
    expect(commandBlock(ctxOf(state), 'tools.open.prepareform')).toBeNull();
    expect(commandBlock(ctxOf(state), 'tools.open.comment')).toBeNull();
    expect(commandBlock(ctxOf(state), 'tools.panel.forms')).toBeNull();
    expect(capabilityBlockText({ kind: 'ownerPassword' })).toBe(tChrome('app.permissions.ownerPasswordNeeded'));
  });

  it('grants every command to the owner opener and to an unencrypted document', () => {
    for (const state of [stateOf(allowing([], 'owner')), stateOf()]) {
      for (const id of Object.keys(COMMANDS) as CommandId[]) {
        expect(commandBlock(ctxOf(state), id), id).toBeNull();
      }
    }
  });

  it('fills where either the fill or the annotation bit is set', () => {
    expect(capabilityBlock(allowing(['fill']), 'fill')).toBeNull();
    expect(capabilityBlock(allowing(['annotate']), 'fill')).toBeNull();
    expect(capabilityBlock(allowing([]), 'fill')).toEqual({ kind: 'permission', permission: 'fill' });
  });
});

describe('the page tier refuses in the reducer', () => {
  it('refuses a rotation with the denied permission as the reason', () => {
    const state = stateOf(allowing(['print']));
    const next = appReducer(state, { type: 'ROTATE_PAGE_REFS', pageIds: [`${PATH}#p0`], delta: 90 });
    expect(next.workspace).toBe(state.workspace);
    expect(next.pageDirtyPaths).toEqual([]);
    expect(next.pageEditRefusals).toBe(state.pageEditRefusals + 1);
    expect(next.pageEditRefusalReason).toEqual({ kind: 'permission', permission: 'assemble' });
  });

  it('takes an annotation edit and a rotation on a user-opened document that allows them', () => {
    const state = stateOf(allowing([...PERMISSION_NAMES]));
    const rotated = appReducer(state, { type: 'ROTATE_PAGE_REFS', pageIds: [`${PATH}#p0`], delta: 90 });
    expect(rotated.pageDirtyPaths).toEqual([PATH]);
    expect(rotated.pageEditRefusals).toBe(state.pageEditRefusals);
    const removed = appReducer(state, {
      type: 'REMOVE_ANNOTATION', docId: `${PATH}#0`, pageId: `${PATH}#p0`, annotationId: 'a1',
    });
    expect(removed.pageEditRefusalReason).not.toEqual({ kind: 'ownerPassword' });
  });

  it('refuses an annotation edit where /P withholds annotate', () => {
    const state = stateOf(allowing(['assemble', 'modify']));
    const next = appReducer(state, {
      type: 'REMOVE_ANNOTATION', docId: `${PATH}#0`, pageId: `${PATH}#p0`, annotationId: 'a1',
    });
    expect(next.pageEditRefusalReason).toEqual({ kind: 'permission', permission: 'annotate' });
  });

  it("keeps a user-opened document's pages from moving into another file, and takes pages into it", () => {
    const OTHER = 'C:/docs/plain.pdf';
    const base = stateOf(allowing([...PERMISSION_NAMES]));
    const other = makeFile(OTHER);
    const otherDoc: OpenDocument = { ...other, id: `${OTHER}#0`, pages: pages(OTHER), pageCount: 2 };
    const state: AppState = {
      ...base,
      files: new Map([...base.files, [OTHER, other]]),
      workspace: { documents: [...base.workspace.documents, otherDoc] },
    };
    const out = appReducer(state, {
      type: 'MOVE_PAGE', fromDocId: `${PATH}#0`, pageId: `${PATH}#p0`, toDocId: `${OTHER}#0`, toIndex: 0,
    } as never);
    expect(out.pageEditRefusalReason).toEqual({ kind: 'ownerPassword' });
    expect(out.workspace).toBe(state.workspace);
    const into = appReducer(state, {
      type: 'MOVE_PAGE', fromDocId: `${OTHER}#0`, pageId: `${OTHER}#p0`, toDocId: `${PATH}#0`, toIndex: 0,
    } as never);
    expect(into.pageEditRefusals).toBe(state.pageEditRefusals);
  });

  it('lets the same rotation through on an unencrypted document', () => {
    const state = stateOf();
    const next = appReducer(state, { type: 'ROTATE_PAGE_REFS', pageIds: [`${PATH}#p0`], delta: 90 });
    expect(next.pageDirtyPaths).toEqual([PATH]);
    expect(next.pageEditRefusals).toBe(state.pageEditRefusals);
  });
});

function openIo(passwordAnswers: string[], engine: (method: string, params: Record<string, unknown>) => Record<string, unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const prompts: (string | undefined)[] = [];
  const io: DocumentOpenIo = {
    call: async (method, params) => {
      calls.push({ method, params });
      return engine(method, params);
    },
    askPassword: async (_name, error) => {
      prompts.push(error);
      const next = passwordAnswers.shift();
      return next === undefined ? 'cancel' : { password: next };
    },
    askCertificate: async () => 'cancel',
    wrongPassword: () => 'incorrect',
  };
  return { io, calls, prompts };
}

describe('the open loop', () => {
  const engine = (method: string, params: Record<string, unknown>): Record<string, unknown> => {
    switch (method) {
      case 'check_encrypted':
        return { encrypted: true, kind: 'password' };
      case 'open_document_attempt':
        if (params.password !== USER_PASSWORD) return { status: 'wrong_password' };
        return {
          status: 'opened',
          document: { encrypted: true, opener: 'user', encryption_kept: true },
        };
      case 'document_permissions':
        return { opener: 'user', permissions: { print: false, copy: true }, revision: 6, p: -3904 };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };

  it('says the password is incorrect and asks again', async () => {
    const { io, prompts } = openIo(['wrong', USER_PASSWORD], engine);
    const opened = await openWithCredentials('w.pdf', 'locked.pdf', io);
    expect(prompts).toEqual([undefined, 'incorrect']);
    expect(opened?.password).toBe(USER_PASSWORD);
  });

  it('surfaces engine failures instead of labeling them wrong passwords', async () => {
    const { io, prompts } = openIo(['valid-password'], (method) => {
      if (method === 'check_encrypted') return { encrypted: true, kind: 'password' };
      if (method === 'open_document_attempt') throw new Error('disk full');
      throw new Error(`unexpected ${method}`);
    });

    await expect(openWithCredentials('w.pdf', 'locked.pdf', io)).rejects.toThrow('disk full');
    expect(prompts).toEqual([undefined]);
  });

  it('ends on open_document_attempt, never asking check_encrypted again', async () => {
    const { io, calls } = openIo([USER_PASSWORD], engine);
    const opened = await openWithCredentials('w.pdf', 'locked.pdf', io);
    expect(calls.map((c) => c.method)).toEqual(['check_encrypted', 'open_document_attempt', 'document_permissions']);
    expect(calls[1].params).toEqual({ path: 'w.pdf', password: USER_PASSWORD });
    expect(opened?.security.opener).toBe('user');
    expect(opened?.security.permissions.print).toBe(false);
    expect(opened?.security.permissions.copy).toBe(true);
  });

  it('returns null when the prompt is cancelled', async () => {
    const { io } = openIo([], engine);
    expect(await openWithCredentials('w.pdf', 'locked.pdf', io)).toBeNull();
  });

  it('opens an unencrypted document with every permission and no password', async () => {
    const { io, calls } = openIo([], (method) =>
      method === 'check_encrypted' ? { encrypted: false } : { opener: 'none', encrypted: false, permissions: {} });
    const opened = await openWithCredentials('w.pdf', 'plain.pdf', io);
    expect(opened).toEqual({ security: UNRESTRICTED, password: null });
    expect(calls.map((c) => c.method)).toEqual(['check_encrypted', 'document_permissions']);
  });

  it('opens an empty-password document through open_document and keeps its /P', async () => {
    const { io, calls } = openIo([], (method) => {
      if (method === 'check_encrypted') return { encrypted: false };
      if (method === 'open_document') return { encrypted: true, opener: 'user', encryption_kept: true };
      return { opener: 'user', encrypted: true, permissions: { print: true } };
    });
    const opened = await openWithCredentials('w.pdf', 'empty.pdf', io);
    expect(calls.map((c) => c.method)).toEqual(['check_encrypted', 'document_permissions', 'open_document', 'document_permissions']);
    expect(calls[2].params).toEqual({ path: 'w.pdf', password: '' });
    expect(opened?.password).toBeNull();
    expect(opened?.security.permissions.copy).toBe(false);
  });

  it('keeps the owner opener unrestricted and holds no password for it', async () => {
    const { io } = openIo(['owner-pw'], (method) => {
      if (method === 'check_encrypted') return { encrypted: true, kind: 'password' };
      if (method === 'open_document_attempt') {
        return {
          status: 'opened',
          document: { encrypted: true, opener: 'owner', encryption_kept: false },
        };
      }
      return { opener: 'owner', permissions: {} };
    });
    const opened = await openWithCredentials('w.pdf', 'locked.pdf', io);
    expect(opened).toEqual({ security: { opener: 'owner', permissions: UNRESTRICTED.permissions }, password: null });
  });
});

describe('the close path', () => {
  it('releases a closed tab: close_document for its working copy and the password forgotten', async () => {
    const state = stateOf(allowing([]));
    const held = new Map<string, string>();
    expect(droppedCredentials(held, state.files)).toEqual([]);
    rememberDocumentPassword(PATH, USER_PASSWORD);
    const closed = appReducer(state, { type: 'CLOSE_FILE', path: PATH });
    const dropped = droppedCredentials(held, closed.files);
    expect(dropped).toEqual([{ path: PATH, workingPath: `${PATH}.working` }]);
    const call = vi.fn(async () => ({ forgotten: true }));
    await releaseDocumentCredentials(PATH, `${PATH}.working`, closed.files.has(PATH), call);
    expect(call).toHaveBeenCalledWith('close_document', { path: `${PATH}.working` });
    expect(documentPassword(PATH)).toBeUndefined();
  });

  it('releases a replaced working copy but keeps the password of a path still open', async () => {
    const held = new Map([[PATH, `${PATH}.old`]]);
    const files = new Map([[PATH, { workingPath: `${PATH}.working` }]]);
    expect(droppedCredentials(held, files)).toEqual([{ path: PATH, workingPath: `${PATH}.old` }]);
    rememberDocumentPassword(PATH, USER_PASSWORD);
    const call = vi.fn(async () => ({}));
    await releaseDocumentCredentials(PATH, `${PATH}.old`, true, call);
    expect(call).toHaveBeenCalledWith('close_document', { path: `${PATH}.old` });
    expect(documentPassword(PATH)).toBe(USER_PASSWORD);
  });

  it('lends a staged copy the credential only for a user-opened document', async () => {
    const call = vi.fn(async () => ({ shared: true }));
    setStageCredentialCaller(call);
    try {
      expect(await shareStageCredential({ workingPath: 'w.pdf' }, 'w.pdf.stage.pdf')).toBe(false);
      expect(call).not.toHaveBeenCalled();
      expect(await shareStageCredential({ workingPath: 'w.pdf', security: allowing([]) }, 'w.pdf.stage.pdf')).toBe(true);
      expect(call).toHaveBeenCalledWith('share_document', { path: 'w.pdf', alias: 'w.pdf.stage.pdf' });
      await releaseStageCredential('w.pdf.stage.pdf');
      expect(call).toHaveBeenLastCalledWith('close_document', { path: 'w.pdf.stage.pdf' });
    } finally {
      setStageCredentialCaller(null);
    }
  });
});

describe('where the typed password may live', () => {
  it('never reaches application state', () => {
    const next = appReducer(initialState, {
      type: 'OPEN_FILE', path: PATH, workingPath: `${PATH}.working`, name: 'locked.pdf', pageCount: 2,
      buffer: [1, 2, 3], security: allowing(['print']),
    });
    const serialized = JSON.stringify(next, (_key, value: unknown) =>
      value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value] : value);
    expect(serialized).not.toContain(USER_PASSWORD);
    expect(serialized).not.toMatch(/password/i);
    expect(Object.keys(next.files.get(PATH)!)).not.toContain('password');
  });

  it('is held by one module, read only by the pdf.js loaders, the health sweep, the open funnel and the close path', () => {
    const root = join(__dirname, '../src/renderer');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !name.includes('.local.')) files.push(full);
      }
    };
    walk(root);
    const importers = files
      .filter((f) => /from '[./]*(lib\/)?document-passwords'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).replace(/\\/g, '/'))
      .sort();
    expect(importers).toEqual(['App.tsx', 'hooks/useDocumentHealth.ts', 'lib/credential-release.ts', 'lib/pdfDocCache.ts', 'lib/workspace.ts']);
    const store = readFileSync(join(root, 'lib/document-passwords.ts'), 'utf8');
    expect(store).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|writeBuffer|invoke\(/);
  });
});
