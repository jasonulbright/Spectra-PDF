// Reading order of pdf.js text-content items across text orientations: the
// rule src/engine/reading_order.py applies to the engine's text, held to one
// table by tests/fixtures/reading-order-corpus.json. An item reads in the
// direction its pen advances — the glyph x axis of its transform, or the
// glyph -y axis for an item a vertical-writing font drew (pdf.js gives those
// `dir: 'ttb'`) — less the page's /Rotate. Items partition by that direction
// (`partition`); parts read by descending character count, then ascending
// display angle, then unreflected before reflected. A part upright in its own
// user space keeps content-stream order; every other part reads as lines of
// its own frame (`clusterLines`). A page whose text is all upright in user
// space returns its items unchanged.

export const AXIS_TOLERANCE = 3;
export const CHAIN_TOLERANCE = 8;
export const MIN_ORIENTED_CHARS = 3;
export const LINE_TOL_EM = 0.12;

export interface OrientedItem {
  str: string;
  hasEOL?: boolean;
  transform?: readonly number[];
  dir?: string;
}

export interface Orientation {
  angle: number;
  reflected: boolean;
}

export interface Part<T> {
  key: Orientation;
  members: T[];
}

export interface Placed<T> {
  unit: T;
  along: number;
  across: number;
  tolerance: number;
}

export type ReadingStep = { kind: 'item'; index: number } | { kind: 'break' };

function mod360(x: number): number {
  const r = x % 360;
  return r < 0 ? r + 360 : r + 0;
}

function finite(x: number | undefined): number {
  return x !== undefined && Number.isFinite(x) ? x : 0;
}

/** The display-space direction an item's pen advances, in degrees
 * counter-clockwise in [0, 360), and whether its glyph space is reflected.
 * pdf.js item transforms are in user space, and /Rotate turns the page
 * clockwise for display (ISO 32000-2 §7.7.3.3), so it is subtracted. */
export function itemOrientation(item: OrientedItem, pageRotate = 0): Orientation {
  const level = { angle: mod360(-pageRotate), reflected: false };
  const m = item.transform;
  if (!m || m.length < 4) return level;
  const [a, b, c, d] = m;
  if (![a, b, c, d].every(Number.isFinite)) return level;
  const [vx, vy] = item.dir === 'ttb' ? [-c, -d] : [a, b];
  if (vx === 0 && vy === 0) return level;
  return { angle: mod360((Math.atan2(vy, vx) * 180) / Math.PI - pageRotate), reflected: a * d - b * c < 0 };
}

/** The user-space frame of the display orientation `key`. */
export function userFrame(key: Orientation, pageRotate: number): Orientation {
  return { angle: mod360(key.angle + pageRotate), reflected: key.reflected };
}

const QUARTER = new Map<number, readonly [number, number]>([
  [0, [1, 0]],
  [90, [0, 1]],
  [180, [-1, 0]],
  [270, [0, -1]],
]);

/** (x, y) in the frame where text of orientation `frame` advances along +x
 * with its glyph tops up: rotated by -angle, then mirrored top to bottom when
 * the glyph space is reflected. Axis frames map with exact cosines. */
export function toFramePoint(x: number, y: number, frame: Orientation): [number, number] {
  const t = (frame.angle * Math.PI) / 180;
  const [cos, sin] = QUARTER.get(frame.angle) ?? [Math.cos(t), Math.sin(t)];
  const u = x * cos + y * sin;
  const v = -x * sin + y * cos;
  return [u, frame.reflected ? -v : v];
}

function circularMean(angles: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos((a * Math.PI) / 180);
    y += Math.sin((a * Math.PI) / 180);
  }
  return Math.round(mod360((Math.atan2(y, x) * 180) / Math.PI) * 1e6) / 1e6;
}

/** `items` grouped by orientation, in reading order of the groups, each group
 * keeping the input order of its members. An angle within `AXIS_TOLERANCE` of
 * a multiple of 90 is that multiple; other angles of one reflection chain
 * around the circle while neighbours lie within `CHAIN_TOLERANCE`, and a chain
 * reads in the frame of its mean angle; a chain weighing under
 * `MIN_ORIENTED_CHARS` joins the upright group. */
export function partition<T>(
  items: readonly T[],
  keyOf: (item: T) => Orientation,
  weightOf: (item: T) => number,
): Part<T>[] {
  const parts = new Map<string, { key: Orientation; indices: number[] }>();
  const add = (key: Orientation, indices: number[]): void => {
    const id = `${key.angle}|${key.reflected ? 1 : 0}`;
    const part = parts.get(id);
    if (part) part.indices.push(...indices);
    else parts.set(id, { key, indices: [...indices] });
  };
  const loose = new Map<boolean, Array<{ angle: number; index: number }>>();
  items.forEach((item, index) => {
    const { angle, reflected } = keyOf(item);
    const axis = mod360(Math.round(angle / 90) * 90);
    if (Math.abs(mod360(angle - axis + 180) - 180) <= AXIS_TOLERANCE) add({ angle: axis, reflected }, [index]);
    else {
      const list = loose.get(reflected) ?? [];
      list.push({ angle, index });
      loose.set(reflected, list);
    }
  });
  const strays: number[] = [];
  for (const reflected of [false, true]) {
    const entries = loose.get(reflected);
    if (!entries) continue;
    entries.sort((p, q) => p.angle - q.angle || p.index - q.index);
    const chains = [[entries[0]]];
    for (const entry of entries.slice(1)) {
      const last = chains[chains.length - 1];
      if (entry.angle - last[last.length - 1].angle <= CHAIN_TOLERANCE) last.push(entry);
      else chains.push([entry]);
    }
    if (chains.length > 1 && entries[0].angle + 360 - entries[entries.length - 1].angle <= CHAIN_TOLERANCE) {
      chains[0] = [...(chains.pop() ?? []), ...chains[0]];
    }
    for (const chain of chains) {
      const members = chain.map((e) => e.index);
      if (members.reduce((s, i) => s + weightOf(items[i]), 0) < MIN_ORIENTED_CHARS) {
        strays.push(...members);
        continue;
      }
      add({ angle: circularMean(chain.map((e) => e.angle)), reflected }, members);
    }
  }
  if (strays.length > 0) add({ angle: 0, reflected: false }, strays);
  const grouped = [...parts.values()].map(({ key, indices }) => {
    const members = [...indices].sort((i, j) => i - j).map((i) => items[i]);
    return { key, members, weight: members.reduce((s, m) => s + weightOf(m), 0) };
  });
  grouped.sort(
    (p, q) => q.weight - p.weight || p.key.angle - q.key.angle || Number(p.key.reflected) - Number(q.key.reflected),
  );
  return grouped.map(({ key, members }) => ({ key, members }));
}

