import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  setView,
  getState,
  addRedactionMark,
  invokeAppCommand,
  closeAllFiles,
  placeNewField,
} from '../support/harness.js';
import { VENV_PYTHON } from '../support/app-data.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// A certificate-encrypted document opens as a plaintext working copy, and a
// save reseals that copy under the document's recipient lists. A save asked
// for while a rewrite of the copy runs must reseal the rewritten bytes.

// A recipient certificate needs the key-encipherment usage bit, which the
// signing fixture does not carry, so the spec makes its own identity.
let signerCert = '';
let signerPfx = '';

const MAKE_RECIPIENT = `
import datetime, sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "Spectra Test Recipient")])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
    .public_key(key.public_key()).serial_number(x509.random_serial_number())
    .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=36500))
    .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False,
        key_encipherment=True, data_encipherment=True, key_agreement=False,
        key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=False)
    .sign(key, hashes.SHA256()))
open(sys.argv[1], "wb").write(cert.public_bytes(serialization.Encoding.DER))
open(sys.argv[2], "wb").write(pkcs12.serialize_key_and_certificates(
    b"recipient", key, cert, None, serialization.BestAvailableEncryption(b"testpw")))
`;

async function pageText(path: string): Promise<string> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const page = await pdf.getPage(1);
  const content = (await page.getTextContent()) as { items: { str?: string }[] };
  await pdf.loadingTask.destroy();
  return content.items.map((it) => it.str ?? '').join(' ');
}

const hold = () => browser.execute(() => { (window as any).__SPECTRA_TEST__.holdRewriteEngineSteps(); });
const release = () => browser.execute(() => { (window as any).__SPECTRA_TEST__.releaseRewriteEngineSteps(); });
const waiting = () => browser.execute(() => (window as any).__SPECTRA_TEST__.rewriteEngineStepsWaiting() as number);

/** Opens a certificate-encrypted file and answers its key prompt. */
async function openWithCertificate(path: string): Promise<void> {
  await browser.execute((p: string) => {
    const w = window as any;
    w.__certificateOpen = { done: false, error: null as string | null };
    w.__SPECTRA_TEST__.openByPaths([p])
      .then(() => { w.__certificateOpen.done = true; })
      .catch((e: unknown) => { w.__certificateOpen = { done: true, error: String(e) }; });
  }, path);
  const pick = await browser.$('[data-testid="certunlock-pick"]');
  await pick.waitForDisplayed({ timeoutMsg: 'the certificate prompt never opened' });
  await browser.execute((pfx: string) => { (window as any).__SPECTRA_TEST__.answerCertificatePicker(pfx); }, signerPfx);
  await pick.click();
  await (await browser.$('[data-testid="certunlock-password"]')).setValue('testpw');
  await (await browser.$('[data-testid="certunlock-submit"]')).click();
  await browser.waitUntil(async () => (await browser.execute(() => (window as any).__certificateOpen)).done === true,
    { timeoutMsg: 'the certificate-encrypted document never opened' });
  expect((await browser.execute(() => (window as any).__certificateOpen)).error).toBeNull();
}

describe('a certificate-encrypted document saved during a rewrite', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-certificate-save-'));
    signerCert = resolve(tmp, 'recipient.cer');
    signerPfx = resolve(tmp, 'recipient.pfx');
    execFileSync(VENV_PYTHON, ['-c', MAKE_RECIPIENT, signerCert, signerPfx]);
    const plain = resolve(tmp, 'plain.pdf');
    source = resolve(tmp, 'sealed.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('SECRET TOP LINE', { x: 50, y: 700, size: 24, font });
    page.drawText('KEEP ME BOTTOM', { x: 50, y: 100, size: 24, font });
    writeFileSync(plain, await doc.save());
    await waitForHarness();
    const sealed = await browser.executeAsync((file: string, output: string, cert: string, done: (r: unknown) => void) => {
      (window as any).__SPECTRA_TEST__.engineRequestWithId('encrypt_pubkey', { file, output, certs: [cert] }, 4343001)
        .then(done).catch((e: unknown) => done(`ERROR:${String(e)}`));
    }, plain, source, signerCert);
    expect(String(sealed)).not.toMatch(/^ERROR:/);
    expect(readFileSync(source).toString('latin1')).toContain('/Adobe.PubSec');
  });
  after(async () => {
    await release();
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reseals the rewritten bytes, still under the recipient list', async () => {
    await openWithCertificate(source);
    await setView('canvas');

    // Save is offered only for a document with unsaved changes, so the
    // document carries one before the redaction starts: a form field.
    await placeNewField({ x: 0.5, y: 0.5, w: 0.3, h: 0.05 });
    const field = await browser.executeAsync((done: (r: string | null) => void) => {
      (window as any).__SPECTRA_TEST__.createPlacedField({ name: 'kept', type: 'text' })
        .then(() => done(null)).catch((e: unknown) => done(String(e)));
    });
    expect(field).toBeNull();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true,
      { timeoutMsg: 'the field left the document clean' });

    await addRedactionMark({ x: 0, y: 0, w: 1, h: 0.25 });

    await hold();
    await browser.execute(() => {
      const w = window as any;
      w.__rewriteRedact = { done: false, error: null as string | null };
      w.__SPECTRA_TEST__.applyRedactions()
        .then(() => { w.__rewriteRedact.done = true; })
        .catch((e: unknown) => { w.__rewriteRedact = { done: true, error: String(e) }; });
    });
    await browser.waitUntil(async () => (await waiting()) === 1, { timeoutMsg: 'the redaction never reached its engine step' });
    const before = readFileSync(source);
    expect(await invokeAppCommand('file.save')).toBe(true);

    await release();
    await browser.waitUntil(async () => (await browser.execute(() => (window as any).__rewriteRedact)).done === true,
      { timeoutMsg: 'the redaction never settled' });
    expect((await browser.execute(() => (window as any).__rewriteRedact)).error).toBeNull();
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === false,
      { timeoutMsg: 'the save never wrote the rewritten document' });
    const saved = readFileSync(source);
    expect(saved.equals(before)).toBe(false);
    expect(saved.toString('latin1')).toContain('/Adobe.PubSec');

    // Opened again with the key, the saved document carries the redaction.
    await closeAllFiles();
    await openWithCertificate(source);
    const working = (await getState()).activeFile!.workingPath;
    const text = await pageText(working);
    expect(text).not.toContain('SECRET TOP LINE');
    expect(text).toContain('KEEP ME BOTTOM');
  });
});
