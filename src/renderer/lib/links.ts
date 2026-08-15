/**
 * The link model, and the canvas→panel channel that carries a drawn one.
 *
 * A link is engine-tier, not an annotation: `engine/links.py` reads and writes
 * it, and this module is the renderer half of the SAME vocabulary — the target
 * kinds, the destination view modes and the border. Keeping the shapes here
 * rather than inside the panel is the crop-draw discipline: there is no DOM
 * test environment, so what can be pinned is a module, and the parts that go
 * wrong (a target that names nothing, a border that reads back as a different
 * border) are exactly the parts that live in one.
 */

export type LinkViewMode =
  | 'inherit'
  | 'xyz'
  | 'fit'
  | 'fith'
  | 'fitv'
  | 'fitr'
  | 'fitb'
  | 'fitbh'
  | 'fitbv';

/** A destination's view half. `inherit` is the page at the reader's own zoom —
 * a destination carrying coordinates moves the view for a reason the author
 * never stated, so it is the default a new link gets. */
export interface LinkView {
  mode: LinkViewMode;
  left?: number | null;
  top?: number | null;
  zoom?: number | null;
  bottom?: number | null;
  right?: number | null;
}

export type LinkTarget =
  | { kind: 'uri'; url: string }
  | { kind: 'goto'; page: number | null; view?: LinkView }
  | { kind: 'named'; name: string }
  | { kind: 'file'; path: string; page?: number | null; view?: LinkView; new_window?: boolean }
  | { kind: 'launch'; path: string }
  | { kind: 'other'; action: string }
  | { kind: 'none' };

/** The kinds a user can AUTHOR. `launch`, `other` and `none` are read-only:
 * the first names a program for the OS to run, and nothing here can say what
 * an unknown action does. */
export const AUTHORED_KINDS = ['uri', 'goto', 'named', 'file'] as const;
export type AuthoredKind = (typeof AUTHORED_KINDS)[number];

export const AUTHORED_STYLES = ['solid', 'dashed', 'underline'] as const;
export type LinkBorderStyle = (typeof AUTHORED_STYLES)[number] | 'beveled' | 'inset';

export const HIGHLIGHT_MODES = ['none', 'invert', 'outline', 'push'] as const;
export type LinkHighlight = (typeof HIGHLIGHT_MODES)[number];

export interface LinkAppearance {
  width: number;
  style: LinkBorderStyle;
  color: [number, number, number] | null;
  highlight: LinkHighlight;
  dashes?: number[];
}

/** One link as `list_links` reports it. */
export interface LinkRecord {
  page: number;
  index: number;
  kind: string;
  target: string;
  rect: [number, number, number, number] | null;
  target_spec: LinkTarget;
  appearance: LinkAppearance;
}

export interface NamedDestination {
  name: string;
  page: number | null;
}

/**
 * One link as `add_links` takes it: 1-based page within the file, a rect in
 * PDF user space, and a target. `url` is the URI shorthand the text-selection
 * gesture and the derived pass both use — the engine spells it out into the
 * same target, so nothing about the bytes they already write changes.
 */
export interface LinkSpec {
  page: number;
  rect: [number, number, number, number];
  url?: string;
  target?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
}

/** A new link's default border: INVISIBLE. The convention every mainstream
 * authoring tool uses — a ring drawn around a link is the author's scaffolding
 * showing through into the reader's document. */
export function defaultAppearance(): LinkAppearance {
  return { width: 0, style: 'solid', color: null, highlight: 'invert' };
}

/** The view modes that take coordinate operands, and which ones. Drives the
 * editor's fields, so a mode cannot offer a box the format has no slot for. */
export const VIEW_OPERANDS: Record<LinkViewMode, readonly ('left' | 'top' | 'zoom' | 'bottom' | 'right')[]> = {
  inherit: [],
  xyz: ['left', 'top', 'zoom'],
  fit: [],
  fith: ['top'],
  fitv: ['left'],
  fitr: ['left', 'bottom', 'right', 'top'],
  fitb: [],
  fitbh: ['top'],
  fitbv: ['left'],
};

