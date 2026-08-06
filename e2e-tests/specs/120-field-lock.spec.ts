// Field-level locking (/FieldMDP) end to end: signing with a lock, seeding one
// onto an unsigned signature field while preparing the form, the panel's
// readout of what it locks, and what the document's own signatures then permit.
//
// The two properties under test are the ones a user acts on: filling a LOCKED
// field is refused rather than warned about (the resulting file would report as
// altered in every reader, so a confirm would offer a choice with one outcome),
// and filling an UNLOCKED field of the same document still just works.
//
// The violation READBACK is pinned in tests/test_field_lock.py, where a file
// whose locked field did change can be constructed; no route through the
// product produces one, which is what this spec's refusal proves.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setView,
  setActiveOp,
  signActiveFileInPlace,
  signCanvasField,
  verifyActiveSignatures,
  setCanvasFormValue,
  applyCanvasFormValues,
  saveActiveAs,
  placeNewField,
  createPlacedField,
  invokeAppCommand,
  focusTab,
  type SignatureVerifySnapshot,
} from '../support/harness.js';

const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

async function clickEl(selector: string): Promise<void> {
  const el = await $(selector);
  await el.waitForExist({ timeout: 20_000 });
  await browser.execute((s: string) => {
    const node = document.querySelector(s) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center' });
    node?.click();
  }, selector);
}

/** Two text fields, so one lock names one of them and leaves the other free. */
async function formFixture(path: string): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('applicant').addToPage(page, {
    x: 40, y: 300, width: 220, height: 24, font,
  });
  form.createTextField('reviewer').addToPage(page, {
    x: 40, y: 250, width: 220, height: 24, font,
  });
  form.updateFieldAppearances(font);
  writeFileSync(path, await doc.save());
  return path;
}

async function openSignForm(): Promise<void> {
  if (!(await $('[data-testid="sign-form"]').isExisting())) {
    await clickEl('[data-testid="sign-open"]');
    await $('[data-testid="sign-form"]').waitForExist({ timeout: 20_000 });
  }
}

async function verifyOnPanel(): Promise<SignatureVerifySnapshot> {
  await setView('operations');
  await setActiveOp('signatures');
  await clickEl('[data-testid="signatures-recheck"]');
  await $('[data-testid="signatures-summary"]').waitForDisplayed({ timeout: 20_000 });
  return verifyActiveSignatures();
}

