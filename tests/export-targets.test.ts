// The export targets the engine produces itself: what each one takes, and what
// it says about what it produced.
import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_EXPORT_FORMATS,
  EXPORT_TARGETS,
  exportParams,
  exportSummary,
  parsePages,
} from '../src/renderer/lib/export-targets';
import { COMMANDS, COMMAND_IDS } from '../src/renderer/commands/registry';
import { MENUS, type MenuNode } from '../src/renderer/commands/menus';

const DEFAULTS = {
  pages: '',
  layout: 'reading',
  pageBreaks: false,
  sheetPer: 'table',
  includeUntabled: false,
  slideSize: 'page',
};

function exportSubmenuCommands(): string[] {
  const file = MENUS.find((m) => m.id === 'file');
  const submenu = file?.items.find(
    (node): node is Extract<MenuNode, { kind: 'submenu' }> =>
      node.kind === 'submenu' && node.id === 'file-export',
  );
  return (submenu?.items ?? [])
    .filter((node): node is Extract<MenuNode, { kind: 'command' }> => node.kind === 'command')
    .map((node) => node.command);
}

describe('the export targets', () => {
  it('declares an option set per target', () => {
    expect(EXPORT_TARGETS.txt.options).toEqual(['pages', 'layout', 'page_breaks']);
    expect(EXPORT_TARGETS.xlsx.options).toEqual(['pages', 'sheet_per', 'include_untabled']);
    expect(EXPORT_TARGETS.pptx.options).toEqual(['pages', 'slide_size']);
    expect(DOCUMENT_EXPORT_FORMATS).toEqual(['txt', 'xlsx', 'pptx']);
  });

  it('sends only the options the target declares', () => {
    for (const format of DOCUMENT_EXPORT_FORMATS) {
      const params = exportParams(format, DEFAULTS);
      const declared = new Set<string>([...EXPORT_TARGETS[format].options, 'fmt']);
      for (const name of Object.keys(params)) {
        expect(declared.has(name), `${format} sent ${name}`).toBe(true);
      }
    }
  });

  it('omits a flag that is off rather than sending it false', () => {
    // The engine refuses an option a target does not take, so a value sent
    // unasked turns a correct refusal into a false one.
    expect(exportParams('txt', DEFAULTS)).not.toHaveProperty('page_breaks');
    expect(exportParams('txt', { ...DEFAULTS, pageBreaks: true }).page_breaks).toBe(true);
    expect(exportParams('xlsx', DEFAULTS)).not.toHaveProperty('include_untabled');
    expect(exportParams('xlsx', { ...DEFAULTS, includeUntabled: true }).include_untabled).toBe(true);
  });

  it("carries each target's own choices", () => {
    expect(exportParams('txt', { ...DEFAULTS, layout: 'layout' }).layout).toBe('layout');
    expect(exportParams('xlsx', { ...DEFAULTS, sheetPer: 'page' }).sheet_per).toBe('page');
    expect(exportParams('pptx', { ...DEFAULTS, slideSize: '16:9' }).slide_size).toBe('16:9');
  });

  it('reads a page scope, or all of them', () => {
    expect(parsePages('')).toBe('all');
    expect(parsePages('  All ')).toBe('all');
    expect(parsePages('1,3, 5')).toEqual([1, 3, 5]);
    expect(parsePages('2,nonsense')).toEqual([2]);
  });
});

describe('the export commands', () => {
  it('registers all eight targets', () => {
    const ids = [
      'file.exportWord', 'file.exportRtf', 'file.exportOdt', 'file.exportHtml',
      'file.exportXhtml', 'file.exportText', 'file.exportExcel', 'file.exportPowerpoint',
    ];
    for (const id of ids) {
      expect(COMMAND_IDS).toContain(id);
      expect(COMMANDS[id as keyof typeof COMMANDS]).toBeDefined();
    }
  });

  it('offers every one of them under File then Export', () => {
    const items = exportSubmenuCommands();
    expect(items).toContain('file.exportText');
    expect(items).toContain('file.exportExcel');
    expect(items).toContain('file.exportPowerpoint');
    expect(items).toContain('file.exportWord');
    expect(items).toContain('file.exportImages');
  });
});

describe('the export summary', () => {
  it('reports what a transcription wrote and what carried no text', () => {
    const lines = exportSummary('txt', {
      output: 'C:/out/report.txt',
      characters: 1200,
      pages_extracted: [1, 2, 3],
      empty_pages: [2],
    });
    expect(lines[0]).toContain('C:/out/report.txt');
    expect(lines[0]).toContain('3 pages');
    expect(lines[1]).toBe('1 page carried no text.');
  });

  it('names the pages a table was not found on', () => {
    const lines = exportSummary('xlsx', {
      output: 'C:/out/report.xlsx',
      tables: [{}, {}],
      pages_analyzed: [1, 2, 3, 4],
      pages_without_tables: [3, 4],
      untabled_lines: 7,
    });
    expect(lines[0]).toContain('2 tables');
    expect(lines[0]).toContain('4 analyzed pages');
    expect(lines[1]).toBe('No table was found on 2 pages.');
    expect(lines[2]).toBe('7 lines of text sit outside a table and were not exported.');
  });

  it('says nothing about counters that are zero', () => {
    const lines = exportSummary('xlsx', {
      output: 'C:/out/report.xlsx',
      tables: [{}],
      pages_analyzed: [1],
      pages_without_tables: [],
      untabled_lines: 0,
      vertical_writing_runs: 0,
      unresolved_rtl_cells: 0,
    });
    expect(lines).toHaveLength(1);
  });

  it('reports the runs and cells detection could not place', () => {
    const lines = exportSummary('xlsx', {
      output: 'C:/out/report.xlsx',
      tables: [{}],
      pages_analyzed: [1],
      vertical_writing_runs: 3,
      unresolved_rtl_cells: 1,
    });
    expect(lines[1]).toBe('3 runs of vertical text were left out of the column detection.');
    expect(lines[2]).toBe('1 right-to-left cell kept the character order the page drew.');
  });

  it('counts slides, and the pages that had to be fitted', () => {
    const lines = exportSummary('pptx', {
      output: 'C:/out/deck.pptx',
      slides: 4,
      pages_of_a_different_size: 1,
    });
    expect(lines[0]).toBe('Wrote 4 slides to C:/out/deck.pptx');
    expect(lines[1]).toBe('1 page is a different size from the slides and was fitted to them.');
  });

  it('reports an empty workbook as zero tables rather than as a success', () => {
    // A refusal is what the engine returns when nothing was found, so this is
    // the shape a caller sees only when the counters genuinely disagree.
    const lines = exportSummary('xlsx', { output: 'C:/out/empty.xlsx', pages_analyzed: [1, 2] });
    expect(lines[0]).toContain('0 tables');
  });
});
