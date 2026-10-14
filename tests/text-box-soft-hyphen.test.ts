// A soft hyphen (U+00AD) in a text box: a break opportunity inside a word.
// It draws nothing and takes no advance inside a line, and a line that ends
// at its break draws a hyphen-minus. The wrap of the build (`wrapLines`) and
// the wrap of the engine (`text_box._wrap`) hold the same rule.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawInFace, shownLine, standardAdvance, standardTextHolds, textForGlyphCoverage, wrapLines, wrapText } from '../src/renderer/lib/free-text-redraw';
import type { TextFace } from '../src/renderer/lib/free-text-redraw';
import { bodyPlanOf, displayLine, standardLayout } from '../src/renderer/lib/text-box-layout';
import { withImportedState } from '../src/renderer/lib/imported-edit';
import { textBoxEditRefusal } from '../src/renderer/lib/text-box-edit';
import { coverageText } from '../src/renderer/lib/text-box-faces';
import type { PageAnnotation } from '../src/renderer/state/types';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit } from './support/commit-cycle';
import { expectSound } from './support/saved-pdf';
import { HAS_BUNDLED_FACES, pythonTextEngine } from './support/text-engine';
import { appearances, blank, box, placing } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const SHY = '\u00ad';
const RUN = 120_000;
/** One unit for each character a line draws. */
const count = (line: string): number => [...line].length;

describe('the wrap of the build', () => {
  it('draws nothing for a soft hyphen inside a line', () => {
    expect(shownLine(`ex${SHY}tra${SHY}`, false)).toBe('extra');
    expect(shownLine(`ex${SHY}tra`, true)).toBe('extra-');
    expect(wrapLines(`ex${SHY}tra words`, undefined, count)).toEqual({ lines: [`ex${SHY}tra words`], hyphens: [] });
    expect(wrapLines(`ex${SHY}tra words`, 11, count)).toEqual({ lines: [`ex${SHY}tra words`], hyphens: [] });
  });

  it('breaks after a soft hyphen and marks the line that draws the hyphen', () => {
    const text = `ab${SHY}cd${SHY}ef`;
    // `abcd-` is five characters wide.
    expect(wrapLines(text, 5.5, count)).toEqual({ lines: [`ab${SHY}cd${SHY}`, 'ef'], hyphens: [0] });
    // `abcd` fits and `abcd-` does not: the line ends at the earlier break.
    expect(wrapLines(text, 4.5, count)).toEqual({ lines: [`ab${SHY}`, `cd${SHY}ef`], hyphens: [0] });
    expect(wrapLines(`one ab${SHY}cd`, 7, count)).toEqual({ lines: [`one ab${SHY}`, 'cd'], hyphens: [0] });
    // The hyphen does not fit after `one ab`: the line breaks at the space.
    expect(wrapLines(`one ab${SHY}cd`, 6, count)).toEqual({ lines: ['one', `ab${SHY}cd`], hyphens: [] });
    expect(wrapText(text, 5.5, count).join('')).toBe(text);
  });

  it('draws a soft hyphen past the width when the word has no earlier break', () => {
    const wrapped = wrapLines(`abc${SHY}def`, 3, count);
    expect(wrapped).toEqual({ lines: [`abc${SHY}`, 'def'], hyphens: [0] });
    const face: TextFace = {
      name: 'F', font: undefined as never, show: (text) => `(${text})`, width: (text) => count(text),
    };
    const drawn = drawInFace(face, `abc${SHY}def`, 1, 1.2, 0, 3);
    expect(drawn.lines).toEqual(wrapped.lines);
    expect(drawn.hyphens).toEqual(wrapped.hyphens);
    expect(drawn.widths).toEqual([4, 3]);
  });

  it('draws no hyphen for a soft hyphen before a space or at a line end', () => {
    expect(wrapLines(`abc${SHY} def${SHY}\nghi${SHY}`, 3.5, count)).toEqual({ lines: [`abc${SHY}`, `def${SHY}`, `ghi${SHY}`], hyphens: [] });
    expect(wrapLines(`abc${SHY} defgh`, 3, count)).toEqual({ lines: [`abc${SHY}`, 'def', 'gh'], hyphens: [] });
  });

  it('cuts a word with no fitting soft break by character, and a cut after a soft hyphen draws it', () => {
    expect(wrapLines('abcdefgh', 3, count)).toEqual({ lines: ['abc', 'def', 'gh'], hyphens: [] });
    expect(wrapLines(`abcdef${SHY}gh`, 3, count)).toEqual({ lines: ['abc', `def${SHY}`, 'gh'], hyphens: [1] });
    expect(wrapLines(`ab${SHY}cdefgh`, 3, count)).toEqual({ lines: [`ab${SHY}`, 'cde', 'fgh'], hyphens: [0] });
  });

  it('shows and measures a line as the wrap measured it', () => {
    const shown: string[] = [];
    const face: TextFace = {
      name: 'F', font: undefined as never,
      show: (text) => {
        shown.push(text);
        return `(${text})`;
      },
      width: (text, size) => count(text) * size,
    };
    const drawn = drawInFace(face, `ab${SHY}cd${SHY}ef gh${SHY}`, 1, 1.2, 0, 5.5);
    expect(drawn.lines).toEqual([`ab${SHY}cd${SHY}`, `ef gh${SHY}`]);
    expect(drawn.hyphens).toEqual([0]);
    expect(shown).toEqual(['abcd-', 'ef gh']);
    expect(drawn.widths).toEqual([5, 5]);
    expect(drawInFace(face, 'plain', 1, 1.2, 0, 10).hyphens).toBeUndefined();
  });

  it('is not used for a text box of this editor with a soft hyphen: the standard font has no code for one', () => {
    expect(standardTextHolds(`co${SHY}operate`)).toBe(false);
    expect(bodyPlanOf({ note: `co${SHY}operate` }).via).toBe('engine');
    // The lines of a text in the standard font carry the marks all the same.
    expect(standardLayout('co operate', 12, 500)).toEqual({ lines: ['co operate'], rtl: false, align: 0 });
    expect(standardLayout('co operate', 12, standardAdvance('operate', 12))).toEqual({ lines: ['co', 'operate'], rtl: false, align: 0 });
  });

  it('plans and admits imported text by the glyphs the redraw can actually show', () => {
    const imported = withImportedState({
      id: 'soft-hyphen-import', kind: 'freetext', x: 0.1, y: 0.1, w: 0.5, h: 0.1,
      color: '#222222', note: `ab${SHY}cd`,
      importedOriginal: {
        subtype: 'FreeText', rect: [10, 20, 110, 40], contents: `ab${SHY}cd`, color: '#222222', hasAppearance: true,
      },
      textRedraw: { style: { family: 'serif' }, holds: coverageText([0x2d, 0x61, 0x62, 0x63, 0x64, 0x65]), size: 10 },
    } as PageAnnotation);
    expect(textForGlyphCoverage(`ab${SHY}cd`)).toBe('abcd-');
    expect(bodyPlanOf(imported).via).toBe('natural');
    expect(textBoxEditRefusal({ ...imported, note: `ab${SHY}cd-` }, 1, new Set())).toBeNull();

    // Other joining and zero-width controls keep their existing coverage
    // rule; only U+00AD is replaced by a visible glyph at a taken break.
    expect(bodyPlanOf({ ...imported, note: 'ab\u200bcd' }).via).toBe('engine');
  });

  it('shows a canvas line as the commit draws it', () => {
    expect(displayLine(`ex${SHY}tra`, false)).toBe('extra');
    expect(displayLine(`ex${SHY}`, true)).toBe('ex-');
    expect(displayLine('', false)).toBe('\u00a0');
    expect(displayLine(SHY, false)).toBe('\u00a0');
  });
});

