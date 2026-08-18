// Certification (DocMDP) signatures end to end: certifying in place, the
// panel's certified readout, and what the document's own policy permits.
//
// The three properties under test are the ones a user acts on: a change the
// certification ALLOWS must not be reported as a violation (the failure that
// would make the feature accuse its own users); a certification that allows
// nothing must REFUSE an edit rather than warn about it; and a change the
// certification forbids must not be APPENDED into a file this product's own
// verifier calls illegally modified — the append is refused, the rewrite lands,
// and the loss of the signature is stated rather than left to be found here.
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
  addAnnotation,
  commitPendingEdits,
  addRedactionMark,
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

async function formFixture(path: string): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  doc.addPage([400, 400]);
  const field = doc.getForm().createTextField('applicant');
  field.addToPage(page, { x: 40, y: 300, width: 220, height: 24, font });
  doc.getForm().updateFieldAppearances(font);
  writeFileSync(path, await doc.save());
  return path;
}

/** Open the sign form if it is not already open. The button toggles, and the
 * panel keeps its open state across a re-check. */
async function openSignForm(): Promise<void> {
  if (!(await $('[data-testid="sign-form"]').isExisting())) {
    await clickEl('[data-testid="sign-open"]');
    await $('[data-testid="sign-form"]').waitForExist({ timeout: 20_000 });
  }
}

/** Mount the Signatures panel, re-run its verification, and read the result.
 * The verify hook lives on the panel, so every read remounts it. */
async function verifyOnPanel(): Promise<SignatureVerifySnapshot> {
  await setView('operations');
  await setActiveOp('signatures');
  await clickEl('[data-testid="signatures-recheck"]');
  await $('[data-testid="signatures-summary"]').waitForDisplayed({ timeout: 20_000 });
  return verifyActiveSignatures();
}

