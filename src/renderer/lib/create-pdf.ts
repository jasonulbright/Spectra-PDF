// P22 — the renderer half of Create PDF (brief 41 § 5.1).
//
// The engine (`engine/create_pdf.py`) is the authority on what converts what;
// this is the SAME table, so a picker can badge a row and refuse a file
// before any engine call. The totality test in `tests/create-pdf.test.ts`
// pins the two together — every accepted suffix must classify to a kind, and
// nothing may classify to a kind the badge list has no label for.
//
// No engine calls here and no React: a leaf data + pure-function module, so
// the list model (add / remove / reorder) is testable without a DOM. There is
// no DOM test environment in this repo, which is exactly why the reorder rules
// live here and not inside the component.

/** What converts a source. `''` is "nothing here does". */
export type SourceKind = 'pdf' | 'image' | 'office' | 'postscript' | 'blank' | '';

/** Mirrors `engine/create_pdf.py`'s IMAGE_SUFFIXES. */
export const IMAGE_SUFFIXES = [
  '.png', '.jpg', '.jpeg', '.jpe', '.tif', '.tiff', '.bmp', '.dib', '.gif',
  '.webp', '.jp2', '.j2k', '.j2c', '.jpc', '.jpf', '.jpx', '.avif', '.heic', '.heif',
] as const;

/** Mirrors `engine/soffice.py`'s OFFICE_SUFFIXES. */
export const OFFICE_SUFFIXES = [
  '.doc', '.docx', '.docm', '.dot', '.dotx', '.odt', '.ott', '.fodt', '.rtf', '.txt',
  '.xls', '.xlsx', '.xlsm', '.xlt', '.xltx', '.ods', '.ots', '.fods', '.csv',
  '.ppt', '.pptx', '.pptm', '.pot', '.potx', '.odp', '.otp', '.fodp',
  '.odg', '.otg', '.html', '.htm', '.xhtml',
] as const;

export const POSTSCRIPT_SUFFIXES = ['.ps', '.eps'] as const;

/** Every extension the dialog's picker offers and its drop target accepts. */
export const ACCEPTED_SUFFIXES: readonly string[] = [
  '.pdf',
  ...IMAGE_SUFFIXES,
  ...POSTSCRIPT_SUFFIXES,
  ...OFFICE_SUFFIXES,
];

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function classify(path: string): SourceKind {
  const ext = extensionOf(path);
  if (ext === '.pdf') return 'pdf';
  if ((IMAGE_SUFFIXES as readonly string[]).includes(ext)) return 'image';
  if ((POSTSCRIPT_SUFFIXES as readonly string[]).includes(ext)) return 'postscript';
  if ((OFFICE_SUFFIXES as readonly string[]).includes(ext)) return 'office';
  return '';
}

/** The catalog key naming each kind in the UI. */
export const KIND_LABEL_KEYS: Record<Exclude<SourceKind, ''>, string> = {
  pdf: 'dialog.createPdf.kindPdf',
  image: 'dialog.createPdf.kindImage',
  office: 'dialog.createPdf.kindOffice',
  postscript: 'dialog.createPdf.kindPostScript',
  blank: 'dialog.createPdf.kindBlank',
};

export const PAGE_SIZES = ['auto', 'first', 'letter', 'legal', 'tabloid', 'a3', 'a4', 'a5'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const ORIENTATIONS = ['auto', 'portrait', 'landscape'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const QUALITY_PRESETS = ['screen', 'ebook', 'printer', 'prepress', 'default'] as const;

/** One row of the dialog's source list. */
export interface SourceRow {
  /** Stable across reorders, so React keys and the row's error survive a move. */
  id: string;
  kind: SourceKind;
  /** Absent for a blank member. */
  path?: string;
}

let nextRowId = 0;

export function rowFromPath(path: string): SourceRow {
  return { id: `s${++nextRowId}`, kind: classify(path), path };
}

export function blankRow(): SourceRow {
  return { id: `s${++nextRowId}`, kind: 'blank' };
}

/**
 * Add paths to the list, skipping ones already present.
 *
 * Duplicate suppression is by path, NOT by row: the same file added twice is
 * almost always a double-click on the picker, while a blank page added twice
 * is deliberate — so blanks never de-duplicate.
 */
export function addPaths(rows: readonly SourceRow[], paths: readonly string[]): SourceRow[] {
  const present = new Set(rows.map((r) => r.path).filter(Boolean));
  const added: SourceRow[] = [];
  for (const path of paths) {
    if (present.has(path)) continue;
    present.add(path);
    added.push(rowFromPath(path));
  }
  return added.length === 0 ? [...rows] : [...rows, ...added];
}

export function removeRow(rows: readonly SourceRow[], id: string): SourceRow[] {
  return rows.filter((r) => r.id !== id);
}

/**
 * Move a row by `delta` positions, clamped.
 *
 * Clamped rather than wrapped: ↑ on the first row must do NOTHING, because a
 * keyboard user holding the key to reach the top would otherwise shoot it to
 * the bottom — the same reason the page-thumbnail reorder clamps.
 */
export function moveRow(rows: readonly SourceRow[], id: string, delta: number): SourceRow[] {
  const from = rows.findIndex((r) => r.id === id);
  if (from < 0) return [...rows];
  const to = Math.max(0, Math.min(rows.length - 1, from + delta));
  if (to === from) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

/** Reorder by drag: `from` lands at `to` (index in the ORIGINAL list). */
export function reorderRows(rows: readonly SourceRow[], from: number, to: number): SourceRow[] {
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length || from === to) {
    return [...rows];
  }
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

/** Is the quality preset meaningful for this list? It is a `distill` parameter
 * and means nothing for an image, an Office file or a blank page, so the
 * control is shown only when a PostScript source is actually present. */
export function needsQualityPreset(rows: readonly SourceRow[]): boolean {
  return rows.some((r) => r.kind === 'postscript');
}

export function hasUnsupported(rows: readonly SourceRow[]): boolean {
  return rows.some((r) => r.kind === '');
}

/** The engine's `sources` argument: order preserved, blanks carried by kind. */
export function toEngineSources(rows: readonly SourceRow[]): Record<string, unknown>[] {
  return rows.map((row) =>
    row.kind === 'blank' ? { kind: 'blank' } : { path: row.path as string },
  );
}

/**
 * The default output name for a list.
 *
 * Named after the FIRST convertible source with its extension swapped for
 * `.pdf` — never after a blank page, which would produce "blank.pdf" for a
 * deck the user added a cover to.
 */
export function defaultOutputPath(rows: readonly SourceRow[]): string | null {
  const first = rows.find((r) => r.path);
  if (!first?.path) return null;
  const ext = extensionOf(first.path);
  const stem = ext ? first.path.slice(0, -ext.length) : first.path;
  return ext === '.pdf' ? `${stem}-combined.pdf` : `${stem}.pdf`;
}
