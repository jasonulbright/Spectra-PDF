// Every export target this build offers: its extension, the engine door that
// produces it, and the options it takes.
//
// The document door REFUSES an option a target does not declare, which is what
// stops a silently ignored option from becoming a silently wrong output. That
// makes the declaration load-bearing on this side too: a value sent unasked
// turns a correct refusal into a false one, so the parameter builder emits only
// what the target declares.
//
// The table is the single-file dialog's and the folder sweep's both. An
// extension is read from here, never spelled at a call site.
import { tChromeCount, tNumber } from '../i18n';

/** Which engine method produces the target. */
export type ExportDoor = 'export_document' | 'export_images';

export interface ExportTarget {
  readonly ext: string;
  readonly door: ExportDoor;
  readonly options: readonly string[];
}

/** Protocol identifiers: never localized, never parsed back from display text. */
export const EXPORT_TARGETS = {
  docx: { ext: 'docx', door: 'export_document', options: [] },
  rtf: { ext: 'rtf', door: 'export_document', options: [] },
  odt: { ext: 'odt', door: 'export_document', options: [] },
  html: { ext: 'html', door: 'export_document', options: [] },
  xhtml: { ext: 'xhtml', door: 'export_document', options: [] },
  txt: { ext: 'txt', door: 'export_document', options: ['pages', 'layout', 'page_breaks'] },
  xlsx: {
    ext: 'xlsx',
    door: 'export_document',
    options: ['pages', 'sheet_per', 'include_untabled'],
  },
  pptx: { ext: 'pptx', door: 'export_document', options: ['pages', 'slide_size'] },
  // The image door names its own outputs: png and jpeg treat the destination as
  // a naming template and expand it per page, tiff writes the one multi-page
  // file. Either way the mirror addresses one path.
  png: { ext: 'png', door: 'export_images', options: ['pages', 'dpi', 'gray'] },
  jpeg: { ext: 'jpg', door: 'export_images', options: ['pages', 'dpi', 'gray', 'quality'] },
  tiff: { ext: 'tiff', door: 'export_images', options: ['pages', 'dpi', 'gray'] },
} as const satisfies Record<string, ExportTarget>;

export type ExportFormat = keyof typeof EXPORT_TARGETS;

export const EXPORT_FORMATS = Object.keys(EXPORT_TARGETS) as readonly ExportFormat[];

/** The targets whose options open a step in the single-file dialog. The other
 * document targets take none and go straight to the save dialog. */
export type DocumentExportFormat = 'txt' | 'xlsx' | 'pptx';

export const DOCUMENT_EXPORT_FORMATS: readonly DocumentExportFormat[] = [
  'txt',
  'xlsx',
  'pptx',
];

export const DEFAULT_IMAGE_DPI = 150;
export const DEFAULT_JPEG_QUALITY = 90;

export interface ExportOptionValues {
  pages: string;
  layout: string;
  pageBreaks: boolean;
  sheetPer: string;
  includeUntabled: boolean;
  slideSize: string;
  dpi?: number;
  gray?: boolean;
  quality?: number;
}

/** The mirror name for one source: its own path with the target's extension in
 * place of `.pdf`. A source that does not end in `.pdf` gains the extension
 * rather than losing its last segment. */
export function exportRel(rel: string, format: ExportFormat): string {
  const ext = EXPORT_TARGETS[format].ext;
  return /\.pdf$/i.test(rel) ? `${rel.slice(0, -4)}.${ext}` : `${rel}.${ext}`;
}

/** A page scope the engine understands: a list, or 'all'. */
export function parsePages(input: string): number[] | 'all' {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return 'all';
  return trimmed
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((value) => !Number.isNaN(value));
}

