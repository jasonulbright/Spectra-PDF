// Print parameter assembly + validation. Pure, so the wire
// contract the dialog sends is unit-testable: the engine's `print_pdf`
// accepts exactly these keys, and `tests/print-params.test.ts` pins them —
// a renamed key here would otherwise only surface as every print failing
// with an unexpected-argument error at run time. The Python side pins the
// same set from its signature (TestPrintPdf.test_wire_contract...).

// The VALIDATION messages below are dialog chrome, so they resolve
// through the catalog. The wire contract this module builds is untouched
// — engine keys and values stay exactly as pinned.
import { tChrome, tChromeCount } from '../i18n';

export const MAX_COPIES = 999;

export type FitMode = 'fit' | 'actual' | 'scale';
export type PageSubset = 'all' | 'odd' | 'even';
export type DuplexMode = 'printer' | 'simplex' | 'long' | 'short';
export type OrientationMode = 'auto' | 'portrait' | 'landscape';
export type ColorMode = 'printer' | 'color' | 'gray';
export type AnnotsMode = 'all' | 'document' | 'stamps';
export type PrintLayout = 'single' | 'nup' | 'booklet' | 'poster';
export type NupOrder =
  | 'horizontal'
  | 'horizontal-reversed'
  | 'vertical'
  | 'vertical-reversed';
export type BookletSubset = 'both' | 'front' | 'back';
export type BookletBinding = 'left' | 'right';

export const IMAGE_DPI_CHOICES = [150, 300, 600] as const;

export interface PrintOptions {
  file: string;
  printer: string;
  gsPath: string;
  pages: string;
  copies: number;
  collate: boolean;
  subset: PageSubset;
  reverse: boolean;
  fit: FitMode;
  scalePercent: number;
  duplex: DuplexMode;
  /** DMPAPER id, null = printer default. */
  paper: number | null;
  orientation: OrientationMode;
  color: ColorMode;
  annots: AnnotsMode;
  asImage: boolean;
  imageDpi: number;
  layout: PrintLayout;
  nupRows: number;
  nupCols: number;
  nupOrder: NupOrder;
  nupBorder: boolean;
  nupAutoRotate: boolean;
  bookletSubset: BookletSubset;
  bookletBinding: BookletBinding;
  posterScale: number;
  posterOverlap: number;
  posterCutMarks: boolean;
  posterLabels: boolean;
  /** Portrait paper size in points — required by the layout modes and
   *  custom scale; resolved from the printer's capability report. */
  sheetWidth: number | null;
  sheetHeight: number | null;
}

/** The dialog's initial state: every option at its engine default. */
export function defaultPrintOptions(): Omit<PrintOptions, 'file' | 'printer' | 'gsPath'> {
  return {
    pages: '',
    copies: 1,
    collate: true,
    subset: 'all',
    reverse: false,
    fit: 'fit',
    scalePercent: 100,
    duplex: 'printer',
    paper: null,
    orientation: 'auto',
    color: 'printer',
    annots: 'all',
    asImage: false,
    imageDpi: 300,
    layout: 'single',
    nupRows: 2,
    nupCols: 2,
    nupOrder: 'horizontal',
    nupBorder: false,
    nupAutoRotate: true,
    bookletSubset: 'both',
    bookletBinding: 'left',
    posterScale: 100,
    posterOverlap: 0,
    posterCutMarks: false,
    posterLabels: false,
    sheetWidth: null,
    sheetHeight: null,
  };
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
    if (!m) return tChrome('dialog.print.errInvalidRange', { token: token || spec });
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : start;
    if (start < 1 || end < 1) return tChrome('dialog.print.errPagesStartAtOne');
    if (end < start) return tChrome('dialog.print.errDescending', { token });
    if (end > pageCount) {
      return tChromeCount('dialog.print.errBeyond', pageCount, { page: end });
    }
  }
  return null;
}

/** "1-3, 5" → "1-3,5" (what -sPageList and the engine expect). */
export function normalizePageRange(spec: string): string {
  return spec.replace(/\s+/g, '');
}

