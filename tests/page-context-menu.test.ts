// The shared page context menu — the builder extracted
// from WorkspaceCanvasView. Same items/guards as the inline version it
// replaced: Open / Rotate CW/CCW / Extract Text / Delete, with the
// multi-select labels and empties-a-file disabling.
import { describe, expect, it, vi } from 'vitest';
import { buildPageContextMenu } from '../src/renderer/lib/page-context-menu';
import type { AppAction, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';

function makeFile(path: string): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount: 3, buffer: [1],
    dirty: false, undoStack: [], redoStack: [],
  };
}
function makePages(path: string, count: number): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${path}#p${i}`, sourceDocId: path, sourcePageIndex: i,
    rotation: 0 as const, width: 300, height: 400,
  }));
}
function makeDoc(path: string, count: number): OpenDocument {
  return { ...makeFile(path), id: `${path}#0`, pages: makePages(path, count), pageCount: count };
}

const labels = (items: ReturnType<typeof buildPageContextMenu>) =>
  items.filter((i) => !i.separator).map((i) => i.label);

/** The gated items ask the signed-document gate before dispatching, so the
 * dispatch lands a turn later than the click. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('buildPageContextMenu', () => {
  const doc = makeDoc('a.pdf', 3);
  const base = {
    docs: [doc],
    docId: doc.id,
    pageId: 'a.pdf#p1',
    confirmPageEdit: async (): Promise<boolean> => true,
    onOpen: vi.fn(),
    onExtractText: vi.fn(),
  };

  it('single-page menu: Open / Rotate ×2 / Extract / Delete', () => {
    const items = buildPageContextMenu({ ...base, selectedPageIds: new Set(), dispatch: vi.fn() });
    expect(labels(items)).toEqual([
      'Open',
      'Rotate right 90°',
      'Rotate left 90°',
      'Extract text…',
      'Delete page',
    ]);
  });

  it('Delete is disabled when the file has one page', () => {
    const one = makeDoc('a.pdf', 1);
    const items = buildPageContextMenu({
      ...base, docs: [one], docId: one.id, pageId: 'a.pdf#p0',
      selectedPageIds: new Set(), dispatch: vi.fn(),
    });
    expect(items.find((i) => i.label === 'Delete page')?.disabled).toBe(true);
  });

  it('multi-select menu labels reflect the count and act on the selection', async () => {
    const dispatch = vi.fn<(a: AppAction) => void>();
    const sel = new Set(['a.pdf#p0', 'a.pdf#p1']);
    const items = buildPageContextMenu({ ...base, selectedPageIds: sel, dispatch });
    expect(labels(items)).toContain('Rotate 2 pages right 90°');
    expect(labels(items)).toContain('Delete 2 pages');
    items.find((i) => i.label === 'Delete 2 pages')!.onClick();
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: 'DELETE_PAGE_REFS', pageIds: ['a.pdf#p0', 'a.pdf#p1'] });
    expect(dispatch).toHaveBeenCalledWith({ type: 'UI_CLEAR_SELECTION' });
  });

  it('multi-delete is disabled when it would empty a file', () => {
    const dispatch = vi.fn();
    const sel = new Set(['a.pdf#p0', 'a.pdf#p1', 'a.pdf#p2']); // all 3 pages
    const items = buildPageContextMenu({ ...base, selectedPageIds: sel, dispatch });
    expect(items.find((i) => i.label === 'Delete 3 pages')?.disabled).toBe(true);
  });

  it('single rotate dispatches ROTATE_PAGE_REF with the accumulated rotation', async () => {
    const dispatch = vi.fn<(a: AppAction) => void>();
    const items = buildPageContextMenu({ ...base, selectedPageIds: new Set(), dispatch });
    items.find((i) => i.label === 'Rotate right 90°')!.onClick();
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: 'ROTATE_PAGE_REF', docId: doc.id, pageId: 'a.pdf#p1', rotation: 90 });
  });

  // The page tier's signed-document gate — asked BEFORE the dispatch, with the
  // delta class the gesture actually produces and the files it touches.
  describe('the signed-document gate', () => {
    it('asks with page-keys for a rotate and page-structure for a delete', async () => {
      const asked: [readonly string[], string][] = [];
      const deps = {
        ...base,
        selectedPageIds: new Set<string>(),
        dispatch: vi.fn(),
        confirmPageEdit: async (paths: readonly string[], delta: string) => {
          asked.push([paths, delta]);
          return true;
        },
      };
      buildPageContextMenu(deps).find((i) => i.label === 'Rotate right 90°')!.onClick();
      buildPageContextMenu(deps).find((i) => i.label === 'Rotate left 90°')!.onClick();
      buildPageContextMenu(deps).find((i) => i.label === 'Delete page')!.onClick();
      await flush();
      expect(asked).toEqual([
        [['a.pdf'], 'page-keys'],
        [['a.pdf'], 'page-keys'],
        [['a.pdf'], 'page-structure'],
      ]);
    });

    it('a refused gate dispatches NOTHING — rotate and delete alike', async () => {
      const dispatch = vi.fn<(a: AppAction) => void>();
      const deps = {
        ...base,
        selectedPageIds: new Set<string>(),
        dispatch,
        confirmPageEdit: async (): Promise<boolean> => false,
      };
      buildPageContextMenu(deps).find((i) => i.label === 'Rotate right 90°')!.onClick();
      buildPageContextMenu(deps).find((i) => i.label === 'Delete page')!.onClick();
      await flush();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('a multi-file selection names every file it touches, once each', async () => {
      const a = makeDoc('a.pdf', 3);
      const b = makeDoc('b.pdf', 3);
      // A second document over the SAME file: its path must not repeat.
      const a2: OpenDocument = { ...a, id: 'a.pdf#1' };
      const paths: string[][] = [];
      const items = buildPageContextMenu({
        ...base,
        docs: [a, a2, b],
        docId: a.id,
        pageId: 'a.pdf#p0',
        selectedPageIds: new Set(['a.pdf#p0', 'b.pdf#p1']),
        dispatch: vi.fn(),
        confirmPageEdit: async (p: readonly string[]) => {
          paths.push([...p]);
          return true;
        },
      });
      items.find((i) => i.label === 'Delete 2 pages')!.onClick();
      await flush();
      expect(paths).toEqual([['a.pdf', 'b.pdf']]);
    });
  });

  it('Open hands over the page identity for the reading jump', () => {
    // Was (path, 1-based number) for the PageInspector; the reading pane
    // replaced it, and a jump wants the page's id.
    const onOpen = vi.fn();
    const items = buildPageContextMenu({ ...base, onOpen, selectedPageIds: new Set(), dispatch: vi.fn() });
    items.find((i) => i.label === 'Open')!.onClick();
    expect(onOpen).toHaveBeenCalledWith(base.docId, 'a.pdf#p1');
  });
});
