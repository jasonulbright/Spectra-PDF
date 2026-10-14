// A text box, a callout, a stamp label and a legend draw every character of
// their text: in the standard Helvetica when WinAnsiEncoding holds the text
// (ISO 32000-2 Annex D), otherwise in bundled faces the engine chooses,
// shapes and embeds (`engine/text_box.py`). No writer replaces a character.
// A text no bundled face holds is refused when the edit is made.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { appReducer } from '../src/renderer/state/reducer';
import type { AppAction, AppState, PageAnnotation } from '../src/renderer/state/types';
import { parseToUnicode } from '../src/renderer/lib/annotation-font';
import { needsShaping, standardShow, standardTextHolds } from '../src/renderer/lib/free-text-redraw';
import { BUNDLED_FACES, FACE_HINTS } from '../src/renderer/lib/bundled-faces';
import { charactersWithoutFace, faceStyleOf } from '../src/renderer/lib/text-box-faces';
import { firstWords, textBoxEditRefusal, textBoxRefusalText } from '../src/renderer/lib/text-box-edit';
import { bodyPlanOf, engineLayout, provideTextBoxEngine, standardLayout } from '../src/renderer/lib/text-box-layout';
import { importedEdit, keptAppearanceMove } from '../src/renderer/lib/imported-edit';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { testPython } from './support/python';
import { expectSound } from './support/saved-pdf';
import { FONT_DIR, HAS_BUNDLED_FACES, engineCalls, pythonTextEngine } from './support/text-engine';
import {
  ARABIC, CJK, HEBREW, POLISH, appearances, baseFont, blank, box, bytesOf, defaults, editingAll, foreign, only, opened, pagesOf, placing, programs, readByViewer, sorted, taller,
} from './support/text-box-fixtures';
import type { Appearance } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 120_000;
const ROOT = join(__dirname, '..');

const CZECH = 'Příliš žluťoučký kůň';
const TURKISH = 'Iğdır İstanbul şöför çığ';
const GREEK = 'Ελληνικά γράμματα';
const CYRILLIC = 'Съешь же ещё этих булок';


describe('the standard Helvetica and its encoding', () => {
  it('holds the typographic quotes and dashes, the euro and the bullet, and nothing outside WinAnsiEncoding', () => {
    expect(standardTextHolds('“quoted” ‘x’ – — … € • ™ café')).toBe(true);
    for (const text of [POLISH, GREEK, CYRILLIC, CJK, HEBREW, ARABIC, '→', '\u{1F600}']) expect(standardTextHolds(text), text).toBe(false);
  });

  it('shows a character by its code and never by another character', () => {
    expect(standardShow('A“€')).toBe('<419380>');
    expect(() => standardShow('Ω')).toThrow(/no code/);
    expect(() => standardShow('a→b')).toThrow(/no code/);
  });
});

