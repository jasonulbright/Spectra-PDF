// The page context menu, factored out of WorkspaceCanvasView (Phase 4 M3) so
// the canvas board and the nav-pane Pages panel share ONE definition — the
// § 3.2 "same menu, same code" promise. A pure builder over (docs, target,
// selection, dispatch, callbacks) returning MenuItem[]; behavior is identical
// to the inline version it replaced (Open / Rotate CW/CCW / Extract Text /
// Delete, with the same multi-select and empties-a-file guards).
import type { AppAction, OpenDocument } from '../state/types';
import type { MenuItem } from '../components/ContextMenu';
import { workspacePageNumber } from './workspace-commit';

export interface PageMenuDeps {
  docs: OpenDocument[];
  docId: string;
  pageId: string;
  selectedPageIds: ReadonlySet<string>;
  dispatch: (action: AppAction) => void;
  /** Open the page (inspector / document view) — 1-based workspace page. */
  onOpen: (path: string, pageNumber: number) => void;
  /** Jump to Extract Text with the page pre-selected — 1-based workspace page. */
  onExtractText: (path: string, pageNumber: number) => void;
}

export function buildPageContextMenu(deps: PageMenuDeps): MenuItem[] {
  const { docs, docId, pageId, selectedPageIds, dispatch, onOpen, onExtractText } = deps;
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return [];

  const fileHasOnePage =
    docs.filter((d) => d.path === doc.path).reduce((sum, d) => sum + d.pages.length, 0) <= 1;
  // A right-click on a page that's part of a multi-selection makes the menu
  // act on the whole selection (delete/rotate as one undo step).
  const multi = selectedPageIds.size > 1 && selectedPageIds.has(pageId);
  const selCount = selectedPageIds.size;
  const selectionIds = (): string[] => [...selectedPageIds];

  // Disable a multi-delete that would empty any file (the reducer rejects such
  // a batch atomically — disabling makes that visible up front).
  const multiDeleteEmpties = (): boolean => {
    const sel = new Map<string, number>();
    const tot = new Map<string, number>();
    for (const d of docs) {
      tot.set(d.path, (tot.get(d.path) ?? 0) + d.pages.length);
      for (const p of d.pages)
        if (selectedPageIds.has(p.id)) sel.set(d.path, (sel.get(d.path) ?? 0) + 1);
    }
    for (const [path, n] of sel) if (n >= (tot.get(path) ?? 0)) return true;
    return false;
  };

  const rotateSingle = (delta: 90 | 270): void => {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return;
    const rotation = ((((page.rotation + delta) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    dispatch({ type: 'ROTATE_PAGE_REF', docId, pageId, rotation });
  };

  return [
    {
      label: 'Open',
      onClick: () => {
        const pageNumber = workspacePageNumber(docs, doc, pageId);
        if (pageNumber != null) onOpen(doc.path, pageNumber);
      },
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: multi ? `Rotate ${selCount} pages right 90°` : 'Rotate right 90°',
      onClick: () =>
        multi
          ? dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: selectionIds(), delta: 90 })
          : rotateSingle(90),
    },
    {
      label: multi ? `Rotate ${selCount} pages left 90°` : 'Rotate left 90°',
      onClick: () =>
        multi
          ? dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: selectionIds(), delta: 270 })
          : rotateSingle(270),
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: 'Extract text…',
      onClick: () => {
        const pageNumber = workspacePageNumber(docs, doc, pageId);
        if (pageNumber != null) onExtractText(doc.path, pageNumber);
      },
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: multi ? `Delete ${selCount} pages` : 'Delete page',
      danger: true,
      // A file's last page can't be deleted (0-page PDFs can't exist) — closing
      // the file is the right gesture. For a multi-delete, disable only when the
      // batch would empty a whole file.
      disabled: multi ? multiDeleteEmpties() : fileHasOnePage,
      // Clear the selection after deleting (mirrors document.deleteSelection):
      // the deleted ids would otherwise linger and could re-bind to a different
      // page on the next commit.
      onClick: () => {
        if (multi) {
          dispatch({ type: 'DELETE_PAGE_REFS', pageIds: selectionIds() });
        } else {
          dispatch({ type: 'DELETE_PAGE_REF', docId, pageId });
        }
        dispatch({ type: 'UI_CLEAR_SELECTION' });
      },
    },
  ];
}
