// The separation preview's pure model: what the engine's plates mean, which
// of them are showing, what the ink arithmetic produces, and how the plate
// cache is keyed and pruned.
//
// The panel and the canvas are thin shells over this. There is no DOM test
// environment, so every decision that can be wrong lives here where it is
// testable — the components only render what these functions decide.

export type InkKind = 'process' | 'spot' | 'all' | 'none';

/** A colorant the document declares. */
export interface Ink {
  name: string;
  kind: InkKind;
  alternate: string;
  display_rgb: number[] | null;
  pages: number[];
  used_in: string[];
}

/**
 * What one `list_inks` call answered.
 *
 * `unknown` is the other half of the answer, not a detail: a resource branch
 * the engine could not read may hold a colorant, so a spot can be missing
 * from `inks` — and therefore from the plate list and from every total-ink
 * figure measured over it — with nothing else saying so. An empty list means
 * the document was read whole.
 */
export interface InkInventory {
  inks: Ink[];
  unknown: string[];
  /** Every colour family the document carries, resource spaces and inline
   *  device operators alike. It decides whether a profile change is a
   *  re-raster or only a re-composite. */
  color_families: string[];
}

/** One rasterized plate of a page. */
export interface Plate {
  name: string;
  kind: InkKind;
  display_rgb: number[];
  file: string;
}

/** Where a soft proof's press profile comes from. */
export type SimulationSource = 'none' | 'document' | 'file' | 'bundled';

/** What the panel asks the engine to proof through. */
export interface SimulationRequest {
  source: SimulationSource;
  /** A picked `.icc` path, for `file`. Read by the ENGINE, never by the
   *  webview: the picked path is outside the runtime fs scope, and a design
   *  that read the profile bytes here would need that scope widened. */
  profile: string;
  paper_white: boolean;
  black_ink: boolean;
}

/**
 * What the engine says it actually USED.
 *
 * The panel renders its select and both switches from this and never from
 * its own request, so a request the engine refused cannot look honoured.
 * `refusal` carries the engine's own sentence when the proof could not be
 * produced; `source` is then `none` and the image is the ordinary composite.
 */
export interface SimulationRecord {
  source: SimulationSource;
  name: string;
  intent: 'relative' | 'absolute' | '';
  black_point_compensation: boolean;
  refusal: string;
  /** Source spaces assumed for a spot whose alternate carries no ICC
   *  description of its own. Empty when nothing had to be assumed. */
  assumed: string[];
}

/** Which press profiles a document can be proofed against. */
export interface SimulationProfiles {
  document: { present: boolean; embedded: boolean; identifier: string; name: string };
  bundled: { present: boolean; name: string };
}

/** What one separation render produced. */
export interface PlateSet {
  dir: string;
  plates: Plate[];
  width: number;
  height: number;
  dpi: number;
  page: number;
  overprint: boolean;
  /** Per-process-ink page coverage as a fraction — a page AVERAGE. */
  coverage: Record<string, number>;
}

/** What a composite of a chosen plate subset produced. */
export interface CompositeResult {
  png: string;
  width: number;
  height: number;
  inks: string[];
  max_tac: number;
  over_pixels: number;
  total_pixels: number;
  over_fraction: number;
  simulation: SimulationRecord | null;
}

/** Total ink a press job is normally held to, in percent. */
export const DEFAULT_TAC_LIMIT = 300;
export const MIN_TAC_LIMIT = 100;
export const MAX_TAC_LIMIT = 400;

/** Neutral density multiplies an ink's absorption in the composite. */
export const DEFAULT_INK_DENSITY = 1;
export const MIN_INK_DENSITY = 0.1;
export const MAX_INK_DENSITY = 2;

/** Separation rasters above this resolution buy nothing a display can show. */
export const MAX_PREVIEW_DPI = 300;
export const MIN_PREVIEW_DPI = 36;
/** Long-edge pixels a preview page is rastered to — a fit-to-width letter
 *  page on a 2× display, which is the most any panel of this size resolves. */
export const PREVIEW_RASTER = 1650;

/** Only these two kinds are inks a user can switch. `/All` paints every plate
 *  and owns none; `/None` paints nothing. Neither is ever offered. */
export function isToggleableInk(ink: { kind: InkKind }): boolean {
  return ink.kind === 'process' || ink.kind === 'spot';
}

/** The plates a composite should draw, given the switched-off ink names. */
export function visiblePlates(plates: readonly Plate[], hidden: ReadonlySet<string>): Plate[] {
  return plates.filter((p) => isToggleableInk(p) && !hidden.has(p.name));
}

export interface InkRequest {
  name: string;
  display_rgb: number[];
  density: number;
  /** The ink this plate is DRAWN as. Under the multiply model the display
   *  colour carries that identity on its own; under a press profile it also
   *  decides which channel of the CMYK buffer the coverage lands in, and a
   *  colour cannot answer that. */
  shown_as: string;
}

