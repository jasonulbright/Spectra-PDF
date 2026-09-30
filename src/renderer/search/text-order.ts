// Reading order of pdf.js text-content items across text orientations,
// matching the engine's `_partition` + part ordering in
// src/engine/extract_text.py. Items of one orientation keep content-stream
// order; orientations read by descending character count, then ascending
// device angle, then unreflected before reflected. A page whose text has one
// orientation returns its items unchanged.

export const AXIS_TOLERANCE = 3;
export const CHAIN_TOLERANCE = 8;
export const MIN_ORIENTED_CHARS = 3;

export interface OrientedItem {
  str: string;
  hasEOL?: boolean;
  transform?: readonly number[];
}

/** Device-space angle in degrees counter-clockwise in [0, 360), and whether
 * the glyph space is reflected. pdf.js item transforms exclude the page's
 * /Rotate (the viewport applies it), and /Rotate turns the page clockwise
 * (ISO 32000-2 §7.7.3.3), so it is subtracted to reach the engine's angle. */
export function itemOrientation(item: OrientedItem, pageRotate = 0): { angle: number; reflected: boolean } {
  const m = item.transform;
  if (!m || m.length < 4) return { angle: mod360(-pageRotate), reflected: false };
  const [a, b, c, d] = m;
  if (![a, b, c, d].every(Number.isFinite) || (a === 0 && b === 0))
    return { angle: mod360(-pageRotate), reflected: false };
  const angle = mod360((Math.atan2(b, a) * 180) / Math.PI - pageRotate);
  return { angle, reflected: a * d - b * c < 0 };
}

function mod360(x: number): number {
  const r = x % 360;
  return r < 0 ? r + 360 : r + 0;
}

/** Characters an item contributes to its orientation's count, in Unicode
 * scalars: the engine counts each drawn glyph by the scalars its /ToUnicode
 * entry maps to, spaces included, so one glyph mapped to several scalars
 * counts each on both paths. pdf.js keeps drawn spaces inside
 * a run's string but emits the spaces it infers from glyph gaps as items of
 * their own, which draw nothing; a whitespace-only item counts zero. */
function charCount(str: string): number {
  if (str.trim().length === 0) return 0;
  return Array.from(str).length;
}

function circularMean(angles: number[]): number {
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos((a * Math.PI) / 180);
    y += Math.sin((a * Math.PI) / 180);
  }
  return Math.round(mod360((Math.atan2(y, x) * 180) / Math.PI) * 1e6) / 1e6;
}

interface Part {
  angle: number;
  reflected: boolean;
  indices: number[];
  chars: number;
}

/** Item indices grouped by orientation and ordered for reading. */
export function orientationOrder(items: readonly OrientedItem[], pageRotate = 0): number[][] {
  const parts = new Map<string, Part>();
  const partFor = (angle: number, reflected: boolean): Part => {
    const key = `${angle}|${reflected ? 1 : 0}`;
    let p = parts.get(key);
    if (!p) {
      p = { angle, reflected, indices: [], chars: 0 };
      parts.set(key, p);
    }
    return p;
  };
  const loose = new Map<boolean, Array<{ angle: number; index: number }>>();
  const orient: Array<{ angle: number; reflected: boolean }> = [];
  items.forEach((it, index) => {
    // An empty item marks a line end and carries whatever matrix is current
    // there, so it reads with the text it ends.
    orient.push(
      it.str.length === 0 && index > 0 ? orient[index - 1] : itemOrientation(it, pageRotate),
    );
  });
  items.forEach((_it, index) => {
    const { angle, reflected } = orient[index];
    const axis = mod360(Math.round(angle / 90) * 90);
    const off = Math.abs(mod360(angle - axis + 180) - 180);
    if (off <= AXIS_TOLERANCE) partFor(axis, reflected).indices.push(index);
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
      const n = members.reduce((s, i) => s + charCount(items[i].str), 0);
      if (n < MIN_ORIENTED_CHARS) {
        strays.push(...members);
        continue;
      }
      partFor(circularMean(chain.map((e) => e.angle)), reflected).indices.push(...members);
    }
  }
  if (strays.length > 0) partFor(0, false).indices.push(...strays);
  const list = [...parts.values()];
  for (const p of list) {
    p.indices.sort((i, j) => i - j);
    p.chars = p.indices.reduce((s, i) => s + charCount(items[i].str), 0);
  }
  list.sort(
    (p, q) =>
      q.chars - p.chars || p.angle - q.angle || Number(p.reflected) - Number(q.reflected),
  );
  return list.map((p) => p.indices);
}

/** Page text in reading order: each item's string, a newline after an item
 * that ends a line, and a newline between orientations. */
export function orderedPageText(items: readonly OrientedItem[], pageRotate = 0): string {
  const groups = orientationOrder(items, pageRotate);
  let text = '';
  for (const group of groups) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    for (const i of group) {
      text += items[i].str;
      if (items[i].hasEOL) text += '\n';
    }
  }
  return text;
}

export type ReadingStep = { kind: 'item'; index: number } | { kind: 'break' };

/** The text layer's node sequence in reading order: each item, a break after
 * an item that ends a line, and a break between orientations — the same
 * boundaries `orderedPageText` writes as newlines. Null when the reading order
 * is content-stream order, so an upright page keeps its layer untouched. */
export function readingSequence(items: readonly OrientedItem[], pageRotate = 0): ReadingStep[] | null {
  const groups = orientationOrder(items, pageRotate);
  if (groups.length <= 1) return null;
  const steps: ReadingStep[] = [];
  for (const group of groups) {
    const last = steps[steps.length - 1];
    if (last && last.kind !== 'break') steps.push({ kind: 'break' });
    for (const index of group) {
      steps.push({ kind: 'item', index });
      if (items[index].hasEOL) steps.push({ kind: 'break' });
    }
  }
  return steps;
}