/** The engine parameters for one export, carrying only declared options. */
export function exportParams(
  format: ExportFormat,
  values: ExportOptionValues,
): Record<string, unknown> {
  const target = EXPORT_TARGETS[format];
  if (target.door === 'export_images') {
    // The image door reads a page selection as the text it was given
    // ('1-3,5'), strictly validated engine-side; empty is every page.
    const params: Record<string, unknown> = {
      fmt: format,
      pages: values.pages.trim(),
      dpi: values.dpi ?? DEFAULT_IMAGE_DPI,
      gray: values.gray ?? false,
    };
    if ((target.options as readonly string[]).includes('quality')) {
      params.quality = values.quality ?? DEFAULT_JPEG_QUALITY;
    }
    return params;
  }
  // A target that declares nothing takes nothing: sending a page scope to the
  // bridged word-processing targets is the false refusal this avoids.
  if (target.options.length === 0) return { fmt: format };
  const params: Record<string, unknown> = { fmt: format, pages: parsePages(values.pages) };
  if (format === 'txt') {
    params.layout = values.layout;
    // A false flag is an ABSENT option, not a value: sending it to a target
    // that does not declare it is what the engine refuses.
    if (values.pageBreaks) params.page_breaks = true;
  } else if (format === 'xlsx') {
    params.sheet_per = values.sheetPer;
    if (values.includeUntabled) params.include_untabled = true;
  } else {
    params.slide_size = values.slideSize;
  }
  return params;
}

export interface ExportImagesResult {
  outputs?: string[];
  pages_rendered?: number;
}

export interface ExportDocumentResult {
  output: string;
  characters?: number;
  pages_extracted?: number[];
  empty_pages?: number[];
  tables?: unknown[];
  pages_analyzed?: number[];
  pages_without_tables?: number[];
  untabled_lines?: number;
  vertical_writing_runs?: number;
  unresolved_rtl_cells?: number;
  slides?: number;
  pages_of_a_different_size?: number;
}

/**
 * What the export produced, as sentences.
 *
 * The first line is the outcome; every line after it is something found and NOT
 * exported. A success notice over a file with nothing in it is the failure this
 * reporting exists to make impossible.
 */
export function exportSummary(
  format: DocumentExportFormat,
  result: ExportDocumentResult,
  lng?: string,
): string[] {
  const lines: string[] = [];
  if (format === 'txt') {
    lines.push(
      tChromeCount('dialog.exportDoc.doneTxt', result.pages_extracted?.length ?? 0, {
        chars: tNumber(result.characters ?? 0),
        path: result.output,
      }, lng),
    );
    if (result.empty_pages?.length) {
      lines.push(tChromeCount('dialog.exportDoc.emptyPages', result.empty_pages.length, undefined, lng));
    }
    return lines;
  }
  if (format === 'xlsx') {
    lines.push(
      tChromeCount('dialog.exportDoc.doneXlsx', result.tables?.length ?? 0, {
        pages: tNumber(result.pages_analyzed?.length ?? 0),
        path: result.output,
      }, lng),
    );
    if (result.pages_without_tables?.length) {
      lines.push(tChromeCount(
        'dialog.exportDoc.pagesWithoutTables', result.pages_without_tables.length, undefined, lng));
    }
    if (result.untabled_lines) {
      lines.push(tChromeCount('dialog.exportDoc.untabledLines', result.untabled_lines, undefined, lng));
    }
    if (result.vertical_writing_runs) {
      lines.push(tChromeCount('dialog.exportDoc.verticalRuns', result.vertical_writing_runs, undefined, lng));
    }
    if (result.unresolved_rtl_cells) {
      lines.push(tChromeCount('dialog.exportDoc.unresolvedRtl', result.unresolved_rtl_cells, undefined, lng));
    }
    return lines;
  }
  lines.push(
    tChromeCount('dialog.exportDoc.donePptx', result.slides ?? 0, { path: result.output }, lng),
  );
  if (result.pages_of_a_different_size) {
    lines.push(tChromeCount(
      'dialog.exportDoc.differingPages', result.pages_of_a_different_size, undefined, lng));
  }
  return lines;
}

/** What one export produced, in English, for a run log a person greps in
 * whatever language the app was running in. Counts only — the log's own line
 * already carries the path. */
export function producedText(
  format: ExportFormat,
  result: ExportDocumentResult | ExportImagesResult,
): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (EXPORT_TARGETS[format].door === 'export_images') {
    const images = result as ExportImagesResult;
    return plural(images.outputs?.length ?? images.pages_rendered ?? 0, 'image');
  }
  const doc = result as ExportDocumentResult;
  if (format === 'txt') {
    return `${plural(doc.pages_extracted?.length ?? 0, 'page')}, ${plural(
      doc.characters ?? 0,
      'character',
    )}`;
  }
  if (format === 'xlsx') {
    return `${plural(doc.tables?.length ?? 0, 'table')} from ${plural(
      doc.pages_analyzed?.length ?? 0,
      'page',
    )}`;
  }
  if (format === 'pptx') return plural(doc.slides ?? 0, 'slide');
  return 'written';
}
