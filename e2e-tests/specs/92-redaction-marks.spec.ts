// Redaction marks persist as real /Redact annotations: save writes
// them into the file (undoable, signature-preserving elsewhere), reopening
// re-seeds them, and APPLYING consumes exactly the applied ones. Marks
// themselves stay transient view state (the standing invariant) — the FILE
// is the persistence format, and after every save/reload the transient set
// is re-seeded from it, so the two cannot disagree.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  addRedactionMark,
  saveRedactionMarks,
  applyRedactions,
  getRedactionMarkCount,
  saveActiveAs,
  closeAllFiles,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function waitForMarkCount(n: number, msg: string): Promise<void> {
  await browser.waitUntil(async () => (await getRedactionMarkCount()) === n, {
    timeout: 15_000,
    timeoutMsg: `${msg} (marks=${await getRedactionMarkCount()})`,
  });
}

describe('persistent redaction marks', () => {
  it('marks survive save + reopen, and applying consumes exactly the applied set', async () => {
    await waitForHarness();
    await closeAllFiles();
    const tmp = mkdtempSync(join(tmpdir(), 'spectra-f10-'));
    const work = join(tmp, 'marks.pdf');
    copyFileSync(SAMPLE_PDF, work);

    await openByPaths([work]);
    await setView('canvas');
    await addRedactionMark({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    await addRedactionMark({ x: 0.5, y: 0.5, w: 0.15, h: 0.1 });
    expect(await getRedactionMarkCount()).toBe(2);

    // Save marks: the WORKING COPY now carries /Redact; the reload re-seeds
    // the marks. Like every edit, the disk file changes only on File ▸ Save.
    await saveRedactionMarks();
    await waitForMarkCount(2, 'marks did not re-seed after save');

    // Persistence proper: File ▸ Save (write the working state over the
    // path), then close and reopen — the marks come back from the FILE,
    // not from view state.
    await saveActiveAs(work);
    await closeAllFiles();
    await waitForMarkCount(0, 'marks survived close');
    await openByPaths([work]);
    await setView('canvas');
    await waitForMarkCount(2, 'saved marks did not re-seed on reopen');

    // Apply consumes them (the redaction engine sweeps overlapping
    // annotations fail-closed) — after apply and its reload, nothing
    // re-seeds because nothing is left in the working state.
    await applyRedactions();
    await waitForMarkCount(0, 'applied marks were not consumed');

    // And the saved file agrees: File ▸ Save the applied state, reopen —
    // no marks re-seed because the /Redact set was consumed by the apply.
    await saveActiveAs(work);
    await closeAllFiles();
    await openByPaths([work]);
    await setView('canvas');
    await browser.pause(1500); // give a would-be seed time to land
    expect(await getRedactionMarkCount()).toBe(0);

    await closeAllFiles();
  });
});
