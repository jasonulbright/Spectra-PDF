import type { PageAnnotation } from '../state/types';

/** What the user changed on an imported annotation since its import. */
export interface ImportedEdit {
  /** `moved`: every coordinate moved by one distance and the size is the
   *  same. `reshaped`: any other change of the box, a point or a quad. */
  geometry: 'same' | 'moved' | 'reshaped';
  /** The box as imported, in the frame the current box is in. */
  from: { x: number; y: number; w: number; h: number };
  text: boolean;
  color: boolean;
  /** Any other entry the commit reads. */
  style: boolean;
}

const EPSILON = 1e-9;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return near(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!sameValue(left[key], right[key])) return false;
    return true;
  }
  return false;
}

/** Whether `now` is `then` with `dx` added to each x and `dy` to each y. */
function shifted(now: readonly number[] | undefined, then: readonly number[] | undefined, dx: number, dy: number): boolean {
  if (now === undefined || then === undefined) return now === then;
  return now.length === then.length && now.every((value, i) => near(value, then[i] + (i % 2 === 0 ? dx : dy)));
}

const GEOMETRY = new Set(['x', 'y', 'w', 'h', 'points', 'strokes', 'quads', 'calloutBox']);
const NOT_COMPARED = new Set(['id', 'importedOriginal', 'importedState', 'geometryDiverged', 'baked', 'note', 'color', 'carriedAppearance', 'originalAppearance']);

/** The kinds whose note is the comment alone: the build derives no other
 *  entry and no drawing from it. */
export const COMMENT_KINDS: ReadonlySet<PageAnnotation['kind']> = new Set(['note', 'textmarkup', 'ink', 'shape', 'highlight']);

/** The edit of an imported annotation, read against the state the import
 *  recorded. Null for an annotation with no recorded state. */
export function importedEdit(a: PageAnnotation): ImportedEdit | null {
  const then = a.importedState;
  if (!a.importedOriginal || !then) return null;
  const dx = a.x - then.x, dy = a.y - then.y;
  const still = near(dx, 0) && near(dy, 0);
  const sized = near(a.w, then.w) && near(a.h, then.h);
  const box = a.calloutBox, boxThen = then.calloutBox;
  const carried = sized
    && shifted(a.points, then.points, dx, dy)
    && shifted(a.quads, then.quads, dx, dy)
    && (a.strokes === undefined || then.strokes === undefined
      ? a.strokes === then.strokes
      : a.strokes.length === then.strokes.length && a.strokes.every((stroke, i) => shifted(stroke, then.strokes![i], dx, dy)))
    && (box === undefined || boxThen === undefined
      ? box === boxThen
      : shifted(box.slice(0, 2), boxThen.slice(0, 2), dx, dy) && near(box[2], boxThen[2]) && near(box[3], boxThen[3]));
  const now = a as unknown as Record<string, unknown>, before = then as unknown as Record<string, unknown>;
  let style = false;
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
    if (GEOMETRY.has(key) || NOT_COMPARED.has(key)) continue;
    if (!sameValue(now[key], before[key])) style = true;
  }
  return {
    geometry: !carried ? 'reshaped' : still ? 'same' : 'moved',
    from: { x: then.x, y: then.y, w: then.w, h: then.h },
    text: (a.note ?? '') !== (then.note ?? ''),
    color: a.color !== then.color,
    style,
  };
}

export const editIsNone = (edit: ImportedEdit | null | undefined): boolean =>
  !!edit && edit.geometry === 'same' && !edit.text && !edit.color && !edit.style;

/** Whether a change of size of `a` keeps the appearance of its original,
 *  scaled into the new rectangle: a viewer maps the appearance box onto /Rect
 *  (ISO 32000-2 12.5.5, algorithm 8.1). It holds for an imported free text
 *  that is no callout and whose text the commit cannot draw again as it was
 *  (`textRedraw.refusal`, or no record at all). */
function scalesAppearance(a: PageAnnotation): boolean {
  return a.kind === 'freetext' && (a.textRedraw === undefined || a.textRedraw.refusal !== undefined);
}

/** Whether a change of size of `a` keeps the appearance of its original:
 *  `scalesAppearance`, and the text, the colour and the style as imported.
 *  Such a change keeps the aspect ratio of the original (`withUniformScale`). */
