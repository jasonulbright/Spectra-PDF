// The shared page context menu (Phase 4 M3, § 3.2) — the builder extracted
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

describe('buildPageContextMenu', () => {
  const doc = makeDoc('a.pdf', 3);
  const base = {
    docs: [doc],
    docId: doc.id,
    pageId: 'a.pdf#p1',
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

  it('multi-select menu labels reflect the count and act on the selection', () => {
    const dispatch = vi.fn<(a: AppAction) => void>();
    const sel = new Set(['a.pdf#p0', 'a.pdf#p1']);
    const items = buildPageContextMenu({ ...base, selectedPageIds: sel, dispatch });
    expect(labels(items)).toContain('Rotate 2 pages right 90°');
    expect(labels(items)).toContain('Delete 2 pages');
    items.find((i) => i.label === 'Delete 2 pages')!.onClick();
    expect(dispatch).toHaveBeenCalledWith({ type: 'DELETE_PAGE_REFS', pageIds: ['a.pdf#p0', 'a.pdf#p1'] });
    expect(dispatch).toHaveBeenCalledWith({ type: 'UI_CLEAR_SELECTION' });
  });

  it('multi-delete is disabled when it would empty a file', () => {
    const dispatch = vi.fn();
    const sel = new Set(['a.pdf#p0', 'a.pdf#p1', 'a.pdf#p2']); // all 3 pages
    const items = buildPageContextMenu({ ...base, selectedPageIds: sel, dispatch });
    expect(items.find((i) => i.label === 'Delete 3 pages')?.disabled).toBe(true);
  });

  it('single rotate dispatches ROTATE_PAGE_REF with the accumulated rotation', () => {
    const dispatch = vi.fn<(a: AppAction) => void>();
    const items = buildPageContextMenu({ ...base, selectedPageIds: new Set(), dispatch });
    items.find((i) => i.label === 'Rotate right 90°')!.onClick();
    expect(dispatch).toHaveBeenCalledWith({ type: 'ROTATE_PAGE_REF', docId: doc.id, pageId: 'a.pdf#p1', rotation: 90 });
  });

  it('Open resolves the 1-based workspace page number', () => {
    const onOpen = vi.fn();
    const items = buildPageContextMenu({ ...base, onOpen, selectedPageIds: new Set(), dispatch: vi.fn() });
    items.find((i) => i.label === 'Open')!.onClick();
    expect(onOpen).toHaveBeenCalledWith('a.pdf', 2); // p1 → page 2
  });
});