describe('certification signatures', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'spectra-e2e-cert-'));
    await waitForHarness();
  });

  it('certifies for form filling, reports the level, permits the fill, and refuses to append a comment', async () => {
    const work = await formFixture(join(tmp, 'certify-form-fill.pdf'));
    await closeAllFiles();
    await openByPaths([work]);
    await setView('operations');
    await setActiveOp('signatures');

    // The certify control is offered on a document with no signature yet.
    await openSignForm();
    await $('[data-testid="certify-group"]').waitForExist({ timeout: 20_000 });

    const summary = await signActiveFileInPlace({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      certify: true,
      certifyLevel: 'form-fill',
    });
    expect(summary.signature_count).toBe(1);

    const certified = await verifyOnPanel();
    expect(certified.certified).toBe(true);
    expect(certified.certification_level).toBe('form-fill');
    expect(certified.any_policy_violation).toBe(false);
    expect(certified.signatures[0].certification_level).toBe('form-fill');
    expect(certified.signatures[0].policy_judged).toBe(true);

    // The panel names the certified state and its level, beside the ordinary
    // status badge rather than instead of it.
    const banner = await $('[data-testid="certification-banner"]');
    await banner.waitForDisplayed({ timeout: 20_000 });
    expect(await banner.getAttribute('data-level')).toBe('form-fill');
    expect(await banner.getAttribute('data-violated')).toBe('false');
    expect(await (await $('[data-testid="certification-level"]')).getText()).toContain(
      'Form filling',
    );
    await $('[data-testid="signature-certification-badge"]').waitForExist({ timeout: 20_000 });

    // The certify control is now absent, with a sentence saying why.
    await openSignForm();
    await $('[data-testid="certify-unavailable"]').waitForExist({ timeout: 20_000 });
    expect(await $('[data-testid="certify-group"]').isExisting()).toBe(false);

    // A form fill is exactly what this certification permits: no interruption,
    // and no violation afterwards.
    await setView('canvas');
    await focusTab({ doc: work });
    expect(await setCanvasFormValue(work, 'applicant', 'Permitted fill')).toBe(true);
    await applyCanvasFormValues();

    const filled = await verifyOnPanel();
    expect(filled.any_policy_violation).toBe(false);
    expect(filled.signatures[0].policy_ok).toBe(true);
    expect(filled.signatures[0].modification_level).toBe('FORM_FILLING');

    // A comment is not, and the answer to that is a REFUSAL, not a preserved
    // file that reports as a policy violation. The append tier's ceiling
    // refuses every class the certification forbids, so the ordinary rewrite
    // lands instead — and the commit says so rather than leaving the loss to
    // be discovered in this panel.
    //
    // This case used to assert the opposite (append it, then report the
    // violation), because that is what the product did before the ceiling
    // existed. Producing a document our own verifier calls illegally modified
    // is the behaviour that was removed, so the expectation moves with it.
    await setView('canvas');
    await focusTab({ doc: work });
    await addAnnotation({ kind: 'highlight', x: 0.2, y: 0.2, w: 0.25, h: 0.1, color: '#ffd54f' });
    await commitPendingEdits();

    const notice = await $('[data-testid="confirm-message"]');
    await notice.waitForDisplayed({ timeout: 20_000 });
    const noticeText = await notice.getText();
    expect(noticeText).toContain('could not be kept');
    // The engine's structured reason, named as the level it allows.
    expect(noticeText).toContain('certified to allow only form filling and signing');
    // Nothing to decide: the rewrite has already landed.
    await $('[data-testid="notice-ok"]').waitForExist({ timeout: 20_000 });
    expect(await $('[data-testid="confirm-affirm"]').isExisting()).toBe(false);
    await clickEl('[data-testid="notice-ok"]');

    // And what the document is afterwards, said plainly: the rewrite took the
    // certification with it, so there is no policy left to violate and the
    // signature no longer verifies. A violated certification is now something
    // this product REPORTS about files from elsewhere, never something it makes.
    const annotated = await verifyOnPanel();
    expect(annotated.certified).toBe(false);
    expect(annotated.certification_level).toBe(null);
    expect(annotated.all_valid).toBe(false);
    expect(annotated.any_policy_violation).toBe(false);
    expect(await $('[data-testid="certification-banner"]').isExisting()).toBe(false);

    await closeAllFiles();
  });

  it('certifies for commenting, and a comment then stays within the policy', async () => {
    const work = await formFixture(join(tmp, 'certify-annotate.pdf'));
    await closeAllFiles();
    await openByPaths([work]);
    await setView('operations');
    await setActiveOp('signatures');

    await signActiveFileInPlace({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      certify: true,
      certifyLevel: 'annotate',
    });
    expect((await verifyOnPanel()).certification_level).toBe('annotate');

    await setView('canvas');
    await focusTab({ doc: work });
    await addAnnotation({ kind: 'highlight', x: 0.2, y: 0.3, w: 0.3, h: 0.08, color: '#80cbc4' });
    await commitPendingEdits();

    const after = await verifyOnPanel();
    expect(after.signatures[0].policy_judged).toBe(true);
    expect(after.signatures[0].policy_ok).toBe(true);
    expect(after.signatures[0].modification_level).toBe('ANNOTATIONS');
    expect(after.any_policy_violation).toBe(false);
    expect(
      await (await $('[data-testid="certification-banner"]')).getAttribute('data-violated'),
    ).toBe('false');
    expect(await $('[data-testid="certification-violation"]').isExisting()).toBe(false);

    await closeAllFiles();
  });

  it('refuses an edit on a no-changes certification rather than warning about it', async () => {
    const work = await formFixture(join(tmp, 'certify-none.pdf'));
    await closeAllFiles();
    await openByPaths([work]);
    await setView('operations');
    await setActiveOp('signatures');

    await signActiveFileInPlace({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      certify: true,
      certifyLevel: 'none',
    });
    expect((await verifyOnPanel()).certification_level).toBe('none');

    await setView('canvas');
    await focusTab({ doc: work });
    await addRedactionMark({ x: 0.1, y: 0.1, w: 0.2, h: 0.06 });
    // Fired without awaiting: the call blocks on the dialog it raises.
    await browser.execute(() => {
      void (
        window as unknown as { __SPECTRA_TEST__: { saveRedactionMarks: () => Promise<void> } }
      ).__SPECTRA_TEST__.saveRedactionMarks();
    });

    const message = await $('[data-testid="confirm-message"]');
    await message.waitForDisplayed({ timeout: 20_000 });
    expect(await message.getText()).toContain('Save a copy');
    // A refusal, not a choice: one acknowledgement button and no Continue.
    await $('[data-testid="notice-ok"]').waitForExist({ timeout: 20_000 });
    expect(await $('[data-testid="confirm-affirm"]').isExisting()).toBe(false);
    await clickEl('[data-testid="notice-ok"]');

    // The document is untouched: still one signature, still certified.
    const after = await verifyOnPanel();
    expect(after.signature_count).toBe(1);
    expect(after.certification_level).toBe('none');

    await closeAllFiles();
  });
});
