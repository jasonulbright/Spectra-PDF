// Canvas whole-document merge helpers (2o).
import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import {
  buildMergedPageRefs,
  pathBlockedFromClose,
  pathReferencedByOtherDocs,
} from '../src/renderer/lib/merge-docs';
import type { AppState, OpenDocument, PageRef } from '../src/renderer/state/types';

function doc(path: string, pages: PageRef[], id = path): OpenDocument {
  return {
    id,
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: pages.length,
    buffer: null,
    dirty: false,
    undoStack: [],
    redoStack: [],
    pages,
  };
}

function page(path: string, index: number, over: Partial<PageRef> = {}): PageRef {
  return {
    id: `${path}#p${index}`,
    sourceDocId: path,
    sourcePageIndex: index,
    rotation: 0,
    width: 600,
    height: 800,
    ...over,
  };
}

describe('buildMergedPageRefs', () => {
  it('copies pages with fresh unique ids, preserving source identity and rotation', () => {
    const src = doc('b.pdf', [page('b.pdf', 0, { rotation: 90 }), page('b.pdf', 1)]);
    const copies = buildMergedPageRefs(src);
    expect(copies).toHaveLength(2);
    for (let i = 0; i < copies.length; i++) {
      expect(copies[i].id).not.toBe(src.pages[i].id);
      expect(copies[i].id.startsWith(`${src.pages[i].id}#m`)).toBe(true);
      expect(copies[i].sourceDocId).toBe('b.pdf');
      expect(copies[i].sourcePageIndex).toBe(i);
    }
    expect(copies[0].rotation).toBe(90);
    expect(new Set(copies.map((c) => c.id)).size).toBe(2);
    // Two merges of the same doc never collide either.
    const again = buildMergedPageRefs(src);
    expect(again[0].id).not.toBe(copies[0].id);
  });

  it('deep-copies annotations and tombstones (no shared references)', () => {
    const src = doc('b.pdf', [
      page('b.pdf', 0, {
        annotations: [
          {
            id: 'a1',
            kind: 'ink',
            x: 0.1,
            y: 0.1,
            w: 0.2,
            h: 0.2,
            color: '#2f6fed',
            points: [0.1, 0.1, 0.3, 0.3],
            importedOriginal: {
              subtype: 'Ink',
              rect: [10, 10, 60, 60],
              color: '#2f6fed',
              hasAppearance: true,
            },
          },
        ],
        removedImportedOriginals: [
          { subtype: 'Square', rect: [1, 2, 3, 4], color: '#ffd54a', hasAppearance: true },
        ],
      }),
    ]);
    const [copy] = buildMergedPageRefs(src);
    const orig = src.pages[0];
    expect(copy.annotations![0]).not.toBe(orig.annotations![0]);
    expect(copy.annotations![0].id).not.toBe('a1');
    expect(copy.annotations![0].points).not.toBe(orig.annotations![0].points);
    expect(copy.annotations![0].points).toEqual(orig.annotations![0].points);
    expect(copy.annotations![0].importedOriginal!.rect).not.toBe(
      orig.annotations![0].importedOriginal!.rect,
    );
    expect(copy.removedImportedOriginals![0]).not.toBe(orig.removedImportedOriginals![0]);
    expect(copy.removedImportedOriginals![0].rect).toEqual([1, 2, 3, 4]);
    // Mutating the copy must not leak back.
    copy.annotations![0].points!.push(9);
    expect(orig.annotations![0].points).toHaveLength(4);
  });

  it('omits absent optional fields rather than materializing them', () => {
    const [copy] = buildMergedPageRefs(doc('b.pdf', [page('b.pdf', 0)]));
    expect('annotations' in copy).toBe(false);
    expect('removedImportedOriginals' in copy).toBe(false);
  });
});

