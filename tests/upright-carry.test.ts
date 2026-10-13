// A document that replaces another for a path is told the pages the replaced
// one had an upright stamp on. The mark names pages only: no stamp and no
// record of the replaced bytes reaches the new document. A read of the
// upright stamps that is pending on a document settles when the cache
// destroys the document.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({
  loadDocument: vi.fn(),
}));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import * as cache from '../src/renderer/lib/pdfDocCache';
import { contentKeyOf, contentKeyOfPlaced, evictExcept, getDocumentProxy } from '../src/renderer/lib/pdfDocCache';
import {
  NO_UPRIGHT_STAMPS, readUprightStamps, recordUprightStamps, subscribeUprightRecord, uprightCarried, uprightPagesOf,
  uprightRenderPlan, uprightStampsOn,
} from '../src/renderer/lib/upright-record';

const loadDocumentMock = vi.mocked(loadDocument);
const STAMP = { id: '5R', rect: [150, 250, 250, 300] as [number, number, number, number] };
const OTHER = { id: '9R', rect: [10, 10, 60, 40] as [number, number, number, number] };
const LISTED = [{ id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: STAMP.rect }];

const makeProxy = (): PDFDocumentProxy => ({ loadingTask: { destroy: vi.fn() } }) as unknown as PDFDocumentProxy;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let buffers = 0;
/** Bytes no other test has. */
const freshBytes = (): Uint8Array => Uint8Array.from([7, 7, 7, ++buffers, buffers >> 8]);
let paths = 0;
const freshPath = (): string => `C:/carry-${++paths}.pdf`;

/** A cached document whose key is bound. */
async function opened(path: string, bytes: Uint8Array): Promise<{ proxy: PDFDocumentProxy; key: string }> {
  const proxy = makeProxy();
  loadDocumentMock.mockResolvedValueOnce(proxy);
  expect(await getDocumentProxy(path, bytes)).toBe(proxy);
  const key = await contentKeyOf(proxy)!;
  await flush();
  return { proxy, key };
}

const plan = (proxy: PDFDocumentProxy, pageIndex: number): string =>
  uprightRenderPlan(uprightStampsOn(proxy, pageIndex), uprightCarried(proxy, pageIndex));

beforeEach(async () => {
  evictExcept(new Set());
  await flush();
  loadDocumentMock.mockReset();
});

