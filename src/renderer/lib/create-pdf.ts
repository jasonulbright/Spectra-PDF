// The renderer half of Create PDF.
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

/**
 * The chosen sources that need Ghostscript — PostScript and EPS, which it
 * distils. Images, Office documents and PDFs go through other tools
 * entirely, so Create PDF refuses a SOURCE when there is no interpreter,
 * never the whole dialog.
 */
export function postscriptSources(paths: readonly string[]): string[] {
  return paths.filter((path) => classify(path) === 'postscript');
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
  /** Page range to contribute ("1-3,5"); empty/absent means every page.
   * Combine Files offers it per member; Create PDF does not show it. */
  pages?: string;
  /** How many pages this source HAS, probed before any run. Distinct from
   * `contributed` on purpose: a range makes them different numbers, and
   * folding a run's result back into this one would make the next preview
   * apply the range to an already-ranged count. */
  pageCount?: number;
  /** How many pages this source CONTRIBUTED, as the engine reported it. */
  contributed?: number;
  /** Why this row could not be used — set from the engine's own per-row
   * report, so a skipped member is a visible state and never a silent drop. */
  error?: string;
  /** Where the row came from, when it was not picked. Changes only what the
   * row is CALLED: a scratch name is not a thing a user recognises, and the
   * kind badge stays the engine's own answer either way. */
  origin?: 'clipboard' | 'web';
  /** For a clipboard row: which flavour arrived (`lib/clipboard-source.ts`). */
  clipboardKind?: 'image' | 'html' | 'text';
  /** For a web-capture row: the address the page came from, and the title the
   * page gave itself — which is what its bookmark is called. */
  captureUrl?: string;
  captureTitle?: string;
  /** Shared temporary directory identity for pages from one capture run. */
  captureId?: string;
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

/** The capture scratch group that becomes unreferenced when `id` is removed. */
export function captureIdToReleaseOnRowRemoval(
  rows: readonly SourceRow[],
  id: string,
): string | null {
  const removed = rows.find((row) => row.id === id);
  if (!removed?.captureId) return null;
  return rows.some((row) => row.id !== id && row.captureId === removed.captureId)
    ? null
    : removed.captureId;
}

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * One picked or dropped batch in the order the folder listed it.
 *
 * The Windows file dialog and the shell drop both report the FOCUSED item
 * first — the file clicked last — and the rest after it, so appending a batch
 * as delivered makes the last-clicked image page 1. Delivery order carries no
 * user intent; the folder's name order (numeric-aware, so `img2` precedes
 * `img10`) is what the user saw. Order within the list is set afterwards by
 * the row controls.
 */
export function orderSelection(paths: readonly string[]): string[] {
  const dirOf = (path: string) => path.slice(0, path.length - baseName(path).length);
  return [...paths].sort(
    (a, b) => NAME_ORDER.compare(dirOf(a), dirOf(b)) || NAME_ORDER.compare(baseName(a), baseName(b)),
  );
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

/** The image suffixes the webview decodes itself; the rest get no thumbnail. */
const PREVIEW_SUFFIXES = ['.png', '.jpg', '.jpeg', '.jpe', '.gif', '.bmp', '.dib', '.webp', '.avif'];

export function hasThumbnail(row: SourceRow): boolean {
  return row.kind === 'image' && !!row.path && PREVIEW_SUFFIXES.includes(extensionOf(row.path));
}

/**
 * Runs at most `limit` tasks at once; the rest wait in call order. A task
 * whose `live()` is false by its turn is dropped without running.
 */
export function createLimiter(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    while (running < limit && queue.length > 0) queue.shift()!();
  };
  return function run<T>(task: () => Promise<T>, live: () => boolean = () => true): Promise<T | null> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        if (!live()) {
          resolve(null);
          return;
        }
        running += 1;
        task().then(resolve, reject).finally(() => {
          running -= 1;
          pump();
        });
      });
      pump();
    });
  };
}

/** Scroll speed, in pixels per frame, for a drag held `distance` pixels from
 * a list edge inside a `band`-pixel zone; 0 outside the zone. Negative scrolls
 * up. */
export function edgeScrollStep(top: number, bottom: number, y: number, band = 24, max = 12): number {
  if (y < top + band) return -Math.ceil(max * Math.min(1, (top + band - y) / band));
  if (y > bottom - band) return Math.ceil(max * Math.min(1, (y - (bottom - band)) / band));
  return 0;
}

/**
 * Where a dragged row lands: its final index is the number of OTHER rows whose
 * vertical midpoint lies above the pointer. `midpoints` are in list order.
 */
export function dragTargetIndex(midpoints: readonly number[], from: number, y: number): number {
  let to = 0;
  midpoints.forEach((mid, i) => {
    if (i !== from && y > mid) to += 1;
  });
  return to;
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

/**
 * The engine's `sources` argument: order preserved, blanks carried by kind.
 *
 * A page range rides only when the row actually has one — the engine REFUSES
 * a range on a blank member, and an empty string would be a range the user
 * never typed.
 */
export function toEngineSources(rows: readonly SourceRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row.kind === 'blank') return { kind: 'blank' };
    const spec = (row.pages ?? '').trim();
    return spec ? { path: row.path as string, pages: spec } : { path: row.path as string };
  });
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
