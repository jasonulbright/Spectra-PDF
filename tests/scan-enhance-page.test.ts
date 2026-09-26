import { describe, expect, it } from 'vitest';
import { readerPage } from '../src/renderer/lib/scan-enhance';
import type { OpenDocument, PageRef } from '../src/renderer/state/types';

const page = (id: string, sourceDocId: string, sourcePageIndex: number): PageRef =>
  ({ id, sourceDocId, sourcePageIndex, rotation: 0, width: 612, height: 792 }) as PageRef;
const doc = (id: string, path: string, pages: PageRef[]): OpenDocument =>
  ({ id, path, name: id, pages }) as unknown as OpenDocument;

describe('readerPage', () => {
  const a = 'C:/a.pdf';
  const docs = [
    doc('a1', a, [page('p0', a, 0), page('p1', a, 1), page('p2', a, 2)]),
    doc('b', 'C:/b.pdf', [page('q0', 'C:/b.pdf', 0)]),
    doc('a2', a, [page('p3', a, 3), page('p4', a, 4)]),
  ];

  it('counts the pages of every earlier partition of the same file', () => {
    expect(readerPage(docs, a, 'p4')).toEqual({ apply: 5, measure: 5 });
    expect(readerPage(docs, a, 'p0')).toEqual({ apply: 1, measure: 1 });
  });

  it('measures a moved page where the current bytes hold it', () => {
    const moved = [doc('a1', a, [page('p2', a, 2), page('p0', a, 0), page('p1', a, 1)])];
    expect(readerPage(moved, a, 'p2')).toEqual({ apply: 1, measure: 3 });
  });

  it('measures nothing for a page the current bytes do not hold', () => {
    const imported = [doc('a1', a, [page('p0', a, 0), page('x0', 'C:/x.pdf', 0)])];
    expect(readerPage(imported, a, 'x0')).toEqual({ apply: 2, measure: null });
  });
});
