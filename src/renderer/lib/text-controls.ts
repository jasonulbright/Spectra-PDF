const TEXTLESS_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image',
]);

/** A form control with no text of its own to select: a select, or an input
 * that is not a text entry. */
export function holdsNoText(el: EventTarget | null): boolean {
  const n = el as HTMLInputElement | null;
  if (!n || !n.tagName) return false;
  if (n.tagName === 'SELECT') return true;
  return n.tagName === 'INPUT' && TEXTLESS_INPUT_TYPES.has(String(n.type ?? '').toLowerCase());
}

/** The element a user types text into: a text-entry input, a textarea, or a
 * contenteditable editing host. */
export function editsText(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  if (n.tagName === 'TEXTAREA') return true;
  if (n.tagName === 'INPUT') return !holdsNoText(n);
  return n.isContentEditable === true;
}
