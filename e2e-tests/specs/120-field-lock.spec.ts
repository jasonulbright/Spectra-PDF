// Field-level locking (/FieldMDP) end to end: signing with a lock, the panel's
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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setView,
  setActiveOp,
  signActiveFileInPlace,
  verifyActiveSignatures,
  setCanvasFormValue,
  applyCanvasFormValues,
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
    expect(await line.getText()).toContain('applicant');
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
