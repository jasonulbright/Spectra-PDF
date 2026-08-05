// The Combine Files list model.
//
// Combine is Create PDF with two differences, and only two: every member may
// contribute a PAGE RANGE, and the assembled result can land in a document
// that is already open instead of in a new file. Everything else — the row
// model, the kind badges, add/remove/reorder, the accepted set — is the SAME
// module (`lib/create-pdf.ts`), deliberately: two list models would be the
// "fixed four times at four dispatchers" mistake in list form, and a user who
// learns one dialog has learned the other.
//
// A leaf data + pure-function module with no React and no engine calls, for
// There is no DOM test environment here, so a
// rule living inside the component is a rule with no test.

import type { SourceKind, SourceRow } from './create-pdf';

/** Where the assembled pages go. */
export const COMBINE_TARGETS = ['new', 'append'] as const;
export type CombineTarget = (typeof COMBINE_TARGETS)[number];

/** A document Combine can append into — the shape App hands the dialog. */
export interface CombineDestination {
  docId: string;
  name: string;
  pages: number;
}

/**
 * What each kind goes through on its way in — shown per row BEFORE the run,
 * because "how will this be converted?" is the question a combine of mixed
 * sources actually raises, and answering it afterwards is answering it late.
 */
export const CONVERTER_LABEL_KEYS: Record<Exclude<SourceKind, ''>, string> = {
  pdf: 'dialog.combine.viaNone',
  blank: 'dialog.combine.viaNone',
  image: 'dialog.combine.viaImage',
  office: 'dialog.combine.viaOffice',
  postscript: 'dialog.combine.viaPostScript',
};

/** What a row's badge column says right now. */
export type RowState = 'unsupported' | 'error' | 'ready';

export function rowState(row: SourceRow): RowState {
  if (row.kind === '') return 'unsupported';
  if (row.error) return 'error';
  return 'ready';
}

// One page or one span per comma-separated part. Deliberately the SAME shape
// `engine/create_pdf.py`'s `_RANGE_PART` accepts — the dialog refusing early
// and the engine refusing late must not disagree about what "1-3,5" means.
const RANGE_PART = /^\s*\d+\s*(?:-\s*\d+\s*)?$/;

/**
 * Is this a page range the engine will accept? An EMPTY spec is valid and
 * means "every page" — the field starts empty, and a user who has not typed
 * anything yet has not made a mistake.
 *
 * Whether the numbers land inside the document is the ENGINE's answer (it is
 * the half that has the file); this only rejects what is not a range at all.
 */
export function isValidPageRange(spec: string): boolean {
  const trimmed = spec.trim();
  if (trimmed === '') return true;
  const parts = trimmed.split(',');
  return parts.every((part) => part.trim() !== '' && RANGE_PART.test(part));
}

/** Ranges are offered per MEMBER, but only where the count is knowable
 * up front — a PDF. A `.docx`'s page count is a property of the conversion,
 * so a range typed before it runs would be a guess dressed as a choice. */
export function supportsPageRange(row: SourceRow): boolean {
  return row.kind === 'pdf';
}

/**
 * How many pages a range selects out of a document of `max` pages.
 *
 * A FAITHFUL mirror of `engine/split.py`'s `parse_ranges`, down to the parts
 * that look like bugs and are not: a span's end is CLAMPED to the document
 * and out-of-document pages drop out (so "1-999" of a 6-page PDF is 6 and
 * "99" is 0), a reversed span selects nothing, and a page named twice is
 * contributed twice (the engine's list is not a set, and "1,1" really does
 * emit the page twice). Guessing differently here would make the dialog's
 * preview disagree with the file it produces.
 */
export function rangeCount(spec: string, max: number): number {
  const trimmed = spec.trim();
  if (trimmed === '' || !isValidPageRange(trimmed)) return max;
  const picked: number[] = [];
  for (const part of trimmed.split(',')) {
    const [from, to] = part.split('-');
    if (to === undefined) {
      picked.push(Number.parseInt(from, 10) - 1);
      continue;
    }
    const start = Number.parseInt(from, 10) - 1;
    const end = Math.min(Number.parseInt(to, 10), max);
    for (let index = start; index < end; index += 1) picked.push(index);
  }
  return picked.filter((index) => index >= 0 && index < max).length;
}

