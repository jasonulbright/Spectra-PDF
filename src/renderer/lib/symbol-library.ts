// N11 slice D — the SYMBOL registry: named sets of vector symbols, the
// built-in artwork, and the JSON interchange a firm brings its own standard
// set through.
//
// It is the stamp library's third species, in the shape slice C already
// established: a symbol is a small VECTOR PART LIST (`poly`/`circle` in the
// unit square, `count-marks.ts`), not SVG path data. One geometry drives every
// consumer — the palette's inline SVG, the annotation overlay, and the PDF
// appearance's `m`/`l`/`c` operators — so there is no path parser anywhere and
// no way for the screen and the paper to disagree.
//
// Three rules this module exists to hold:
//
//   • **Untrusted artwork is sanitized before it is artwork.** A part list
//     becomes PDF path operators, so an imported set and a symbol read back
//     out of a PDF both go through `sanitizeParts` (the pure schema check in
//     `count-marks.ts`). Nothing here ever concatenates a value it has not
//     proven to be a finite number in the unit square.
//   • **Ids are identity; names are display.** A BUILT-IN symbol's name
//     localizes (it is our word, like a built-in stamp's), a user's name is
//     their own data and is shown verbatim. Nothing derives a lookup, a test
//     id or an armed state from either.
//   • **We ship our OWN artwork.** The built-in AEC set below is authored
//     here; a third party's drawn library has unknown licensing, and the
//     import path is what makes any set usable without copying one.
//
// Storage mirrors `stamp-library.ts` (its own localStorage key + pure
// helpers), with the module-store subscription `takeoff-settings.ts` uses,
// because three surfaces read the registry and must not disagree about it.

import { COUNT_SYMBOLS, sanitizeParts, type SymbolPart } from './count-marks';

export interface SymbolDef {
  /** Stable id — what an annotation records, what a count group names, and
   * what the localized display name is keyed by. Never derived from a label.
   * Restricted to a PDF-name-safe charset because it lands in
   * `/SpectraSymbol`. */
  id: string;
  /** English for a built-in (localized at render); the user's own text for an
   * imported one (shown verbatim). */
  name: string;
  parts: readonly SymbolPart[];
}

export interface SymbolSet {
  id: string;
  name: string;
  /** Built-in sets localize their set and symbol names; imported ones do not
   * (a firm's symbol name is their data). */
  builtin?: boolean;
  symbols: readonly SymbolDef[];
}

/** Ids that reach `/SpectraSymbol` (a PDF name) and an i18n key. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SYMBOL_SET_MAX_SYMBOLS = 400;

// ── Authoring helpers (build time, not runtime) ──────────────────────────

/** A circular arc as a polyline, y DOWN like every other part. Curves are
 * approximated at AUTHORING time so the schema stays two kinds wide: a 16-step
 * quarter arc deviates by r·(1−cos(2.8°)) ≈ 0.0012 of the unit square, which
 * is under a tenth of a point on a 72 pt symbol. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push(round4(cx + r * Math.cos(a)), round4(cy + r * Math.sin(a)));
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function poly(points: number[], closed = false): SymbolPart {
  return { kind: 'poly', points, closed };
}

function rect(x0: number, y0: number, x1: number, y1: number): SymbolPart {
  return poly([x0, y0, x1, y0, x1, y1, x0, y1], true);
}

function circle(cx: number, cy: number, r: number): SymbolPart {
  return { kind: 'circle', cx, cy, r };
}

// ── The built-in sets ────────────────────────────────────────────────────

/** The slice-C count markers, re-presented as a set. Same geometry object —
 * the marker a count group draws and the symbol the palette offers are one
 * registry, which is the point of slice D. */
const MARKER_NAMES: Record<string, string> = {
  circle: 'Circle',
  square: 'Square',
  triangle: 'Triangle',
  diamond: 'Diamond',
  cross: 'Cross',
  ex: 'X',
  hexagon: 'Hexagon',
  star: 'Star',
  target: 'Target',
};

