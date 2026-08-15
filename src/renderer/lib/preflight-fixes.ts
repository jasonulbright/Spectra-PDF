// Which preflight findings the panel can repair, and how.
//
// The ENGINE owns what a fixup DOES and the order a pass runs them in
// (`engine/preflight_fixups.py` is the one table of check → doors). This table
// owns the other half — what the SURFACE offers: whether a check gets a button
// or a field, whose value the field takes, and which fixup an authored value
// belongs to. The two halves answer different questions, and
// `tests/preflight-fixes.test.ts` pins this one against the engine module's own
// lists so a fixup cannot be automatic in one and authored in the other.
//
// The `a11y-fixes.ts` shape, deliberately: a user reading both panels is
// reading one product, and a second vocabulary for "this row has a fix" would
// make them two.
import type { Check } from './preflight-report';

/** How a finding is repaired. */
export type FixKind = 'auto' | 'authored';

/** What an authored fixup asks for. */
export type FixInput = 'text' | 'number' | 'trapped' | 'ink';

export interface AuthoredFix {
  /** The fixup id the value belongs to. */
  fixup: string;
  /** The control the value is typed into. */
  input: FixInput;
  /** The parameter the value lands on. */
  param: string;
  /** Whether the value repairs the whole check at once or one finding. An
   * ink alias is per finding because the ink it moves is the finding itself;
   * everything else is one value for the document. */
  scope: 'check' | 'finding';
  /** Catalog suffix for the field's label and its placeholder. */
  field: 'title' | 'trapped' | 'bleed' | 'ink';
}

export interface FixOffer {
  kind: FixKind;
  /** Every fixup this row's control runs, in the engine's own order. */
  fixups: readonly string[];
  authored?: AuthoredFix;
}

/**
 * The engine's `CHECK_FIXUPS`, mirrored. A check absent from this map routes
 * to the surface that owns the edit instead — inventing a fix this app cannot
 * perform is worse than the route.
 */
export const CHECK_FIXUPS: Readonly<Record<string, readonly string[]>> = {
  pdf_version: ['set_pdf_version'],
  output_intent: ['convert_to_pdfx'],
  pdfx_claim: ['convert_to_pdfx'],
  trapped_declared: ['set_trapped'],
  embedded_files: ['remove_attachments'],
  trim_box: ['set_trim_box'],
  bleed_sufficient: ['grow_bleed_box'],
  colour_family: ['convert_to_cmyk'],
  grayscale_only: ['convert_to_grayscale'],
  device_independent_colour: ['convert_to_cmyk'],
  spot_ink_count: ['spots_to_process'],
  spot_ink_names: ['alias_spot', 'spots_to_process'],
  fonts_embedded: ['embed_missing_fonts'],
  image_max_dpi: ['downsample_images'],
  image_compression: ['downsample_images'],
  image_colour_space: ['convert_to_cmyk'],
  live_transparency: ['flatten_transparency'],
  hairlines_absent: ['fix_hairlines'],
  printing_annotations: ['remove_annotations'],
  title_present: ['set_document_title'],
  document_javascript: ['remove_javascript'],
  xmp_present: ['write_xmp'],
};

/** The engine's `AUTHORED_FIXUPS`, mirrored — the four whose value no machine
 * may invent. */
export const AUTHORED_FIXUPS: readonly string[] = [
  'alias_spot',
  'grow_bleed_box',
  'set_document_title',
  'set_trapped',
];

/** The trapping states `/Trapped` may carry. There is no fourth: the flag is a
 * claim, and "unknown" is the claim that no claim has been made. */
export const TRAPPED_STATES = ['true', 'false', 'unknown'] as const;

const AUTHORED: Record<string, AuthoredFix> = {
  alias_spot: {
    fixup: 'alias_spot',
    input: 'ink',
    param: 'target',
    scope: 'finding',
    field: 'ink',
  },
  grow_bleed_box: {
    fixup: 'grow_bleed_box',
    input: 'number',
    param: 'bleed_pt',
    scope: 'check',
    field: 'bleed',
  },
  set_document_title: {
    fixup: 'set_document_title',
    input: 'text',
    param: 'title',
    scope: 'check',
    field: 'title',
  },
  set_trapped: {
    fixup: 'set_trapped',
    input: 'trapped',
    param: 'trapped',
    scope: 'check',
    field: 'trapped',
  },
};

