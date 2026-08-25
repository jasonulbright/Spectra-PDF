// The preflight profile, panel-side: only what the PANEL decides by itself.
//
// The engine owns what a profile MEANS — the check inventory, every parameter
// and its bound, the nine shipped rule sets, and the validation that refuses a
// bad one (`engine/preflight_profiles.py`). A second validator here would be a
// second answer waiting to drift, and a profile is also resolved by the
// command line, where no renderer exists at all. So this module answers only
// the questions the panel has: which profiles to offer and in what order, what
// a derived profile is called, which ids can never be written over, and what a
// profile FILE looks like on its way in and out.
//
// A leaf module: no React, no Tauri, no engine. There is no DOM test
// environment here, so the breakable parts live in the model and are tested
// there.

/** Every verdict a check can carry. `not_applicable` is a state of its own and
 * is excluded from the pass tally. */
export type Verdict = 'pass' | 'fail' | 'warn' | 'needs_review' | 'not_applicable';

/** What a profile may set a check's severity to. `pass` is not a severity: a
 * check that must never fail is DISABLED, and the report says so. */
export type Severity = 'fail' | 'warn';

export interface ProfileCheck {
  enabled?: boolean;
  severity?: Severity;
  [param: string]: unknown;
}

export interface ProfileFixup {
  id: string;
  params?: Record<string, unknown>;
}

export interface PreflightProfile {
  schema: number;
  id: string;
  /** A USER profile's name is authored content and is never translated. */
  name: string;
  /** SHIPPED profiles only — the catalog key their name renders through. */
  name_key?: string;
  description_key?: string;
  /** Provenance for a derived profile: the shipped rule it started from. */
  based_on?: string;
  checks: Record<string, ProfileCheck>;
  fixups: ProfileFixup[];
}

export const PROFILE_SCHEMA = 1;

/**
 * The engine's check inventory, mirrored: id → category, in report order.
 *
 * The engine is the authority (`engine/preflight_profiles.py`'s
 * CHECK_INVENTORY); this mirror is what derives the catalog keys, so a check
 * the engine reports and this list omits would render nameless.
 * `tests/preflight-report.test.ts` reads the engine module as source text and
 * fails on any divergence.
 */
export const CHECK_INVENTORY: readonly (readonly [string, string])[] = [
  ['pdf_version', 'document'],
  ['print_permitted', 'document'],
  ['structurally_sound', 'document'],
  ['output_intent', 'document'],
  ['pdfx_claim', 'document'],
  ['trapped_declared', 'document'],
  ['embedded_files', 'document'],
  ['page_size_consistent', 'pages'],
  ['page_size_expected', 'pages'],
  ['trim_box', 'pages'],
  ['bleed_sufficient', 'pages'],
  ['page_count', 'pages'],
  ['colour_family', 'colour'],
  ['grayscale_only', 'colour'],
  ['device_independent_colour', 'colour'],
  ['spot_ink_count', 'colour'],
  ['spot_ink_names', 'colour'],
  ['ink_coverage_max', 'colour'],
  ['overprint', 'colour'],
  ['fonts_embedded', 'fonts'],
  ['fonts_subset', 'fonts'],
  ['type3_fonts', 'fonts'],
  ['min_type_size', 'fonts'],
  ['small_text_k_only', 'fonts'],
  ['image_min_dpi_contone', 'images'],
  ['image_min_dpi_bitonal', 'images'],
  ['image_max_dpi', 'images'],
  ['image_compression', 'images'],
  ['image_colour_space', 'images'],
  ['live_transparency', 'content'],
  ['hairlines_absent', 'content'],
  ['optional_content', 'content'],
  ['processing_steps', 'content'],
  ['printing_annotations', 'content'],
  ['interactive_form', 'content'],
  ['title_present', 'metadata'],
  ['document_javascript', 'metadata'],
  ['xmp_present', 'metadata'],
];

export const CATEGORY_IDS: readonly string[] = [
  'document',
  'pages',
  'colour',
  'fonts',
  'images',
  'content',
  'metadata',
];

/** The nine ids the engine reserves. A user profile may never claim one, which
 * is what keeps "reset to the shipped rule" available. Mirrored for the
 * picker's ordering and the editor's write guard; the engine still refuses. */
