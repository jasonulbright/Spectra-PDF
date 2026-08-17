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

// Committed test-only signers (self-signed, 100-year) — never real keys.
const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';
const TEST_PEM_KEY = resolve(__dirname, '..', 'fixtures', 'test-signer.key.pem');
const TEST_PEM_CERT = resolve(__dirname, '..', 'fixtures', 'test-signer.crt.pem');

async function widgetFieldNames(path: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
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

  it('signs with a PEM key + certificate source', async () => {
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

  it('places a visible signature on the canvas and the stamp lands at the drawn box', async () => {
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

  it('signs with the PAdES profile and the CLI verifies subfilter + user trust anchor', async () => {
    await setView('operations');
    await setActiveOp('signatures');
    const padesOut = resolve(tmp, 'signed-pades.pdf');
    // The PEM pair, so the SAME certificate can serve as the trust anchor
    // below (the .pfx fixture is a different identity).
    const summary = await signActiveFile({
      keyPath: TEST_PEM_KEY,
      certPath: TEST_PEM_CERT,
      password: '',
      output: padesOut,
      pades: true,
    });
    expect(summary.valid).toBe(true);
    expect(summary.intact).toBe(true);

    // Independent verification through the REAL CLI arm: the subfilter is
    // ETSI.CAdES.detached, and `trusted` flips true ONLY with the signer's
    // own cert supplied as a user trust anchor (self-signed → its own root).
    const { execFileSync } = await import('node:child_process');
    const binary = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
    const bare = JSON.parse(
      execFileSync(binary, ['verify-signatures', padesOut], { encoding: 'utf-8' }),
    ) as { signatures: { pades: boolean; subfilter: string; trusted: boolean }[] };
    expect(bare.signatures[0].pades).toBe(true);
    expect(bare.signatures[0].subfilter).toBe('/ETSI.CAdES.detached');
    expect(bare.signatures[0].trusted).toBe(false); // no anchors → deterministic false

    const anchored = JSON.parse(
      execFileSync(
        binary,
        ['verify-signatures', padesOut, '--trust-root', TEST_PEM_CERT],
        { encoding: 'utf-8' },
      ),
    ) as { signatures: { trusted: boolean }[]; summary: { trust_verified: boolean } };
    expect(anchored.signatures[0].trusted).toBe(true);
    expect(anchored.summary.trust_verified).toBe(true);
  });

  it('carries the system-store opt-in from the panel through to the engine', async () => {
    // The toggle's WIRING, not a trust outcome: nothing here reads or writes
    // the machine's certificate store, and the test signer is self-signed, so
    // no store on any host can anchor it. The purpose-filtered store read
    // itself is proven in the engine suite against an injected store.
    const { execFileSync } = await import('node:child_process');
    const binary = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
    const off = JSON.parse(
      execFileSync(binary, ['verify-signatures', output], { encoding: 'utf-8' }),
    ) as { system_trust: { requested: boolean; available: boolean } };
    expect(off.system_trust.requested).toBe(false);

    const on = JSON.parse(
      execFileSync(binary, ['verify-signatures', output, '--system-trust'], {
        encoding: 'utf-8',
      }),
    ) as {
      system_trust: { requested: boolean; available: boolean; anchor_count: number };
      signatures: { trusted: boolean; trust_source: string | null }[];
      summary: { trust_verified: boolean };
    };
    expect(on.system_trust.requested).toBe(true);
    expect(on.system_trust.available).toBe(true);
    expect(on.system_trust.anchor_count).toBeGreaterThan(0);
    expect(on.signatures[0].trusted).toBe(false);
    expect(on.signatures[0].trust_source).toBe(null);
    expect(on.summary.trust_verified).toBe(false);

    await openByPaths([output]);
    await setView('operations');
    await setActiveOp('signatures');
    await $('[data-testid="signatures-summary"]').waitForDisplayed({ timeout: 20000 });
    // No trust source configured yet: the standing identity caveat.
    await $('[data-testid="trust-caveat"]').waitForDisplayed({ timeout: 10000 });

    await $('[data-testid="trust-system-store"]').click();
    // A source is configured now, so the box becomes a verdict — a failed one,
    // since a self-signed signer chains to nothing in any store.
    const box = $('[data-testid="trust-status"]');
    await box.waitForDisplayed({ timeout: 20000 });
    expect(await box.getAttribute('data-trust')).toBe('failed');

    // The preference survives a re-mount of the panel.
    await setActiveOp('rotate');
    await setActiveOp('signatures');
    await $('[data-testid="trust-status"]').waitForDisplayed({ timeout: 20000 });
    expect(await $('[data-testid="trust-system-store"]').isSelected()).toBe(true);

    // Leave the app in its default posture for whatever runs next.
    await $('[data-testid="trust-system-store"]').click();
    await $('[data-testid="trust-caveat"]').waitForDisplayed({ timeout: 20000 });
  });

  it('carries the trusted-list opt-in from the panel through to the engine', async () => {
    // Same shape as the case above and for the same reason: this proves the
    // toggle's WIRING and the bundle's provenance reaching the panel, never a
    // trust outcome — the self-signed test signer chains to nothing in any
    // trusted list. Anchoring against the bundle is proven in the engine suite.
    const { execFileSync } = await import('node:child_process');
    const binary = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
    const off = JSON.parse(
      execFileSync(binary, ['verify-signatures', output], { encoding: 'utf-8' }),
    ) as { eutl_trust: { requested: boolean; available: boolean } };
    expect(off.eutl_trust.requested).toBe(false);
    expect(off.eutl_trust.available).toBe(false);

    const on = JSON.parse(
      execFileSync(binary, ['verify-signatures', output, '--eutl-trust'], {
        encoding: 'utf-8',
      }),
    ) as {
      eutl_trust: {
        requested: boolean;
        available: boolean;
        anchor_count: number;
        fetched: string | null;
        list_count: number | null;
      };
      signatures: { trusted: boolean; trust_source: string | null }[];
      summary: { trust_verified: boolean };
    };
    expect(on.eutl_trust.requested).toBe(true);
    expect(on.eutl_trust.available).toBe(true);
    expect(on.eutl_trust.anchor_count).toBeGreaterThan(0);
    // The bundle states its own age; a feed that cannot is one that gets read
    // as current.
    expect(on.eutl_trust.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(on.eutl_trust.list_count).toBeGreaterThan(0);
    expect(on.signatures[0].trusted).toBe(false);
    expect(on.signatures[0].trust_source).toBe(null);
    expect(on.summary.trust_verified).toBe(false);

    await openByPaths([output]);
    await setView('operations');
    await setActiveOp('signatures');
    await $('[data-testid="signatures-summary"]').waitForDisplayed({ timeout: 20000 });
    await $('[data-testid="trust-caveat"]').waitForDisplayed({ timeout: 10000 });

    await $('[data-testid="trust-eutl"]').click();
    const box = $('[data-testid="trust-status"]');
    await box.waitForDisplayed({ timeout: 20000 });
    expect(await box.getAttribute('data-trust')).toBe('failed');
    // The provenance line only appears once a verification has reported it.
    const provenance = $('[data-testid="trust-eutl-provenance"]');
    await provenance.waitForDisplayed({ timeout: 20000 });
    expect(await provenance.getText()).not.toBe('');

    // The preference survives a re-mount of the panel.
    await setActiveOp('rotate');
    await setActiveOp('signatures');
    await $('[data-testid="trust-status"]').waitForDisplayed({ timeout: 20000 });
    expect(await $('[data-testid="trust-eutl"]').isSelected()).toBe(true);

    // Leave the app in its default posture for whatever runs next.
    await $('[data-testid="trust-eutl"]').click();
    await $('[data-testid="trust-caveat"]').waitForDisplayed({ timeout: 20000 });
  });
});
