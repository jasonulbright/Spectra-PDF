// Print parameter assembly + range validation (M-P, § 3.4). Pure, so the
// wire contract the dialog sends is unit-testable: the engine's `print_pdf`
// accepts exactly these keys, and `tests/print-params.test.ts` pins them —
// a renamed key here would otherwise only surface as every print failing
// with an unexpected-argument error at run time.

export const MAX_COPIES = 99;

export type FitMode = 'fit' | 'actual';

export interface PrintParams extends Record<string, unknown> {
  file: string;
  printer: string;
  gs_path: string;
  /** Normalized range like "1-3,5"; empty string = all pages. */
  pages: string;
  copies: number;
  fit: FitMode;
}

/**
 * Validate a print range like "1-3, 5" against the document; returns an
 * error message or null. Mirrors the engine's parse_page_spec (which
 * revalidates — this copy exists so the dialog can refuse BEFORE the job is
 * queued, with the field still focused). Strict like the engine: every token
 * N or N-M, 1-based, ascending, within the document. Empty = all pages.
 */
export function pageRangeError(spec: string, pageCount: number): string | null {
  const normalized = spec.replace(/\s+/g, '');
  if (normalized === '') return null;
  for (const token of normalized.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!m) return `Invalid page range: “${token || spec}”`;
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : start;
    if (start < 1 || end < 1) return 'Page numbers start at 1';
    if (end < start) return `Descending range: “${token}”`;
    if (end > pageCount) {
      return `Page ${end} is beyond the document (${pageCount} page${pageCount === 1 ? '' : 's'})`;
    }
  }
  return null;
}

/** "1-3, 5" → "1-3,5" (what -sPageList and the engine expect). */
export function normalizePageRange(spec: string): string {
  return spec.replace(/\s+/g, '');
}

/** Copies must be a whole number 1..99; returns an error message or null. */
export function copiesError(raw: string): string | null {
  if (!/^\d+$/.test(raw.trim())) return 'Copies must be a whole number';
  const n = Number(raw.trim());
  if (n < 1 || n > MAX_COPIES) return `Copies must be between 1 and ${MAX_COPIES}`;
  return null;
}

export function buildPrintParams(opts: {
  file: string;
  printer: string;
  gsPath: string;
  pages: string;
  copies: number;
  fit: FitMode;
}): PrintParams {
  return {
    file: opts.file,
    printer: opts.printer,
    gs_path: opts.gsPath,
    pages: normalizePageRange(opts.pages),
    copies: opts.copies,
    fit: opts.fit,
  };
}