export function setRowRange(
  rows: readonly SourceRow[],
  id: string,
  spec: string,
): SourceRow[] {
  return rows.map((row) => (row.id === id ? { ...row, pages: spec } : row));
}

export function setRowPageCount(
  rows: readonly SourceRow[],
  id: string,
  pageCount: number,
): SourceRow[] {
  return rows.map((row) => (row.id === id ? { ...row, pageCount } : row));
}

export function setRowContributed(
  rows: readonly SourceRow[],
  id: string,
  contributed: number,
): SourceRow[] {
  return rows.map((row) => (row.id === id ? { ...row, contributed } : row));
}

export function setRowError(
  rows: readonly SourceRow[],
  id: string,
  error: string,
): SourceRow[] {
  return rows.map((row) => (row.id === id ? { ...row, error } : row));
}

/** Drop every per-row RESULT before a new run, keeping what the user typed
 * and what was PROBED. Without this a row that failed once keeps its old
 * error beside its new success, which reads as a run that half-worked; and a
 * PDF's own page count is not a result — it does not change because a combine
 * failed, and dropping it would blank the range preview for no reason. */
export function clearRowResults(rows: readonly SourceRow[]): SourceRow[] {
  return rows.map(({ error: _error, contributed: _contributed, ...row }) => row);
}

/** One `sources` row as the engine reports it back. */
export interface CombineSourceReport {
  path?: string;
  kind: string;
  pages: number;
  error?: string;
  fonts_substituted?: string[];
}

/**
 * Fold the engine's per-source report back onto the list.
 *
 * By INDEX, because the engine emits exactly one row per source in the order
 * it was given — including the skipped ones (`on_unsupported: "skip"` appends
 * a row carrying the error rather than dropping it). Matching by path instead
 * would collapse two rows naming the same file, which Create PDF forbids but
 * a hand-built call does not.
 */
export function applyReport(
  rows: readonly SourceRow[],
  reported: readonly CombineSourceReport[],
): SourceRow[] {
  return rows.map((row, index) => {
    const report = reported[index];
    if (!report) return row;
    // `contributed`, never `pageCount`: the report counts what this member
    // PUT IN, which for a ranged member is not what it has.
    const next: SourceRow = { ...row, contributed: report.pages };
    if (report.error) next.error = report.error;
    else delete next.error;
    return next;
  });
}

/**
 * Why the Combine button is disabled, as a catalog KEY, or null when it is
 * not. Keys rather than sentences: this module stays free of i18next, and the
 * component renders the reason where the user is looking.
 */
export function combineBlocker(
  rows: readonly SourceRow[],
  target: CombineTarget,
  destination: CombineDestination | null,
): string | null {
  if (rows.length === 0) return 'dialog.combine.needsSources';
  if (rows.every((row) => row.kind === 'blank')) return 'dialog.combine.needsSources';
  if (rows.some((row) => row.kind === '')) return 'dialog.combine.hasUnsupported';
  if (rows.some((row) => !isValidPageRange(row.pages ?? ''))) {
    return 'dialog.combine.badRange';
  }
  if (target === 'append' && destination === null) return 'dialog.combine.needsDestination';
  return null;
}

/** What ONE row will contribute, or null while that is not yet knowable.
 *
 * A finished run's REPORTED count wins over the derived preview — it is what
 * actually happened, and for a converted source it is the only count anybody
 * has. */
export function rowContribution(row: SourceRow): number | null {
  if (row.kind === '' || row.error) return null;
  if (typeof row.contributed === 'number') return row.contributed;
  if (row.kind === 'blank') return 1;
  if (typeof row.pageCount !== 'number') return null;
  const spec = row.pages ?? '';
  return spec.trim() === '' ? row.pageCount : rangeCount(spec, row.pageCount);
}

/**
 * The pages this list will contribute, as far as it is currently known, and
 * whether anything is still unknown.
 *
 * `known` is false when any member's contribution cannot be counted yet (an
 * unconverted `.docx`, whose page count is a property of the conversion),
 * which is what stops the dialog claiming a total it has not earned.
 */
export function plannedPages(rows: readonly SourceRow[]): { pages: number; known: boolean } {
  let pages = 0;
  let known = true;
  for (const row of rows) {
    const contribution = rowContribution(row);
    if (contribution === null) known = false;
    else pages += contribution;
  }
  return { pages, known };
}