describe('field locks', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'spectra-e2e-lock-'));
    await waitForHarness();
  });

  it('signs with an include lock, reports it, and offers the document its own field names', async () => {
    const work = await formFixture(join(tmp, 'lock-include.pdf'));
    await closeAllFiles();
    await openByPaths([work]);
    await setView('operations');
    await setActiveOp('signatures');

    // The picker is populated from the document, and signature fields are not
    // among the names it offers.
    await openSignForm();
    await $('[data-testid="sign-lock-action"]').waitForExist({ timeout: 20_000 });
    await clickEl('[data-testid="sign-lock-action"]');
    await browser.execute(() => {
      const select = document.querySelector(
        '[data-testid="sign-lock-action"]',
      ) as HTMLSelectElement | null;
      if (select) {
        select.value = 'include';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await $('[data-testid="sign-lock-field-applicant"]').waitForExist({ timeout: 20_000 });
    await $('[data-testid="sign-lock-field-reviewer"]').waitForExist({ timeout: 20_000 });

    const summary = await signActiveFileInPlace({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      lock: 'include',
      lockFields: ['applicant'],
    });
    expect(summary.signature_count).toBe(1);

    const verified = await verifyOnPanel();
    expect(verified.signature_count).toBe(1);
    expect(verified.any_lock_violation).toBe(false);
    expect(verified.signatures[0].lock).toEqual({ action: 'include', fields: ['applicant'] });
    expect(verified.signatures[0].lock_violation).toBe(null);

    // The card names what the signature locks, beside its ordinary status.
    const line = await $('[data-testid="signature-lock"]');
    await line.waitForDisplayed({ timeout: 20_000 });
    expect(await line.getAttribute('data-lock-action')).toBe('include');
    // textContent, not getText(): the card sits in a scrolling list, and a line
    // below the fold renders as an empty string to the driver.
    const lockText = await browser.execute(
      () => document.querySelector('[data-testid="signature-lock"]')?.textContent ?? '',
    );
    expect(lockText).toContain('applicant');
    expect(await $('[data-testid="signature-lock-violation"]').isExisting()).toBe(false);
  });

  it('fills an unlocked field of the same document without interruption', async () => {
    const work = join(tmp, 'lock-include.pdf');
    await setView('canvas');
    await focusTab({ doc: work });
    expect(await setCanvasFormValue(work, 'reviewer', 'Reviewed')).toBe(true);
    await applyCanvasFormValues();

    const after = await verifyOnPanel();
    expect(after.signature_count).toBe(1);
    expect(after.any_lock_violation).toBe(false);
    expect(after.signatures[0].lock_violation).toBe(null);
    expect(after.signatures[0].modification_level).toBe('FORM_FILLING');
  });

  it('refuses a fill of the locked field rather than warning about it', async () => {
    const work = join(tmp, 'lock-include.pdf');
    await setView('canvas');
    await focusTab({ doc: work });
    expect(await setCanvasFormValue(work, 'applicant', 'Should not land')).toBe(true);
    // Fired without awaiting: the call blocks on the dialog it raises.
    await browser.execute(() => {
      void (
        window as unknown as { __SPECTRA_TEST__: { applyCanvasFormValues: () => Promise<void> } }
      ).__SPECTRA_TEST__.applyCanvasFormValues();
    });

    const message = await $('[data-testid="confirm-message"]');
    await message.waitForDisplayed({ timeout: 20_000 });
    const text = await message.getText();
    expect(text).toContain('applicant');
    expect(text).toContain('Save a copy');
    // A refusal, not a choice: one acknowledgement button and no Continue.
    await $('[data-testid="notice-ok"]').waitForExist({ timeout: 20_000 });
    expect(await $('[data-testid="confirm-affirm"]').isExisting()).toBe(false);
    await clickEl('[data-testid="notice-ok"]');

    // The document is untouched: still one signature, still no violation.
    const after = await verifyOnPanel();
    expect(after.signature_count).toBe(1);
    expect(after.any_lock_violation).toBe(false);
    expect(after.signatures[0].lock_violation).toBe(null);

    await closeAllFiles();
  });

  it('locks every field when the action covers them all', async () => {
    const work = await formFixture(join(tmp, 'lock-all.pdf'));
    await closeAllFiles();
    await openByPaths([work]);
    await setView('operations');
    await setActiveOp('signatures');

    await signActiveFileInPlace({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      lock: 'all',
    });
    const verified = await verifyOnPanel();
    expect(verified.signatures[0].lock).toEqual({ action: 'all', fields: [] });

    await setView('canvas');
    await focusTab({ doc: work });
    expect(await setCanvasFormValue(work, 'reviewer', 'Blocked too')).toBe(true);
    await browser.execute(() => {
      void (
        window as unknown as { __SPECTRA_TEST__: { applyCanvasFormValues: () => Promise<void> } }
      ).__SPECTRA_TEST__.applyCanvasFormValues();
    });
    const message = await $('[data-testid="confirm-message"]');
    await message.waitForDisplayed({ timeout: 20_000 });
    expect(await message.getText()).toContain('reviewer');
    await clickEl('[data-testid="notice-ok"]');

    expect((await verifyOnPanel()).signature_count).toBe(1);
    await closeAllFiles();
  });
});

/** Field names and lock targets are PDF text strings, which the renderer writes
 * in hex form — `String(value)` would give the `<…>` literal, not the name. */
function decodeText(value: unknown): string | null {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
}

/** The `/Lock` a top-level signature field carries, read straight from the file
 * rather than through any app surface. */
async function lockOfFile(
  path: string,
  fieldName: string,
): Promise<{ action: string; fields: string[] } | null> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), {
    ignoreEncryption: true,
  });
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  for (let i = 0; i < (fields?.size() ?? 0); i++) {
    const entry = fields!.get(i);
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) continue;
    if (decodeText(dict.get(PDFName.of('T'))) !== fieldName) continue;
    const lock = dict.lookupMaybe(PDFName.of('Lock'), PDFDict);
    if (!lock) return null;
    const action = lock.lookupMaybe(PDFName.of('Action'), PDFName)?.asString() ?? '';
    const listed = lock.lookupMaybe(PDFName.of('Fields'), PDFArray);
    const names: string[] = [];
    for (let j = 0; j < (listed?.size() ?? 0); j++) {
      const text = decodeText(listed!.get(j));
      if (text !== null) names.push(text);
    }
    return { action, fields: names };
  }
  return null;
}

