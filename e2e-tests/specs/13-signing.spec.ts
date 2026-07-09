import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { waitForHarness, openByPaths, setView, setActiveOp, signActiveFile } from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// A committed test-only signer (self-signed, 100-year, password below) — never
// a real key. See docs/architecture/11-phase2h-signing.md.
const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

async function widgetFieldNames(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    isEvalSupported: false,
  }).promise;
  const objs = (await pdf.getFieldObjects()) as Record<string, unknown[]> | null;
  await pdf.loadingTask.destroy();
  return objs ? Object.keys(objs) : [];
}

describe('signing applies a verifiable signature via the panel + engine', () => {
  let tmp: string;
  let source: string;
  let output: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-sign-'));
    source = resolve(tmp, 'to-sign.pdf');
    output = resolve(tmp, 'signed.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    writeFileSync(source, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('signs the active file and the engine self-verifies the produced file', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('signatures'); // mounts the panel (registers the sign hook)

    const summary = await signActiveFile({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      output,
      reason: 'e2e approval',
    });

    // The engine's self-verify (through the real binary + bundled pyHanko).
    expect(summary.signer).toContain('Spectra Test Signer');
    expect(summary.valid).toBe(true);
    expect(summary.intact).toBe(true);
    expect(summary.covers_whole_document).toBe(true);

    // The output file exists and independently carries a signature field.
    expect(existsSync(output)).toBe(true);
    expect(await widgetFieldNames(output)).toContain('Signature1');
  });

  it('rejects a wrong password without producing a file', async () => {
    const badOut = resolve(tmp, 'should-not-exist.pdf');
    await expect(
      signActiveFile({ pfxPath: TEST_PFX, password: 'wrong-password', output: badOut }),
    ).rejects.toThrow();
    expect(existsSync(badOut)).toBe(false);
  });
});
