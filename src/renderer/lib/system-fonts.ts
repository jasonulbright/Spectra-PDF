/**
 * The machine's installed fonts, for the editor's family pickers.
 *
 * Editing has offered Keep-original plus three bundled families since 7.4.
 * Those exist so a replacement is always available offline and metric-
 * compatible; they were never meant to be the whole choice. This fetches
 * what is actually installed.
 *
 * The list is fetched ONCE per session and cached: a machine's font folder
 * does not change while a document is open, the scan reads several hundred
 * files, and the engine is a strictly serial FIFO — re-fetching every time a
 * picker opens would put a font scan in front of the user's actual work.
 */

export interface SystemFontFace {
  path: string;
  index: number;
  style: string;
  name: string;
  bold: boolean;
  italic: boolean;
}

export interface SystemFontFamily {
  family: string;
  faces: SystemFontFace[];
}

export interface SystemFontListing {
  families: SystemFontFamily[];
  count: number;
  /** Faces the foundry's own `fsType` forbids embedding. Reported so the UI
   * can SAY why a font is missing rather than leave a user hunting. */
  restricted: number;
}

const EMPTY: SystemFontListing = { families: [], count: 0, restricted: 0 };

let cached: Promise<SystemFontListing> | null = null;

type EngineCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Parse an engine reply defensively — a malformed entry is dropped, never
 * allowed to break the picker. */
export function parseListing(raw: unknown): SystemFontListing {
  const res = raw as { families?: unknown; count?: unknown; restricted?: unknown };
  if (!res || !Array.isArray(res.families)) return EMPTY;
  const families: SystemFontFamily[] = [];
  for (const entry of res.families) {
    const fam = entry as { family?: unknown; faces?: unknown };
    if (typeof fam.family !== 'string' || !fam.family || !Array.isArray(fam.faces)) continue;
    const faces: SystemFontFace[] = [];
    for (const f of fam.faces) {
      const face = f as Record<string, unknown>;
      if (typeof face.path !== 'string' || !face.path) continue;
      faces.push({
        path: face.path,
        index: typeof face.index === 'number' ? face.index : 0,
        style: typeof face.style === 'string' ? face.style : 'Regular',
        name: typeof face.name === 'string' ? face.name : fam.family,
        bold: Boolean(face.bold),
        italic: Boolean(face.italic),
      });
    }
    if (faces.length) families.push({ family: fam.family, faces });
  }
  return {
    families,
    count: typeof res.count === 'number' ? res.count : families.length,
    restricted: typeof res.restricted === 'number' ? res.restricted : 0,
  };
}

/**
 * The face within `family` that best matches a requested weight and slant.
 *
 * Exact match first, then the same weight, then the family's Regular, then
 * whatever it has — face IDENTITY beats weight, the same degrade ladder the
 * bundled resolver uses, so asking for a bold italic of a family that has
 * neither lands on that family rather than on another family's bold.
 */
export function pickFace(
  family: SystemFontFamily,
  bold: boolean,
  italic: boolean,
): SystemFontFace | null {
  if (!family.faces.length) return null;
  const exact = family.faces.find((f) => f.bold === bold && f.italic === italic);
  if (exact) return exact;
  const sameWeight = family.faces.find((f) => f.bold === bold);
  if (sameWeight) return sameWeight;
  const regular = family.faces.find((f) => !f.bold && !f.italic);
  return regular ?? family.faces[0];
}

/** The installed fonts, fetched once per session. */
export function loadSystemFonts(call: EngineCall): Promise<SystemFontListing> {
  if (cached) return cached;
  cached = call('list_system_fonts', {})
    .then(parseListing)
    .catch(() => {
      // A machine that cannot answer keeps the three bundled families —
      // the picker is an addition, never a dependency.
      cached = null;
      return EMPTY;
    });
  return cached;
}

/**
 * The listing SYNCHRONOUSLY, or null before it lands.
 *
 * The picker lives deep in the page tree, where there is no engine handle;
 * priming happens once at the workspace level and every consumer reads the
 * result from here. That is deliberately a module cache rather than four
 * layers of prop: the value is a property of the MACHINE, identical for
 * every document and every cell, and threading it would be churn that says
 * nothing true about the data.
 */
let settled: SystemFontListing | null = null;
const listeners = new Set<() => void>();

export function getSystemFonts(): SystemFontListing | null {
  return settled;
}

export function subscribeSystemFonts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Prime the cache. Safe to call repeatedly; only the first fetches. */
export function primeSystemFonts(call: EngineCall): void {
  if (settled !== null || cached !== null) return;
  void loadSystemFonts(call).then((listing) => {
    settled = listing;
    for (const fn of listeners) fn();
  });
}

/** Test seam: forget the cached listing. */
export function __resetSystemFonts(): void {
  cached = null;
  settled = null;
  listeners.clear();
}
