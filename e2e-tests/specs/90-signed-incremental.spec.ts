// Annotating a SIGNED document commits as an INCREMENTAL APPEND:
// the working copy becomes original-bytes + one revision, so the embedded
// signature keeps verifying. The CLI is the truth on both claims:
// verify-signatures (still intact+valid) and comments-list (the annotation
// is really in the file). This exact flow used to break the
// signature silently — the commit was a pdf-lib rewrite.
//
// The PAGE tier is the second half, and it is the one whose write happens
// later: a rotate lands in memory and the file is rebuilt at commit time. So
// the question a gesture has to ask is not "is this document signed" but
// "will this document's signature survive THIS delta" — which is why the four
// cases below are a matrix of (signature situation × delta) rather than a
// signed/unsigned pair. An approval signature carries a page-key change and
// must raise nothing; a certification forbids it and must be asked BEFORE the
// gesture; a watermark is drawn-content drift and warns whatever the document
// says; and a delta the transplant refuses lands as a rewrite that has to SAY
// the signature is gone rather than leave it to be discovered.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  focusTab,
  getState,
  getWorkspacePageIds,
  selectCanvasPages,
  getSelectedCanvasPageIds,
  invokeAppCommand,
  addAnnotation,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
  signActiveFileInPlace,
  verifyActiveSignatures,
  setReactInputValue,
  setReactSelectValue,
  waitForDisplayedSelector,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const SIGNED_PDF = resolve(__dirname, '..', 'fixtures', 'signed.pdf');
const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_AFFIRM = '[data-testid="confirm-affirm"]';
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]';
const NOTICE_OK = '[data-testid="notice-ok"]';
/** Present exactly while the page tier holds an uncommitted edit. */
const PENDING_BADGE = '[data-testid="apply-page-edits-btn"]';

function cliJson<T>(args: string[]): T {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  return JSON.parse(out.slice(out.indexOf('{'))) as T;
}

interface VerifyResult {
  signatures: { intact: boolean; valid: boolean }[];
}

/** There is no certified fixture on disk and there should not be one: a
 * certification is authored by the product's own sign flow, and a fixture
 * frozen beside it would go stale the first time that flow changes. The
 * document is built here and certified through the same in-place signing the
 * Signatures panel runs. */
async function certifiedFixture(path: string, level: 'annotate' | 'none'): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  doc.addPage([400, 400]);
  const field = doc.getForm().createTextField('applicant');
  field.addToPage(page, { x: 40, y: 300, width: 220, height: 24, font });
  doc.getForm().updateFieldAppearances(font);
  writeFileSync(path, await doc.save());

  await closeAllFiles();
  await openByPaths([path]);
  await setView('operations');
  await setActiveOp('signatures');
  await signActiveFileInPlace({
    pfxPath: TEST_PFX,
    password: TEST_PFX_PASSWORD,
    certify: true,
    certifyLevel: level,
  });
  const verified = await verifyActiveSignatures();
  expect(verified.certified).toBe(true);
  expect(verified.certification_level).toBe(level);
  return path;
}

const pageIdsOf = async (path: string): Promise<string[]> =>
  (await getWorkspacePageIds()).filter((id) => id.startsWith(path));

/**
 * Select the first page of the active document on the canvas, and answer with
 * the page ids as they stood — the caller compares against them.
 *
 * The selection is made INSIDE the wait and then re-proved against a fresh
 * listing, because page ids are generation-tagged and the reindex that follows
 * an engine op (here: signing the document in place) is async. A selection
 * dispatched from an id read a moment too early names a generation that no
 * longer exists; the reindex's own prune cannot help, because it only drops
 * ids that were selected BEFORE it ran. What is left is a selection the
 * commands still count as one and the reducer then rejects — a gesture that
 * does nothing, which reads exactly like a gate that failed to fire. It is a
 * driving hazard only: a page a user can click is a page that is on screen.
 */
async function selectFirstPage(path: string): Promise<string[]> {
  await setView('canvas');
  await focusTab({ doc: path });
  let ids: string[] = [];
  await browser.waitUntil(
    async () => {
      ids = await pageIdsOf(path);
      if (ids.length === 0) return false;
      await selectCanvasPages([ids[0]]);
      const selected = await getSelectedCanvasPageIds();
      const live = await pageIdsOf(path);
      return (
        selected.length === 1 && selected[0] === ids[0] && live.length === ids.length &&
        live.every((id, i) => id === ids[i])
      );
    },
    {
      timeout: 30_000,
      interval: 400,
      timeoutMsg: `${path} never settled into a selectable listing on the canvas`,
    },
  );
  return ids;
}

/** The working copy's bytes — what a commit actually writes. The user's own
 * file is not touched until a save, so it cannot tell an edit that landed from
 * one that was called off. */
async function workingBytes(): Promise<Buffer> {
  const workingPath = (await getState()).activeFile?.workingPath;
  expect(typeof workingPath).toBe('string');
  return readFileSync(workingPath!);
}

async function dialogExists(): Promise<boolean> {
  return await browser.execute(
    (sel: string) => document.querySelector(sel) !== null,
    CONFIRM_MESSAGE,
  );
}

