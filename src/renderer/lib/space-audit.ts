// The space report, as data.
//
// The panel renders this and owns no rules: the row order, the share
// rendering, which knob a category maps to, and whether a report still
// describes the open document are decided here, where they are testable
// without a DOM.
//
// The property this module exists to hold: THE ROWS ADD UP. The engine
// attributes every byte of the file to exactly one row, `overhead` last as the
// residual, so `sum(row.bytes) === fileSize`. A report whose rows do not sum
// is reported as inconsistent rather than rendered — a breakdown the reader
// cannot add up is worse than no breakdown.

/** Every category the audit reports, in the engine's own order. A drift shows
 * up as a row the panel cannot label. */
export const CATEGORY_IDS = [
  'images',
  'fonts',
  'content_streams',
  'annotations',
  'forms',
  'embedded_files',
  'bookmarks',
  'named_destinations',
  'tagged_structure',
  'document_structure',
  'metadata',
  'javascript',
  'other_objects',
  'overhead',
] as const;

export type SpaceCategoryId = (typeof CATEGORY_IDS)[number];

/** The controls a category can be addressed by. Only controls that EXIST are
 * listed: a report naming a knob the product does not have would send the
 * reader looking for it. */
export const KNOB_IDS = [
  'compress',
  'compress_streams',
  'strip_metadata',
  'sanitize_comments',
  'sanitize_forms',
  'sanitize_embedded_files',
  'sanitize_bookmarks',
  'sanitize_javascript',
  'sanitize_structure',
  'rewrite',
] as const;

export type KnobId = (typeof KNOB_IDS)[number];

export interface SpaceDetail {
  readonly page?: number | null;
  readonly name?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly bytes: number;
  readonly objects?: number;
}

export interface SpaceCategory {
  readonly id: string;
  readonly bytes: number;
  readonly share: number;
  readonly objects: number;
  readonly knob?: string;
  readonly residual?: boolean;
  readonly detail: readonly SpaceDetail[];
  readonly detail_truncated?: boolean;
}

export interface SpaceReport {
  readonly file_size: number;
  readonly total: number;
  readonly objects: number;
  readonly revisions: number;
  readonly unmeasured_objects: number;
  readonly categories: readonly SpaceCategory[];
}

/** Rows largest first. `overhead` sorts by its size like any other row — it is
 * a real part of the file, not a footnote, and on a small or incrementally
 * updated document it is routinely the largest thing in it.
 *
 * Ties break on the engine's report order so the table does not reshuffle
 * between two audits of the same document. */
export function ranked(report: SpaceReport): readonly SpaceCategory[] {
  const order = new Map<string, number>(CATEGORY_IDS.map((id, i) => [id, i]));
  return [...report.categories].sort((a, b) => {
    if (b.bytes !== a.bytes) return b.bytes - a.bytes;
    return (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
  });
}

/** Does the report account for the file it claims to describe?
 *
 * The engine computes `overhead` by subtraction, so the identity holds by
 * construction and a violation means the payload was not produced by this
 * audit — a truncated response, a stale shape, a hand-built object in a test.
 * Rendering it anyway would show percentages that do not reach 100. */
export function accountsForFile(report: SpaceReport | null): boolean {
  if (!report || report.file_size <= 0) return false;
  const summed = report.categories.reduce((acc, row) => acc + row.bytes, 0);
  return summed === report.file_size && report.total === report.file_size;
}

/** A category's share as a percentage of the file, rounded to one decimal.
 * Derived from the engine's `share` so every surface agrees, and clamped
 * because a negative row would be an accounting failure rendered as a chart. */
export function percentOf(row: SpaceCategory): number {
  const value = Number.isFinite(row.share) ? row.share : 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 10;
}

/** The knob a row maps to, or null when the product has no control for it. */
export function knobOf(row: SpaceCategory): KnobId | null {
  const knob = row.knob;
  return knob && (KNOB_IDS as readonly string[]).includes(knob) ? (knob as KnobId) : null;
}

/** The overhead row's measured parts, in the order they are worth reading:
 * the two a user can act on first. Returns an empty list for any other row. */
export function overheadParts(row: SpaceCategory): readonly SpaceDetail[] {
  if (!row.residual) return [];
  const order = ['superseded', 'unreferenced', 'cross_reference', 'structural'];
  return [...row.detail].sort(
    (a, b) => order.indexOf(a.kind ?? '') - order.indexOf(b.kind ?? ''),
  );
}
