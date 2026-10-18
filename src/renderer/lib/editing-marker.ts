import { editsText } from './text-controls';

// The text field the user is editing paints its own selection; every other
// field paints none (styles.css, the selection policy). `:focus` alone cannot
// tell them apart: it stops matching while the window is inactive, although
// the field keeps the document's focus and its selection. The field therefore
// carries this attribute from the focus it receives until the document's focus
// leaves it.
export const EDITING_ATTRIBUTE = 'data-editing';

interface MarkerElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface Listeners {
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
}

/**
 * Keeps {@link EDITING_ATTRIBUTE} on the one text field that holds the
 * document's focus. A window that loses focus fires `focusout` on the field
 * but leaves it as the active element, so the mark stays. A focus change
 * inside the page moves the mark, and while the window is inactive, when the
 * page fires no focus events, the mark is checked again when the window is
 * focused. Returns the uninstaller. One install per realm: each window runs
 * its own.
 */
export function installEditingMarker(
  doc: Listeners & { readonly activeElement: unknown },
  win: Listeners,
  defer: (task: () => void) => void = queueMicrotask,
): () => void {
  let marked: MarkerElement | null = null;
  const clear = (): void => {
    marked?.removeAttribute(EDITING_ATTRIBUTE);
    marked = null;
  };
  const focusIn = (event: Event): void => {
    const target = event.target;
    if (marked !== null && (marked as unknown) !== target) clear();
    if (editsText(target)) {
      marked = target as unknown as MarkerElement;
      marked.setAttribute(EDITING_ATTRIBUTE, '');
    }
  };
  const focusOut = (event: Event): void => {
    const left = event.target;
    if (marked === null || (marked as unknown) !== left) return;
    defer(() => {
      if ((marked as unknown) === left && doc.activeElement !== left) clear();
    });
  };
  const windowFocus = (): void => {
    if (marked !== null && doc.activeElement !== marked) clear();
  };
  doc.addEventListener('focusin', focusIn, true);
  doc.addEventListener('focusout', focusOut, true);
  win.addEventListener('focus', windowFocus);
  return () => {
    doc.removeEventListener('focusin', focusIn, true);
    doc.removeEventListener('focusout', focusOut, true);
    win.removeEventListener('focus', windowFocus);
    clear();
  };
}