/** The verdicts a fix is offered against — the engine's `_FIXABLE_STATES`. A
 * `warn` is short of the recommendation, which is still something a door
 * repairs. */
export function isFixableStatus(status: string): boolean {
  return status === 'fail' || status === 'warn';
}

/** Which fixups of a profile's set could answer this check, in the profile's
 * own listing order. Nothing is offered that the profile does not carry: a
 * button whose only outcome is "that profile has no fixup for this" is worse
 * than no button. */
export function carriedFixups(
  checkId: string,
  carried: readonly string[],
): readonly string[] {
  const doors = CHECK_FIXUPS[checkId] ?? [];
  return doors.filter((id) => carried.includes(id));
}

/**
 * What this check offers right now, or null for nothing.
 *
 * A check whose only carried fixup is an authored one gets a field; a check
 * with an automatic one gets a button, even where an authored fixup is also
 * carried — `spot_ink_names` is the case that makes the rule concrete, and
 * converting the unlisted spots to process is the answer that needs nothing
 * typed.
 */
export function fixFor(check: Check, carried: readonly string[]): FixOffer | null {
  if (!isFixableStatus(check.status)) return null;
  const doors = carriedFixups(check.id, carried);
  if (doors.length === 0) return null;
  const automatic = doors.filter((id) => !AUTHORED_FIXUPS.includes(id));
  if (automatic.length > 0) return { kind: 'auto', fixups: automatic };
  return { kind: 'authored', fixups: doors, authored: AUTHORED[doors[0]] };
}

/** Every check the "fix what this profile can" control would repair — the
 * failing and warning rows whose doors this profile carries. A control that
 * offered more than it runs would report a success over rows it never
 * touched. */
export function fixableChecks(
  checks: readonly Check[],
  carried: readonly string[],
): string[] {
  return checks
    .filter((check) => fixFor(check, carried)?.kind === 'auto')
    .map((check) => check.id);
}

/** The engine call one row's fix becomes.
 *
 * `checks` names the CHECK, not the door: the engine resolves it through its
 * own table and applies the result in its own canonical order, so the panel
 * never states a sequence of its own. */
export interface FixCall {
  method: 'apply_preflight_fixups';
  params: Record<string, unknown>;
}

export function autoFixCall(profile: unknown, checks: readonly string[]): FixCall | null {
  if (checks.length === 0) return null;
  return {
    method: 'apply_preflight_fixups',
    params: { profile, checks: [...checks] },
  };
}

/**
 * One authored value, as the profile the run measures against.
 *
 * An authored fixup's value is a PARAMETER of the profile's own fixup entry,
 * so it travels as a profile with that one parameter filled in rather than as
 * a second argument the engine would have to merge. The engine then validates
 * it like any other rule — there is one validator, and this is not it.
 */
export function authoredFixProfile(
  profile: { fixups: { id: string; params: Record<string, unknown> }[] },
  authored: AuthoredFix,
  value: string,
  extra: Record<string, unknown> = {},
): { profile: unknown; checks: string[] } | null {
  const text = value.trim();
  if (!text) return null;
  let typed: unknown = text;
  if (authored.input === 'number') {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    typed = parsed;
  }
  if (authored.input === 'trapped' && !(TRAPPED_STATES as readonly string[]).includes(text)) {
    return null;
  }
  const patched = {
    ...profile,
    fixups: profile.fixups.map((entry) =>
      entry.id === authored.fixup
        ? { ...entry, params: { ...entry.params, ...extra, [authored.param]: typed } }
        : entry,
    ),
  };
  return { profile: patched, checks: [authored.fixup] };
}

/** The draft key one editor writes under. A check-scope fixup has one editor
 * for the whole check; a finding-scope one has an editor per row. */
export function draftKey(checkId: string, findingIndex: number | null): string {
  return findingIndex === null ? `fix:${checkId}` : `fix:${checkId}:${findingIndex}`;
}

/** What an authored editor starts with.
 *
 * A bleed editor starts at the profile's own minimum, because the rule the row
 * was measured against is the value that clears it. A title and an ink target
 * start empty: both are values a machine must not invent.
 */
export function suggestionFor(check: Check): string {
  if (check.id === 'bleed_sufficient') {
    const required = Number((check.params ?? {}).min_bleed_pt ?? 0);
    return Number.isFinite(required) && required > 0 ? String(required) : '';
  }
  if (check.id === 'trapped_declared') return 'false';
  return '';
}