describe('merge-up through the real reducer (IMPORT_PAGES with copies)', () => {
  function stateWith(documents: OpenDocument[]): AppState {
    return {
      ...initialState,
      files: new Map(documents.map((d) => [d.path, { ...d, pages: undefined } as never])),
      workspace: { documents },
    };
  }

  it('one dispatch appends the copies, keeps the source strip, and is one undo step', () => {
    const a = doc('a.pdf', [page('a.pdf', 0), page('a.pdf', 1)], 'A');
    const b = doc('b.pdf', [page('b.pdf', 0, { rotation: 90 })], 'B');
    const state = stateWith([a, b]);
    const next = appReducer(state, {
      type: 'IMPORT_PAGES',
      toDocId: 'A',
      toIndex: a.pages.length,
      pages: buildMergedPageRefs(b),
    });
    const mergedA = next.workspace.documents.find((d) => d.id === 'A')!;
    const stillB = next.workspace.documents.find((d) => d.id === 'B')!;
    expect(mergedA.pages).toHaveLength(3);
    expect(mergedA.pages[2].sourceDocId).toBe('b.pdf');
    expect(mergedA.pages[2].rotation).toBe(90); // pending state travels
    expect(stillB.pages).toHaveLength(1); // source strip intact (copy, not move)
    expect(next.pageUndoStack).toHaveLength(1); // ONE undo step
    expect(next.pageDirtyPaths).toContain('a.pdf');
    // Every id in the workspace stays unique (the fresh-id requirement).
    const ids = next.workspace.documents.flatMap((d) => d.pages.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
    // The staged copy blocks closing b.pdf (referenced by a DIRTY target).
    expect(pathBlockedFromClose(next.workspace.documents, next.pageDirtyPaths, 'b.pdf')).toBe(true);

    // Undo restores both strips exactly and lifts the block.
    const undone = appReducer(next, { type: 'UNDO_PAGE_OP' });
    expect(undone.workspace.documents.find((d) => d.id === 'A')!.pages).toHaveLength(2);
    expect(pathBlockedFromClose(undone.workspace.documents, undone.pageDirtyPaths, 'b.pdf')).toBe(false);
  });
});

describe('close-guard predicates', () => {
  it('detects a foreign reference and clears once it is gone', () => {
    const a = doc('a.pdf', [page('a.pdf', 0)]);
    const b = doc('b.pdf', [page('b.pdf', 0)]);
    expect(pathReferencedByOtherDocs([a, b], 'b.pdf')).toBe(false);

    // Merge-up staged: a copy of b's page sits in a's doc.
    const merged = doc('a.pdf', [page('a.pdf', 0), page('b.pdf', 0, { id: 'b.pdf#p0#m1' })]);
    expect(pathReferencedByOtherDocs([merged, b], 'b.pdf')).toBe(true);
    // The source's own strip never counts as a foreign reference.
    expect(pathReferencedByOtherDocs([merged, b], 'a.pdf')).toBe(false);

    // Post-commit the copies re-bake to a.pdf and the reference clears.
    const rebaked = doc('a.pdf', [page('a.pdf', 0), page('a.pdf', 1)]);
    expect(pathReferencedByOtherDocs([rebaked, b], 'b.pdf')).toBe(false);
  });

  it('blocks only while the REFERENCING path is page-tier dirty', () => {
    const merged = doc('a.pdf', [page('a.pdf', 0), page('b.pdf', 0, { id: 'b.pdf#p0#m1' })]);
    const b = doc('b.pdf', [page('b.pdf', 0)]);
    // Staged (dirty target): closing the source is hazardous.
    expect(pathBlockedFromClose([merged, b], ['a.pdf'], 'b.pdf')).toBe(true);
    // Post-commit reindex window: refs linger but the tier is clean — no
    // commit can consume them and the reindex is imminent; must NOT block
    // (a spurious "Apply changes first" right after the user applied).
    expect(pathBlockedFromClose([merged, b], [], 'b.pdf')).toBe(false);
    // Dirt on an UNRELATED path doesn't block either.
    expect(pathBlockedFromClose([merged, b], ['c.pdf'], 'b.pdf')).toBe(false);
  });

  it('covers partitions of the same path (a .pdfx sibling is not foreign)', () => {
    const part1 = doc('x.pdfx', [page('x.pdfx', 0)], 'part1');
    const part2 = doc('x.pdfx', [page('x.pdfx', 1)], 'part2');
    expect(pathReferencedByOtherDocs([part1, part2], 'x.pdfx')).toBe(false);
    expect(pathBlockedFromClose([part1, part2], ['x.pdfx'], 'x.pdfx')).toBe(false);
  });
});
