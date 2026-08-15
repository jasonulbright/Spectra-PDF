/**
 * On-canvas article-bead draw.
 *
 * An article thread is an ordered list of rectangles ("beads") across pages;
 * the engine (`engine/threads.py`) wants each one in PDF user space against
 * the UNROTATED page. The band arrives display-normalised (0..1 of the drawn
 * frame, y from the TOP — the frame every other banded gesture uses), so a
 * conversion sits between them, and it is here rather than in a component
 * because there is no DOM test environment: the arithmetic is where the
 * mistakes live, so the arithmetic is what gets pinned.
 *
 * The band -> user-space conversion is `crop-draw.ts`'s `pageRectFromBand`,
 * shared with link authoring rather than restated here — two implementations
 * of the quarter-turn rule is how a landscape scan gets its geometry on the
 * wrong axis.
 */

/** A bead as the engine takes it: 1-based page, rect in PDF user space. */
export interface Bead {
  page: number;
  rect: [number, number, number, number];
}

/** An article as `list_threads` reports it and `set_threads` takes it. */
export interface Article {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  beads: Bead[];
}

/** A fresh, empty article. Titles are the user's; the rest stays blank until
 * they fill it, because writing an /I entry nobody asked for makes every
 * document look authored. */
export function emptyArticle(title: string): Article {
  return { title, author: '', subject: '', keywords: '', beads: [] };
}

/** Move a bead within its article. Returns the same array when the move would
 * fall off either end, so a caller can compare identity for "nothing to do". */
export function moveBead(beads: Bead[], index: number, delta: number): Bead[] {
  const target = index + delta;
  if (index < 0 || index >= beads.length || target < 0 || target >= beads.length) return beads;
  const next = [...beads];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * The bead a next/previous step lands on. Threads are CIRCULAR — the last
 * bead's next is the first — so the walk wraps rather than stopping, which is
 * what following an article to its end actually does.
 */
export function stepBead(count: number, current: number, delta: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

/**
 * The drawn bead, from the canvas to the Articles panel.
 *
 * A module channel rather than a prop chain, for the reason `crop-draw.ts`
 * gives for the same handoff: two surfaces that do not contain each other, one
 * transient request, and no place for it in app state. Nothing is committed by
 * publishing — the panel appends the box and the user still presses Save.
 */
export interface DrawnBead extends Bead {
  /** The document the band belongs to; a stale publish must not append a box
   * to an article the user has since switched away from. */
  path: string;
}

let drawn: DrawnBead | null = null;
const beadListeners = new Set<(bead: DrawnBead) => void>();

export function publishDrawnBead(bead: DrawnBead): void {
  drawn = bead;
  for (const fn of beadListeners) fn(bead);
}

/**
 * Read the pending bead AND clear it — consume-once, the `consumeDrawnCrop`
 * rule: a panel remount must not silently re-append a box the user already
 * has.
 */
export function consumeDrawnBead(): DrawnBead | null {
  const bead = drawn;
  drawn = null;
  return bead;
}

export function subscribeDrawnBead(fn: (bead: DrawnBead) => void): () => void {
  beadListeners.add(fn);
  return () => beadListeners.delete(fn);
}

/** Test seam. */
export function __resetDrawnBead(): void {
  drawn = null;
  beadListeners.clear();
}