export function resizeKeepsAppearance(a: PageAnnotation): boolean {
  if (!scalesAppearance(a) || a.baked || !a.originalAppearance || a.importedOriginal?.hasAppearance !== true) return false;
  const edit = importedEdit(a);
  return !!edit && !edit.text && !edit.color && !edit.style;
}

/** Whether the commit keeps the appearance of `a` scaled into its new
 *  rectangle: `resizeKeepsAppearance` and a changed size. */
export function keepsScaledAppearance(a: PageAnnotation): boolean {
  return resizeKeepsAppearance(a) && importedEdit(a)!.geometry === 'reshaped';
}

/**
 * `next`, the annotation `a` with a new box, held to the aspect ratio of the
 * original when the commit keeps the original's appearance scaled into the
 * box: a kept appearance scales by one factor, so its glyphs are never
 * stretched. The side the edit changed more gives the factor. An edge the
 * edit left in place stays in place; with none, or both, the centre stays.
 * Any other `next` is answered as it is.
 */
export function withUniformScale(a: PageAnnotation, next: PageAnnotation): PageAnnotation {
  const then = next.importedState;
  if (!then || !(then.w > 0) || !(then.h > 0) || !keepsScaledAppearance(next)) return next;
  const sx = next.w / then.w, sy = next.h / then.h;
  if (Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy)) return next;
  const scale = Math.abs(sx - a.w / then.w) >= Math.abs(sy - a.h / then.h) ? sx : sy;
  const w = then.w * scale, h = then.h * scale;
  const placed = (start: number, size: number, startBefore: number, sizeBefore: number, sized: number): number => {
    const low = near(start, startBefore), high = near(start + size, startBefore + sizeBefore);
    if (low && !high) return start;
    if (high && !low) return start + size - sized;
    return start + (size - sized) / 2;
  };
  return { ...next, x: placed(next.x, next.w, a.x, a.w, w), y: placed(next.y, next.h, a.y, a.h, h), w, h };
}

/** A kept appearance on the canvas: the move of its rectangle, and the
 *  factors its width and height grow by. */
export interface KeptAppearance { dx: number; dy: number; sx?: number; sy?: number }

/**
 * The place of an imported annotation whose appearance the commit keeps as
 * its original wrote it, display-normalized in the frame of the annotation;
 * null when the commit draws the annotation again, when it has no appearance,
 * and for a stamp. The rule is the model's side of the build's
 * `keepsAppearance` and `scaledOriginal`: no change of style or colour, a new
 * text only where the appearance does not draw the text, and a change of
 * shape only where the appearance is scaled (`scalesAppearance`).
 *
 * `dragged` is the box of a move or a resize in progress.
 */
export function keptAppearanceMove(
  a: PageAnnotation, dragged?: { x: number; y: number; w: number; h: number },
): KeptAppearance | null {
  const then = a.importedState;
  if (!then || !a.originalAppearance || a.importedOriginal?.hasAppearance !== true || a.kind === 'stamp' || a.baked) return null;
  const edit = importedEdit(a);
  if (!edit) return null;
  if (edit.style || edit.color) return null;
  if (edit.text && (!COMMENT_KINDS.has(a.kind) || a.originalAppearance.drawsText)) return null;
  const scales = !edit.text && scalesAppearance(a) && then.w > 0 && then.h > 0;
  if (edit.geometry === 'reshaped' && !scales) return null;
  const box = dragged ?? a;
  const sized = Math.abs(box.w - then.w) <= 1e-6 && Math.abs(box.h - then.h) <= 1e-6;
  if (!sized && !scales) return null;
  return { dx: box.x - then.x, dy: box.y - then.y, ...(sized ? {} : { sx: box.w / then.w, sy: box.h / then.h }) };
}

/** The annotation with the state of its import recorded on it. */
export function withImportedState(a: PageAnnotation): PageAnnotation {
  const { id: _id, importedOriginal: _original, importedState: _state, geometryDiverged: _diverged, baked: _baked, ...state } = a;
  return { ...a, importedState: state };
}

/** A PDF date string (ISO 32000-2 7.9.4) in UTC. */
export function pdfDate(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}