describe.skipIf(!HAS_BUNDLED_FACES)('the bundled faces table', () => {
  it('is what the generator writes from the engine tables and the face files', () => {
    execFileSync(testPython(), ['-B', join(ROOT, 'scripts', 'gen-bundled-faces.py'), '--check', '--fonts', FONT_DIR], { cwd: ROOT, windowsHide: true });
  }, RUN);

  it('reads the family and the style of a font as the engine does', () => {
    const cases: { base: string; flags?: number; angle?: number }[] = [
      { base: 'Helvetica' }, { base: 'Times-BoldItalic' }, { base: 'Courier-Oblique' }, { base: 'ABCDEF+Body', flags: 34 },
      { base: 'ABCDEF+Body', flags: 33 }, { base: 'ABCDEF+Body', flags: 32 | (1 << 18), angle: -12 }, { base: 'XYZABC+LiberationSerif-BoldItalic', flags: 32 },
      { base: 'XYZABC+NotoSansCJKsc-Bold', flags: 32 }, { base: 'ABCDEF+Georgia-Semibold', flags: 32 | (1 << 6) }, { base: 'Consolas' },
    ];
    const script = [
      'import sys, json',
      "sys.path.insert(0, 'src')",
      'from pikepdf import Dictionary, Name',
      'from engine.font_fallback import classify_font_family, classify_font_style',
      'out = []',
      'for case in json.loads(sys.stdin.read()):',
      "    font = Dictionary(Type=Name('/Font'), Subtype=Name('/Type1'), BaseFont=Name('/' + case['base']))",
      "    if 'flags' in case:",
      "        font['/FontDescriptor'] = Dictionary(Type=Name('/FontDescriptor'), Flags=case['flags'], **({'ItalicAngle': case['angle']} if 'angle' in case else {}))",
      '    bold, italic = classify_font_style(font)',
      '    out.append([classify_font_family(font), bold, italic])',
      'print(json.dumps(out))',
    ].join('\n');
    const engine = JSON.parse(execFileSync(testPython(), ['-B', '-c', script], { cwd: ROOT, input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true })) as [string, boolean, boolean][];
    const doc = PDFDocument.create();
    return doc.then(({ context }) => {
      const mine = cases.map(({ base, flags, angle }) => {
        const style = faceStyleOf(context, context.obj({
          Type: 'Font', Subtype: 'Type1', BaseFont: base,
          ...(flags !== undefined ? { FontDescriptor: { Type: 'FontDescriptor', Flags: flags, ...(angle !== undefined ? { ItalicAngle: angle } : {}) } } : {}),
        } as never));
        return [style.family, style.bold === true, style.italic === true];
      });
      expect(mine).toEqual(engine);
      expect(FACE_HINTS.bold).toContain('semibold');
      expect(BUNDLED_FACES.sans.regular).toBe('LiberationSans-Regular.ttf');
    });
  }, RUN);

  it('tells the characters no face holds, by the ladder the engine walks for one character', () => {
    expect(charactersWithoutFace(`${POLISH} ${CZECH} ${TURKISH} ${GREEK} ${CYRILLIC} ${CJK} ${HEBREW} ${ARABIC} → ‏`)).toEqual([]);
    expect(charactersWithoutFace('नमस्ते')).toEqual([...new Set('नमस्ते')]);
    expect(charactersWithoutFace('a \u{1F600} b')).toEqual(['\u{1F600}']);
    expect(charactersWithoutFace('ภาษาไทย').length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_BUNDLED_FACES)('a text box this editor creates', () => {
  it('draws a text WinAnsiEncoding holds in the standard Helvetica, embeds nothing and asks no engine', async () => {
    const calls = engineCalls.length;
    const text = 'Plain “quoted” – 5 € café';
    const output = await commit(await blank(), placing(box(text)));
    await expectSound(output);
    const [out] = await appearances(output);
    expect(engineCalls.length).toBe(calls);
    expect(Object.keys(out.fonts)).toEqual(['Helv']);
    expect(baseFont(out.fonts.Helv)).toBe('/Helvetica');
    expect(programs(out.fonts.Helv)).toBe(false);
    expect(out.shown).toBe(text);
    expect(out.da).toMatch(/ rg \/Helv 12 Tf$/);
    expect((await readByViewer(output))[0]).toEqual([text]);
  }, RUN);

  it.each([
    ['Polish', POLISH], ['Czech', CZECH], ['Turkish', TURKISH], ['Greek', GREEK], ['Cyrillic', CYRILLIC], ['an arrow', 'in → out'],
  ])('draws %s in a subset of the sans face, named in /DA and bound in /DR', async (_name, text) => {
    const output = await commit(await blank(), placing(box(text)));
    await expectSound(output);
    const [out] = await appearances(output);
    expect(Object.keys(out.fonts)).toEqual(['LiberationSans']);
    expect(baseFont(out.fonts.LiberationSans)).toMatch(/^\/[A-Z]{6}\+LiberationSans$/);
    expect(programs(out.fonts.LiberationSans)).toBe(true);
    expect(out.shown).toBe(text);
    expect(out.shown).not.toContain('?');
    expect(out.da).toMatch(/ rg \/LiberationSans 12 Tf$/);
    expect(out.dict.lookup(N('DS'))).toBeUndefined();
    expect(out.dict.lookup(N('RC'))).toBeUndefined();
    expect(out.dict.lookup(N('Q'))).toBeUndefined();
    const doc = await PDFDocument.load(output, { updateMetadata: false });
    expect(defaults(doc).LiberationSans).toBe(baseFont(out.fonts.LiberationSans));
    expect((await readByViewer(output))[0]).toEqual([text]);
  }, RUN);

  it('draws CJK in the CJK face, and wraps it between characters', async () => {
    const text = '中文测试中文测试中文测试中文测试中文测试中文测试';
    const output = await commit(await blank(), placing(box(text, { w: 0.3 })));
    await expectSound(output);
    const [out] = await appearances(output);
    expect(Object.keys(out.fonts)).toEqual(['NotoSansCJKsc']);
    expect(out.shown).toBe(text);
    expect(out.content.match(/ Tm /g)!.length).toBeGreaterThan(1);
  }, RUN);

  it('draws each run of a text in several scripts in a face that holds it', async () => {
    const mixed = `${POLISH} 中文`;
    const output = await commit(await blank(), placing(box(mixed), box('Latin and Кириллица', { y: 0.3 }), box('Latin 中文', { y: 0.5 })));
    await expectSound(output);
    const [first, second, third] = await appearances(output);
    expect(Object.keys(first.fonts).sort()).toEqual(['LiberationSans', 'NotoSansCJKsc']);
    expect(first.shown).toBe(mixed);
    // /DA names the face of the first character.
    expect(first.da).toMatch(/ \/LiberationSans 12 Tf$/);
    expect(Object.keys(second.fonts)).toHaveLength(1);
    expect(second.shown).toBe('Latin and Кириллица');
    // One face holds the whole text: the engine rule for page text.
    expect(Object.keys(third.fonts)).toHaveLength(1);
    expect(baseFont(Object.values(third.fonts)[0])).toMatch(/\+NotoSansCJKsc$/);
    expect(third.shown).toBe('Latin 中文');
    expect((await readByViewer(output)).map((lines) => lines.join(' '))).toEqual([mixed, 'Latin and Кириллица', 'Latin 中文']);
  }, RUN);

  it('draws Hebrew from right to left, right aligned, in visual order', async () => {
    const text = `${HEBREW} abc 123`;
    const output = await commit(await blank(), placing(box(text)));
    await expectSound(output);
    const [out] = await appearances(output);
    expect(out.dict.lookup(N('Q'))).toEqual(out.dict.context.obj(2));
    // The content shows the line as the eye reads it from the left.
    expect(sorted(out.shown)).toBe(sorted(text));
    expect(out.shown.replace(/\s/g, '').endsWith('שלום'.split('').reverse().join(''))).toBe(true);
    expect((await readByViewer(output))[0]).toEqual([text]);
  }, RUN);

  it('draws a right-to-left word inside a left-to-right line in visual order, through a second commit too', async () => {
    const text = 'Zażółć שלום';
    const once = await commit(await blank(), placing(box(text)));
    const twice = await commit(once, editingAll(taller));
    await expectSound(twice);
    for (const output of [once, twice]) {
      const [out] = await appearances(output);
      // The base direction is that of the first strong character: left to
      // right. The Hebrew word is shown from its last letter to its first.
      expect(out.shown).toBe('Zażółć םולש');
      expect(out.dict.lookup(N('Q'))).toBeUndefined();
      expect(Object.keys(out.fonts)).toEqual(['LiberationSans']);
      const [read] = (await readByViewer(output))[0];
      expect(read).toContain('Zażółć');
      expect(read).toContain('שלום');
    }
  }, RUN);

  it('draws Arabic joined, with its ligature as one glyph that spells both letters', async () => {
    const text = `${ARABIC} سلام`;
    const output = await commit(await blank(), placing(box(text)));
    await expectSound(output);
    const [out] = await appearances(output);
    expect(Object.keys(out.fonts)).toEqual(['IBMPlexSansArabic']);
    expect(out.dict.lookup(N('Q'))).toEqual(out.dict.context.obj(2));
    expect(sorted(out.shown)).toBe(sorted(text));
    const map = parseToUnicode(bytesOf(out.fonts.IBMPlexSansArabic.lookup(N('ToUnicode'))));
    // Lam and alef are one glyph: one code spells the two letters.
    expect([...map.values()]).toContain('لا');
    const codes = (out.content.match(/<[0-9a-f]+>/g) ?? []).join('').replace(/[<>]/g, '').length / 4;
    expect(codes).toBeLessThan([...text].length);
    const plain = await commit(await blank(), placing(box(ARABIC)));
    expect((await readByViewer(plain))[0]).toEqual([ARABIC]);
  }, RUN);

  it('draws a callout, a stamp label and a legend in the faces that hold their text', async () => {
    const callout: PageAnnotation = {
      id: 'c', kind: 'callout', x: 0.1, y: 0.1, w: 0.6, h: 0.2, calloutBox: [0.3, 0.1, 0.4, 0.1], points: [0.1, 0.3, 0.2, 0.2, 0.3, 0.15],
      color: '#e0393e', note: `${CZECH} ${HEBREW}`, strokeWidth: 1,
    };
    const stamp: PageAnnotation = { id: 's', kind: 'stamp', x: 0.1, y: 0.4, w: 0.5, h: 0.08, color: '#16a34a', note: 'одобрено' };
    const legend: PageAnnotation = {
      id: 'l', kind: 'countlegend', x: 0.1, y: 0.6, w: 0.5, h: 0.2, color: '#14213d', note: 'Legend',
      legendTitle: 'Zliczenia', legendTotalWord: 'Razem', legendRows: [
        { group: 'Drzwi wewnętrzne', color: '#e0393e', symbol: 'circle', count: 3 }, { group: '门', color: '#2563eb', symbol: 'circle', count: 12 },
      ],
    };
    const output = await commit(await blank(), placing(callout, stamp, legend));
    await expectSound(output);
    const [c, s, l] = await appearances(output);
    expect(sorted(c.shown)).toBe(sorted(`${CZECH} ${HEBREW}`));
    expect(c.shown).not.toContain('?');
    expect(s.shown).toBe('ОДОБРЕНО');
    expect(baseFont(Object.values(s.fonts).find((font) => programs(font))!)).toMatch(/\+LiberationSans-Bold$/);
    expect(sorted(l.shown)).toBe(sorted('Zliczenia Drzwi wewnętrzne 3 门 12 Razem 15'));
    for (const out of [c, s, l]) expect(out.shown).not.toMatch(/[?�]/);
  }, RUN);

  it('refuses in the build a text no bundled face holds, by the rule of edited page text', async () => {
    // An Indic conjunct and an emoji: the engine holds no face for either,
    // and the page-text editor refuses the same characters.
    await expect(commit(await blank(), placing(box('क्ष'))))
      .rejects.toThrow(/Page 1, Text box “क्ष”: no font of this editor draws these characters: /);
    await expect(commit(await blank(), placing(box('ok \u{1F600}'))))
      .rejects.toThrow(/no font of this editor draws these characters: \u{1F600}\./u);
    const answer = await pythonTextEngine([{ text: 'क्ष', size: 12, family: 'sans' }, { text: 'a \u{1F600}', size: 12, family: 'sans' }], true);
    expect(answer.blocks.map((block) => block.refused)).toEqual([[...new Set('क्ष')].sort().join(''), '\u{1F600}']);
  }, RUN);
});

describe.skipIf(!HAS_BUNDLED_FACES)('a text box read back and edited again', () => {
  it('keeps its text and its face through a change of size, and adds no font for a text one font holds', async () => {
    const texts = [POLISH, `${POLISH} 中文`, `${HEBREW} abc`, ARABIC, 'Plain'];
    const once = await commit(await blank(), placing(...texts.map((text, i) => box(text, { id: `b${i}`, y: 0.05 + i * 0.15 }))));
    const first = await appearances(once);
    const twice = await commit(once, editingAll(taller));
    await expectSound(twice);
    const second = await appearances(twice);
    expect(second.map((out) => sorted(out.shown))).toEqual(texts.map(sorted));
    expect(second.map((out) => Object.values(out.fonts).map(baseFont).map((name) => name.replace(/^\/[A-Z]{6}\+/, '')).sort()))
      .toEqual(first.map((out) => Object.values(out.fonts).map(baseFont).map((name) => name.replace(/^\/[A-Z]{6}\+/, '')).sort()));
    expect(second.map((out) => out.da.replace(/^.* rg /, ''))).toEqual(first.map((out) => out.da.replace(/^.* rg /, '')));
    // The Polish text is drawn in the font object the first commit wrote.
    expect(baseFont(second[0].fonts.LiberationSans)).toBe(baseFont(first[0].fonts.LiberationSans));
    expect((await readByViewer(twice)).map((lines) => lines.join(' '))).toEqual(texts);
    // A third commit after a change of colour draws the same text again.
    const thrice = await commit(twice, editingAll((a) => ({ ...a, color: '#16a34a' })));
    await expectSound(thrice);
    const third = await appearances(thrice);
    expect(third.map((out) => sorted(out.shown))).toEqual(texts.map(sorted));
    // The default resources hold the fonts the default appearances name, and
    // no subset an earlier commit embedded for a text since drawn again.
    const named = (list: Appearance[]): string[] => [...new Set(list.map((out) => /\/(\S+) 12 Tf$/.exec(out.da)![1]))].sort();
    for (const [bytes, list] of [[twice, second], [thrice, third]] as const) {
      const held = defaults(await PDFDocument.load(bytes, { updateMetadata: false }));
      expect(Object.keys(held).sort()).toEqual(named(list));
    }
  }, RUN);

  it('draws from /Contents a text box an earlier version wrote with replaced characters, and leaves an unedited one as written', async () => {
    // The appearance an earlier version wrote: Helvetica, and `?` for every
    // character outside Latin-1. /Contents holds the text.
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const ctx = doc.context;
    const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
    const stream = ctx.register(ctx.stream(
      '0.98 0.98 0.96 rg 0 0 240 60 re f 0.1 0.2 0.9 RG 0.75 w 0.5 0.5 239 59 re S BT /Helv 12 Tf 14.4 TL 0.1 0.2 0.9 rg 3 45 Td (Za???? g??l? ja??) Tj T* ET',
      { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 240, 60], Resources: { Font: { Helv: font } } },
    ));
    const annotation = ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [40, 480, 280, 540], C: [0.1, 0.2, 0.9], F: 4, AP: { N: stream } }) as PDFDict;
    annotation.set(N('DA'), PDFString.of('0.1 0.2 0.9 rg /Helv 12 Tf'));
    annotation.set(N('Contents'), PDFHexString.fromText(POLISH));
    page.node.set(N('Annots'), ctx.obj([ctx.register(annotation)]));
    doc.catalog.set(N('AcroForm'), ctx.register(ctx.obj({ Fields: [], DR: { Font: { Helv: font } } })));
    const old = await doc.save({ useObjectStreams: false });

    const untouched = await appearances(await commit(old));
    expect(untouched[0].content).toContain('(Za???? g??l? ja??) Tj');
    const [imported] = (await importedPages(old))[0].annotations!;
    expect(imported.textRedraw).toMatchObject({ style: { family: 'sans' }, standard: true, size: 12 });
    expect(imported.textRedraw!.refusal).toBeUndefined();

    const resized = await commit(old, editingAll(taller));
    await expectSound(resized);
    const [out] = await appearances(resized);
    expect(out.shown).toBe(POLISH);
    expect(out.content).not.toContain('?');
    expect(Object.keys(out.fonts)).toEqual(['LiberationSans']);
    expect((await readByViewer(resized))[0]).toEqual([POLISH]);
  }, RUN);
});

describe.skipIf(!HAS_BUNDLED_FACES)('no writer replaces a character', () => {
  it('shows every character of a text in each kind that draws text, for every script a face holds', async () => {
    const texts = ['Plain', POLISH, CZECH, TURKISH, GREEK, CYRILLIC, CJK, HEBREW, ARABIC, `${POLISH} ${CJK} ${HEBREW}`, 'a “b” → c?', 'שָׁלוֹם'];
    for (const text of texts) {
      const callout: PageAnnotation = {
        id: 'c', kind: 'callout', x: 0.1, y: 0.25, w: 0.8, h: 0.2, calloutBox: [0.3, 0.25, 0.6, 0.1], points: [0.1, 0.4, 0.2, 0.3, 0.3, 0.3], color: '#e0393e', note: text,
      };
      const legend: PageAnnotation = {
        id: 'l', kind: 'countlegend', x: 0.1, y: 0.6, w: 0.8, h: 0.2, color: '#14213d', note: 'Legend', legendTitle: text, legendTotalWord: text,
        legendRows: [{ group: text, color: '#e0393e', symbol: 'circle', count: 1 }],
      };
      const stamp: PageAnnotation = { id: 's', kind: 'stamp', x: 0.1, y: 0.5, w: 0.8, h: 0.06, color: '#16a34a', note: text };
      const output = await commit(await blank(), placing(box(text, { w: 0.8 }), callout, stamp, legend));
      const [b, c, s, l] = await appearances(output);
      expect(sorted(b.shown), text).toBe(sorted(text));
      expect(sorted(c.shown), text).toBe(sorted(text));
      expect(sorted(l.shown), text).toBe(sorted(`${text}${text}${text}11`));
      // A label in the standard face is cut to its box; in bundled faces it is whole.
      const label = text.toUpperCase();
      if (standardTextHolds(label) && !needsShaping(label)) expect(label.startsWith(s.shown), text).toBe(true);
      else expect(sorted(s.shown), text).toBe(sorted(label));
      for (const out of [b, c, s, l]) {
        expect(out.shown.includes('�'), text).toBe(false);
        expect(out.shown.split('?').length, text).toBeLessThanOrEqual(text.split('?').length * 3);
      }
    }
  }, 300_000);
});

// ── The edit is refused when it is made ──────────────────────────────────


describe.skipIf(!HAS_BUNDLED_FACES)('an edit the commit could not draw', () => {
  it('records at the import why a text box cannot be drawn again as it was', async () => {
    const record = async (kind: 'type3' | 'times' | 'styled') => (await importedPages(await foreign(kind)))[0].annotations![0].textRedraw;
    expect((await record('type3'))!.refusal).toBe('font');
    expect((await record('styled'))!.refusal).toBe('styled');
    const times = (await record('times'))!;
    expect(times.refusal).toBeUndefined();
    expect(times.style).toEqual({ family: 'serif' });
    expect(times.size).toBe(10);
  }, RUN);

  it('is refused by the store with a notice that names the annotation, and leaves the model as it was', async () => {
    const bytes = await foreign('type3');
    const state = opened(await importedPages(bytes), bytes);
    const a = only(state);
    const recolour: AppAction = { type: 'RECOLOR_ANNOTATION', docId: 'a.pdf#0', pageId: pagesOf(state)[0].id, annotationId: a.id, color: '#00ff00' };
    const refused = appReducer(state, recolour);
    expect(refused.workspace).toBe(state.workspace);
    expect(refused.pageUndoStack).toBe(state.pageUndoStack);
    expect(refused.pageDirtyPaths).toEqual([]);
    expect(refused.pageEditRefusals).toBe(state.pageEditRefusals + 1);
    expect(refused.pageEditRefusalReason).toEqual({ textBox: { reason: 'font', kind: 'freetext', page: 1, words: 'Ten point text' } });
    expect(textBoxRefusalText((refused.pageEditRefusalReason as { textBox: never }).textBox))
      .toBe('Page 1, Text box “Ten point text”: the font of this text cannot be read. You can move it or replace its text. The change was not made.');

    const emoji = appReducer(state, { type: 'UPDATE_ANNOTATION', docId: 'a.pdf#0', pageId: pagesOf(state)[0].id, annotationId: a.id, note: 'Now \u{1F600}' });
    expect(emoji.workspace).toBe(state.workspace);
    expect(emoji.pageEditRefusalReason).toEqual({ textBox: { reason: 'script', kind: 'freetext', page: 1, words: 'Now \u{1F600}', characters: ['\u{1F600}'] } });

    const fresh = appReducer(state, { type: 'ADD_ANNOTATION', docId: 'a.pdf#0', pageId: pagesOf(state)[0].id, annotation: box('नमस्ते दुनिया') });
    expect(fresh.workspace).toBe(state.workspace);
    expect((fresh.pageEditRefusalReason as { textBox: { reason: string } }).textBox.reason).toBe('script');
  }, RUN);

  it('never blocks a commit: every edit the store admits builds, and every edit it refuses is one the build refuses', async () => {
    const fixtures: Record<string, Uint8Array> = {
      type3: await foreign('type3'), times: await foreign('times'), styled: await foreign('styled'),
      own: await commit(await blank(), placing(box(POLISH))), ownPlain: await commit(await blank(), placing(box('Plain'))),
      ownArabic: await commit(await blank(), placing(box(ARABIC))), timesOmega: await foreign('times', 'Ohm Ω'),
    };
    const actions = (state: AppState): Record<string, AppAction> => {
      const page = pagesOf(state)[0];
      const a = only(state);
      const at = { docId: 'a.pdf#0', pageId: page.id };
      const transform = (over: Partial<PageAnnotation>): AppAction => ({
        type: 'TRANSFORM_ANNOTATIONS', docId: 'a.pdf#0',
        edits: [{ pageId: page.id, annotationId: a.id, x: a.x, y: a.y, w: a.w, h: a.h, ...over }],
      });
      const say = (note: string): AppAction => ({ type: 'UPDATE_ANNOTATION', ...at, annotationId: a.id, note });
      return {
        recolour: { type: 'RECOLOR_ANNOTATION', ...at, annotationId: a.id, color: '#00ff00' },
        recolourMany: { type: 'RECOLOR_ANNOTATIONS', ...at, annotationIds: [a.id], color: '#00ff00' },
        move: transform({ x: a.x + 0.05, y: a.y + 0.05 }),
        resize: transform({ w: a.w * 1.3, h: a.h * 1.6 }),
        plain: say('Changed text'), polish: say(POLISH), hebrew: say(HEBREW), arabic: say(`${ARABIC} سلام`), cjk: say(`${POLISH} 中文`),
        emoji: say('a \u{1F600}'), indic: say('क्ष'), thai: say('ภาษาไทย'),
      };
    };
    const outcomes: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(fixtures)) {
      const state = opened(await importedPages(bytes), bytes);
      for (const [edit, action] of Object.entries(actions(state))) {
        const next = appReducer(state, action);
        const admitted = next.workspace !== state.workspace;
        outcomes[`${name}/${edit}`] = admitted ? 'drawn'
          : next.pageEditRefusals === state.pageEditRefusals ? 'same'
            : (next.pageEditRefusalReason as { textBox?: { reason: string } } | null)?.textBox?.reason ?? 'other';
        if (admitted) {
          const output = await commit(bytes, () => pagesOf(next));
          await expectSound(output, [], undefined, bytes);
        }
      }
    }
    const refused = Object.fromEntries(Object.entries(outcomes).filter(([, outcome]) => outcome !== 'drawn' && outcome !== 'same'));
    expect(Object.entries(outcomes).filter(([, outcome]) => outcome === 'same').map(([name]) => name)).toEqual(['own/polish']);
    expect(refused).toEqual({
      'type3/recolour': 'font', 'type3/recolourMany': 'font',
      'styled/recolour': 'styled', 'styled/recolourMany': 'styled',
      ...Object.fromEntries(Object.keys(fixtures).flatMap((name) => ['emoji', 'indic', 'thai'].map((edit) => [`${name}/${edit}`, 'script']))),
    });
  }, 600_000);

  it('shows on the canvas the scaled appearance the commit keeps for a text box it cannot draw again', async () => {
    const bytes = await foreign('type3');
    const [a] = (await importedPages(bytes))[0].annotations!;
    const resized = { ...a, w: a.w * 2, h: a.h * 1.5, geometryDiverged: true };
    expect(importedEdit(resized)!.geometry).toBe('reshaped');
    expect(keptAppearanceMove(resized)).toEqual({ dx: 0, dy: 0, sx: 2, sy: 1.5 });
    expect(keptAppearanceMove(a, { x: a.x + 0.1, y: a.y, w: a.w * 2, h: a.h })).toMatchObject({ sx: 2, sy: 1 });
    expect(keptAppearanceMove({ ...resized, color: '#00ff00' })).toBeNull();
    expect(textBoxEditRefusal(resized, 1)).toBeNull();
    // A text box the commit can draw again is drawn again, never scaled.
    const [times] = (await importedPages(await foreign('times')))[0].annotations!;
    expect(keptAppearanceMove({ ...times, w: times.w * 2, geometryDiverged: true })).toBeNull();
  }, RUN);

  it('names the annotation by its first words', () => {
    expect(firstWords('  one\ntwo   three ')).toBe('one two three');
    expect(firstWords('word '.repeat(30))).toBe('word word word word word word word word…');
  });
});

