// Copying text out of a document needs its copy permission (ISO 32000-2
// Table 22 bit 5, Table 24 bit 5). A workspace canvas can show pages of several
// files, so the check covers every file a selection's pages come from, and the
// file on screen when the selection names no page.
import { capabilityBlock, type CapabilityBlock } from './document-permissions';
import { documentPermissions, showableDoc } from '../state/selectors';
import type { AppState } from '../state/types';

export function copyBlock(state: AppState, pageIds: readonly string[]): CapabilityBlock | null {
  const wanted = new Set(pageIds);
  const paths = new Set<string>();
  for (const doc of state.workspace.documents) {
    for (const page of doc.pages) {
      if (wanted.has(page.id)) paths.add(page.sourceDocId);
    }
  }
  if (paths.size === 0) {
    const onScreen = showableDoc(state);
    if (onScreen) paths.add(onScreen);
  }
  for (const path of paths) {
    const block = capabilityBlock(documentPermissions(state, path), 'copy');
    if (block) return block;
  }
  return null;
}

/** The page ids whose cells a DOM selection touches. */
export function selectionPageIds(selection: Selection | null): string[] {
  if (!selection || selection.isCollapsed || typeof document === 'undefined') return [];
  const ids = new Set<string>();
  const add = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    const id = element?.closest('[data-page-id]')?.getAttribute('data-page-id');
    if (id) ids.add(id);
  };
  add(selection.anchorNode);
  add(selection.focusNode);
  for (const cell of Array.from(document.querySelectorAll('[data-page-id]'))) {
    if (selection.containsNode(cell, true)) {
      const id = cell.getAttribute('data-page-id');
      if (id) ids.add(id);
    }
  }
  return [...ids];
}