const MARKER_SET: SymbolSet = {
  id: 'markers',
  name: 'Markers',
  builtin: true,
  symbols: COUNT_SYMBOLS.map((s) => ({ id: s.id, name: MARKER_NAMES[s.id] ?? s.id, parts: s.parts })),
};

/**
 * A general AEC starter set — OUR OWN artwork, drawn from the shapes any
 * drafting convention shares (a door swing is a leaf and an arc everywhere).
 * We do not copy a third party's drawn library; a firm with its own standard
 * brings it through the JSON import instead.
 */
const AEC_SET: SymbolSet = {
  id: 'aec',
  name: 'AEC general',
  builtin: true,
  symbols: [
    {
      id: 'aec-door',
      name: 'Door swing',
      parts: [poly([0.14, 0.86, 0.14, 0.16]), poly(arc(0.14, 0.86, 0.7, -90, 0))],
    },
    {
      id: 'aec-window',
      name: 'Window',
      parts: [poly([0.06, 0.3, 0.94, 0.3]), poly([0.06, 0.5, 0.94, 0.5]), poly([0.06, 0.7, 0.94, 0.7])],
    },
    {
      id: 'aec-receptacle',
      name: 'Receptacle',
      parts: [circle(0.5, 0.62, 0.3), poly([0.38, 0.36, 0.38, 0.88]), poly([0.62, 0.36, 0.62, 0.88])],
    },
    {
      id: 'aec-switch',
      name: 'Switch',
      parts: [circle(0.2, 0.74, 0.06), circle(0.8, 0.74, 0.06), poly([0.2, 0.68, 0.78, 0.24])],
    },
    {
      id: 'aec-light',
      name: 'Ceiling light',
      parts: [circle(0.5, 0.5, 0.34), poly([0.16, 0.5, 0.84, 0.5]), poly([0.5, 0.16, 0.5, 0.84])],
    },
    {
      id: 'aec-fixture-linear',
      name: 'Linear fixture',
      parts: [rect(0.08, 0.34, 0.92, 0.66), poly([0.08, 0.5, 0.92, 0.5])],
    },
    {
      id: 'aec-smoke-detector',
      name: 'Smoke detector',
      parts: [circle(0.5, 0.5, 0.36), poly([0.5, 0.2, 0.8, 0.5, 0.5, 0.8, 0.2, 0.5], true)],
    },
    {
      id: 'aec-thermostat',
      name: 'Thermostat',
      parts: [circle(0.5, 0.5, 0.32), poly([0.5, 0.22, 0.5, 0.5, 0.74, 0.62])],
    },
    {
      id: 'aec-exit-sign',
      name: 'Exit sign',
      parts: [rect(0.08, 0.3, 0.92, 0.7), poly([0.28, 0.5, 0.68, 0.5]), poly([0.56, 0.38, 0.68, 0.5, 0.56, 0.62])],
    },
    {
      id: 'aec-data-outlet',
      name: 'Data outlet',
      parts: [poly([0.5, 0.24, 0.86, 0.84, 0.14, 0.84], true), poly([0.5, 0.24, 0.5, 0.06])],
    },
    {
      id: 'aec-junction-box',
      name: 'Junction box',
      parts: [rect(0.16, 0.16, 0.84, 0.84), poly([0.16, 0.16, 0.84, 0.84]), poly([0.84, 0.16, 0.16, 0.84])],
    },
    {
      id: 'aec-floor-drain',
      name: 'Floor drain',
      parts: [circle(0.5, 0.5, 0.34), poly([0.26, 0.26, 0.74, 0.74]), poly([0.74, 0.26, 0.26, 0.74])],
    },
    {
      id: 'aec-diffuser',
      name: 'Supply diffuser',
      parts: [
        rect(0.08, 0.08, 0.92, 0.92),
        rect(0.32, 0.32, 0.68, 0.68),
        poly([0.08, 0.08, 0.32, 0.32]),
        poly([0.92, 0.08, 0.68, 0.32]),
        poly([0.92, 0.92, 0.68, 0.68]),
        poly([0.08, 0.92, 0.32, 0.68]),
      ],
    },
    {
      id: 'aec-return-grille',
      name: 'Return grille',
      parts: [
        rect(0.08, 0.16, 0.92, 0.84),
        poly([0.08, 0.36, 0.92, 0.36]),
        poly([0.08, 0.5, 0.92, 0.5]),
        poly([0.08, 0.64, 0.92, 0.64]),
      ],
    },
    {
      id: 'aec-sprinkler',
      name: 'Sprinkler head',
      parts: [
        circle(0.5, 0.5, 0.14),
        poly([0.5, 0.06, 0.5, 0.34]),
        poly([0.5, 0.66, 0.5, 0.94]),
        poly([0.06, 0.5, 0.34, 0.5]),
        poly([0.66, 0.5, 0.94, 0.5]),
      ],
    },
    {
      id: 'aec-valve',
      name: 'Valve',
      parts: [poly([0.1, 0.3, 0.1, 0.8, 0.9, 0.3, 0.9, 0.8], true), poly([0.5, 0.55, 0.5, 0.16]), poly([0.32, 0.16, 0.68, 0.16])],
    },
    {
      id: 'aec-north-arrow',
      name: 'North arrow',
      parts: [poly([0.5, 0.04, 0.74, 0.94, 0.5, 0.72, 0.26, 0.94], true)],
    },
    {
      id: 'aec-detail-bubble',
      name: 'Detail bubble',
      parts: [circle(0.5, 0.5, 0.42), poly([0.08, 0.5, 0.92, 0.5])],
    },
    {
      id: 'aec-elevation-marker',
      name: 'Elevation marker',
      parts: [poly([0.06, 0.34, 0.94, 0.34]), poly([0.24, 0.34, 0.76, 0.34, 0.5, 0.88], true)],
    },
    {
      id: 'aec-fire-extinguisher',
      name: 'Fire extinguisher',
      parts: [rect(0.34, 0.22, 0.66, 0.9), rect(0.42, 0.08, 0.58, 0.22), poly([0.66, 0.32, 0.86, 0.32])],
    },
  ],
};