export const SHIPPED_PROFILE_IDS: readonly string[] = [
  'sheetfed_offset',
  'web_offset_heatset',
  'newsprint',
  'digital_printing',
  'large_format',
  'pdfx_1a',
  'pdfx_3',
  'pdfx_4',
  'office_print',
];

export const DEFAULT_PROFILE_ID = 'sheetfed_offset';

/** The fixup ids a profile may name, mirrored so the editor can offer them. */
export const FIXUP_IDS: readonly string[] = [
  'remove_javascript',
  'remove_attachments',
  'remove_annotations',
  'embed_missing_fonts',
  'convert_to_cmyk',
  'convert_to_grayscale',
  'spots_to_process',
  'alias_spot',
  'downsample_images',
  'fix_hairlines',
  'flatten_transparency',
  'set_trim_box',
  'grow_bleed_box',
  'set_document_title',
  'set_trapped',
  'write_xmp',
  'set_pdf_version',
  'convert_to_pdfx',
  'convert_to_pdfa',
  'add_printer_marks',
];

export function isShippedProfileId(id: string): boolean {
  return SHIPPED_PROFILE_IDS.includes(id);
}

/** How one parameter is edited. The engine's bound is what refuses a bad
 * value; this only decides which control the editor draws. */
export type ParamKind = 'number' | 'integer' | 'text' | 'boolean' | 'list';

export function paramKind(value: unknown): ParamKind {
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return 'text';
}

/** The unit a parameter's value is spelled with, or '' where it has none. The
 * unit goes through the catalog with a placeholder; it is never concatenated. */
export function paramUnit(name: string): 'pt' | 'dpi' | 'pct' | '' {
  if (name.endsWith('_pt')) return 'pt';
  if (name.endsWith('_dpi') || name === 'dpi') return 'dpi';
  if (name.endsWith('_pct')) return 'pct';
  return '';
}

// ── the store ─────────────────────────────────────────────────────────────
//
// The panel's own list of user profiles, on the guided-actions store
// conventions: one key, a reader that can never throw at a caller, and one
// write path. The PORTABLE artefact is the exported `.json` file — that is
// what makes a shop's profile hand-able to its customers — and this is only
// the list the picker offers.

const KEY = 'spectra-preflight-profiles';

function coerce(entry: unknown): PreflightProfile | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  if (isShippedProfileId(raw.id)) return null;
  const checks = raw.checks;
  const fixups = raw.fixups;
  return {
    schema: PROFILE_SCHEMA,
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    ...(typeof raw.based_on === 'string' && raw.based_on ? { based_on: raw.based_on } : {}),
    checks: checks && typeof checks === 'object' && !Array.isArray(checks)
      ? (checks as Record<string, ProfileCheck>)
      : {},
    fixups: Array.isArray(fixups) ? (fixups as ProfileFixup[]) : [],
  };
}

export function loadUserProfiles(): PreflightProfile[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: PreflightProfile[] = [];
    for (const entry of raw) {
      const profile = coerce(entry);
      // Ids are identity: a duplicate would make "which profile is this"
      // ambiguous in a picker whose whole job is to answer that.
      if (profile && !out.some((p) => p.id === profile.id)) out.push(profile);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveUserProfiles(profiles: readonly PreflightProfile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles));
  } catch {
    // storage full or unavailable — the nine shipped profiles still resolve
  }
}

/** Store one profile, replacing an earlier one with the same id. Returns the
 * new list; a shipped id is refused here as well as at the engine. */
export function storeProfile(profile: PreflightProfile): PreflightProfile[] {
  if (isShippedProfileId(profile.id)) return loadUserProfiles();
  const next = loadUserProfiles().filter((p) => p.id !== profile.id);
  next.push(profile);
  next.sort((a, b) => a.name.localeCompare(b.name));
  saveUserProfiles(next);
  return next;
}

export function removeProfile(id: string): PreflightProfile[] {
  const next = loadUserProfiles().filter((p) => p.id !== id);
  saveUserProfiles(next);
  return next;
}

// ── deriving ──────────────────────────────────────────────────────────────

/** A slug that can be a profile id: lowercase, ASCII-safe, never empty. */
export function profileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'profile';
}

