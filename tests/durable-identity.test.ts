import { beforeEach, describe, expect, it } from 'vitest';
import {
  adoptAuthoredIdentity,
  nextGeneration,
  pageIdAtSourceIndex,
  positionalDocId,
  positionalPageId,
  resetGenerations,
} from '../src/renderer/lib/durable-identity';
import type { OpenDocument, PageRef, PdfBuffer } from '../src/renderer/state/types';

function page(id: string, index: number): PageRef {
  return { id, sourceDocId: 'a.pdf', sourcePageIndex: index, rotation: 0, width: 612, height: 792 };
}

function doc(id: string, name: string, pages: PageRef[]): OpenDocument {
  return {
    id,
    name,
    path: 'a.pdf',
    workingPath: 'a.work.pdf',
    pageCount: pages.length,
    buffer: null,
    dirty: false,
    undoStack: [],
    redoStack: [],
    pages,
  };
}

beforeEach(() => resetGenerations());

describe('generation-tagged positional ids (§ F)', () => {
  it('bumps per path, independently', () => {
    expect(nextGeneration('a.pdf')).toBe(1);
    expect(nextGeneration('a.pdf')).toBe(2);
    expect(nextGeneration('b.pdf')).toBe(1);
  });

  it('THE no-stale-match property: two positional indexes of the same path never mint an overlapping id', () => {
    const g1 = nextGeneration('a.pdf');
    const g2 = nextGeneration('a.pdf');
    const first = new Set(
      Array.from({ length: 50 }, (_, i) => positionalPageId('a.pdf', g1, i)).concat(
        Array.from({ length: 5 }, (_, d) => positionalDocId('a.pdf', g1, d)),
      ),
    );
    for (let i = 0; i < 50; i++) expect(first.has(positionalPageId('a.pdf', g2, i))).toBe(false);
    for (let d = 0; d < 5; d++) expect(first.has(positionalDocId('a.pdf', g2, d))).toBe(false);
  });

  it('a path containing #g cannot collide across generations either', () => {
    // Paths are raw OS strings; the tag must not be confusable with them.
    const weird = 'C:\\odd#g1#p0\\f.pdf';
    const g1 = nextGeneration(weird);
    const g2 = nextGeneration(weird);
    expect(positionalPageId(weird, g1, 0)).not.toBe(positionalPageId(weird, g2, 0));
  });
});

describe('adoptAuthoredIdentity', () => {
  const buffer = new Uint8Array([1]) as PdfBuffer;

  it('adopts page and document ids in authored order, ids only', () => {
    const indexed = [
      doc('a.pdf#g2#0', 'A', [page('a.pdf#g2#p0', 0), page('a.pdf#g2#p1', 1)]),
    ];
    const out = adoptAuthoredIdentity(
      indexed,
      {
        buffer,
        // The user had reordered: old page ids in the NEW file order —
        // including one that migrated in from another file.
        pages: ['a.pdf#g1#p1', 'b.pdf#g1#p3'],
        documents: [{ id: 'a.pdf#g1#0', name: 'A' }],
      },
      buffer,
    );
    expect(out[0].id).toBe('a.pdf#g1#0');
    expect(out[0].pages.map((p) => p.id)).toEqual(['a.pdf#g1#p1', 'b.pdf#g1#p3']);
    // Everything else stays freshly read (position, dims).
    expect(out[0].pages.map((p) => p.sourcePageIndex)).toEqual([0, 1]);
    expect(out[0].pages[0].width).toBe(612);
  });

  it('is inert for a different buffer (a later non-authored rebuild)', () => {
    const indexed = [doc('a.pdf#g3#0', 'A', [page('a.pdf#g3#p0', 0)])];
    const out = adoptAuthoredIdentity(
      indexed,
      { buffer, pages: ['old#p0'], documents: [{ id: 'old#0', name: 'A' }] },
      new Uint8Array([2]) as PdfBuffer,
    );
    expect(out).toBe(indexed);
  });

  it('fails closed on shape mismatch (page count / doc count divergence)', () => {
    const indexed = [doc('a.pdf#g3#0', 'A', [page('a.pdf#g3#p0', 0), page('a.pdf#g3#p1', 1)])];
    expect(
      adoptAuthoredIdentity(
        indexed,
        { buffer, pages: ['only-one'], documents: [{ id: 'x', name: 'A' }] },
        buffer,
      ),
    ).toBe(indexed);
    expect(
      adoptAuthoredIdentity(
        indexed,
        { buffer, pages: ['a', 'b'], documents: [] },
        buffer,
      ),
    ).toBe(indexed);
  });

  it('adopts across multiple partitions with a running page cursor', () => {
    const indexed = [
      doc('a.pdf#g2#0', 'One', [page('a.pdf#g2#p0', 0)]),
      doc('a.pdf#g2#1', 'Two', [page('a.pdf#g2#p1', 1), page('a.pdf#g2#p2', 2)]),
    ];
    const out = adoptAuthoredIdentity(
      indexed,
      {
        buffer,
        pages: ['idA', 'idB', 'idC'],
        documents: [
          { id: 'docOne', name: 'One' },
          { id: 'docTwo', name: 'Two' },
        ],
      },
      buffer,
    );
    expect(out[0].pages.map((p) => p.id)).toEqual(['idA']);
    expect(out[1].pages.map((p) => p.id)).toEqual(['idB', 'idC']);
    expect(out.map((d) => d.id)).toEqual(['docOne', 'docTwo']);
  });
});

describe('pageIdAtSourceIndex', () => {
  it('resolves by SOURCE identity across partitions, ignoring array position', () => {
    const docs = [
      doc('x#0', 'One', [page('p-a', 0), page('p-b', 1)]),
      { ...doc('other', 'Other', [page('other-p', 0)]), path: 'other.pdf' },
      doc('x#1', 'Two', [page('p-c', 2)]),
    ];
    expect(pageIdAtSourceIndex(docs, 'a.pdf', 1)).toBe('p-a');
    expect(pageIdAtSourceIndex(docs, 'a.pdf', 3)).toBe('p-c');
    expect(pageIdAtSourceIndex(docs, 'a.pdf', 4)).toBeNull();
    expect(pageIdAtSourceIndex(docs, 'missing.pdf', 1)).toBeNull();
  });

  it('a PENDING reorder does not retarget a bookmark (review-caught HIGH)', () => {
    // Bookmark says "page 2" = on-disk index 1. The array is reordered
    // in memory (uncommitted): array-order counting would hand back the
    // page now SITTING second (p-a) — the wrong physical page.
    const reordered = [doc('x#0', 'One', [page('p-b', 1), page('p-a', 0)])];
    expect(pageIdAtSourceIndex(reordered, 'a.pdf', 2)).toBe('p-b');
  });

  it('finds a page moved into ANOTHER file by its source identity', () => {
    const docs = [
      { ...doc('b#0', 'B', [page('a-page-in-b', 3)]), path: 'b.pdf' },
    ];
    docs[0].pages[0] = { ...docs[0].pages[0], sourceDocId: 'a.pdf' };
    expect(pageIdAtSourceIndex(docs, 'a.pdf', 4)).toBe('a-page-in-b');
  });
});
