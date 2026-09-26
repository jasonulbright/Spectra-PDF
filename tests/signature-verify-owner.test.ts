import { describe, expect, it } from 'vitest';
import {
  createVerifyRuns,
  displayedVerify,
  runOwnedVerify,
  verifyOwnerOf,
  type OwnedVerify,
} from '../src/renderer/lib/signature-verify-owner';
import type { OpenFile } from '../src/renderer/state/types';

const file = (path: string, bytes: number[]): OpenFile => ({
  path,
  workingPath: `${path}.work`,
  name: path,
  pageCount: 1,
  buffer: new Uint8Array(bytes) as unknown as OpenFile['buffer'],
  dirty: false,
  undoStack: [],
  redoStack: [],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('signature verification ownership', () => {
  const trust = { anchors: [] };

  it('drops a late reply for A once B has been verified, and B stays displayed', async () => {
    const runs = createVerifyRuns();
    const a = file('A.pdf', [1]);
    const b = file('B.pdf', [2]);
    let shown: OwnedVerify<string> | null = null;
    const publish = (o: OwnedVerify<string>) => { shown = o; };
    const slowA = deferred<string>();
    const first = runOwnedVerify(runs, verifyOwnerOf(a, trust)!, () => slowA.promise, publish);
    const second = runOwnedVerify(runs, verifyOwnerOf(b, trust)!, async () => 'B result', publish);
    expect(await second).toBe('published');
    slowA.resolve('A result');
    expect(await first).toBe('stale');
    expect(displayedVerify(shown, b, trust)).toBe('B result');
  });

  it('drops a late failure of a superseded run instead of reporting it', async () => {
    const runs = createVerifyRuns();
    const slow = deferred<string>();
    const first = runOwnedVerify(runs, verifyOwnerOf(file('A.pdf', [1]), trust)!, () => slow.promise, () => {});
    runs.begin();
    slow.reject(new Error('late'));
    expect(await first).toBe('stale');
  });

  it('hides a result once the document, its bytes or the trust configuration changes', () => {
    const a = file('A.pdf', [1]);
    const owned: OwnedVerify<string> = { owner: verifyOwnerOf(a, trust)!, value: 'A result' };
    expect(displayedVerify(owned, a, trust)).toBe('A result');
    expect(displayedVerify(owned, file('B.pdf', [1]), trust)).toBeNull();
    expect(displayedVerify(owned, { ...a, buffer: new Uint8Array([1]) as unknown as OpenFile['buffer'] }, trust)).toBeNull();
    expect(displayedVerify(owned, a, { anchors: [] })).toBeNull();
    expect(displayedVerify(owned, null, trust)).toBeNull();
  });
});
