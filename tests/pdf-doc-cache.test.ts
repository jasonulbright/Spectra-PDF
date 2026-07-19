// pdfDocCache (Phase 9): one live pdf.js proxy per open file, keyed by
// (path, buffer identity). getDocumentProxy TRUSTS its caller — a mismatched
// buffer evicts + destroys the cached entry — so a caller whose buffer
// crossed an async gap goes through requestDocumentProxy, which refuses
// (null, cache untouched) when the want went stale (round 24 tail: a stale
// caller must never destroy the CURRENT buffer's live proxy out from under
// the canvas — a getPage against a destroyed proxy hangs, never rejects).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({
  loadDocument: vi.fn(),
}));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import {
  evictExcept,
  getDocumentProxy,
  requestDocumentProxy,
} from '../src/renderer/lib/pdfDocCache';

const loadDocumentMock = vi.mocked(loadDocument);

function makeProxy(): { proxy: PDFDocumentProxy; destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  const proxy = { loadingTask: { destroy } } as unknown as PDFDocumentProxy;
  return { proxy, destroy };
}

// destroyEntry chains destroy on the entry's promise — flush a macrotask so
// "was (not) destroyed" assertions observe the chain, not a race with it.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  // The cache is a module-level singleton — drop everything between tests.
  evictExcept(new Set());
  await flush();
  loadDocumentMock.mockReset();
});

describe('getDocumentProxy', () => {
  it('serves the cached promise for the same (path, buffer)', async () => {
    const buf = new Uint8Array([1]);
    const { proxy } = makeProxy();
    loadDocumentMock.mockResolvedValueOnce(proxy);
    const first = getDocumentProxy('C:/a.pdf', buf);
    expect(getDocumentProxy('C:/a.pdf', buf)).toBe(first);
    await expect(first).resolves.toBe(proxy);
    expect(loadDocumentMock).toHaveBeenCalledTimes(1);
  });

  it('a different buffer for the same path evicts and destroys the old entry', async () => {
    // The documented contract for SYNCHRONOUS callers (buffer straight off
    // state) — and exactly the trust requestDocumentProxy exists to gate.
    const bufA = new Uint8Array([1]);
    const bufB = new Uint8Array([2]);
    const a = makeProxy();
    const b = makeProxy();
    loadDocumentMock.mockResolvedValueOnce(a.proxy).mockResolvedValueOnce(b.proxy);
    await getDocumentProxy('C:/a.pdf', bufA);
    const second = getDocumentProxy('C:/a.pdf', bufB);
    await flush();
    expect(a.destroy).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(b.proxy);
    expect(b.destroy).not.toHaveBeenCalled();
  });

  it('a rejected load is evicted so a retry re-attempts it', async () => {
    // Retriers (indexer, useWorkspaceForms' bounded retry) must not replay a
    // cached rejection forever.
    const buf = new Uint8Array([1]);
    const { proxy } = makeProxy();
    loadDocumentMock
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce(proxy);
    await expect(getDocumentProxy('C:/a.pdf', buf)).rejects.toThrow('load failed');
    await flush();
    await expect(getDocumentProxy('C:/a.pdf', buf)).resolves.toBe(proxy);
    expect(loadDocumentMock).toHaveBeenCalledTimes(2);
  });
});

describe('requestDocumentProxy', () => {
  it('delegates to the cache while still wanted', async () => {
    const buf = new Uint8Array([1]);
    const { proxy } = makeProxy();
    loadDocumentMock.mockResolvedValueOnce(proxy);
    const p = requestDocumentProxy('C:/a.pdf', buf, () => true);
    expect(p).not.toBeNull();
    // Same entry the synchronous path serves — one shared proxy per file.
    expect(getDocumentProxy('C:/a.pdf', buf)).toBe(p);
    await expect(p).resolves.toBe(proxy);
    expect(loadDocumentMock).toHaveBeenCalledTimes(1);
  });

  it('a stale request returns null and leaves the newer live proxy untouched', async () => {
    // The round-24 hazard: a caller captured bufStale before an await; while
    // it slept the file moved to bufCurrent and the cache loaded it. The
    // stale caller must get null — NOT evict + destroy the live entry.
    const bufCurrent = new Uint8Array([1]);
    const bufStale = new Uint8Array([2]);
    const { proxy, destroy } = makeProxy();
    loadDocumentMock.mockResolvedValueOnce(proxy);
    const live = getDocumentProxy('C:/a.pdf', bufCurrent);
    await live;

    expect(requestDocumentProxy('C:/a.pdf', bufStale, () => false)).toBeNull();
    await flush();
    // No load for the stale bytes, no destruction of the live proxy…
    expect(loadDocumentMock).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    // …and the live entry still serves, un-reloaded.
    expect(getDocumentProxy('C:/a.pdf', bufCurrent)).toBe(live);
    expect(loadDocumentMock).toHaveBeenCalledTimes(1);
  });
});