export const BUILTIN_SYMBOL_SETS: readonly SymbolSet[] = [MARKER_SET, AEC_SET];

// ── Storage ──────────────────────────────────────────────────────────────

const KEY = 'symbol-sets';

/** Coerce one stored/imported set. Returns null when the shape is wrong —
 * storage is best-effort and a malformed entry is dropped rather than
 * refused (the import path refuses LOUDLY; this is the read-back). */
function coerceSet(raw: unknown): SymbolSet | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return null;
  if (!Array.isArray(r.symbols) || r.symbols.length === 0) return null;
  const symbols: SymbolDef[] = [];
  for (const entry of r.symbols.slice(0, SYMBOL_SET_MAX_SYMBOLS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) continue;
    const parts = sanitizeParts(s.parts);
    if (!parts) continue;
    const symName = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : s.id;
    if (symbols.some((x) => x.id === s.id)) continue;
    symbols.push({ id: s.id, name: symName, parts });
  }
  if (symbols.length === 0) return null;
  return { id: r.id, name, symbols };
}

export function loadUserSymbolSets(): SymbolSet[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: SymbolSet[] = [];
    for (const entry of raw) {
      const set = coerceSet(entry);
      // Ids are identity: a duplicate would make "which set is this" ambiguous
      // in a picker whose whole job is to answer that.
      if (set && !out.some((s) => s.id === set.id) && !BUILTIN_SYMBOL_SETS.some((s) => s.id === set.id)) {
        out.push(set);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveUserSymbolSets(sets: readonly SymbolSet[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sets));
  } catch {
    // storage full / unavailable — the built-ins still work
  }
}

let current: SymbolSet[] | null = null;
const listeners = new Set<() => void>();

/** The user's imported sets (module-cached; the built-ins are separate so a
 * cleared store can never lose them). */
export function getUserSymbolSets(): SymbolSet[] {
  if (current === null) current = loadUserSymbolSets();
  return current;
}

let allCache: SymbolSet[] | null = null;

/** Every set, built-ins first — the order the palette lists them in. */
export function getSymbolSets(): SymbolSet[] {
  if (allCache === null) allCache = [...BUILTIN_SYMBOL_SETS, ...getUserSymbolSets()];
  return allCache;
}

function publish(next: SymbolSet[]): void {
  current = next;
  allCache = null;
  saveUserSymbolSets(next);
  for (const fn of [...listeners]) fn();
}

export function subscribeSymbolSets(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Add an imported set, or REPLACE the one it shares an id with.
 *
 * Replacing is the honest reading of a re-import: the file declares the set's
 * id, so a second import of the same id is that set's next revision, not a
 * second set with the same name. Annotations are unaffected either way — a
 * placed symbol carries its own geometry.
 */
export function addSymbolSet(set: SymbolSet): 'added' | 'updated' {
  const sets = getUserSymbolSets();
  const at = sets.findIndex((s) => s.id === set.id);
  if (at >= 0) {
    const next = [...sets];
    next[at] = set;
    publish(next);
    return 'updated';
  }
  publish([...sets, set]);
  return 'added';
}

/** Remove an imported set. Built-ins are not removable — they are the floor
 * the product ships with, and nothing placed depends on the set anyway. */
export function removeSymbolSet(id: string): void {
  publish(getUserSymbolSets().filter((s) => s.id !== id));
}

/** For tests and the e2e harness: reset the module cache after the backing
 * store was written from outside. */
export function reloadSymbolSets(): void {
  current = null;
  allCache = null;
  for (const fn of [...listeners]) fn();
}

// ── Lookup + search ──────────────────────────────────────────────────────

export interface SymbolHit {
  set: SymbolSet;
  symbol: SymbolDef;
}

/** The symbol with this id anywhere in the registry, or null. Ids are unique
 * across sets by construction: an imported set whose symbol id collides with
 * one already present is refused at parse time. */
export function findSymbol(id: string | undefined): SymbolHit | null {
  if (!id) return null;
  for (const set of getSymbolSets()) {
    const symbol = set.symbols.find((s) => s.id === id);
    if (symbol) return { set, symbol };
  }
  return null;
}

/** A symbol's parts, or null when this build has never heard of the id — the
 * caller falls back to the default marker or to the annotation's own carried
 * geometry, never to nothing. */
export function symbolParts(id: string | undefined): readonly SymbolPart[] | null {
  return findSymbol(id)?.symbol.parts ?? null;
}

/**
 * Search the registry. `displayName` resolves a symbol's shown name (the
 * localized one for a built-in), so a Spanish user searching "puerta" finds
 * the door — matching the ENGLISH name too, because the id and the authored
 * name are what a shared set file carries.
 */
export function searchSymbols(
  query: string,
  displayName: (set: SymbolSet, symbol: SymbolDef) => string,
  sets: readonly SymbolSet[] = getSymbolSets(),
): SymbolHit[] {
  const q = query.trim().toLocaleLowerCase();
  const out: SymbolHit[] = [];
  for (const set of sets) {
    for (const symbol of set.symbols) {
      if (
        !q ||
        displayName(set, symbol).toLocaleLowerCase().includes(q) ||
        symbol.name.toLocaleLowerCase().includes(q) ||
        symbol.id.toLocaleLowerCase().includes(q)
      ) {
        out.push({ set, symbol });
      }
    }
  }
  return out;
}

// ── JSON interchange ─────────────────────────────────────────────────────
//
// The refusals follow the guided-actions import precedent exactly: one
// interpolated catalog key per problem, naming the offending symbol, so a
// file that cannot be imported says WHY rather than half-importing.

export const SYMBOL_SET_FILE_KIND = 'spectra-symbol-set';

/** The export shape — also what an import accepts. */
export function symbolSetToJson(set: SymbolSet): string {
  return `${JSON.stringify(
    {
      kind: SYMBOL_SET_FILE_KIND,
      version: 1,
      id: set.id,
      name: set.name,
      symbols: set.symbols.map((s) => ({ id: s.id, name: s.name, parts: s.parts })),
    },
    null,
    2,
  )}\n`;
}

/** The refusal a `parseSymbolSetFile` problem carries: a catalog KEY plus its
 * interpolation values, resolved by the caller (this module stays free of the
 * i18n layer so it can be unit-tested without one). */
export interface SymbolSetRefusal {
  key: string;
  vars?: Record<string, string | number>;
}

export type SymbolSetParse =
  | { ok: true; set: SymbolSet }
  | { ok: false; refusal: SymbolSetRefusal };

/**
 * Parse + validate a symbol-set FILE. Every artwork number goes through
 * `sanitizeParts`; a symbol whose id collides with one already in the
 * registry (including the built-ins) is refused rather than shadowing it,
 * because a placed annotation names its symbol by id.
 */
export function parseSymbolSetFile(text: string): SymbolSetParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, refusal: { key: 'refusal.symbolSet.notJson' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, refusal: { key: 'refusal.symbolSet.notASet' } };
  }
  const r = parsed as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || !Array.isArray(r.symbols)) {
    return { ok: false, refusal: { key: 'refusal.symbolSet.notASet' } };
  }
  if (r.symbols.length === 0) {
    return { ok: false, refusal: { key: 'refusal.symbolSet.noSymbols' } };
  }
  if (r.symbols.length > SYMBOL_SET_MAX_SYMBOLS) {
    return {
      ok: false,
      refusal: { key: 'refusal.symbolSet.tooManySymbols', vars: { max: SYMBOL_SET_MAX_SYMBOLS } },
    };
  }
  let id = typeof r.id === 'string' ? r.id : '';
  if (id && !ID_RE.test(id)) {
    return { ok: false, refusal: { key: 'refusal.symbolSet.setId' } };
  }
  // A set file may omit its id (hand-authored); one is minted so the set can
  // be updated by a later export of itself.
  if (!id) id = `set-${crypto.randomUUID().slice(0, 8)}`;
  if (BUILTIN_SYMBOL_SETS.some((s) => s.id === id)) {
    return { ok: false, refusal: { key: 'refusal.symbolSet.builtinId', vars: { id } } };
  }
  // Symbol ids must be unique against every OTHER set — but not against the
  // set being REPLACED by this very import, whose ids are this set's own.
  const taken = new Map<string, string>();
  for (const set of getSymbolSets()) {
    if (set.id === id) continue;
    for (const s of set.symbols) taken.set(s.id, set.name);
  }
  const symbols: SymbolDef[] = [];
  for (let i = 0; i < r.symbols.length; i++) {
    const entry = r.symbols[i];
    const n = i + 1;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, refusal: { key: 'refusal.symbolSet.symbolShape', vars: { index: n } } };
    }
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
      return { ok: false, refusal: { key: 'refusal.symbolSet.symbolId', vars: { index: n } } };
    }
    if (symbols.some((x) => x.id === s.id)) {
      return { ok: false, refusal: { key: 'refusal.symbolSet.duplicateId', vars: { id: s.id } } };
    }
    const clash = taken.get(s.id);
    if (clash !== undefined) {
      return {
        ok: false,
        refusal: { key: 'refusal.symbolSet.idInUse', vars: { id: s.id, set: clash } },
      };
    }
    const parts = sanitizeParts(s.parts);
    if (!parts) {
      return { ok: false, refusal: { key: 'refusal.symbolSet.parts', vars: { id: s.id } } };
    }
    const symName = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : s.id;
    symbols.push({ id: s.id, name: symName, parts });
  }
  return { ok: true, set: { id, name, symbols } };
}