/** Units of one frame grouped into lines and ordered for reading. A unit
 * joins the first line whose first unit lies within the larger of the two
 * tolerances across; lines read in descending across (top to bottom in the
 * frame) and units within a line in ascending along. */
export function clusterLines<T>(placed: readonly Placed<T>[]): Placed<T>[][] {
  const clusters: Placed<T>[][] = [];
  for (const entry of [...placed].sort((p, q) => q.across - p.across)) {
    const line = clusters.find((c) => Math.abs(entry.across - c[0].across) <= Math.max(c[0].tolerance, entry.tolerance));
    if (line) line.push(entry);
    else clusters.push([entry]);
  }
  const lines = clusters.map((c) => [...c].sort((p, q) => p.along - q.along));
  const top = (line: Placed<T>[]): number => line.reduce((max, p) => Math.max(max, p.across), -Infinity);
  return lines.sort((p, q) => top(q) - top(p));
}

/** Characters an item contributes to its orientation's count, in Unicode
 * scalars: the engine counts each drawn glyph by the scalars its /ToUnicode
 * entry maps to, spaces included. pdf.js keeps drawn spaces inside a run's
 * string but emits the spaces it infers from glyph gaps as items of their
 * own, which draw nothing; a whitespace-only item counts zero. */
function charCount(str: string): number {
  if (str.trim().length === 0) return 0;
  return Array.from(str).length;
}

interface Reading {
  steps: ReadingStep[];
  groups: number[][];
  reordered: boolean;
}

function read(items: readonly OrientedItem[], pageRotate: number): Reading {
  const orient: Orientation[] = [];
  items.forEach((it, index) => {
    // pdf.js emits a line-end item and an inferred space for the end of, or
    // the gap after, the item before them; neither carries a writing
    // direction of its own, so they read with that item.
    orient.push(index > 0 && it.str.trim().length === 0 ? orient[index - 1] : itemOrientation(it, pageRotate));
  });
  const indices = items.map((_it, index) => index);
  const parts = partition(indices, (i) => orient[i], (i) => charCount(items[i].str));
  const native = (key: Orientation): boolean => !key.reflected && mod360(key.angle + pageRotate) === 0;
  const steps: ReadingStep[] = [];
  const inOrder = (members: readonly number[]): void => {
    for (const index of members) {
      steps.push({ kind: 'item', index });
      if (items[index].hasEOL) steps.push({ kind: 'break' });
    }
  };
  if (parts.length <= 1 && parts.every((p) => native(p.key))) {
    inOrder(indices);
    return { steps, groups: indices.length > 0 ? [indices] : [], reordered: false };
  }
  const groups: number[][] = [];
  for (const part of parts) {
    const last = steps[steps.length - 1];
    if (last && last.kind !== 'break') steps.push({ kind: 'break' });
    if (native(part.key)) {
      inOrder(part.members);
      groups.push(part.members);
      continue;
    }
    const frame = userFrame(part.key, pageRotate);
    const placed = part.members
      .filter((index) => items[index].str.length > 0)
      .map((index): Placed<number> => {
        const m = items[index].transform ?? [];
        const [along, across] = toFramePoint(finite(m[4]), finite(m[5]), frame);
        return { unit: index, along, across, tolerance: LINE_TOL_EM * Math.max(Math.hypot(finite(m[2]), finite(m[3])), 0.01) };
      });
    const group: number[] = [];
    for (const line of clusterLines(placed)) {
      for (const { unit } of line) {
        steps.push({ kind: 'item', index: unit });
        group.push(unit);
      }
      steps.push({ kind: 'break' });
    }
    groups.push(group);
  }
  return { steps, groups, reordered: true };
}

/** Item indices per orientation part, in reading order. */
export function orientationOrder(items: readonly OrientedItem[], pageRotate = 0): number[][] {
  return read(items, pageRotate).groups;
}

/** Page text in reading order: each item's string and a newline at every
 * break `readingSequence` places. */
export function orderedPageText(items: readonly OrientedItem[], pageRotate = 0): string {
  return read(items, pageRotate)
    .steps.map((step) => (step.kind === 'break' ? '\n' : items[step.index].str))
    .join('');
}

/** The text layer's node sequence in reading order: each item, and a break
 * after a line and between orientations — the boundaries `orderedPageText`
 * writes as newlines. Null when the reading order is content-stream order, so
 * a page upright in user space keeps its layer untouched. */
export function readingSequence(items: readonly OrientedItem[], pageRotate = 0): ReadingStep[] | null {
  const reading = read(items, pageRotate);
  return reading.reordered ? reading.steps : null;
}