/**
 * A PREVIEW alias: which ink each colorant is shown as.
 *
 * The document is untouched — the plates are still separate, and the preview
 * simply draws them as one ink. The applied alias is a different door: it
 * rewrites the colorant name in the file, and the separation device then
 * plates them together for real.
 */
export type InkAliases = ReadonlyMap<string, string>;

/** The ink a colorant is shown as, following one hop only — an alias chain
 *  is not a plate, and resolving one would let a cycle hang the panel. */
export function resolveAlias(aliases: InkAliases, name: string): string {
  return aliases.get(name) ?? name;
}

/** Would adding this alias point an ink at one that is itself aliased away,
 *  or at itself? Either makes the target something the preview cannot draw. */
export function aliasIsAllowed(aliases: InkAliases, source: string, target: string): boolean {
  if (source === target) return false;
  if (aliases.has(target)) return false;
  return true;
}

/**
 * Print sequence: the order the plates are listed in.
 *
 * PDF has no key for it — no colour space or page dictionary carries an ink
 * order — so it is an application setting, and what it drives is this list.
 * It deliberately does NOT reorder the composite: inks multiply down, and
 * multiplication commutes, so a claim that the sequence changed the image
 * would be a claim about nothing.
 * Names the sequence does not mention keep their natural order behind the
 * ones it does, so a sequence recorded for one document does not hide an ink
 * in another.
 */
export function orderInks<T extends { name: string }>(
  items: readonly T[],
  sequence: readonly string[],
): T[] {
  const rank = new Map(sequence.map((name, index) => [name, index]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.name);
    const rb = rank.get(b.name);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

/** Move one ink up or down the print sequence, clamped at the ends. */
export function moveInSequence(
  sequence: readonly string[],
  name: string,
  delta: number,
): string[] {
  const from = sequence.indexOf(name);
  if (from < 0) return [...sequence];
  const to = Math.min(sequence.length - 1, Math.max(0, from + delta));
  if (to === from) return [...sequence];
  const next = [...sequence];
  next.splice(from, 1);
  next.splice(to, 0, name);
  return next;
}

export interface InkRow {
  plate: Plate;
  /** Colorants shown as this one. Empty for an ink nothing points at. */
  aliasedFrom: string[];
}

/** The panel's ink list: one row per ink actually drawn, each naming the
 *  colorants merged onto it. */
export function inkRows(plates: readonly Plate[], aliases: InkAliases): InkRow[] {
  const shown = plates.filter((p) => isToggleableInk(p) && !aliases.has(p.name));
  return shown.map((plate) => ({
    plate,
    aliasedFrom: plates
      .filter((p) => aliases.get(p.name) === plate.name)
      .map((p) => p.name),
  }));
}

/**
 * What the engine is asked to composite.
 *
 * A plate is found by ITS OWN name — that is the file the device wrote — but
 * it takes the colour and density of the ink it is shown as, and it hides
 * when that ink hides. An alias whose target is not a plate on this page
 * falls back to the plate's own identity rather than vanishing.
 */
export function compositeRequest(
  plates: readonly Plate[],
  hidden: ReadonlySet<string>,
  densities: ReadonlyMap<string, number>,
  aliases: InkAliases = new Map(),
): InkRequest[] {
  const byName = new Map(plates.map((p) => [p.name, p]));
  const out: InkRequest[] = [];
  for (const plate of plates) {
    if (!isToggleableInk(plate)) continue;
    const shownAs = resolveAlias(aliases, plate.name);
    const target = byName.get(shownAs) ?? plate;
    if (hidden.has(target.name)) continue;
    out.push({
      name: plate.name,
      display_rgb: target.display_rgb,
      density: clampDensity(densities.get(target.name) ?? DEFAULT_INK_DENSITY),
      shown_as: target.name,
    });
  }
  return out;
}

export function clampDensity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INK_DENSITY;
  return Math.min(MAX_INK_DENSITY, Math.max(MIN_INK_DENSITY, value));
}

export function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TAC_LIMIT;
  return Math.min(MAX_TAC_LIMIT, Math.max(MIN_TAC_LIMIT, Math.round(value)));
}

/**
 * One pixel of the composite, in 0…255 sRGB.
 *
 * Each ink multiplies its own absorption down, scaled by its coverage at that
 * pixel and by its density — so an ink switched off leaves the pixel exactly
 * as if that ink had never printed. This mirrors the engine's array
 * arithmetic; it is here so the model can be proven against it.
 */
