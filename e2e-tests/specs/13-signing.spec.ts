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
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  signActiveFile,
  placeSignature,
  buildSignatureAppearance,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// Committed test-only signers (self-signed, 100-year) — never real keys. See
// docs/architecture/11-phase2h-signing.md / 13-phase2k-signature-completeness.md.
const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';
const TEST_PEM_KEY = resolve(__dirname, '..', 'fixtures', 'test-signer.key.pem');
const TEST_PEM_CERT = resolve(__dirname, '..', 'fixtures', 'test-signer.crt.pem');

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

  it('signs with a PEM key + certificate source (2k)', async () => {
    const pemOut = resolve(tmp, 'signed-pem.pdf');
    const summary = await signActiveFile({
      keyPath: TEST_PEM_KEY,
      certPath: TEST_PEM_CERT,
      password: '',
      output: pemOut,
    });
    expect(summary.signer).toContain('Spectra Test PEM Signer');
    expect(summary.valid).toBe(true);
    expect(summary.intact).toBe(true);
    expect(existsSync(pemOut)).toBe(true);
    expect(await widgetFieldNames(pemOut)).toContain('Signature1');
  });

  it('places a visible signature on the canvas and the stamp lands at the drawn box (2k)', async () => {
    // Rubber band + native dialogs aren't WebDriver-drivable: the harness
    // places the box and returns the REAL display→PDF conversion, then the
    // sign hook runs the same engine call the canvas Sign button sends.
    await setView('canvas');
    await placeSignature({ x: 0.1, y: 0.7, w: 0.5, h: 0.15 });
    const built = await buildSignatureAppearance();
    expect(built).not.toBeNull();
    expect(built!.appearance.page).toBe(1);

    await setView('operations');
    await setActiveOp('signatures');
    const visOut = resolve(tmp, 'signed-visible.pdf');
    const summary = await signActiveFile({
      pfxPath: TEST_PFX,
      password: TEST_PFX_PASSWORD,
      output: visOut,
      reason: 'placed on canvas',
      appearance: built!.appearance,
    });
    expect(summary.valid).toBe(true);
    expect(summary.covers_whole_document).toBe(true);

    // Independent pdf.js check: the widget annotation sits on page 1 at the
    // converted rect, with a generated (non-empty) appearance.
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(visOut)),
      isEvalSupported: false,
    }).promise;
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as Array<{
      subtype: string;
      rect: number[];
      hasAppearance?: boolean;
    }>;
    await pdf.loadingTask.destroy();
    const widget = annots.find((a) => a.subtype === 'Widget');
    expect(widget).toBeDefined();
    const [ex0, ey0, ex1, ey1] = built!.appearance.rect;
    expect(widget!.rect[0]).toBeCloseTo(ex0, 0);
    expect(widget!.rect[1]).toBeCloseTo(ey0, 0);
    expect(widget!.rect[2]).toBeCloseTo(ex1, 0);
    expect(widget!.rect[3]).toBeCloseTo(ey1, 0);
  });
});
