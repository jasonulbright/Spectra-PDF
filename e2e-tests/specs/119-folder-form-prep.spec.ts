// Preparing a FOLDER of flat forms: files nobody opened, analysed by path,
// with the checkbox still deciding which fields get created.
//
// 114 covers the open-document scope and 118 covers the folder mirror for a
// different tool; neither joins them. The assertions only this spec can make
// are that the ORIGINALS are byte-identical afterwards, that the MIRROR files
// carry real AcroForm fields under the detected names, that an already
// prepared form reports itself rather than silently offering nothing, and
// that an unchecked candidate never became a field.
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  waitForHarness,
  invokeAppCommand,
  getState,
  closeAllFiles,
  formPrepSetFolders,
  formPrepDetect,
  formPrepCheck,
  formPrepApply,
  formPrepSnapshot,
} from '../support/harness.js';

const LABELS = ['First name:', 'Last name:', 'Email address:'];

/** A flat form: a label with a ruled line under it, the idiom detection reads.
 * `extraField` adds a REAL field, which is what makes a file "already
 * prepared". */
async function makeForm(path: string, extraField: boolean): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 700;
  for (const label of LABELS) {
    page.drawText(label, { x: 72, y: y + 3, size: 11, font });
    page.drawLine({
      start: { x: 170, y },
      end: { x: 520, y },
      thickness: 0.7,
      color: rgb(0, 0, 0),
    });
    y -= 40;
  }
  if (extraField) {
    const field = doc.getForm().createTextField('Already_there');
    field.addToPage(page, { x: 170, y: 500, width: 350, height: 20 });
  }
  writeFileSync(path, await doc.save());
}

async function fieldNames(path: string): Promise<string[]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return doc
    .getForm()
    .getFields()
    .map((f) => f.getName());
}

