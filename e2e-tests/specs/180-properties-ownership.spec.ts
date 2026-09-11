import { linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { answerNextSaveDialog, closeAllFiles, focusTab, getState, openByPaths,
  setReactInputValue, setReactSelectValue, waitForHarness, invokeAppCommand,
  a11ySnapshot, a11yAuthoredFix } from '../support/harness.js';

const N = PDFName.of;
async function openProperties(tab = 'description') {
  await browser.keys(['Control', 'd']);
  await $('[data-testid="properties-dialog"]').waitForDisplayed();
  await $('[data-testid="props-title"]').waitForEnabled();
  await $(`[data-testid="props-tab-${tab}"]`).click();
}
const saved = () => browser.waitUntil(async () => (await $('[data-testid="props-status"]').getText()) === 'Saved to the document',
  { timeout: 20000, timeoutMsg: 'Properties operation did not publish successfully' });

describe('Properties facts, drafts and publication ownership', () => {
  let directory: string, a: string, b: string, working: string;
  beforeEach(async () => {
    await waitForHarness();
    if (await $('[data-testid="props-close"]').isExisting()) await $('[data-testid="props-close"]').click();
    await closeAllFiles();
    directory = mkdtempSync(resolve(__dirname, '../../properties-ownership.local.d-'));
    a = resolve(directory, 'A.pdf'); b = resolve(directory, 'B.pdf');
    for (const [path, title] of [[a, 'Title A'], [b, 'Title B']]) {
      const pdf = await PDFDocument.create(); const first = pdf.addPage([300, 400]); pdf.addPage([300, 400]);
      pdf.setTitle(title); pdf.setAuthor('Preserved author');
      pdf.catalog.set(N('OpenAction'), pdf.context.obj({ S: 'GoTo', D: [first.ref, 'FitR', 10, 20, 200, 300],
        Next: { S: 'Named', N: 'NextPage' } }));
      writeFileSync(path, await pdf.save({ useObjectStreams: false }));
    }
    await openByPaths([a, b]); await focusTab({ doc: a });
    working = (await getState()).activeFile!.workingPath;
  });
  afterEach(async () => {
    if (await $('[data-testid="props-close"]').isExisting()) await $('[data-testid="props-close"]').click();
    await closeAllFiles();
  });
  it('applying Advanced retains unsaved Description and Initial View input', async () => {
    await openProperties(); await setReactInputValue('[data-testid="props-title"]', 'Unsubmitted title');
    await $('[data-testid="props-tab-initialView"]').click(); await $('[data-testid="props-iv-mode"]').waitForEnabled();
    await setReactSelectValue('[data-testid="props-iv-mode"]', 'thumbnails');
    await $('[data-testid="props-tab-advanced"]').click(); await $('[data-testid="props-base-url"]').waitForEnabled();
    await setReactInputValue('[data-testid="props-base-url"]', 'https://example.invalid/new/');
    await $('[data-testid="props-advanced-apply"]').click(); await saved();
    await $('[data-testid="props-tab-initialView"]').click(); await $('[data-testid="props-iv-mode"]').waitForEnabled();
    expect(await $('[data-testid="props-iv-mode"]').getValue()).toBe('thumbnails');
    expect(await $('[data-testid="props-iv-apply"]').isEnabled()).toBe(true);
    await $('[data-testid="props-tab-description"]').click(); await $('[data-testid="props-title"]').waitForEnabled();
    expect(await $('[data-testid="props-title"]').getValue()).toBe('Unsubmitted title');
    const pdf = await PDFDocument.load(readFileSync(working), { updateMetadata: false });
    expect(pdf.getTitle()).toBe('Title A');
    expect(pdf.catalog.lookup(N('URI'), PDFDict).lookup(N('Base'), PDFString).decodeText()).toBe('https://example.invalid/new/');
  });
  it('A-B-A retains separate drafts and never adopts the other document input', async () => {
    await openProperties(); await setReactInputValue('[data-testid="props-title"]', 'A draft');
    await focusTab({ doc: b }); await $('[data-testid="props-title"]').waitForEnabled();
    await browser.waitUntil(async () => (await $('[data-testid="props-title"]').getValue()) === 'Title B');
    await setReactInputValue('[data-testid="props-title"]', 'B draft');
    await focusTab({ doc: a });
    await browser.waitUntil(async () => (await $('[data-testid="props-title"]').getValue()) === 'A draft');
    await focusTab({ doc: b });
    await browser.waitUntil(async () => (await $('[data-testid="props-title"]').getValue()) === 'B draft');
  });
  it('a page-only change preserves the stored view rectangle and chained action', async () => {
    await openProperties('initialView'); await $('[data-testid="props-iv-page"]').waitForEnabled();
    expect(await $('[data-testid="props-iv-zoom"]').getValue()).toBe('custom');
    await setReactInputValue('[data-testid="props-iv-page"]', '2');
    await $('[data-testid="props-iv-apply"]').click(); await saved();
    const pdf = await PDFDocument.load(readFileSync(working), { updateMetadata: false });
    const action = pdf.catalog.lookup(N('OpenAction'), PDFDict), dest = action.lookup(N('D'), PDFArray);
    expect(dest.get(0).toString()).toBe(pdf.getPage(1).ref.toString());
    expect(dest.asArray().slice(1).map(x => x.toString())).toEqual(['/FitR', '10', '20', '200', '300']);
    expect(action.lookup(N('Next'), PDFDict).lookup(N('N'), PDFName).toString()).toBe('/NextPage');
  });
  it('malformed advanced facts remain unknown and cannot seed an Apply', async () => {
    await closeAllFiles();
    const pdf = await PDFDocument.load(readFileSync(a), { updateMetadata: false });
    pdf.catalog.set(N('MarkInfo'), pdf.context.obj({ Marked: PDFString.of('false') }));
    const bad = resolve(directory, 'malformed.pdf'); writeFileSync(bad, await pdf.save());
    await openByPaths([bad]); await openProperties('advanced');
    await $('[data-testid="props-read-error"]').waitForDisplayed();
    expect(await $('[data-testid="props-tagged"]').getText()).toBe('Unknown');
    expect(await $('[data-testid="props-advanced-apply"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="props-base-url"]').isEnabled()).toBe(false);
  });
  it('strip-to-copy does not clear the open metadata draft or source bytes', async () => {
    const before = readFileSync(working), output = resolve(directory, 'stripped.pdf');
    await openProperties(); await setReactInputValue('[data-testid="props-title"]', 'Keep draft');
    await answerNextSaveDialog(output); await $('[data-testid="props-strip"]').click();
    await browser.waitUntil(async () => (await $('[data-testid="props-status"]').getText()) === 'All metadata removed', { timeout: 20000 });
    expect(await $('[data-testid="props-title"]').getValue()).toBe('Keep draft');
    expect(readFileSync(working).equals(before)).toBe(true);
    const copy = await PDFDocument.load(readFileSync(output), { updateMetadata: false }); expect(copy.getTitle()).toBeUndefined();
  });
  it('accessibility title repair retains unrelated metadata and publishes the display flag', async () => {
    expect(await invokeAppCommand('tools.panel.accessibility')).toBe(true);
    await $('[data-testid="a11y-tree"]').waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(async () => (await a11ySnapshot()) !== null, { timeout: 30000 });
    expect(await a11yAuthoredFix('title', null, 'Accessible title')).toBe('');
    const pdf = await PDFDocument.load(readFileSync(working), { updateMetadata: false });
    expect(pdf.getTitle()).toBe('Accessible title');
    expect(pdf.getAuthor()).toBe('Preserved author');
    expect(pdf.catalog.lookup(N('ViewerPreferences'), PDFDict).get(N('DisplayDocTitle'))?.toString()).toBe('true');
  });
  for (const alias of [false, true]) it(`metadata copy cannot replace an open working file (hardlink=${alias})`, async () => {
    const before = readFileSync(working);
    await openProperties(); await setReactInputValue('[data-testid="props-title"]', 'Not published');
    const output = alias ? resolve(directory, 'working-alias.pdf') : working;
    if (alias) linkSync(working, output);
    await answerNextSaveDialog(output); await $('[data-testid="props-save"]').click();
    await browser.waitUntil(async () => (await $('[data-testid="props-status"]').getText()).includes('different file'), { timeout: 15000 });
    expect(readFileSync(working).equals(before)).toBe(true);
    expect(await $('[data-testid="props-title"]').getValue()).toBe('Not published');
  });
});
