// The module-level slot the mounted omnisearch box fills, so a command can
// put the caret in it (the `registerCanvasServices` idiom — the box is chrome,
// not a canvas service, so it gets its own leaf slot rather than widening
// CanvasServices with something the canvas does not own).
//
// Focusing is ONLY focusing: it opens no panel and arms no canvas mode, so
// the `openTool` invariant is untouched by this path.

type FocusFn = () => boolean;

let focusFn: FocusFn | null = null;

/** The box registers on mount and clears on unmount. */
export function registerOmniSearchFocus(fn: FocusFn | null): void {
  focusFn = fn;
}

/** Whether a box is mounted to receive the caret. */
export function omniSearchAvailable(): boolean {
  return focusFn !== null;
}

/** Put the caret in the search box. False when none is mounted. */
export function focusOmniSearch(): boolean {
  return focusFn ? focusFn() : false;
}
