import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineClosures } from './helpers/engine-closures';
import { exclusiveKeys, lockKeysFor, withFileLock, withWriteChain, __chainedCount, __lockedCount } from '../src/renderer/lib/engine-lock';
import { beginDocumentWrites } from '../src/renderer/lib/document-writes';
import { EngineError } from '../src/renderer/lib/engine-messages';
import { UNRESTRICTED } from '../src/renderer/lib/document-permissions';
import {
  READER_COPY_METHODS,
  holdReaderCopies,
  withReaderCopies,
  type ReaderCopyIo,
  type ReaderCopyRun,
} from '../src/renderer/lib/reader-copy';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({}));

const W = 'C:\\work\\a.1\\doc.pdf';
const W2 = 'C:\\work\\b.1\\other.pdf';
const OUT = 'C:\\out\\doc.txt';

/** One macrotask: every microtask a runnable waiter needs has run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function copyOf(working: string, n: number): string {
  const at = working.lastIndexOf('\\');
  return `${working.slice(0, at)}\\r42-${n.toString(16).padStart(8, '0')}${working.slice(at)}`;
}

/** A window with `open` working copies. Records every copy made, removed,
 * lent and given back, and how many file-lock keys were held while each copy
 * was made. */
function readerIo(open: string[]) {
  const made: string[] = [];
  const removed: string[] = [];
  const lent: string[] = [];
  const returned: string[] = [];
  const heldWhileCopying: number[] = [];
  let n = 0;
  const io = {
    fileAt: vi.fn((path: string) => open.includes(path)
      ? { workingPath: path, security: { ...UNRESTRICTED, opener: 'recipient' as const } } : undefined),
    create: vi.fn(async (path: string) => {
      heldWhileCopying.push(__lockedCount());
      const copy = copyOf(path, ++n);
      made.push(copy);
      return copy;
    }),
    remove: vi.fn(async (copy: string) => { removed.push(copy); return true; }),
    lend: vi.fn(async (_file: unknown, copy: string) => { lent.push(copy); return true; }),
    giveBack: vi.fn(async (copy: string) => { returned.push(copy); }),
  } satisfies ReaderCopyIo;
  return { io, made, removed, lent, returned, heldWhileCopying };
}

function engine(io: ReaderCopyIo | null, trackable = true) {
  const rawCall = vi.fn<(method: string, params?: Record<string, unknown>, options?: unknown) => Promise<unknown>>(async () => ({}));
  const runCommitGate = vi.fn(async () => {});
  const track = vi.fn(async (_m: string, _p: unknown, run: () => Promise<unknown>) => run());
  const closures = engineClosures({
    isTrackableMethod: () => trackable, beginInteractive: () => () => {},
    runCommitGate, restoreLostCredentials: async () => {}, lockKeysFor, exclusiveKeys, withFileLock, withWriteChain,
    beginDocumentWrites, track, rawCall, readerCopies: io,
  });
  return { ...closures, rawCall, runCommitGate, track };
}

afterEach(() => {
  vi.restoreAllMocks();
  expect(__lockedCount()).toBe(0);
  expect(__chainedCount()).toBe(0);
});