describe('Prepare Forms across a folder', () => {
  let tmp: string;
  let src: string;
  let dest: string;
  let alpha: string;
  let beta: string;
  let prepared: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-f19-'));
    src = resolve(tmp, 'source');
    dest = resolve(tmp, 'mirror');
    mkdirSync(resolve(src, 'sub'), { recursive: true });
    alpha = resolve(src, 'alpha.pdf');
    beta = resolve(src, 'sub', 'beta.pdf');
    prepared = resolve(src, 'prepared.pdf');
    await makeForm(alpha, false);
    await makeForm(beta, false);
    await makeForm(prepared, true);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('analyses a folder by path, creates only the checked fields, and never touches the originals', async function () {
    this.timeout(180_000);
    await waitForHarness();

    // No document is open, and none is opened by any of this — the command is
    // enabled regardless, like the other folder tools.
    expect(await invokeAppCommand('tools.formPrepFolder')).toBe(true);
    await $('[data-testid="form-prep-dialog"]').waitForDisplayed({ timeout: 10_000 });

    const before = {
      alpha: readFileSync(alpha),
      beta: readFileSync(beta),
      prepared: readFileSync(prepared),
    };

    await formPrepSetFolders(src, dest);
    await browser.waitUntil(async () => (await formPrepSnapshot())?.fileCount === 3, {
      timeout: 20_000,
      timeoutMsg: 'enumeration never found the 3 fixture PDFs',
    });

    await formPrepDetect();
    await browser.waitUntil(async () => (await formPrepSnapshot())?.phase === 'review', {
      timeout: 120_000,
      interval: 500,
      timeoutMsg:
        'the sweep never reached review — snapshot: ' + JSON.stringify(await formPrepSnapshot()),
    });

    const reviewed = await formPrepSnapshot();
    const byRel = new Map((reviewed?.files ?? []).map((f) => [f.rel, f]));
    expect(byRel.get('alpha.pdf')?.candidates).toBe(3);
    expect(byRel.get('sub\\beta.pdf')?.candidates).toBe(3);
    expect(byRel.get('alpha.pdf')?.names).toEqual([
      'First_name',
      'Last_name',
      'Email_address',
    ]);
    // The already-prepared form is a RESULT, not silence: the detector
    // subtracts the widget it already carries, and the file still reports what
    // it has.
    expect(byRel.get('prepared.pdf')?.candidates).toBe(3);
    expect(byRel.get('prepared.pdf')?.existingFields).toBe(1);

    // Nine candidates are offered and NONE is checked: the run pre-consents
    // to nothing.
    const keys = reviewed?.candidateKeys ?? [];
    expect(keys).toHaveLength(9);
    // Keys arrive in file then detection order, so alpha's are the first
    // three; the middle one is the candidate this run deliberately leaves out.
    const checked = keys.filter((_, i) => i !== 1);
    await formPrepCheck(checked);

    await formPrepApply();
    await browser.waitUntil(async () => (await formPrepSnapshot())?.phase === 'done', {
      timeout: 120_000,
      interval: 500,
      timeoutMsg:
        'the apply never finished — snapshot: ' + JSON.stringify(await formPrepSnapshot()),
    });

    const report = (await formPrepSnapshot())?.report;
    expect(report?.cancelled).toBe(false);
    const results = new Map((report?.results ?? []).map((r) => [r.rel, r]));
    expect(results.get('alpha.pdf')?.status).toBe('prepared');
    expect(results.get('sub\\beta.pdf')?.status).toBe('prepared');
    expect(results.get('prepared.pdf')?.status).toBe('prepared');
    expect(results.get('alpha.pdf')?.fields).toBe(2);

    // The ORIGINALS are untouched, byte for byte.
    expect(readFileSync(alpha).equals(before.alpha)).toBe(true);
    expect(readFileSync(beta).equals(before.beta)).toBe(true);
    expect(readFileSync(prepared).equals(before.prepared)).toBe(true);

    const mirrorAlpha = resolve(dest, 'alpha.pdf');
    const mirrorBeta = resolve(dest, 'sub', 'beta.pdf');
    const mirrorPrepared = resolve(dest, 'prepared.pdf');
    expect(existsSync(mirrorAlpha)).toBe(true);
    expect(existsSync(mirrorBeta)).toBe(true);
    expect(existsSync(mirrorPrepared)).toBe(true);

    // The MIRROR carries real fields under the labels' own names…
    expect(await fieldNames(mirrorAlpha)).toEqual(['First_name', 'Email_address']);
    expect(await fieldNames(mirrorBeta)).toEqual([
      'First_name',
      'Last_name',
      'Email_address',
    ]);
    // …the unchecked candidate never became one, which is what proves the
    // checkbox means something across a whole folder…
    expect(await fieldNames(mirrorAlpha)).not.toContain('Last_name');
    // …and a form that already had a field keeps it beside the new ones.
    const preparedNames = await fieldNames(mirrorPrepared);
    expect(preparedNames).toContain('Already_there');
    expect(preparedNames).toHaveLength(4);

    // The dialog holds its report until it is dismissed; the next case needs
    // it back at setup.
    await $('[data-testid="form-prep-close"]').click();
  });

  it('hands one file to the document flow, where its candidates are reviewable on the page', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await closeAllFiles();

    expect(await invokeAppCommand('tools.formPrepFolder')).toBe(true);
    await $('[data-testid="form-prep-dialog"]').waitForDisplayed({ timeout: 10_000 });
    await formPrepSetFolders(src, dest);
    await browser.waitUntil(async () => (await formPrepSnapshot())?.fileCount === 3, {
      timeout: 20_000,
      timeoutMsg: 'enumeration never found the 3 fixture PDFs',
    });
    await formPrepDetect();
    await browser.waitUntil(async () => (await formPrepSnapshot())?.phase === 'review', {
      timeout: 60_000,
      interval: 500,
      timeoutMsg:
        'the sweep never reached review — snapshot: ' + JSON.stringify(await formPrepSnapshot()),
    });

    // The escalation is the review affordance a folder cannot offer itself:
    // it opens the document through the app's one open funnel and arms the
    // tool that reviews candidates on the page.
    await $('[data-testid="form-prep-review-alpha.pdf"]').click();
    await browser.waitUntil(async () => (await getState()).activeFileId === alpha, {
      timeout: 20_000,
      timeoutMsg: 'the escalation never opened the file it named',
    });
    await browser.waitUntil(async () => (await getState()).activeToolId === 'prepareform', {
      timeout: 15_000,
      timeoutMsg: 'the escalation never armed Prepare Form',
    });
    // The dialog is gone: its list would be stale against a document the user
    // is now free to change.
    expect(await $('[data-testid="form-prep-dialog"]').isExisting()).toBe(false);
    await $('[data-testid="prepare-form-panel"]').waitForExist({ timeout: 15_000 });
    await closeAllFiles();
  });
});
