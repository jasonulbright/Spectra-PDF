// The content key of a loaded document: SHA-256 of its bytes. Recognition for
// selection is cached under it, so a new pdf.js document over equal bytes
// serves the boxes the old one recognised, and other bytes never do.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({
  loadDocument: vi.fn(),
}));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import {
  contentKeyOf,
  contentKeyOfBuffer,
  evictDocumentProxy,
  evictExcept,
  getDocumentProxy,
  replacementOf,
} from '../src/renderer/lib/pdfDocCache';
import { peekSelectionCache, recognizeForSelection } from '../src/renderer/lib/ocr-selection';
import type { OcrResult } from '../src/renderer/ocr/types';

const loadDocumentMock = vi.mocked(loadDocument);

function makeProxy(): PDFDocumentProxy {
  return { loadingTask: { destroy: vi.fn() } } as unknown as PDFDocumentProxy;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const page: OcrResult = {
  text: 'one two three four',
  words: ['one', 'two', 'three', 'four'].map((text, i) => ({
    text, x: 0.1, y: 0.1 + i * 0.05, w: 0.2, h: 0.03, conf: 95,
  })),
};

async function keyOf(proxy: PDFDocumentProxy): Promise<string> {
  const key = contentKeyOf(proxy);
  if (!key) throw new Error('no content key for a cached document');
  return key;
}

beforeEach(async () => {
  evictExcept(new Set());
  await flush();
  loadDocumentMock.mockReset();
});

describe('contentKeyOfBuffer', () => {
  it('gives equal bytes the same key, whatever holds them', async () => {
    const bytes = [37, 80, 68, 70, 45, 49, 46, 55];
    const a = await contentKeyOfBuffer(new Uint8Array(bytes));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentKeyOfBuffer(new Uint8Array(bytes).buffer)).toBe(a);
    expect(await contentKeyOfBuffer(bytes)).toBe(a);
  });

  it('gives bytes that differ in one byte another key', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const other = bytes.slice();
    other[7] = 54;
    expect(await contentKeyOfBuffer(other)).not.toBe(await contentKeyOfBuffer(bytes));
  });
});

// A file whose buffer changed shows no document until the new bytes load; the
// text layer keeps its spans over that gap and takes them down only when the
// replacing load fails.
describe('replacementOf', () => {
  it('is null for a document nothing replaced', async () => {
    loadDocumentMock.mockResolvedValueOnce(makeProxy());
    expect(replacementOf(await getDocumentProxy('C:/a.pdf', new Uint8Array([1])))).toBeNull();
  });

  it('follows the newest replacement and settles with its load', async () => {
    const newest = makeProxy();
    loadDocumentMock
      .mockResolvedValueOnce(makeProxy())
      .mockResolvedValueOnce(makeProxy())
      .mockResolvedValueOnce(newest);
    const first = await getDocumentProxy('C:/a.pdf', new Uint8Array([1]));
    void getDocumentProxy('C:/a.pdf', new Uint8Array([2]));
    void getDocumentProxy('C:/a.pdf', new Uint8Array([3]));
    await expect(replacementOf(first)).resolves.toBe(newest);
  });

  it('rejects when the replacing load fails', async () => {
    loadDocumentMock
      .mockResolvedValueOnce(makeProxy())
      .mockRejectedValueOnce(new Error('load failed'));
    const first = await getDocumentProxy('C:/a.pdf', new Uint8Array([1]));
    void getDocumentProxy('C:/a.pdf', new Uint8Array([2])).catch(() => {});
    await expect(replacementOf(first)).rejects.toThrow('load failed');
    // Nothing newer stands behind the failure: the same load comes back.
    const failed = replacementOf(first);
    await flush();
    expect(replacementOf(first)).toBe(failed);
  });

  it('a chain whose middle load fails leads on to the newer load', async () => {
    // Two quick refreshes: pdf.js aborts the first replacement's load.
    const newest = makeProxy();
    let rejectMiddle!: (e: Error) => void;
    loadDocumentMock
      .mockResolvedValueOnce(makeProxy())
      .mockReturnValueOnce(new Promise<PDFDocumentProxy>((_, reject) => { rejectMiddle = reject; }))
      .mockResolvedValueOnce(newest);
    const first = await getDocumentProxy('C:/a.pdf', new Uint8Array([1]));
    void getDocumentProxy('C:/a.pdf', new Uint8Array([2])).catch(() => {});
    const middle = replacementOf(first)!;
    void getDocumentProxy('C:/a.pdf', new Uint8Array([3]));
    rejectMiddle(new Error('Loading aborted'));
    await expect(middle).rejects.toThrow('Loading aborted');
    const newer = replacementOf(first);
    expect(newer).not.toBe(middle);
    await expect(newer).resolves.toBe(newest);
  });

  it('a load after an eviction is the replacement, and its failure has nothing behind it', async () => {
    const bytes = new Uint8Array([1]);
    loadDocumentMock
      .mockResolvedValueOnce(makeProxy())
      .mockRejectedValueOnce(new Error('load failed'));
    const first = await getDocumentProxy('C:/a.pdf', bytes);
    evictDocumentProxy('C:/a.pdf', bytes);
    expect(replacementOf(first)).toBeNull();
    void getDocumentProxy('C:/a.pdf', new Uint8Array([2])).catch(() => {});
    const failed = replacementOf(first);
    await expect(failed).rejects.toThrow('load failed');
    await flush();
    // The failed load left the cache and no successor follows it.
    expect(replacementOf(first)).toBeNull();
  });
});

