// The three export targets the engine produces itself, and what each of them
// takes and reports.
//
// The engine REFUSES an option a target does not declare, which is what stops a
// silently ignored option from becoming a silently wrong output. That makes the
// declaration load-bearing on this side too: a value sent unasked turns a
// correct refusal into a false one, so the parameter builder emits only what
// the target declares.
import { tChromeCount, tNumber } from '../i18n';

/** Protocol identifiers: never localized, never parsed back from display text. */
export type DocumentExportFormat = 'txt' | 'xlsx' | 'pptx';

export const EXPORT_TARGETS = {
  txt: { ext: 'txt', options: ['pages', 'layout', 'page_breaks'] },
  xlsx: { ext: 'xlsx', options: ['pages', 'sheet_per', 'include_untabled'] },
  pptx: { ext: 'pptx', options: ['pages', 'slide_size'] },
} as const satisfies Record<DocumentExportFormat, { ext: string; options: readonly string[] }>;

export const DOCUMENT_EXPORT_FORMATS = Object.keys(
  EXPORT_TARGETS,
) as readonly DocumentExportFormat[];

export interface ExportOptionValues {
  pages: string;
  layout: string;
  pageBreaks: boolean;
  sheetPer: string;
  includeUntabled: boolean;
  slideSize: string;
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
  format: DocumentExportFormat,
  values: ExportOptionValues,
): Record<string, unknown> {
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