/** An id nothing already uses, shipped or stored. */
export function freeProfileId(base: string, taken: readonly string[]): string {
  const seed = profileSlug(base);
  const used = new Set([...SHIPPED_PROFILE_IDS, ...taken]);
  if (!used.has(seed)) return seed;
  for (let n = 2; ; n += 1) {
    const candidate = `${seed}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * A copy of `base` under a new name.
 *
 * Saving a shipped profile with an edit creates a DERIVED profile rather than
 * overwriting the shipped one, which is what makes "reset to the shipped rule"
 * always available. `based_on` records where it came from, so a report a year
 * later still says which press rule it started as.
 */
export function deriveProfile(
  base: PreflightProfile,
  name: string,
  taken: readonly string[],
): PreflightProfile {
  return {
    schema: PROFILE_SCHEMA,
    id: freeProfileId(name, taken),
    name,
    based_on: base.based_on || base.id,
    checks: JSON.parse(JSON.stringify(base.checks ?? {})) as Record<string, ProfileCheck>,
    fixups: JSON.parse(JSON.stringify(base.fixups ?? [])) as ProfileFixup[],
  };
}

/** The picker's order: the nine shipped rules in their own order, then the
 * user's by name. A shop's own profile sits below the ones it was derived
 * from, never scattered through them. */
export function pickerOrder(
  shipped: readonly PreflightProfile[],
  user: readonly PreflightProfile[],
): PreflightProfile[] {
  const byId = new Map(shipped.map((p) => [p.id, p]));
  const ordered = SHIPPED_PROFILE_IDS.map((id) => byId.get(id)).filter(
    (p): p is PreflightProfile => Boolean(p),
  );
  return [...ordered, ...[...user].sort((a, b) => a.name.localeCompare(b.name))];
}

// ── the file shape ────────────────────────────────────────────────────────

export const PROFILE_FILE_KIND = 'spectra-preflight-profile';

export interface ProfileRefusal {
  key: string;
  vars?: Record<string, string>;
}

export type ProfileParse =
  | { ok: true; profile: PreflightProfile }
  | { ok: false; refusal: ProfileRefusal };

/**
 * Read a profile FILE, or refuse loudly.
 *
 * The refusals here are about the FILE — is it JSON, is it this app's kind, is
 * there a profile in it. Whether the RULE is valid is the engine's answer and
 * only the engine's; this never second-guesses a parameter. A file that cannot
 * be imported imports NOTHING: a half-read rule set is a rule nobody wrote.
 */
export function parseProfileFile(text: string): ProfileParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, refusal: { key: 'panel.preflight.import.notJson' } };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, refusal: { key: 'panel.preflight.import.notProfile' } };
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.kind === 'string' && doc.kind !== PROFILE_FILE_KIND) {
    return {
      ok: false,
      refusal: { key: 'panel.preflight.import.wrongKind', vars: { kind: doc.kind } },
    };
  }
  const body = (doc.profile && typeof doc.profile === 'object' ? doc.profile : doc) as
    Record<string, unknown>;
  if (typeof body.id !== 'string' || !body.id.trim()) {
    return { ok: false, refusal: { key: 'panel.preflight.import.noId' } };
  }
  const schema = body.schema ?? PROFILE_SCHEMA;
  if (schema !== PROFILE_SCHEMA) {
    return {
      ok: false,
      refusal: {
        key: 'panel.preflight.import.wrongSchema',
        vars: { schema: String(schema), expected: String(PROFILE_SCHEMA) },
      },
    };
  }
  const profile = coerce(body);
  if (!profile) {
    return {
      ok: false,
      refusal: { key: 'panel.preflight.import.shippedId', vars: { id: String(body.id) } },
    };
  }
  return { ok: true, profile };
}

/** Write a profile out in the SAME shape the import accepts. That symmetry is
 * the point: a print shop hands this file to its customers. */
export function profileToJson(profile: PreflightProfile): string {
  return `${JSON.stringify(
    {
      kind: PROFILE_FILE_KIND,
      version: PROFILE_SCHEMA,
      profile: {
        schema: PROFILE_SCHEMA,
        id: profile.id,
        name: profile.name,
        ...(profile.based_on ? { based_on: profile.based_on } : {}),
        checks: profile.checks ?? {},
        fixups: profile.fixups ?? [],
      },
    },
    null,
    2,
  )}\n`;
}

/** The file name an exported profile lands on. */
export function profileFileName(profile: PreflightProfile): string {
  const base = (profile.name || profile.id).replace(/[\\/:*?"<>|]/g, '_').trim();
  return `${base || 'preflight-profile'}.json`;
}
