import { BASE_PAGE_HEIGHT, displayWidthOf, pageDisplayWidth } from '../../canvas/layout';
import type { DropTarget } from '../../canvas/layout';
import type { GhostSize } from './DropGhost';
import type { DragSource } from '../../canvas/usePageDrag';
import type { OpenDocument, PageRef } from '../../state/types';

const LETTER_PAGE = { width: 612, height: 792 };

export const LETTER_GHOST: GhostSize = {
  width: pageDisplayWidth(LETTER_PAGE.width, LETTER_PAGE.height),
  height: BASE_PAGE_HEIGHT,
};

export function pageGhostSize(page: PageRef): GhostSize {
  return { width: displayWidthOf(page), height: BASE_PAGE_HEIGHT };
}

export interface DropGhosts {
  intoDocId: string | null;
  intoIndex: number;
  betweenIndex: number;
  ghostSize: GhostSize;
  betweenPages: GhostSize[];
}

// Internal-drag variant of PDFx's deriveDropGhosts — external file drags go
// through Tauri's window-level drop (DropZone), not the canvas.
export function deriveDropGhosts(
  docs: OpenDocument[],
  draggingPage: DragSource | null,
  dropTarget: DropTarget | null,
): DropGhosts {
  const draggedEntry = draggingPage
    ? docs
        .find((d) => d.id === draggingPage.docId)
        ?.pages.find((p) => p.id === draggingPage.pageId)
    : undefined;
  const draggedSize = draggedEntry ? pageGhostSize(draggedEntry) : null;
  const intoDocId = dropTarget?.kind === 'into' ? dropTarget.docId : null;
  const intoIndex = dropTarget?.kind === 'into' ? dropTarget.index : -1;
  const betweenIndex = dropTarget?.kind === 'between' ? dropTarget.docIndex : -1;

  let ghostSize = LETTER_GHOST;
  if (draggedSize) {
    ghostSize = draggedSize;
  } else if (intoDocId) {
    const target = docs.find((d) => d.id === intoDocId);
    const ref = target?.pages[Math.min(intoIndex, target.pages.length - 1)];
    if (ref) ghostSize = pageGhostSize(ref);
  }

  return {
    intoDocId,
    intoIndex,
    betweenIndex,
    ghostSize,
    betweenPages: [draggedSize ?? LETTER_GHOST],
  };
}