describe('preparer-placed field locks', () => {
  let tmp: string;
  let prepared: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'spectra-e2e-seed-'));
    await waitForHarness();
  });

  it('authors a signature field carrying its own lock', async () => {
    const work = await formFixture(join(tmp, 'prepare.pdf'));
    await closeAllFiles();
    await openByPaths([work]);
    await setView('canvas');

    // The picker offers the document's own fillable names and no signature
    // field: a lock governs form fields.
    await placeNewField({ x: 0.55, y: 0.6, w: 0.35, h: 0.12 });
    await $('[data-testid="new-field-type"]').waitForExist({ timeout: 20_000 });
    await browser.execute(() => {
      const select = document.querySelector('[data-testid="new-field-type"]') as HTMLSelectElement | null;
      if (select) {
        select.value = 'signature';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await $('[data-testid="new-field-lock-action"]').waitForExist({ timeout: 20_000 });
    await browser.execute(() => {
      const select = document.querySelector('[data-testid="new-field-lock-action"]') as HTMLSelectElement | null;
      if (select) {
        select.value = 'include';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await $('[data-testid="new-field-lock-field-applicant"]').waitForExist({ timeout: 20_000 });
    await $('[data-testid="new-field-lock-field-reviewer"]').waitForExist({ timeout: 20_000 });
    expect(await $('[data-testid="new-field-lock-field-Approval"]').isExisting()).toBe(false);

    await createPlacedField(
      { name: 'Approval', type: 'signature', lock: { action: 'include', fields: ['applicant'] } },
      { path: work },
    );

    prepared = join(tmp, 'prepared.pdf');
    await saveActiveAs(prepared);
    expect(await lockOfFile(prepared, 'Approval')).toEqual({
      action: '/Include',
      fields: ['applicant'],
    });
    await closeAllFiles();
  });

  it('binds whoever signs that field, with no lock asked for', async () => {
    await openByPaths([prepared]);
    await setView('canvas');
    const signed = join(tmp, 'prepared-signed.pdf');
    // No lock parameter anywhere in this call: the seed is the whole request.
    const summary = await signCanvasField({
      fieldName: 'Approval',
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      output: signed,
    });
    expect(summary.valid).toBe(true);

    await closeAllFiles();
    await openByPaths([signed]);
    const verified = await verifyOnPanel();
    expect(verified.signature_count).toBe(1);
    expect(verified.signatures[0].lock).toEqual({ action: 'include', fields: ['applicant'] });
    expect(verified.signatures[0].lock_violation).toBe(null);
  });

  it('refuses a fill of the field the preparer locked', async () => {
    const signed = join(tmp, 'prepared-signed.pdf');
    await setView('canvas');
    await focusTab({ doc: signed });
    expect(await setCanvasFormValue(signed, 'applicant', 'Should not land')).toBe(true);
    // Fired without awaiting: the call blocks on the dialog it raises.
    await browser.execute(() => {
      void (
        window as unknown as { __SPECTRA_TEST__: { applyCanvasFormValues: () => Promise<void> } }
      ).__SPECTRA_TEST__.applyCanvasFormValues();
    });
    const message = await $('[data-testid="confirm-message"]');
    await message.waitForDisplayed({ timeout: 20_000 });
    expect(await message.getText()).toContain('applicant');
    await clickEl('[data-testid="notice-ok"]');

    // The other field of the same document is untouched by the lock.
    expect(await setCanvasFormValue(signed, 'reviewer', 'Reviewed')).toBe(true);
    await applyCanvasFormValues();
    const after = await verifyOnPanel();
    expect(after.any_lock_violation).toBe(false);
    expect(after.signatures[0].modification_level).toBe('FORM_FILLING');
    await closeAllFiles();
  });

  it('edits an unsigned signature field lock from the Prepare Form panel', async () => {
    await openByPaths([prepared]);
    expect(await invokeAppCommand('tools.panel.prepareform')).toBe(true);
    await $('[data-testid="prepare-form-panel"]').waitForDisplayed({ timeout: 20_000 });
    const row = await $('[data-testid="prepare-form-sigfield-Approval"]');
    await row.waitForExist({ timeout: 20_000 });
    await browser.execute(() => {
      const select = document.querySelector(
        '[data-testid="prepare-form-sigfield-Approval-lock-action"]',
      ) as HTMLSelectElement | null;
      if (select) {
        select.value = 'all';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await clickEl('[data-testid="prepare-form-sigfield-apply-Approval"]');
    await $('[data-testid="prepare-form-status"]').waitForDisplayed({ timeout: 30_000 });

    const edited = join(tmp, 'edited.pdf');
    await saveActiveAs(edited);
    expect(await lockOfFile(edited, 'Approval')).toEqual({ action: '/All', fields: [] });
    await closeAllFiles();
  });
});