export const VIEW_MODES = Object.keys(VIEW_OPERANDS) as LinkViewMode[];

/** A fresh target of the given kind, with every field the kind carries. */
export function emptyTarget(kind: AuthoredKind): LinkTarget {
  switch (kind) {
    case 'uri':
      return { kind: 'uri', url: '' };
    case 'goto':
      return { kind: 'goto', page: 1, view: { mode: 'inherit' } };
    case 'named':
      return { kind: 'named', name: '' };
    default:
      return { kind: 'file', path: '', page: null, view: { mode: 'inherit' } };
  }
}

/** Whether a kind can be authored — a read-only target is shown, never edited
 * into something the document did not say. */
export function isAuthored(kind: string): kind is AuthoredKind {
  return (AUTHORED_KINDS as readonly string[]).includes(kind);
}

/**
 * The reason a target cannot be written, as a catalog key, or null.
 *
 * The engine refuses the same things one layer down; this exists so the
 * editor can disable Create rather than let a user press it and read a
 * refusal for a field they can see is empty. The engine stays the authority:
 * nothing here is a substitute for its check.
 */
export function targetProblem(
  target: LinkTarget,
  context: { pageCount: number; names: readonly string[] },
): string | null {
  switch (target.kind) {
    case 'uri':
      return target.url.trim() ? null : 'panel.links.problem.url';
    case 'goto':
      if (target.page === null || !Number.isInteger(target.page)) return 'panel.links.problem.page';
      if (target.page < 1 || target.page > context.pageCount) return 'panel.links.problem.pageRange';
      return null;
    case 'named':
      if (!target.name.trim()) return 'panel.links.problem.name';
      return context.names.includes(target.name) ? null : 'panel.links.problem.unknownName';
    case 'file':
      if (!target.path.trim()) return 'panel.links.problem.path';
      if (target.page != null && (!Number.isInteger(target.page) || target.page < 1)) {
        return 'panel.links.problem.filePage';
      }
      return null;
    default:
      return 'panel.links.problem.readOnly';
  }
}

/** The reason an appearance cannot be written, as a catalog key, or null. */
export function appearanceProblem(appearance: LinkAppearance): string | null {
  if (!Number.isFinite(appearance.width) || appearance.width < 0) {
    return 'panel.links.problem.width';
  }
  if (!(AUTHORED_STYLES as readonly string[]).includes(appearance.style)) {
    return 'panel.links.problem.style';
  }
  if (appearance.color && appearance.color.some((c) => !(c >= 0 && c <= 1))) {
    return 'panel.links.problem.color';
  }
  return null;
}

