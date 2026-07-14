import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, closeAllFiles, setView } from '../support/harness.js';

// A PDF signed with a long-lived self-signed cert (same fixture 12-signatures
// uses; crypto verification is clock-independent).
const SIGNED_PDF = resolve(__dirname, '..', 'fixtures', 'signed.pdf');

// Phase 4 M3.3b: the nav-pane Signatures panel — a compact READ view over the
// same verify_signatures data as Tools ▸ Signatures. Distinct testids from the
// Tools panel (this drives the nav strip, not the operations view).

async function ensureSignaturesOpen(): Promise<void> {
  const pressed = await $('[data-testid="navicon-signatures"]').getAttribute('aria-pressed');
  if (pressed !== 'true') await $('[data-testid="navicon-signatures"]').click();
  await $('[data-testid="signatures-nav-panel"]').waitForDisplayed({
    timeoutMsg: 'signatures nav panel did not open',
  });
}

describe('navigation pane — Signatures panel', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SIGNED_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });
    await setView('canvas');
  });

  it('lists the embedded signature with signer, status, and the trust caveat', async () => {
    await ensureSignaturesOpen();
    const card = $('[data-testid="signature-nav-card"]');
    await card.waitForDisplayed({ timeout: 20_000, timeoutMsg: 'signature card never verified' });

    expect(await $('[data-testid="signature-nav-signer"]').getText()).toContain('Spectra Test Signer');
    expect(await $('[data-testid="signature-nav-status"]').getText()).toContain('Cryptographically valid');
    // dot reflects the shared classifier
    expect(await card.getAttribute('data-status')).toBe('valid');

    // The card's CSS rule must actually match its className (a plural/singular
    // selector typo left it unstyled — a class no JS/TS gate can catch). Assert
    // the computed style really applied: non-zero padding + a border.
    const cardStyle = await browser.execute(() => {
      const el = document.querySelector('[data-testid="signature-nav-card"]');
      if (!el) return null;
      const s = getComputedStyle(el);
      return { paddingTop: s.paddingTop, borderTopWidth: s.borderTopWidth };
    });
    expect(cardStyle).not.toBeNull();
    expect(cardStyle!.paddingTop).not.toBe('0px');
    expect(cardStyle!.borderTopWidth).not.toBe('0px');

    const caveat = $('[data-testid="signatures-nav-caveat"]');
    await caveat.waitForDisplayed({ timeout: 5_000 });
    expect(await caveat.getText()).toContain('not verified against a trusted authority');
  });

  it('Re-check re-verifies and keeps the result', async () => {
    await $('[data-testid="signatures-nav-recheck"]').click();
    await $('[data-testid="signature-nav-card"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'Re-check dropped the signature card',
    });
    expect(await $('[data-testid="signature-nav-status"]').getText()).toContain('Cryptographically valid');
  });

  it('reports no signatures for an unsigned document', async () => {
    // sample.pdf ships unsigned.
    const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
    await openByPaths([SAMPLE]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('sample.pdf'),
      { timeout: 15_000, timeoutMsg: 'sample.pdf never became active' },
    );
    await ensureSignaturesOpen();
    await $('[data-testid="signatures-nav-empty"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'unsigned document did not report an empty signature state',
    });
  });
});