/** The first page's /Rotate in a saved file. */
async function firstPageRotation(path: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(path), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return doc.getPage(0).getRotation().angle;
}

describe('signed-document incremental commit', () => {
  it('an added comment survives commit with the signature still verifying', async () => {
    await waitForHarness();
    await closeAllFiles();

    const tmp = mkdtempSync(join(tmpdir(), 'spectra-o5b-'));
    const work = join(tmp, 'signed-work.pdf');
    copyFileSync(SIGNED_PDF, work);
    const originalBytes = readFileSync(work);

    // Baseline: the fixture's signature verifies before any edit.
    const before = cliJson<VerifyResult>(['verify-signatures', work]);
    expect(before.signatures).toHaveLength(1);
    expect(before.signatures[0].intact).toBe(true);
    expect(before.signatures[0].valid).toBe(true);

    await openByPaths([work]);
    await setView('canvas');
    await addAnnotation({ kind: 'highlight', x: 0.2, y: 0.2, w: 0.25, h: 0.1, color: '#ffd54f' });
    await commitPendingEdits();

    const dest = join(tmp, 'signed-annotated.pdf');
    await saveActiveAs(dest);

    // The transplant property, byte-for-byte: the saved file STARTS WITH
    // the signed original verbatim (an appended revision, not a rewrite).
    const savedBytes = readFileSync(dest);
    expect(savedBytes.length).toBeGreaterThan(originalBytes.length);
    expect(savedBytes.subarray(0, originalBytes.length).equals(originalBytes)).toBe(true);

    // Signature still verifies AND the annotation is really in the file.
    const after = cliJson<VerifyResult>(['verify-signatures', dest]);
    expect(after.signatures).toHaveLength(1);
    expect(after.signatures[0].intact).toBe(true);
    expect(after.signatures[0].valid).toBe(true);

    const comments = cliJson<{ count: number; annotations: { subtype: string }[] }>(
      ['comments-list', dest],
    );
    expect(
      comments.annotations.some(
        (a) => a.subtype.includes('Square') || a.subtype.includes('Highlight'),
      ),
    ).toBe(true);

    await closeAllFiles();
  });

  it('rotating a page of an approval-signed document asks nothing and keeps the signature', async () => {
    await waitForHarness();
    await closeAllFiles();

    const tmp = mkdtempSync(join(tmpdir(), 'spectra-o5b-rotate-'));
    const work = join(tmp, 'signed-rotate.pdf');
    copyFileSync(SIGNED_PDF, work);
    const originalBytes = readFileSync(work);
    expect(await firstPageRotation(work)).toBe(0);

    await openByPaths([work]);
    await selectFirstPage(work);

    // The gate is DELTA-aware: /Rotate is a single-key change the transplant
    // appends, so an approval signature survives it and there is nothing to
    // warn about. The gesture landing at all is the proof — a dialog would
    // have held the dispatch behind it.
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await waitForDisplayedSelector(PENDING_BADGE, {
      timeout: 20_000,
      timeoutMsg: 'the rotate never reached the page tier on an approval-signed document',
    });
    expect(await dialogExists()).toBe(false);

    await commitPendingEdits();
    // Re-read after the commit: a dialog raised late is still a dialog.
    expect(await dialogExists()).toBe(false);

    // The panel's own verdict on the committed working copy — the surface a
    // user would check, not just the file the CLI reads.
    await setView('operations');
    await setActiveOp('signatures');
    const panel = await verifyActiveSignatures();
    expect(panel.signature_count).toBe(1);
    expect(panel.all_valid).toBe(true);
    expect(panel.certified).toBe(false);

    const dest = join(tmp, 'signed-rotated.pdf');
    await saveActiveAs(dest);

    // The transplant carried the page key: the saved file is the signed
    // original verbatim plus one revision, and the rotation is really in it.
    const savedBytes = readFileSync(dest);
    expect(savedBytes.length).toBeGreaterThan(originalBytes.length);
    expect(savedBytes.subarray(0, originalBytes.length).equals(originalBytes)).toBe(true);
    expect(await firstPageRotation(dest)).toBe(90);

    const after = cliJson<VerifyResult>(['verify-signatures', dest]);
    expect(after.signatures).toHaveLength(1);
    expect(after.signatures[0].intact).toBe(true);
    expect(after.signatures[0].valid).toBe(true);

    await closeAllFiles();
  });

  it('the same rotate on a CERTIFIED document asks first, and declining changes nothing', async () => {
    await waitForHarness();

    const tmp = mkdtempSync(join(tmpdir(), 'spectra-o5b-certified-'));
    const work = await certifiedFixture(join(tmp, 'certified-decline.pdf'), 'annotate');

    const idsBefore = await selectFirstPage(work);
    const bytesBefore = await workingBytes();

    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);

    // BEFORE the gesture, not after the commit: no certification admits a page
    // key, so this rotate costs the certification and the question is asked
    // while there is still an answer that avoids it.
    await waitForDisplayedSelector(CONFIRM_MESSAGE, {
      timeout: 20_000,
      timeoutMsg: 'the certified rotate raised no dialog',
    });
    const message = await $(CONFIRM_MESSAGE).getText();
    expect(message).toContain('certified');
    expect(message).toContain('break the certification');
    // A warn, not a refusal: this level allows something, so the user has a
    // choice to make and both buttons are there to make it.
    expect(await $(CONFIRM_AFFIRM).isExisting()).toBe(true);
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });

    // Declining leaves the document exactly as it stood: no page-tier edit,
    // the same page identities, and not one byte written.
    expect(await $(PENDING_BADGE).isExisting()).toBe(false);
    expect((await getWorkspacePageIds()).filter((id) => id.startsWith(work))).toEqual(idsBefore);
    expect((await workingBytes()).equals(bytesBefore)).toBe(true);

    await setView('operations');
    await setActiveOp('signatures');
    const still = await verifyActiveSignatures();
    expect(still.signature_count).toBe(1);
    expect(still.certified).toBe(true);
    expect(still.certification_level).toBe('annotate');
    expect(still.any_policy_violation).toBe(false);

    await closeAllFiles();
  });

  it('a watermark on a signed document warns before the engine runs', async () => {
    await waitForHarness();
    await closeAllFiles();

    const tmp = mkdtempSync(join(tmpdir(), 'spectra-o5b-watermark-'));
    const work = join(tmp, 'signed-watermark.pdf');
    copyFileSync(SIGNED_PDF, work);

    await openByPaths([work]);
    await setView('operations');
    await setActiveOp('watermark');
    await setReactSelectValue('[data-testid="watermark-source"]', 'text');
    await setReactInputValue('[data-testid="watermark-text"]', 'E2E-SIGNED-WM');

    // Stamping is drawn-content drift, which the append tier refuses on
    // purpose — so the op's roster class is structural and every signed
    // document gets the question, certified or not.
    await $('[data-testid="watermark-apply"]').click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, {
      timeout: 20_000,
      timeoutMsg: 'the watermark ran against a signed document with no warning',
    });
    expect(await $(CONFIRM_MESSAGE).getText()).toContain('invalidate its digital signatures');
    expect(await $(CONFIRM_AFFIRM).isExisting()).toBe(true);
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });

    // Declined means nothing ran: the engine was never called, so the file is
    // not dirty and its signature is untouched.
    expect((await getState()).activeFile?.dirty).toBe(false);
    await setActiveOp('signatures');
    const untouched = await verifyActiveSignatures();
    expect(untouched.signature_count).toBe(1);
    expect(untouched.all_valid).toBe(true);

    await closeAllFiles();
  });

  it('a refused transplant says the signature was not preserved instead of rewriting in silence', async () => {
    await waitForHarness();

    const tmp = mkdtempSync(join(tmpdir(), 'spectra-o5b-notice-'));
    const work = await certifiedFixture(join(tmp, 'certified-continue.pdf'), 'annotate');

    await selectFirstPage(work);
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await waitForDisplayedSelector(CONFIRM_MESSAGE, {
      timeout: 20_000,
      timeoutMsg: 'the certified rotate raised no dialog',
    });
    // This time the user accepts the cost, which is what puts the commit on
    // the rewrite path the notice exists to report.
    await $(CONFIRM_AFFIRM).click();
    await waitForDisplayedSelector(PENDING_BADGE, {
      timeout: 20_000,
      timeoutMsg: 'the accepted rotate never reached the page tier',
    });

    await commitPendingEdits();

    // The notice is drained OUTSIDE the commit promise, so it arrives after
    // the commit resolves rather than parking the engine queue behind an OK.
    await waitForDisplayedSelector(CONFIRM_MESSAGE, {
      timeout: 20_000,
      timeoutMsg: 'the rewrite landed with no word about the lost signature',
    });
    const notice = await $(CONFIRM_MESSAGE).getText();
    expect(notice).toContain('could not be kept');
    expect(notice).toContain('certified-continue.pdf');
    // The engine's structured refusal reason, carried through as a clause —
    // not a bare "the signature is gone".
    expect(notice).toContain('certified to allow only form filling, signing and commenting');
    // Nothing left to decide: the rewrite has already landed.
    expect(await $(NOTICE_OK).isExisting()).toBe(true);
    expect(await $(CONFIRM_AFFIRM).isExisting()).toBe(false);
    await $(NOTICE_OK).click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });

    // And the notice told the truth on both halves: the rotate is in the file
    // and the signature is not.
    const dest = join(tmp, 'certified-rewritten.pdf');
    await saveActiveAs(dest);
    expect(await firstPageRotation(dest)).toBe(90);
    // "No longer verifies as signed" has two shapes and both are that claim:
    // the rewrite can drop the signature field outright, or keep it over a
    // byte range that no longer covers the file.
    const after = cliJson<{ signed: boolean; signatures: { intact: boolean }[] }>([
      'verify-signatures',
      dest,
    ]);
    expect(after.signed === false || after.signatures.some((s) => !s.intact)).toBe(true);

    await closeAllFiles();
  });
});
