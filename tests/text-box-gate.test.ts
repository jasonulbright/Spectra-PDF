// The edit gate knows every refusal of the build and of the engine: a build
// of any size draws in engine calls of a bounded size, a text longer than one
// call lays out is refused when the edit is made, and no text the gate admits
// makes the engine fail.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appReducer } from '../src/renderer/state/reducer';
import type { PageAnnotation } from '../src/renderer/state/types';
import { TEXT_BOX_TEXT_LIMIT, textBoxEditRefusal, textBoxRefusalText } from '../src/renderer/lib/text-box-edit';
import { ENGINE_BLOCKS_PER_CALL, ENGINE_UNITS_PER_CALL, engineBatches } from '../src/renderer/lib/pdfx-build';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { expectSound } from './support/saved-pdf';
import { HAS_BUNDLED_FACES, engineCalls } from './support/text-engine';
import { POLISH, appearances, blank, box, opened, pagesOf, placing } from './support/text-box-fixtures';
import type { TextBlockResult, TextBoxEngine } from '../src/renderer/lib/text-box-engine';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const RUN = 120_000;

describe.skipIf(!HAS_BUNDLED_FACES)('a build of any size', () => {
  it('cuts the engine calls by blocks and by text, in order', () => {
    const jobs = (texts: string[]) => texts.map((text) => ({ request: { text } }));
    const many = engineBatches(jobs(Array.from({ length: ENGINE_BLOCKS_PER_CALL * 2 + 5 }, (_, i) => `t${i}`)));
    expect(many.map((batch) => batch.length)).toEqual([ENGINE_BLOCKS_PER_CALL, ENGINE_BLOCKS_PER_CALL, 5]);
    expect(many.flat().map((job) => job.request.text).slice(0, 3)).toEqual(['t0', 't1', 't2']);
    const long = 'x'.repeat(ENGINE_UNITS_PER_CALL - 10);
    expect(engineBatches(jobs(['a', long, 'b'.repeat(20), 'c', long + long])).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(engineBatches([])).toEqual([]);
    expect(TEXT_BOX_TEXT_LIMIT).toBeLessThanOrEqual(ENGINE_UNITS_PER_CALL);
  });

  it('draws a legend of more text blocks than the engine takes in one call', async () => {
    const legendRows = Array.from({ length: 2100 }, (_, i) => ({ group: `Żółw ${i}`, color: '#e0393e', symbol: 'circle' as const, count: 1 }));
    const legend: PageAnnotation = {
      id: 'l', kind: 'countlegend', x: 0.05, y: 0.05, w: 0.9, h: 0.9, color: '#14213d', note: 'Legend',
      legendTitle: 'Zliczenia', legendTotalWord: 'Razem', legendRows,
    };
    const state = opened((await importedPages(await blank())), await blank());
    const added = appReducer(state, { type: 'ADD_ANNOTATION', docId: 'a.pdf#0', pageId: pagesOf(state)[0].id, annotation: legend });
    expect(added.workspace).not.toBe(state.workspace);
    engineCalls.length = 0;
    const input = await blank();
    const output = await commit(input, placing(legend));
    const blocks = engineCalls.filter((call) => call.draw).map((call) => call.blocks);
    expect(blocks.reduce((sum, count) => sum + count, 0)).toBe(3 + 2 * legendRows.length);
    expect(blocks.length).toBeGreaterThan(4);
    expect(Math.max(...blocks)).toBeLessThanOrEqual(ENGINE_BLOCKS_PER_CALL);
    const [drawn] = await appearances(output);
    for (const row of [0, 1023, 1024, 2099]) expect(drawn.shown.includes(`Żółw ${row}`), String(row)).toBe(true);
    expect(drawn.shown.includes('Zliczenia') && drawn.shown.includes('Razem')).toBe(true);
    // The parts of one appearance come from several calls: the fonts of a later call take its mark.
    expect(Object.keys(drawn.fonts).some((name) => /_b\d+$/.test(name))).toBe(true);
    await expectSound(output, [], undefined, input);
  }, 600_000);

  it('refuses at the edit a text longer than one engine call lays out', () => {
    expect(textBoxEditRefusal(box('x'.repeat(TEXT_BOX_TEXT_LIMIT)), 1)).toBeNull();
    expect(textBoxEditRefusal(box('x'.repeat(TEXT_BOX_TEXT_LIMIT + 1)), 4)).toMatchObject({ reason: 'long', page: 4 });
    expect(textBoxRefusalText(textBoxEditRefusal(box(`Long ${'x'.repeat(TEXT_BOX_TEXT_LIMIT)}`), 4)!)).toMatch(/^Page 4, Text box “Long x+…”: this text is too long to draw\. The change was not made\.$/);
  });

  it('draws a glyph that spells two texts in one block, and each part of an annotation in its own style', async () => {
    const texts = ['é é 中', '가 가 中', 'fi ﬁ 中'];
    for (const text of texts) expect(textBoxEditRefusal(box(text), 1), text).toBeNull();
    const output = await commit(await blank(), placing(...texts.map((text, i) => box(text, { id: `b${i}`, y: 0.1 + i * 0.2 }))));
    const drawn = await appearances(output);
    expect(drawn.map((out) => out.shown)).toEqual(texts);
    await expectSound(output);
  }, RUN);

  it('names the missing face file when the engine refuses a character the face tables hold and lists a folder without the file', async () => {
    const refusing: TextBoxEngine = async (blocks) => ({ blocks: blocks.map((block) => ({ refused: block.text }) as TextBlockResult), faces: [] });
    await expect(commit(await blank(), placing(box(POLISH)), 'a.pdf', { textBoxes: refusing }))
      .rejects.toThrow('Page 1, Text box “Zażółć gęślą jaźń”: a font file that draws this text is missing from this installation.');
  }, RUN);
});
