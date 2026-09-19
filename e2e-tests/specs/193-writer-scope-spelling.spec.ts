import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { expect } from '@wdio/globals';
// @ts-ignore — the legacy entry has no separate declaration file.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { closeAllFiles, getState, openByPaths, saveActiveAs, setActiveOp,
  setReactInputValue, setView, waitForHarness } from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const standardFontDataUrl = pathToFileURL(resolve(require.resolve('pdfjs-dist/package.json'), '../standard_fonts')).href + '/';
async function textPages(path: string): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), standardFontDataUrl }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      out.push((content.items as { str?: string }[]).map((item) => item.str ?? '').join(' '));
    }
    return out;
  } finally { await doc.loadingTask.destroy(); }
}

describe('owned writers preserve page scope and mixed-source spelling', () => {
  let directory: string, source: string;
  beforeEach(async () => {
    await waitForHarness(); await closeAllFiles();
    directory = mkdtempSync(resolve(__dirname, '../../writer-intents.local.d-'));
    source = resolve(directory, 'source.pdf');
  });
  afterEach(async () => { await closeAllFiles(); });
  async function open(op: string, spelling = false) {
    const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 0; n < 3; n++) {
      const page = doc.addPage([612, 792]);
      page.drawText(spelling && n === 1 ? 'definately definately' : `BODY ${n + 1}`, { x: 50, y: 400, size: 14, font });
      if (spelling && n !== 1) page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Text', Rect: [100, 100, 120, 120], Contents: PDFString.of('definately definately'), F: 4,
      }))]));
    }
    if (spelling) {
      const field = doc.getForm().createTextField('Notes'); field.setText('definately definately');
      field.addToPage(doc.getPage(0), { x: 100, y: 500, width: 220, height: 25 });
      doc.getForm().updateFieldAppearances(font);
    }
    writeFileSync(source, await doc.save());
    await openByPaths([source]); await setView('operations'); await setActiveOp(op);
  }
  async function save() {
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, { timeout: 30000 });
    const dest = resolve(directory, 'result.pdf'); await saveActiveAs(dest); return dest;
  }
  it('header/footer stamps exactly pages 1 and 3 with consecutive Bates numbers', async () => {
    await open('headerfooter'); const before = readFileSync(source);
    await setReactInputValue('[data-testid="hf-tl"]', 'STAMP-{bates}');
    await setReactInputValue('[data-testid="hf-pages"]', '1,3');
    await setReactInputValue('[data-testid="hf-bates-start"]', '41');
    await setReactInputValue('[data-testid="hf-bates-digits"]', '3');
    await $('[data-testid="hf-apply"]').click();
    const texts = await textPages(await save());
    expect(texts[0]).toContain('STAMP-041'); expect(texts[1]).not.toContain('STAMP'); expect(texts[2]).toContain('STAMP-042');
    expect(readFileSync(source)).toEqual(before);
  });
  it('watermark expands 1-3 rather than silently marking only page 1', async () => {
    await open('watermark'); const before = readFileSync(source);
    await setReactInputValue('[data-testid="watermark-text"]', 'SCOPE');
    await setReactInputValue('[data-testid="watermark-pages"]', '1-3');
    await $('[data-testid="watermark-apply"]').click();
    const texts = await textPages(await save());
    expect(texts).toHaveLength(3); for (const text of texts) expect(text).toContain('SCOPE');
    expect(readFileSync(source)).toEqual(before);
  });
  it('Change all corrects text, a field, and duplicate notes without losing earlier corrections', async function () {
    // Eight corrections across three surfaces, each its own owned run, plus a
    // dictionary load and a full recheck: the case's own waits outlast the
    // default per-test budget.
    this.timeout(240_000);
    await open('spelling', true); const before = readFileSync(source);
    await $('[data-testid="spelling-language"] option[value="en_US"]').waitForExist({ timeout: 30000 });
    await $('[data-testid="spelling-language"]').selectByAttribute('value', 'en_US');
    await $('[data-testid="spelling-check"]').click();
    await $('[data-testid="spelling-word-definately"]').waitForDisplayed({ timeout: 45000 });
    await $('[data-testid="spelling-word-definately"]').click();
    await browser.waitUntil(async () => (await $('[data-testid="spelling-replacement"]').getValue()).length > 0, { timeout: 20000 });
    await setReactInputValue('[data-testid="spelling-replacement"]', 'definitely');
    await $('[data-testid="spelling-change-all"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="spelling-word-definately"]').isExisting())
      && await $('[data-testid="spelling-check"]').isEnabled(), { timeout: 90000, timeoutMsg: 'Spelling correction/recheck did not finish' });
    await $('[data-testid="spelling-report"]').waitForDisplayed({ timeout: 20_000 });
    expect(await $('[data-testid="spelling-status"]').isExisting()).toBe(false);
    const dest = await save(), texts = await textPages(dest), pdf = await PDFDocument.load(readFileSync(dest));
    expect(texts[1]).toContain('definitely definitely');
    expect(pdf.getForm().getTextField('Notes').getText()).toBe('definitely definitely');
    for (const n of [0, 2]) {
      const annotations = pdf.getPage(n).node.lookup(PDFName.of('Annots'), PDFArray);
      const notes = annotations.asArray().map(ref => pdf.context.lookup(ref, PDFDict))
        .filter(a => a.get(PDFName.of('Subtype')) === PDFName.of('Text'));
      expect(notes).toHaveLength(1);
      // A PDF text string is literal or hex; a corrected note is written UTF-16 hex.
      const contents = notes[0].lookup(PDFName.of('Contents')) as PDFString | PDFHexString;
      expect(contents.decodeText()).toBe('definitely definitely');
    }
    expect(readFileSync(source)).toEqual(before);
  });
});
