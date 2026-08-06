// The hidden-information report, as data.
//
// The panel renders this and owns no rules: which categories can be selected,
// which cost the document something, what the before/after comparison says,
// and when a report has stopped describing the file are all decided here,
// where they are testable without a DOM.
//
// Two properties this module exists to hold:
//
//   * NOTHING IS SELECTED BY DEFAULT. The report is the feature; a pass that
//     pre-checked its own boxes would be a sweep with a report attached.
//   * THE COMPARISON IS THE HONESTY CHECK. A category whose remover left
//     something behind comes back with a non-zero count, and `compare` reports
//     that as a residue rather than as a success.

/** Every category the audit reports, in report order. Mirrors the engine's
 * own list; a drift shows up as a row the panel cannot label. */
export const CATEGORY_IDS = [
  'metadata',
  'embedded_files',
  'bookmarks',
  'comments',
  'form_fields',
  'javascript',
  'hidden_layers',
  'hidden_text',
  'prior_revisions',
  'unreferenced_objects',
  'links_and_actions',
  'thumbnails',
  'attached_structure',
  'signatures',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Categories whose removal takes something a reader may want. They are
 * offered, they are never pre-selected, and the surface says what is lost. */
export const COSTLY_CATEGORIES: readonly CategoryId[] = ['form_fields', 'attached_structure'];

/** The hidden-text kinds. `partially_covered` is reported and never removed —
 * the uncovered half is content. `ocr_layer` is removable only when it is
 * asked for by name, because removing it makes a scan unsearchable. */
export const TEXT_KIND_IDS = [
  'off_layer',
  'invisible',
  'ocr_layer',
  'background_fill',
  'covered',
  'partially_covered',
] as const;

export type TextKind = (typeof TEXT_KIND_IDS)[number];

export interface AuditDetail {
  readonly where?: string;
  readonly name?: string;
  readonly via?: string;
  readonly bytes?: number;
  readonly page?: number;
  readonly kind?: string;
  readonly text?: string;
  readonly title?: string;
  readonly author?: string;
  readonly contents?: string;
  readonly subtype?: string;
  readonly value?: string;
  readonly type?: string;
  readonly target?: string;
  readonly site?: string;
  readonly revisions?: number;
  readonly recoverable_bytes?: number;
  readonly destroys_signatures?: number;
  readonly objects?: number;
  readonly keys?: readonly string[];
  readonly replaced?: boolean;
}

export interface AuditCategory {
  readonly id: string;
  readonly count: number;
  readonly removable: boolean;
  readonly detail: readonly AuditDetail[];
  readonly detail_truncated?: boolean;
  readonly unreadable?: boolean;
  readonly xfa?: boolean;
  readonly content_blocks?: number;
  readonly by_kind?: Readonly<Record<string, number>>;
  readonly certification?: string | null;
}

export interface AuditSignatures {
  readonly count: number;
  readonly document_timestamps: number;
  readonly certification: string | null;
}

export interface UnreadableEntry {
  readonly category: string;
  readonly page: number | null;
  readonly reason: string;
}

export interface AuditReport {
  readonly file: string;
  readonly categories: readonly AuditCategory[];
  readonly signatures: AuditSignatures;
  readonly pages_analyzed: number;
  readonly pages: number;
  readonly unreadable: readonly UnreadableEntry[];
}

/** A report, plus the buffer it was taken from. A report describes bytes; when
 * the bytes change it stops being about the open document, and a stale report
 * offered as a checklist would remove categories from a file that no longer
 * has them. */
export interface HeldReport {
  readonly report: AuditReport;
  readonly buffer: unknown;
}

export function isStale(held: HeldReport | null, buffer: unknown): boolean {
  return held !== null && held.buffer !== buffer;
}

export function categoryOf(report: AuditReport, id: string): AuditCategory | null {
  return report.categories.find((c) => c.id === id) ?? null;
}

export function countOf(report: AuditReport, id: string): number {
  return categoryOf(report, id)?.count ?? 0;
}

/** Can the user check this row? A category with no remover, and one the audit
 * could not read, are shown with their count and no checkbox. */
export function isSelectable(category: AuditCategory): boolean {
  return category.removable && !category.unreadable;
}

/** How many of a category's hidden-text findings fall in one kind. */
export function textKindCount(report: AuditReport, kind: TextKind): number {
  return categoryOf(report, 'hidden_text')?.by_kind?.[kind] ?? 0;
}

/** The hidden-text findings a removal would act on, given the recognition
 * opt-in. Partial coverage is never included. */
export function removableTextCount(report: AuditReport, includeOcrLayer: boolean): number {
  const kinds = categoryOf(report, 'hidden_text')?.by_kind ?? {};
  let total = 0;
  for (const [kind, n] of Object.entries(kinds)) {
    if (kind === 'partially_covered') continue;
    if (kind === 'ocr_layer' && !includeOcrLayer) continue;
    total += n;
  }
  return total;
}

export type Selection = ReadonlySet<string>;

export function emptySelection(): Selection {
  return new Set<string>();
}

export function toggle(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selection as the engine takes it: report order, and only rows that are
 * both selectable and actually present. */
export function selectedCategories(report: AuditReport, selection: Selection): string[] {
  return report.categories
    .filter((c) => selection.has(c.id) && isSelectable(c))
    .map((c) => c.id);
}

/** Selecting everything that costs nothing — the convenience the surfaces
 * offer. The costly categories and the recognition sub-class stay out: a
 * shortcut that silently destroyed a document's accessibility tree would be
 * the same defect as a panel that pre-checked them. */
export function allRemovable(report: AuditReport): Selection {
  return new Set(
    report.categories
      .filter(
        (c) =>
          isSelectable(c) &&
          c.count > 0 &&
          !(COSTLY_CATEGORIES as readonly string[]).includes(c.id),
      )
      .map((c) => c.id),
  );
}

export interface ComparisonRow {
  readonly id: string;
  readonly before: number;
  readonly after: number;
  readonly selected: boolean;
  /** Selected, and something is still there. The panel says so instead of
   * reporting success over a file that still carries the payload. */
  readonly residue: boolean;
}

export function compare(
  before: AuditReport,
  after: AuditReport,
  selection: readonly string[],
): ComparisonRow[] {
  const chosen = new Set(selection);
  return before.categories.map((category) => {
    const now = countOf(after, category.id);
    const picked = chosen.has(category.id);
    return {
      id: category.id,
      before: category.count,
      after: now,
      selected: picked,
      residue: picked && now > 0,
    };
  });
}

/** The rows whose remover did not fully clear them. */
export function residues(rows: readonly ComparisonRow[]): ComparisonRow[] {
  return rows.filter((r) => r.residue);
}

/** Is a sanitize pass available at all? A category the audit could not read
 * refuses the whole pass at the engine, so the surface says why first. */
export function blockedReason(report: AuditReport): UnreadableEntry | null {
  return report.unreadable.length > 0 ? report.unreadable[0] : null;
}

export interface SanitizeRequest {
  readonly categories: string[];
  readonly formFieldsMode: 'remove' | 'flatten';
  readonly includeOcrLayer: boolean;
  readonly signatures: AuditSignatures;
  /** How many signatures collapsing the prior revisions destroys, as the
   * report itself measured it. Named before the choice, not after. */
  readonly destroysSignatures: number;
}

export function buildRequest(
  report: AuditReport,
  selection: Selection,
  formFieldsMode: 'remove' | 'flatten',
  includeOcrLayer: boolean,
): SanitizeRequest {
  const revisions = categoryOf(report, 'prior_revisions')?.detail?.[0];
  return {
    categories: selectedCategories(report, selection),
    formFieldsMode,
    includeOcrLayer,
    signatures: report.signatures,
    destroysSignatures: revisions?.destroys_signatures ?? report.signatures.count,
  };
}
