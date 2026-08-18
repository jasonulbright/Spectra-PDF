// The page context menu, factored out of WorkspaceCanvasView so
// the canvas board and the nav-pane Pages panel share ONE definition — the
// "same menu, same code" promise. A pure builder over (docs, target,
// selection, dispatch, callbacks) returning MenuItem[]; behavior is identical
// to the inline version it replaced (Open / Rotate CW/CCW / Extract Text /
// Delete, with the same multi-select and empties-a-file guards).
import type { AppAction, OpenDocument } from '../state/types';
import type { MenuItem } from '../components/ContextMenu';
import { workspacePageNumber } from './workspace-commit';
import type { PageDelta } from './page-edit-gate';
import { tChrome, tChromeCount } from '../i18n';

export interface PageMenuDeps {
  docs: OpenDocument[];
  docId: string;
  pageId: string;
  selectedPageIds: ReadonlySet<string>;
  dispatch: (action: AppAction) => void;
  /** The page tier's signed-document gate, asked BEFORE the dispatch — the
   * same instance App gives the command registry, so the board menu, the
   * Pages panel menu and the Document menu take one decision, not three.
   * Resolves false when the edit is refused or declined, and nothing is
   * dispatched. */
  confirmPageEdit: (paths: readonly string[], delta: PageDelta) => Promise<boolean>;
  /** Open the page (inspector / document view) — 1-based workspace page. */
  // "Open" = READ this page: the reading pane replaced the
  // PageInspector as the look-closely surface, and a jump wants the page's
  // id, not a file+number pair.
  onOpen: (docId: string, pageId: string) => void;
  /** Jump to Extract Text with the page pre-selected — 1-based workspace page. */
  onExtractText: (path: string, pageNumber: number) => void;
}

export function buildPageContextMenu(deps: PageMenuDeps): MenuItem[] {
  const { docs, docId, pageId, selectedPageIds, dispatch, confirmPageEdit, onOpen, onExtractText } =
    deps;
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

  /** The FILES a menu action touches — this page's file for a single-target
   * action, every file the selection spans for a multi one. A page id names
   * no document on its own and the gate decides per file. */
  const targetPaths = (multiTarget: boolean): string[] => {
    if (!multiTarget) return [doc.path];
    const paths: string[] = [];
    for (const d of docs) {
      if (paths.includes(d.path)) continue;
      if (d.pages.some((p) => selectedPageIds.has(p.id))) paths.push(d.path);
    }
    return paths;
  };

  /** Ask, then act. The gate is asked BEFORE the dispatch because the page
   * tier's write is the commit's, and a dispatch already made is an edit the
   * user would have to undo rather than one they were asked about. */
  const gated = (delta: PageDelta, multiTarget: boolean, act: () => void) => (): void => {
    void (async () => {
      if (await confirmPageEdit(targetPaths(multiTarget), delta)) act();
    })();
  };

  return [
    {
      label: tChrome('pagemenu.open'),
      onClick: () => onOpen(docId, pageId),
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: multi
        ? tChromeCount('pagemenu.rotateRightN', selCount)
        : tChrome('pagemenu.rotateRight'),
      // /Rotate is `page-keys`: a single-key appendable change, so a rotate
      // on an approval-signed document raises no dialog and keeps its
      // signature through the commit.
      onClick: gated('page-keys', multi, () =>
        multi
          ? dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: selectionIds(), delta: 90 })
          : rotateSingle(90),
      ),
    },
    {
      label: multi
        ? tChromeCount('pagemenu.rotateLeftN', selCount)
        : tChrome('pagemenu.rotateLeft'),
      onClick: gated('page-keys', multi, () =>
        multi
          ? dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: selectionIds(), delta: 270 })
          : rotateSingle(270),
      ),
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: tChrome('pagemenu.extractText'),
      onClick: () => {
        const pageNumber = workspacePageNumber(docs, doc, pageId);
        if (pageNumber != null) onExtractText(doc.path, pageNumber);
      },
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: multi ? tChromeCount('pagemenu.deleteN', selCount) : tChrome('pagemenu.deletePage'),
      danger: true,
      // A file's last page can't be deleted (0-page PDFs can't exist) — closing
      // the file is the right gesture. For a multi-delete, disable only when the
      // batch would empty a whole file.
      disabled: multi ? multiDeleteEmpties() : fileHasOnePage,
      // Clear the selection after deleting (mirrors document.deleteSelection):
      // the deleted ids would otherwise linger and could re-bind to a different
      // page on the next commit.
      // Removing a page rewrites the page TREE — `page-structure`, which no
      // certification permits and which the append carries only on an
      // approval-signed document.
      onClick: gated('page-structure', multi, () => {
        if (multi) {
          dispatch({ type: 'DELETE_PAGE_REFS', pageIds: selectionIds() });
        } else {
          dispatch({ type: 'DELETE_PAGE_REF', docId, pageId });
        }
        dispatch({ type: 'UI_CLEAR_SELECTION' });
      }),
    },
  ];
}