describe.skipIf(!HAS_BUNDLED_FACES)('a committed text box with a soft hyphen', () => {
  it('draws the hyphen only at a line end it breaks', async () => {
    const latin = `incomprehensi${SHY}bilities and more`;
    const polish = `zażółć${SHY}gęślą${SHY}jaźń zażółć`;
    const output = await commit(await blank(), placing(
      box(latin, { id: 'wide', x: 0.05, y: 0.05, w: 0.9, h: 0.1 }),
      box(latin, { id: 'narrow', x: 0.05, y: 0.2, w: 0.25, h: 0.3 }),
      box(polish, { id: 'face-wide', x: 0.05, y: 0.55, w: 0.9, h: 0.1 }),
      box(polish, { id: 'face-narrow', x: 0.05, y: 0.7, w: 0.2, h: 0.25 }),
    ));
    await expectSound(output);
    const [wide, narrow, faceWide, faceNarrow] = await appearances(output);
    expect(wide.lines).toEqual(['incomprehensibilities and more']);
    expect(narrow.lines[0]).toBe('incomprehensi-');
    expect(narrow.lines[1].startsWith('bilities')).toBe(true);
    expect(narrow.lines.join(' ')).toBe('incomprehensi- bilities and more');
    expect(faceWide.lines).toEqual(['zażółćgęśląjaźń zażółć']);
    expect(faceNarrow.lines.filter((line) => line.endsWith('-')).length).toBeGreaterThan(0);
    expect(faceNarrow.lines.join('').replace(/[- ]/g, '')).toBe('zażółćgęśląjaźńzażółć');
    expect(faceNarrow.lines.join('')).not.toContain(SHY);
  }, RUN);

  it('is laid out by the engine with the lines the build draws', async () => {
    const text = `zażółć${SHY}gęślą${SHY}jaźń`;
    const [laid] = (await pythonTextEngine([{ text, size: 12, family: 'sans', width: 60 }], false)).blocks;
    const [drawn] = (await pythonTextEngine([{ text, size: 12, family: 'sans', width: 60 }], true)).blocks;
    expect(laid.lines.join('')).toBe(text);
    expect(laid.hyphens).toEqual(laid.lines.slice(0, -1).map((_line, index) => index));
    expect(drawn.lines).toEqual(laid.lines);
    expect(drawn.hyphens).toEqual(laid.hyphens);
    expect(drawn.widths).toEqual(laid.widths);
  }, RUN);
});