/** Copies must be a whole number 1..999; returns an error message or null. */
export function copiesError(raw: string): string | null {
  if (!/^\d+$/.test(raw.trim())) return tChrome('dialog.print.errCopiesWhole');
  const n = Number(raw.trim());
  if (n < 1 || n > MAX_COPIES) return tChrome('dialog.print.errCopiesRange', { max: MAX_COPIES });
  return null;
}

/** Custom scale 1..1000 percent. */
export function scaleError(raw: string): string | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || raw.trim() === '') return tChrome('dialog.print.errScaleNumber');
  if (n < 1 || n > 1000) return tChrome('dialog.print.errScaleRange');
  return null;
}

/** Poster tile scale 1..2000 percent. */
export function posterScaleError(raw: string): string | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || raw.trim() === '') return tChrome('dialog.print.errTileNumber');
  if (n < 1 || n > 2000) return tChrome('dialog.print.errTileRange');
  return null;
}

/** Poster overlap in points, 0..half the smaller sheet edge. */
export function posterOverlapError(
  raw: string,
  sheetWidth: number | null,
  sheetHeight: number | null,
): string | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || raw.trim() === '') return tChrome('dialog.print.errOverlapNumber');
  if (n < 0) return tChrome('dialog.print.errOverlapNegative');
  if (sheetWidth !== null && sheetHeight !== null && n >= Math.min(sheetWidth, sheetHeight) / 2) {
    return tChrome('dialog.print.errOverlapTooBig');
  }
  return null;
}

/** The engine wire object — snake_case keys exactly matching print_pdf. */
export interface PrintParams extends Record<string, unknown> {
  file: string;
  printer: string;
  gs_path: string;
  pages: string;
  copies: number;
  fit: FitMode;
}

/**
 * Assemble the engine call. Defaulted options are OMITTED so the wire stays
 * minimal and the engine's own defaults are the single source of truth —
 * the pinned exception being the six original keys, always present.
 */
export function buildPrintParams(opts: PrintOptions): PrintParams {
  const p: PrintParams = {
    file: opts.file,
    printer: opts.printer,
    gs_path: opts.gsPath,
    pages: normalizePageRange(opts.pages),
    copies: opts.copies,
    fit: opts.fit,
  };
  if (!opts.collate) p.collate = false;
  if (opts.subset !== 'all') p.subset = opts.subset;
  if (opts.reverse) p.reverse = true;
  if (opts.fit === 'scale') p.scale_percent = opts.scalePercent;
  if (opts.duplex !== 'printer') p.duplex = opts.duplex;
  if (opts.paper !== null) p.paper = opts.paper;
  if (opts.orientation !== 'auto') p.orientation = opts.orientation;
  if (opts.color !== 'printer') p.color = opts.color;
  if (opts.annots !== 'all') p.annots = opts.annots;
  if (opts.asImage) {
    p.as_image = true;
    p.image_dpi = opts.imageDpi;
  }
  if (opts.layout !== 'single') p.layout = opts.layout;
  if (opts.layout === 'nup') {
    p.nup_rows = opts.nupRows;
    p.nup_cols = opts.nupCols;
    p.nup_order = opts.nupOrder;
    p.nup_border = opts.nupBorder;
    p.nup_auto_rotate = opts.nupAutoRotate;
  }
  if (opts.layout === 'booklet') {
    p.booklet_subset = opts.bookletSubset;
    p.booklet_binding = opts.bookletBinding;
  }
  if (opts.layout === 'poster') {
    p.poster_scale = opts.posterScale;
    p.poster_overlap = opts.posterOverlap;
    p.poster_cut_marks = opts.posterCutMarks;
    p.poster_labels = opts.posterLabels;
  }
  if (opts.layout !== 'single' || opts.fit === 'scale') {
    if (opts.sheetWidth !== null) p.sheet_width = opts.sheetWidth;
    if (opts.sheetHeight !== null) p.sheet_height = opts.sheetHeight;
  }
  return p;
}