describe('a long reader reads a private copy', () => {
  it('lets an exclusive claim on the working copy through while its engine step runs', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    const step = deferred();
    e.rawCall.mockImplementationOnce(async () => { await step.promise; return {}; });
    const exported = e.call('export_document', { file: W, output: OUT, fmt: 'txt' });
    await vi.waitFor(() => expect(e.rawCall).toHaveBeenCalledOnce());
    expect(e.rawCall.mock.calls[0][1]).toEqual({ file: r.made[0], output: OUT, fmt: 'txt' });
    // A page commit of the document claims its working copy exclusively.
    const committed = vi.fn();
    await withFileLock([W], async () => { committed(); });
    expect(committed).toHaveBeenCalledOnce();
    step.resolve();
    await exported;
    expect(r.heldWhileCopying).toEqual([1]);
  });

  it('a call that is not a member keeps the claim waiting until its engine step ends (control)', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    const step = deferred();
    e.rawCall.mockImplementationOnce(async () => { await step.promise; return {}; });
    const extracted = e.call('extract_text', { file: W, output: OUT });
    await vi.waitFor(() => expect(e.rawCall).toHaveBeenCalledOnce());
    const committed = vi.fn();
    const commit = withFileLock([W], async () => { committed(); });
    await settle();
    expect(committed).not.toHaveBeenCalled();
    step.resolve();
    await Promise.all([extracted, commit]);
    expect(committed).toHaveBeenCalledOnce();
    expect(r.io.create).not.toHaveBeenCalled();
  });

  it('a member naming a path that is no working copy of this window reads it under its lock', async () => {
    const r = readerIo([]);
    const e = engine(r.io);
    await e.call('export_document', { file: W, output: OUT, fmt: 'txt' });
    expect(r.io.create).not.toHaveBeenCalled();
    expect(e.rawCall.mock.calls[0][1]).toEqual({ file: W, output: OUT, fmt: 'txt' });
  });

  it('makes one copy per distinct working path, under one claim of the paths it reads', async () => {
    const same = readerIo([W]);
    const e1 = engine(same.io);
    await e1.call('compare_visual', { file_a: W, file_b: W });
    expect(same.made).toHaveLength(1);
    expect(e1.rawCall.mock.calls[0][1]).toEqual({ file_a: same.made[0], file_b: same.made[0] });

    const two = readerIo([W, W2]);
    const e2 = engine(two.io);
    await e2.call('compare_visual', { file_a: W, file_b: W2 });
    expect(two.made).toEqual([copyOf(W, 1), copyOf(W2, 2)]);
    expect(e2.rawCall.mock.calls[0][1]).toEqual({ file_a: two.made[0], file_b: two.made[1] });
    expect(two.heldWhileCopying).toEqual([2, 2]);
    expect(two.removed).toEqual(two.made);
  });

  it('the queue entry and its log read the caller\'s parameters', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    const params = { file: W, output: OUT, fmt: 'txt' };
    await e.call('export_document', params);
    expect(e.track).toHaveBeenCalledOnce();
    expect(e.track.mock.calls[0][0]).toBe('export_document');
    expect(e.track.mock.calls[0][1]).toBe(params);
    expect(params.file).toBe(W);
  });

  it('the result names the working copy, never the copy', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    e.rawCall.mockImplementationOnce(async (_m, p) => {
      const copy = String(p!.file);
      const folder = copy.slice(0, copy.lastIndexOf('\\'));
      return {
        output: OUT, file: copy, folder, pages: 3,
        notes: [`read ${copy}`, `quoted '${copy.replace(/\\/g, '\\\\')}'`],
      };
    });
    const result = await e.call('preflight', { file: W });
    expect(result).toEqual({
      output: OUT, file: W, folder: 'C:\\work\\a.1', pages: 3,
      notes: [`read ${W}`, `quoted '${W.replace(/\\/g, '\\\\')}'`],
    });
  });

  it('the refusal names the working copy, never the copy', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    e.rawCall.mockImplementationOnce(async (_m, p) => {
      throw new EngineError(`Cannot open ${String(p!.file)}`, { path: p!.file });
    });
    const refusal = await e.call('export_document', { file: W, output: OUT, fmt: 'txt' }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EngineError);
    expect((refusal as EngineError).raw).toBe(`Cannot open ${W}`);
    expect((refusal as EngineError).data).toEqual({ path: W });

    const plain = readerIo([W]);
    const e2 = engine(plain.io);
    e2.rawCall.mockImplementationOnce(async (_m, p) => { throw new Error(`gone: ${String(p!.file)}`); });
    await expect(e2.call('print', { file: W })).rejects.toThrow(`gone: ${W}`);
  });

  it('removes the copy and returns the credential on success, refusal, abort and a throw before dispatch', async () => {
    const outcomes: Array<[string, (e: ReturnType<typeof engine>) => Promise<unknown>]> = [
      ['success', e => e.call('export_document', { file: W, output: OUT })],
      ['refusal', e => {
        e.rawCall.mockImplementationOnce(async () => { throw new EngineError('refused'); });
        return e.call('export_document', { file: W, output: OUT }).catch(() => undefined);
      }],
      ['abort', e => {
        const abort = new AbortController();
        abort.abort();
        e.rawCall.mockImplementationOnce(async () => ({ cancelled: true }));
        return e.call('export_document', { file: W, output: OUT }, { signal: abort.signal });
      }],
      ['throw before dispatch', e => {
        let checks = 0;
        return e.call('export_document', { file: W, output: OUT }, {
          assertCurrent: () => { if (++checks > 1) throw new Error('changed'); },
        }).catch(() => undefined);
      }],
    ];
    for (const [name, run] of outcomes) {
      const r = readerIo([W]);
      const e = engine(r.io);
      await run(e);
      expect(r.made, name).toHaveLength(1);
      expect(r.removed, name).toEqual(r.made);
      expect(r.lent, name).toEqual(r.made);
      expect(r.returned, name).toEqual(r.made);
      if (name === 'throw before dispatch') expect(e.rawCall).not.toHaveBeenCalled();
      if (name === 'abort') expect(e.rawCall.mock.calls[0][2]).toHaveProperty('signal');
    }
  });

  it('a copy that cannot be made falls back to the locked read, with one log line and no loan', async () => {
    const r = readerIo([W]);
    r.io.create.mockRejectedValueOnce('Failed to make a reader copy: no space');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const e = engine(r.io);
    const step = deferred();
    e.rawCall.mockImplementationOnce(async () => { await step.promise; return {}; });
    const exported = e.call('export_document', { file: W, output: OUT });
    await vi.waitFor(() => expect(e.rawCall).toHaveBeenCalledOnce());
    expect(e.rawCall.mock.calls[0][1]).toEqual({ file: W, output: OUT });
    const committed = vi.fn();
    const commit = withFileLock([W], async () => { committed(); });
    await settle();
    expect(committed).not.toHaveBeenCalled();
    step.resolve();
    await Promise.all([exported, commit]);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain(W);
    expect(r.io.lend).not.toHaveBeenCalled();
    expect(r.io.remove).not.toHaveBeenCalled();
  });

  it('a copy whose credential cannot be lent is removed, and the call reads the working copy', async () => {
    const r = readerIo([W]);
    r.io.lend.mockRejectedValueOnce(new Error('stage credentials are not registered'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const e = engine(r.io);
    await e.call('print', { file: W });
    expect(e.rawCall.mock.calls[0][1]).toEqual({ file: W });
    expect(r.removed).toEqual(r.made);
    expect(r.returned).toEqual([]);
  });

  it('a path the call also writes is never copied', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    await e.call('sign_pdf', { file: W, output: W });
    expect(r.io.create).not.toHaveBeenCalled();
    expect(e.rawCall.mock.calls[0][1]).toEqual({ file: W, output: W });
  });

  it('the hold seam holds a call on a copy before its engine step, holding no lock of the working copy', async () => {
    const r = readerIo([W]);
    const e = engine(r.io);
    const hold = holdReaderCopies();
    try {
      const exported = e.call('export_document', { file: W, output: OUT });
      await vi.waitFor(() => expect(hold.waiting()).toBe(1));
      expect(e.rawCall).not.toHaveBeenCalled();
      await withFileLock([W], async () => {});
      hold.release();
      await exported;
      expect(e.rawCall).toHaveBeenCalledOnce();
    } finally {
      hold.release();
    }
  });

  it('every member names only parameters the lock table holds shared', () => {
    for (const [method, params] of Object.entries(READER_COPY_METHODS)) {
      for (const param of params) {
        expect(lockKeysFor(method, { [param]: W }), `${method}.${param}`).toEqual([{ key: W, mode: 'shared' }]);
      }
    }
  });
});

