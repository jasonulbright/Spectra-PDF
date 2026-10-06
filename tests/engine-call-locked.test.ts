import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineClosures } from './helpers/engine-closures';
import { lockKeysFor, withFileLock, __lockedCount } from '../src/renderer/lib/engine-lock';
import {
  forgetLostCredential,
  markCredentialLost,
  restoreLostCredentials,
  setCredentialUnlocker,
  unlockLostDocument,
} from '../src/renderer/lib/credential-recovery';
import { recognizePage } from '../src/renderer/lib/ocr-recognize';
import { UNRESTRICTED } from '../src/renderer/lib/document-permissions';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({ app: { getTesseractPath: async () => 'tesseract.exe' } }));
vi.mock('../src/renderer/lib/gs-capability', () => ({ requireGsPath: async () => 'gs.exe' }));

const W = 'C:\\work\\a\\doc.pdf';

/** One macrotask: every microtask a runnable waiter needs has run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function engine() {
  const sent: string[] = [];
  const rawCall = vi.fn(async (method: string): Promise<unknown> => { sent.push(method); return { status: 'opened', text: '', words: [] }; });
  const runCommitGate = vi.fn(async () => {});
  const track = vi.fn(async (_m: string, _p: unknown, run: () => Promise<unknown>) => run());
  const closures = engineClosures({
    isTrackableMethod: () => false, beginInteractive: () => () => {},
    runCommitGate, restoreLostCredentials, lockKeysFor, withFileLock, track, rawCall,
  });
  return { ...closures, rawCall, runCommitGate, track, sent };
}

afterEach(() => {
  setCredentialUnlocker(null);
  forgetLostCredential(W);
});

describe('the locked internal call path', () => {
  it('takes the method locks, and runs neither the gate, the queue nor credential recovery', async () => {
    const e = engine();
    markCredentialLost(W);
    const unlocker = vi.fn(async () => false);
    setCredentialUnlocker(unlocker);
    const hold = deferred();
    const commit = withFileLock([W], () => hold.promise);
    const read = e.callLocked('recognize', { file: W, page: 1 });
    await settle();
    expect(e.rawCall).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([commit, read]);
    expect(e.sent).toEqual(['recognize']);
    expect(unlocker).not.toHaveBeenCalled();
    expect(e.runCommitGate).not.toHaveBeenCalled();
    expect(e.track).not.toHaveBeenCalled();
    expect(__lockedCount()).toBe(0);
  });

  it('readers of one working copy overlap through it', async () => {
    const e = engine();
    const order: string[] = [];
    const first = deferred();
    e.rawCall.mockImplementationOnce(async () => { order.push('a:start'); await first.promise; order.push('a:end'); return {}; });
    e.rawCall.mockImplementationOnce(async () => { order.push('b'); return {}; });
    const a = e.callLocked('recognize', { file: W, page: 1 });
    const b = e.callLocked('get_page_count', { file: W });
    // Released late either way: a reader that waited for the first one would
    // run after `a:end` instead of hanging the test.
    setTimeout(first.resolve, 20);
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'b', 'a:end']);
  });

  it('the gated path, by contrast, recovers a lost credential before the same read', async () => {
    const e = engine();
    markCredentialLost(W);
    const unlocker = vi.fn(async () => false);
    setCredentialUnlocker(unlocker);
    await e.call('recognize', { file: W, page: 1 });
    expect(unlocker).toHaveBeenCalledWith(W);
  });

  it('the find index recognizes a page with a lost credential without a prompt, once per page', async () => {
    const e = engine();
    markCredentialLost(W);
    const unlocker = vi.fn(async () => false);
    setCredentialUnlocker(unlocker);
    for (const page of [0, 1, 2]) await recognizePage(e.callLocked, W, page, 'eng');
    expect(unlocker).not.toHaveBeenCalled();
    expect(e.sent).toEqual(['recognize', 'recognize', 'recognize']);
  });

  it('the find index, the print preview and the unlocker are wired to it', () => {
    const read = (p: string) => readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf8');
    expect(read('search/useSearchIndex.ts')).toContain('recognizePage(callLocked, path, pageIndex, lang)');
    const print = read('components/PrintDialog.tsx');
    expect(print).toContain("callLocked('print_preview', params)");
    expect(print).toContain("callLocked('print_preview_cleanup', { directory: dir })");
    expect(print).not.toMatch(/\bcall\('print_preview/);
    expect(read('App.tsx')).toMatch(/unlockLostDocument\(record, \{\s*call: callLocked,/);
  });
});

describe('the credential unlocker holds the lock of the document it opens', () => {
  const doc = { path: 'C:\\docs\\doc.pdf', name: 'doc.pdf', workingPath: W, security: UNRESTRICTED };

  it('a password retry waits for a reader of the working copy, then holds it exclusively', async () => {
    const e = engine();
    const reading = deferred();
    const reader = withFileLock(lockKeysFor('recognize', { file: W }), () => reading.promise);
    const unlocked = unlockLostDocument(doc, {
      call: e.callLocked,
      askPassword: async () => ({ password: 'pw' }),
      askCertificate: async () => 'cancel',
      wrongPassword: () => 'wrong',
      rememberPassword: () => {},
    });
    await settle();
    expect(e.sent).toEqual([]);
    // A reader that arrives after the exclusive claim waits for the unlock.
    const later = withFileLock(lockKeysFor('recognize', { file: W }), async () => { e.sent.push('later read'); });
    reading.resolve();
    await Promise.all([reader, later]);
    await expect(unlocked).resolves.toBe(true);
    expect(e.sent).toEqual(['open_document_attempt', 'later read']);
    expect(__lockedCount()).toBe(0);
  });

  it('a certificate retry waits for a writer of the working copy', async () => {
    const e = engine();
    const writing = deferred();
    const writer = withFileLock([W], () => writing.promise);
    const unlocked = unlockLostDocument({ ...doc, security: { ...UNRESTRICTED, opener: 'recipient' as const } }, {
      call: e.callLocked,
      askPassword: async () => 'cancel',
      askCertificate: async () => ({ pfx: 'C:\\id.pfx', password: 'pw' }),
      wrongPassword: () => 'wrong',
      rememberPassword: () => {},
    });
    await settle();
    expect(e.sent).toEqual([]);
    writing.resolve();
    await writer;
    await expect(unlocked).resolves.toBe(true);
    expect(e.sent).toEqual(['pubkey_reattach']);
  });
});
