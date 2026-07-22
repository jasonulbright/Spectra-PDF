import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  invokeAppCommand,
  signActiveFileInPlace,
  verifyActiveSignatures,
} from '../support/harness.js';

// Phase 9.F5 — IN-PLACE signing against the real binary. Unlike Sign & Save
// (a new file), in-place signing routes through the workspace's undoable
// performOperation: the signature APPENDS to the open document's working copy
// (pyHanko IncrementalPdfFileWriter — the original bytes stay verbatim), the
// document becomes signed WITHOUT a new file, and Ctrl+Z restores the unsigned
// state (the on-disk file is only written on Save). Proof: unsigned → sign in
// place → 1 valid signature on the SAME document → undo → unsigned again.

const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

describe('in-place signing (Phase 9.F5)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-sign-inplace-'));
    source = resolve(tmp, 'to-sign.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    writeFileSync(source, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('signs the open document in place, and undo restores the unsigned state', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('signatures'); // mounts the panel (registers the hooks)

    // Starts unsigned.
    expect((await verifyActiveSignatures()).signature_count).toBe(0);

    // Sign IN PLACE — no output path; the working copy becomes signed.
    const summary = await signActiveFileInPlace({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      reason: 'e2e in-place approval',
    });
    expect(summary.signature_count).toBe(1);
    expect(summary.all_valid).toBe(true);

    // The SAME open document now carries a valid signature (no new file).
    const afterSign = await verifyActiveSignatures();
    expect(afterSign.signature_count).toBe(1);
    expect(afterSign.all_valid).toBe(true);

    // Undo the in-place signing — the document returns to unsigned.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => (await verifyActiveSignatures()).signature_count === 0,
      { timeout: 15_000, timeoutMsg: 'undo did not restore the unsigned document' },
    );
  });

  it('rejects a wrong password and leaves the document unsigned', async () => {
    await expect(
      signActiveFileInPlace({ pfxPath: TEST_PFX, password: 'wrong-password' }),
    ).rejects.toThrow();
    // The document is untouched — still no signature.
    expect((await verifyActiveSignatures()).signature_count).toBe(0);
  });
});