describe('the document that replaces one with an upright stamp', () => {
  it('is told the pages that had a stamp, takes no stamp of the replaced bytes, and tells no listener', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    recordUprightStamps(first.key, [[], [STAMP]]);
    expect(uprightStampsOn(first.proxy, 1)).toEqual([STAMP]);

    let told = 0;
    const off = subscribeUprightRecord(() => { told++; });
    const second = await opened(path, freshBytes());
    off();
    expect(second.key).not.toBe(first.key);
    expect([0, 1].map((index) => uprightCarried(second.proxy, index))).toEqual([false, true]);
    expect([0, 1].map((index) => uprightStampsOn(second.proxy, index))).toEqual([undefined, undefined]);
    // The told page is read from the new document; the other renders at once.
    expect([0, 1].map((index) => plan(second.proxy, index))).toEqual(['plain', 'read']);
    // The only notice is the bound key of the new document.
    expect(told).toBe(1);
  });

  it('renders a told page from its own record once the index writes it, with no read', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    recordUprightStamps(first.key, [[STAMP], [STAMP]]);
    const second = await opened(path, freshBytes());
    expect(plan(second.proxy, 0)).toBe('read');
    recordUprightStamps(second.key, [[OTHER], []]);
    expect(uprightStampsOn(second.proxy, 0)).toEqual([OTHER]);
    expect([0, 1].map((index) => plan(second.proxy, index))).toEqual(['stamps', 'plain']);
  });

  it('bytes that are read before they are placed: the record is there when the key is bound', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    recordUprightStamps(first.key, [[], [STAMP]]);

    const after = freshBytes();
    // The reader of published bytes records under the key of the buffer.
    recordUprightStamps(contentKeyOfPlaced(after), [[], [OTHER]]);
    const proxy = makeProxy();
    loadDocumentMock.mockResolvedValueOnce(proxy);
    await getDocumentProxy(path, after);
    expect(contentKeyOf(proxy)).toBe(contentKeyOfPlaced(after));
    // A read of the told page waits for the key and reads nothing.
    let reads = 0;
    const stamps = await readUprightStamps(proxy, {
      pageNumber: 2,
      getAnnotations: async () => {
        reads++;
        return [];
      },
    });
    expect(stamps).toEqual([OTHER]);
    expect(reads).toBe(0);
  });

  it('hands the pages on when it is replaced before anything is known of them, loaded or not', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    recordUprightStamps(first.key, [[], [], [STAMP]]);
    const second = await opened(path, freshBytes());
    expect(uprightCarried(second.proxy, 2)).toBe(true);

    // The third document replaces the second while the fourth replaces the
    // third before the third has loaded.
    let finishThird!: (proxy: PDFDocumentProxy) => void;
    loadDocumentMock.mockReturnValueOnce(new Promise<PDFDocumentProxy>((resolve) => { finishThird = resolve; }));
    void getDocumentProxy(path, freshBytes());
    const fourth = await opened(path, freshBytes());
    finishThird(makeProxy());
    await flush();
    expect([1, 2].map((index) => uprightCarried(fourth.proxy, index))).toEqual([false, true]);
  });

  it('hands on a page whose stamp a read found, and drops a told page a read found no stamp on', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    recordUprightStamps(first.key, [[STAMP], [STAMP]]);
    const second = await opened(path, freshBytes());
    await readUprightStamps(second.proxy, { pageNumber: 1, getAnnotations: async () => LISTED });
    await readUprightStamps(second.proxy, { pageNumber: 2, getAnnotations: async () => [] });
    expect(uprightPagesOf(second.proxy)).toEqual([0]);
    const third = await opened(path, freshBytes());
    expect([0, 1].map((index) => uprightCarried(third.proxy, index))).toEqual([true, false]);
  });

  it('is told nothing when the replaced document had no upright stamp', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    recordUprightStamps(first.key, [[], []]);
    const second = await opened(path, freshBytes());
    expect([0, 1].map((index) => uprightCarried(second.proxy, index))).toEqual([false, false]);
  });

  it('is told nothing when it is the first document of a path', async () => {
    const first = await opened(freshPath(), freshBytes());
    expect(uprightCarried(first.proxy, 0)).toBe(false);
  });

  it('has no wait to end: the cache exports no settle step', () => {
    expect(Object.keys(cache).filter((name) => /settle|await/i.test(name))).toEqual([]);
  });
});

describe('a read of the upright stamps that is pending when the cache destroys its document', () => {
  it('settles with no upright stamp', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    let reads = 0;
    const read = readUprightStamps(first.proxy, {
      pageNumber: 4,
      getAnnotations: () => {
        reads++;
        return new Promise<unknown[]>(() => {});
      },
    });
    expect(reads).toBe(1);
    await opened(path, freshBytes());
    expect(await read).toBe(NO_UPRIGHT_STAMPS);
  });

  it('a document that is closed does the same', async () => {
    const path = freshPath();
    const first = await opened(path, freshBytes());
    const read = readUprightStamps(first.proxy, { pageNumber: 1, getAnnotations: () => new Promise<unknown[]>(() => {}) });
    evictExcept(new Set());
    expect(await read).toBe(NO_UPRIGHT_STAMPS);
  });
});

describe('the content key of a buffer that is placed', () => {
  it('is one promise per buffer object, and the key the cache gives the document', async () => {
    const bytes = freshBytes();
    const key = contentKeyOfPlaced(bytes);
    expect(contentKeyOfPlaced(bytes)).toBe(key);
    const { proxy } = await opened(freshPath(), bytes);
    expect(contentKeyOf(proxy)).toBe(key);
    expect(contentKeyOfPlaced(Uint8Array.from(bytes))).not.toBe(key);
    expect(await contentKeyOfPlaced(Uint8Array.from(bytes))).toBe(await key);
  });
});