export function compositePixel(
  inks: readonly Pick<InkRequest, 'display_rgb' | 'density'>[],
  coverage: readonly number[],
): [number, number, number] {
  const rgb: [number, number, number] = [1, 1, 1];
  inks.forEach((ink, index) => {
    const amount = Math.min(1, Math.max(0, coverage[index] ?? 0));
    for (let c = 0; c < 3; c += 1) {
      const absorb = 1 - (ink.display_rgb[c] ?? 0) / 255;
      rgb[c] *= Math.min(1, Math.max(0, 1 - amount * ink.density * absorb));
    }
  });
  return [
    Math.round(rgb[0] * 255),
    Math.round(rgb[1] * 255),
    Math.round(rgb[2] * 255),
  ];
}

/** Total ink at one pixel, in percent. */
export function totalInk(coverage: readonly number[]): number {
  return coverage.reduce((sum, c) => sum + Math.min(1, Math.max(0, c)) * 100, 0);
}

/**
 * The resolution to raster a page at.
 *
 * Capped at what the display can show: the ink arithmetic is
 * resolution-independent, so anything beyond the on-screen pixel pitch costs
 * time and changes no number the panel reports.
 */
export function previewDpi(pageWidthPoints: number, pageHeightPoints: number): number {
  const longEdge = Math.max(pageWidthPoints, pageHeightPoints);
  if (!(longEdge > 0)) return MIN_PREVIEW_DPI;
  const dpi = (PREVIEW_RASTER * 72) / longEdge;
  return Math.round(Math.min(MAX_PREVIEW_DPI, Math.max(MIN_PREVIEW_DPI, dpi)));
}

// ── the plate cache ────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  /** The page this entry belongs to. Held as a FIELD, never parsed back out
   *  of the key: a page id is opaque and string-building or splitting one is
   *  how a stale id re-binds. */
  pageId: string;
  value: T;
}

export function plateCacheKey(
  fileId: string,
  pageId: string,
  dpi: number,
  overprint: boolean,
  profile = '',
): string {
  return JSON.stringify([fileId, pageId, dpi, overprint, profile]);
}

/**
 * Drop every entry whose page is no longer in the document.
 *
 * Synchronous, and run before the first await of anything that reads the
 * cache: a page id is generation-tagged, so an entry keyed by a retired id
 * can never re-bind and would otherwise show one page's separations under
 * another's. Returns the removed keys so the caller can release what they
 * held.
 */
export function prunePlateCache<T>(
  cache: Map<string, CacheEntry<T>>,
  livePageIds: ReadonlySet<string>,
): string[] {
  const removed: string[] = [];
  for (const [key, entry] of cache) {
    if (!livePageIds.has(entry.pageId)) removed.push(key);
  }
  for (const key of removed) cache.delete(key);
  return removed;
}

/** The per-ink page coverage readout, ordered and labelled as percentages.
 *  This is the device's page AVERAGE — it cannot answer "how much ink is on
 *  the heaviest pixel", which is what the limit alarm measures. */
export function coverageRows(coverage: Record<string, number>): Array<{ name: string; pct: number }> {
  return ['Cyan', 'Magenta', 'Yellow', 'Black']
    .filter((name) => typeof coverage[name] === 'number')
    .map((name) => ({ name, pct: coverage[name] * 100 }));
}

/** Does this composite trip the limit? */
export function alarmTripped(result: Pick<CompositeResult, 'over_pixels'>): boolean {
  return result.over_pixels > 0;
}

/**
 * The engine's inventory as the panel reads it.
 *
 * A response missing either field is read as "could not tell", never as a
 * clean document: an older or partial payload that defaulted `unknown` to
 * empty would restore exactly the silent gap this reports.
 */
export function readInventory(payload: unknown): InkInventory {
  const raw = (payload ?? {}) as {
    inks?: unknown;
    unknown?: unknown;
    color_families?: unknown;
  };
  return {
    inks: Array.isArray(raw.inks) ? (raw.inks as Ink[]) : [],
    unknown: Array.isArray(raw.unknown) ? raw.unknown.map((r) => String(r)) : [],
    // A payload that named no families is read as "could not tell", and the
    // staging test then answers yes: a profile change re-rasters rather than
    // proofing plates that may have come from another press.
    color_families: Array.isArray(raw.color_families)
      ? raw.color_families.map((f) => String(f))
      : [''],
  };
}

/**
 * Is the plate list complete?
 *
 * The gate on every claim the panel makes about the WHOLE page — the plate
 * inventory, the coverage rows and the total-ink figures. Each is measured
 * over the plates that exist; an ink the engine could not reach is in none of
 * them, so the numbers are a floor rather than the page's total.
 */
export function inventoryIsComplete(inventory: Pick<InkInventory, 'unknown'>): boolean {
  return inventory.unknown.length === 0;
}

// ── the soft proof ─────────────────────────────────────────────────────────