describe('recognition keyed by the cached documents', () => {
  it('a new document for equal bytes finds the recognition of the old one', async () => {
    const first = makeProxy();
    const second = makeProxy();
    loadDocumentMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const bytes = new Uint8Array([1, 2, 3]);
    const key = await keyOf(await getDocumentProxy('C:/scan.pdf', bytes));
    const run = vi.fn(async () => page);
    const recognised = await recognizeForSelection(key, 1, 0, 'eng', run);

    // A refresh with a copy of the same bytes: new buffer identity, new proxy.
    const refreshed = await getDocumentProxy('C:/scan.pdf', bytes.slice());
    expect(refreshed).toBe(second);
    await flush();
    expect(await keyOf(refreshed)).toBe(key);
    expect(peekSelectionCache(key, 1, 0, 'eng')).not.toBeNull();
    expect(await recognizeForSelection(key, 1, 0, 'eng', run)).toBe(recognised);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('different bytes miss', async () => {
    loadDocumentMock.mockResolvedValueOnce(makeProxy()).mockResolvedValueOnce(makeProxy());
    const key = await keyOf(await getDocumentProxy('C:/scan.pdf', new Uint8Array([1, 2, 3])));
    await recognizeForSelection(key, 1, 0, 'eng', async () => page);
    const changed = await keyOf(await getDocumentProxy('C:/scan.pdf', new Uint8Array([1, 2, 4])));
    await flush();
    expect(changed).not.toBe(key);
    expect(peekSelectionCache(changed, 1, 0, 'eng')).toBeNull();
    // The old bytes have no document left, so their recognition went too.
    expect(peekSelectionCache(key, 1, 0, 'eng')).toBeNull();
  });

  it('two open files over equal bytes share the entry until the last closes', async () => {
    loadDocumentMock.mockResolvedValueOnce(makeProxy()).mockResolvedValueOnce(makeProxy());
    const bytes = [5, 6, 7];
    const key = await keyOf(await getDocumentProxy('C:/a.pdf', new Uint8Array(bytes)));
    expect(await keyOf(await getDocumentProxy('C:/b.pdf', new Uint8Array(bytes)))).toBe(key);
    await recognizeForSelection(key, 1, 0, 'eng', async () => page);

    evictExcept(new Set(['C:/b.pdf']));
    await flush();
    expect(peekSelectionCache(key, 1, 0, 'eng')).not.toBeNull();

    evictExcept(new Set());
    await flush();
    expect(peekSelectionCache(key, 1, 0, 'eng')).toBeNull();
  });

  it('a failed load holds no key', async () => {
    loadDocumentMock.mockRejectedValueOnce(new Error('load failed'));
    const bytes = new Uint8Array([9, 9]);
    const key = await contentKeyOfBuffer(bytes);
    await expect(getDocumentProxy('C:/bad.pdf', bytes)).rejects.toThrow('load failed');
    await flush();
    await recognizeForSelection(key, 1, 0, 'eng', async () => page);
    expect(peekSelectionCache(key, 1, 0, 'eng')).toBeNull();
  });
});