/** `#rrggbb` → the engine's 0..1 triple, or null for anything else. */
export function colorToTriple(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The engine's 0..1 triple → `#rrggbb`. Round-trips `colorToTriple` to the
 * byte, so opening an editor on a colour the user chose shows that colour. */
export function tripleToColor(triple: readonly number[] | null | undefined): string {
  if (!triple || triple.length !== 3) return '#000000';
  const b = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${b(triple[0])}${b(triple[1])}${b(triple[2])}`;
}

/**
 * Strip a target down to what the engine takes: the fields of ITS kind and no
 * others. An editor that has been switched between kinds still holds the
 * previous kind's fields in state, and sending them would author a `/GoToR`
 * carrying a `url` nothing reads.
 */
export function targetPayload(target: LinkTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'uri':
      return { kind: 'uri', url: target.url.trim() };
    case 'goto':
      return { kind: 'goto', page: target.page, view: viewPayload(target.view) };
    case 'named':
      return { kind: 'named', name: target.name.trim() };
    case 'file':
      return {
        kind: 'file',
        path: target.path.trim(),
        ...(target.page != null ? { page: target.page, view: viewPayload(target.view) } : {}),
        ...(target.new_window ? { new_window: true } : {}),
      };
    default:
      return { kind: target.kind };
  }
}

/** A view stripped to its mode's own operands, for the same reason. */
export function viewPayload(view: LinkView | undefined): Record<string, unknown> {
  const mode = view?.mode ?? 'inherit';
  const out: Record<string, unknown> = { mode };
  for (const key of VIEW_OPERANDS[mode]) {
    const raw = view?.[key];
    out[key] = raw == null || !Number.isFinite(raw) ? null : raw;
  }
  return out;
}

/** An appearance stripped the same way: dashes belong to `dashed` alone, and
 * a colour to a border that is actually drawn. */
export function appearancePayload(appearance: LinkAppearance): Record<string, unknown> {
  const out: Record<string, unknown> = {
    width: appearance.width,
    style: appearance.style,
    highlight: appearance.highlight,
  };
  if (appearance.width > 0 && appearance.color) out.color = appearance.color;
  if (appearance.width > 0 && appearance.style === 'dashed' && appearance.dashes?.length) {
    out.dashes = appearance.dashes;
  }
  return out;
}

// ── the canvas → panel channel ──────────────────────────────────────────────
// The drawn-crop channel verbatim (`lib/crop-draw.ts`): a HANDOFF between two
// surfaces that do not contain each other, carrying a single transient request
// with no place in app state. Nothing is committed by publishing — the panel
// fills its editor and the user still presses Create, so a mis-drag costs a
// redraw rather than an undo.

/** A rectangle drawn on the page, in the page's own user space. */
export interface DrawnLink {
  /** 1-based page within the workspace document the band was drawn on. */
  page: number;
  rect: [number, number, number, number];
  /** The document the band belongs to — a stale publish must not fill the
   * editor of a different file the user has since switched to. */
  path: string;
}

/** An existing link the user clicked on the page, addressed the way the
 * engine addresses one. */
export interface PickedLink {
  path: string;
  page: number;
  index: number;
}

/** One of the file's links, projected onto a canvas page. `rect` is
 * display-normalised (0..1 of the drawn frame, y from the top), the frame
 * every other page overlay uses; `page` and `index` are the engine's own
 * address, so a click on the overlay and a row in the panel name one link. */
export interface LinkRegion extends PickedLink {
  pageId: string;
  rect: { x: number; y: number; w: number; h: number };
  kind: string;
}

const NO_REGIONS: readonly LinkRegion[] = [];

/** The regions belonging to one page. Returns a shared empty array for a page
 * with none, so the memoised cell does not re-render on every parent pass. */
export function linksForPage(
  regions: readonly LinkRegion[] | undefined,
  pageId: string,
): readonly LinkRegion[] {
  if (!regions || regions.length === 0) return NO_REGIONS;
  const out = regions.filter((r) => r.pageId === pageId);
  return out.length === 0 ? NO_REGIONS : out;
}

let drawn: DrawnLink | null = null;
let picked: PickedLink | null = null;
const drawListeners = new Set<(link: DrawnLink) => void>();
const pickListeners = new Set<(link: PickedLink) => void>();

export function publishDrawnLink(link: DrawnLink): void {
  drawn = link;
  for (const fn of drawListeners) fn(link);
}

/** Read the pending rect AND clear it — consume-once, the drawn-crop reason:
 * leaving it in place would refill the editor on a panel remount with a link
 * the user already created. */
export function consumeDrawnLink(): DrawnLink | null {
  const value = drawn;
  drawn = null;
  return value;
}

export function subscribeDrawnLink(fn: (link: DrawnLink) => void): () => void {
  drawListeners.add(fn);
  return () => drawListeners.delete(fn);
}

export function publishPickedLink(link: PickedLink): void {
  picked = link;
  for (const fn of pickListeners) fn(link);
}

export function consumePickedLink(): PickedLink | null {
  const value = picked;
  picked = null;
  return value;
}

export function subscribePickedLink(fn: (link: PickedLink) => void): () => void {
  pickListeners.add(fn);
  return () => pickListeners.delete(fn);
}

/** Test seam. */
export function __resetLinkChannel(): void {
  drawn = null;
  picked = null;
  drawListeners.clear();
  pickListeners.clear();
}
