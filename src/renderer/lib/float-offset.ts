// Where a bar that floats over the canvas sits when the user has moved it.
//
// The bar keeps its default slot in the layout and is moved by a translation,
// so moving it never changes its width or wrapping. The offset is logical:
// `inline` is the distance moved from the slot toward the inline-start side
// of the canvas, `block` the distance moved down. A right-to-left layout
// mirrors the slot to the left edge, and the same offset mirrors with it.
// Callers pass the UI direction from `isRtlUi` (lib/inline-direction.ts).

export interface FloatOffset {
  inline: number;
  block: number;
}

/** The measured layout the offset is kept inside. Every length is in CSS
 * pixels; the slot is the bar's own box with no offset applied. */
export interface FloatBounds {
  /** The canvas view's padding box. */
  viewWidth: number;
  viewHeight: number;
  /** The chrome the view holds above and below the document region. */
  insetStart: number;
  insetEnd: number;
  /** From the view's inline-end edge to the slot's inline-end edge. */
  slotEnd: number;
  /** From the view's top edge to the slot's top edge. */
  slotTop: number;
  barWidth: number;
  barHeight: number;
}

/** Arrow-key steps for a focused grip, in CSS pixels. */
export const FLOAT_KEY_STEP = 8;
export const FLOAT_KEY_STEP_LARGE = 48;

/** A pointer must travel this far before a press becomes a move. */
export const FLOAT_DRAG_THRESHOLD = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The nearest offset that keeps the whole bar inside the document region:
 * between the view's inline edges, below the chrome above it and above the
 * chrome below it. A bar wider or taller than the region keeps its
 * inline-end edge or its top edge in view.
 */
export function clampFloatOffset(offset: FloatOffset, bounds: FloatBounds): FloatOffset {
  const inline = clamp(
    offset.inline,
    -bounds.slotEnd,
    bounds.viewWidth - bounds.barWidth - bounds.slotEnd,
  );
  const block = clamp(
    offset.block,
    bounds.insetStart - bounds.slotTop,
    bounds.viewHeight - bounds.insetEnd - bounds.barHeight - bounds.slotTop,
  );
  return { inline: inline + 0, block: block + 0 };
}

/**
 * Where the bar is drawn for the offset the user chose. The choice is kept as
 * it was made and only the drawing is clamped, so a bar pulled in by a
 * narrower canvas goes back to where the user put it when the canvas widens.
 */
export function drawnFloatOffset(intended: FloatOffset | null, bounds: FloatBounds | null): FloatOffset | null {
  if (intended === null || bounds === null) return intended;
  return clampFloatOffset(intended, bounds);
}

/** True when two measurements describe the same layout. */
export function sameFloatBounds(a: FloatBounds | null, b: FloatBounds | null): boolean {
  if (a === null || b === null) return a === b;
  return (Object.keys(a) as (keyof FloatBounds)[]).every((k) => a[k] === b[k]);
}

/** The offset after a pointer moved `dx`, `dy` screen pixels from where a
 * move started at `start`. */
export function dragFloatOffset(start: FloatOffset, dx: number, dy: number, rtl: boolean): FloatOffset {
  return { inline: start.inline + (rtl ? dx : -dx), block: start.block + dy };
}

/** The screen translation that draws `offset`. */
export function floatTranslation(offset: FloatOffset, rtl: boolean): { x: number; y: number } {
  return { x: (rtl ? offset.inline : -offset.inline) + 0, y: offset.block + 0 };
}

/** The offset after an arrow key on a focused grip; null for any other key.
 * Arrows move on screen, so Left is left in either direction. */
export function keyFloatOffset(
  start: FloatOffset,
  key: string,
  large: boolean,
  rtl: boolean,
): FloatOffset | null {
  const step = large ? FLOAT_KEY_STEP_LARGE : FLOAT_KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return dragFloatOffset(start, -step, 0, rtl);
    case 'ArrowRight':
      return dragFloatOffset(start, step, 0, rtl);
    case 'ArrowUp':
      return dragFloatOffset(start, 0, -step, rtl);
    case 'ArrowDown':
      return dragFloatOffset(start, 0, step, rtl);
    default:
      return null;
  }
}

/** The bounds of a bar laid out inside `view` with a direction of `rtl`.
 * `offsetLeft` and `offsetTop` ignore the translation, so this reads the slot
 * whether or not the bar is moved. */
export function measureFloatBounds(
  bar: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number },
  view: { clientWidth: number; clientHeight: number },
  insets: { start: number; end: number },
  rtl: boolean,
): FloatBounds {
  return {
    viewWidth: view.clientWidth,
    viewHeight: view.clientHeight,
    insetStart: insets.start,
    insetEnd: insets.end,
    slotEnd: rtl ? bar.offsetLeft : view.clientWidth - (bar.offsetLeft + bar.offsetWidth),
    slotTop: bar.offsetTop,
    barWidth: bar.offsetWidth,
    barHeight: bar.offsetHeight,
  };
}
