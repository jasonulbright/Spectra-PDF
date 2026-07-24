import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  getState,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function makeLinkedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const ctx = doc.context;
  const link = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [50, 100, 200, 120],
    A: ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of('https://old.example.com') }),
  });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(link)]));
  writeFileSync(path, await doc.save());
}

async function firstLinkUrl(path: string): Promise<string | undefined> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; url?: string }[];
  await pdf.loadingTask.destroy();
  return annots.find((a) => a.subtype === 'Link')?.url;
}

async function applyAndSave(dest: string): Promise<void> {
  await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
    timeout: 20_000,
    timeoutMsg: 'link mutation never marked the file dirty',
  });
  await saveActiveAs(dest);
  expect(existsSync(dest)).toBe(true);
}

describe('links manager (N1)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-link-'));
    source = resolve(tmp, 'linked.pdf');
    await makeLinkedPdf(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists a link and retargets its URL through the engine', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('links');

    const item = $('[data-testid="link-item"]');
    await item.waitForDisplayed({ timeout: 20_000 });
    expect(await item.getText()).toContain('old.example.com');

    await $('[data-testid="link-edit-1-0"]').click();
    await setReactInputValue('[data-testid="link-url-input-1-0"]', 'https://new.example.com');
    await $('[data-testid="link-save-1-0"]').click();
    const dest = resolve(tmp, 'retargeted.pdf');
    await applyAndSave(dest);
    expect(await firstLinkUrl(dest)).toBe('https://new.example.com/');
  });

  it('deletes a link through the engine', async () => {
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('links');
    await $('[data-testid="link-delete-1-0"]').waitForDisplayed({ timeout: 20_000 });
    await $('[data-testid="link-delete-1-0"]').click();
    const dest = resolve(tmp, 'nolink.pdf');
    await applyAndSave(dest);
    await $('[data-testid="links-empty"]').waitForDisplayed({ timeout: 20_000 });
    expect(await firstLinkUrl(dest)).toBeUndefined();
  });
});