/**
 * Colour families a page can carry and still separate to the document's own
 * ink numbers on every press. Anything else reached the plates through
 * Ghostscript's compiled-in default CMYK, which is not the press being
 * proofed, so the page has to be colour-managed before it is separated.
 */
const DEVICE_CMYK_FAMILIES = new Set(['DeviceCMYK', 'Separation', 'DeviceN']);

/** Does a profile change re-raster this document, or only re-composite it? */
export function stagingApplies(families: readonly string[]): boolean {
  return families.some((family) => !DEVICE_CMYK_FAMILIES.has(family));
}

/**
 * The plate cache's profile component.
 *
 * Empty unless the staging applies: a profile change is a re-raster only for
 * a page whose plates the profile can move, and splitting the cache on a
 * choice that changes nothing would re-run the separation device on every
 * ink toggle that followed a profile change.
 */
export function plateProfileComponent(
  request: SimulationRequest,
  families: readonly string[],
): string {
  if (request.source === 'none' || !stagingApplies(families)) return '';
  return JSON.stringify([request.source, request.profile]);
}

/**
 * Which profile source the panel opens on.
 *
 * The document's own output intent first, then a profile the user picked,
 * then the bundled press, then none. The bundled press is OFFERED and never
 * assumed: proofing against a press neither the user chose nor the document
 * declared is a claim about nobody's press, so an ordinary document with no
 * intent opens unproofed.
 */
export function resolveSimulationSource(available: {
  document: boolean;
  picked: boolean;
  bundled: boolean;
}): SimulationSource {
  if (available.document) return 'document';
  if (available.picked) return 'file';
  if (available.bundled) return 'bundled';
  return 'none';
}

/** Is there anything for the two switches to act on? */
export function simulationIsLive(source: SimulationSource): boolean {
  return source !== 'none';
}

/**
 * Does simulating paper white force simulating black ink?
 *
 * Always, and the reason is arithmetic rather than convention: absolute
 * colorimetric already carries both endpoints of the medium, so black-point
 * compensation changes nothing under it. Leaving the control live would ship
 * a switch that visibly does nothing.
 */
export function blackInkIsForced(paperWhite: boolean): boolean {
  return paperWhite;
}

/** The black-ink value the engine is asked for. The user's own choice is
 *  REMEMBERED rather than overwritten, so turning paper white off restores
 *  it. */
export function effectiveBlackInk(paperWhite: boolean, blackInk: boolean): boolean {
  return paperWhite ? true : blackInk;
}

/** What the panel sends. Both switches are inert under `none`. */
export function simulationRequest(
  source: SimulationSource,
  profile: string,
  paperWhite: boolean,
  blackInk: boolean,
): SimulationRequest {
  const live = simulationIsLive(source);
  return {
    source,
    profile: source === 'file' ? profile : '',
    paper_white: live && paperWhite,
    black_ink: live && effectiveBlackInk(paperWhite, blackInk),
  };
}

/**
 * The engine's simulation record as the panel reads it.
 *
 * A payload missing the field is read as "could not tell", never as "off" —
 * the `readInventory` discipline. A soft proof that quietly showed sRGB when
 * the transform never ran is the silent degradation this row exists to
 * prevent, so the absence of an answer must not be readable as a clean one.
 */
export function readSimulation(payload: unknown): SimulationRecord | null {
  const raw = (payload ?? {}) as { simulation?: unknown };
  const record = raw.simulation;
  if (record === null || typeof record !== 'object') return null;
  const value = record as Partial<SimulationRecord>;
  const source = value.source;
  const intent = value.intent;
  return {
    source:
      source === 'document' || source === 'file' || source === 'bundled' ? source : 'none',
    name: typeof value.name === 'string' ? value.name : '',
    intent: intent === 'relative' || intent === 'absolute' ? intent : '',
    black_point_compensation: value.black_point_compensation === true,
    refusal: typeof value.refusal === 'string' ? value.refusal : '',
    assumed: Array.isArray(value.assumed) ? value.assumed.map((a) => String(a)) : [],
  };
}

/** The profiles the engine offered, read the same way. */
export function readSimulationProfiles(payload: unknown): SimulationProfiles {
  const raw = (payload ?? {}) as { document?: unknown; bundled?: unknown };
  const document = (raw.document ?? {}) as Record<string, unknown>;
  const bundled = (raw.bundled ?? {}) as Record<string, unknown>;
  return {
    document: {
      present: document.present === true,
      embedded: document.embedded === true,
      identifier: typeof document.identifier === 'string' ? document.identifier : '',
      name: typeof document.name === 'string' ? document.name : '',
    },
    bundled: {
      present: bundled.present === true,
      name: typeof bundled.name === 'string' ? bundled.name : '',
    },
  };
}