describe.skipIf(!HAS_BUNDLED_FACES)('the lines the canvas shows before the commit', () => {
  it('are the lines the commit writes, for the standard face and for the engine', async () => {
    const plain = 'A plain text that is long enough to take more than one line in a narrow text box';
    const mixed = `${HEBREW} ${POLISH} ${HEBREW} ${ARABIC} and more words to wrap`;
    const width = 0.3 * 400;
    const output = await commit(await blank(), placing(box(plain, { w: 0.3, h: 0.3 }), box(mixed, { id: 'm', y: 0.5, w: 0.3, h: 0.3 })));
    const [first, second] = await appearances(output);
    const written = (out: Appearance): number => out.content.match(/ Tm /g)!.length;

    expect(bodyPlanOf(box(plain))).toMatchObject({ via: 'standard', size: 12 });
    const standard = standardLayout(plain, 12, width - 6);
    expect(standard.lines.length).toBeGreaterThan(1);
    expect(standard.lines.length).toBe(written(first));
    expect(standard.lines.join(' ')).toBe(plain);

    expect(bodyPlanOf(box(mixed))).toMatchObject({ via: 'engine', size: 12 });
    provideTextBoxEngine(pythonTextEngine);
    const layout = await engineLayout(mixed, bodyPlanOf(box(mixed)), width - 6);
    provideTextBoxEngine(undefined);
    expect(layout).not.toBeNull();
    expect(layout!.rtl).toBe(true);
    expect(layout!.align).toBe(2);
    expect(layout!.lines.length).toBe(written(second));
    expect(layout!.lines.join(' ')).toBe(mixed);
    expect(second.lines.map(sorted)).toEqual(layout!.lines.map(sorted));
    expect(first.lines).toEqual(standard.lines);
  }, RUN);
});