describe('the copy is never claimed while the call\'s claims are held', () => {
  // A commit of two dirty documents claims both working copies exclusively in
  // one step. It arrives while the reader copies its first document.
  const D = W;
  const E = W2;

  it('a nested copy claim deadlocks against an atomic two-path commit (the mutant)', async () => {
    // A private instance of the locks: the two holders below never release.
    vi.resetModules();
    const locks = await import('../src/renderer/lib/engine-lock');
    const copyingD = deferred();
    const commitQueued = deferred();
    // The mutant claims E as the call's read, then copies D inside that claim.
    const mutant = locks.withFileLock([{ key: E, mode: 'shared' }], async () => {
      copyingD.resolve();
      await commitQueued.promise;
      await locks.withFileLock([{ key: D, mode: 'shared' }], async () => {});
    });
    await copyingD.promise;
    const commit = locks.withFileLock([D, E], async () => {});
    commitQueued.resolve();
    const outcome = await Promise.race([
      Promise.all([mutant, commit]).then(() => 'finished'),
      new Promise(resolve => setTimeout(() => resolve('deadlocked'), 50)),
    ]);
    expect(outcome).toBe('deadlocked');
    expect(locks.__lockedCount()).toBe(2);
  });

  it('a commit of both documents in one step cannot land between the two copies', async () => {
    const D3 = 'C:\\work\\e.1\\d.pdf';
    const E3 = 'C:\\work\\f.1\\e.pdf';
    const r = readerIo([D3, E3]);
    const order: string[] = [];
    const firstCopy = deferred<string>();
    const firstStarted = deferred();
    r.io.create.mockImplementationOnce(async (path: string) => {
      order.push(`copy ${path}`);
      firstStarted.resolve();
      return firstCopy.promise;
    });
    r.io.create.mockImplementationOnce(async (path: string) => {
      order.push(`copy ${path}`);
      return copyOf(path, 8);
    });
    const e = engine(r.io);
    const compared = e.call('compare_visual', { file_a: D3, file_b: E3 });
    await firstStarted.promise;
    // A page moved from D to E commits both working copies at once.
    const commit = withFileLock([D3, E3], async () => { order.push('commit'); });
    await settle();
    firstCopy.resolve(copyOf(D3, 7));
    await Promise.all([compared, commit]);
    expect(order).toEqual([`copy ${D3}`, `copy ${E3}`, 'commit']);
  });

  it('the real order finishes both', async () => {
    const D2 = 'C:\\work\\c.1\\d.pdf';
    const E2 = 'C:\\work\\d.1\\e.pdf';
    const r = readerIo([D2, E2]);
    const copying = deferred<string>();
    const copyStarted = deferred();
    r.io.create.mockImplementationOnce(async () => { copyStarted.resolve(); return copying.promise; });
    const e = engine(r.io);
    const compared = e.call('compare_visual', { file_a: D2, file_b: E2 });
    await copyStarted.promise;
    const committed = vi.fn();
    const commit = withFileLock([D2, E2], async () => { committed(); });
    copying.resolve(copyOf(D2, 9));
    const outcome = await Promise.race([
      Promise.all([compared, commit]).then(() => 'finished'),
      new Promise(resolve => setTimeout(() => resolve('deadlocked'), 500)),
    ]);
    expect(outcome).toBe('finished');
    expect(committed).toHaveBeenCalledOnce();
  });
});

describe('withReaderCopies', () => {
  it('runs a non-member synchronously with its own parameters and claims', () => {
    const r = readerIo([W]);
    const run = vi.fn<ReaderCopyRun<string>>(async () => 'ran');
    const params = { file: W };
    const claims = lockKeysFor('recognize', params);
    void withReaderCopies('recognize', params, claims, r.io, run);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe(params);
    expect(run.mock.calls[0][1]).toBe(claims);
  });
});
