// O5b — annotating a SIGNED document commits as an INCREMENTAL APPEND:
// the working copy becomes original-bytes + one revision, so the embedded
// signature keeps verifying. The CLI is the truth on both claims:
// verify-signatures (still intact+valid) and comments-list (the annotation
// is really in the file). Before O5b this exact flow silently broke the
// signature — the commit was a pdf-lib rewrite.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  addAnnotation,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const SIGNED_PDF = resolve(__dirname, '..', 'fixtures', 'signed.pdf');

function cliJson<T>(args: string[]): T {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  return JSON.parse(out.slice(out.indexOf('{'))) as T;
}

interface VerifyResult {
  signatures: { intact: boolean; valid: boolean }[];
}

describe('signed-document incremental commit (O5b)', () => {
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
});
