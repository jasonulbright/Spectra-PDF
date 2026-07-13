import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, setActiveOp } from '../support/harness.js';

// A PDF signed with a long-lived (100-year) self-signed cert — committed under
// fixtures/ (generated once via pyHanko; crypto verification is stable and
// clock-independent). See docs/architecture/10-phase2h-signatures.md.
const SIGNED_PDF = resolve(__dirname, '..', 'fixtures', 'signed.pdf');

describe('signatures panel verifies an embedded signature', () => {
  it('shows the signer, a valid badge, and the trust caveat', async () => {
    await waitForHarness();
    await openByPaths([SIGNED_PDF]);
    await setView('operations');
    await setActiveOp('signatures');

    // The panel auto-verifies on mount.
    const card = $('[data-testid="signature-card"]');
    try {
      await card.waitForDisplayed({ timeout: 20_000 });
    } catch (e) {
      // Surface WHY the card never rendered instead of an opaque timeout. The
      // panel routes a verify failure (a JSON-RPC error from the engine, which
      // ipc.py returns rather than printing to stderr) into its StatusBar, and a
      // signed:false result into signatures-empty. Capture both so a CI-only
      // failure reports the real engine message, not just "element not displayed".
      const status = await $('[data-testid="status-bar"]')
        .getText()
        .catch(() => '(no status-bar)');
      const empty = await $('[data-testid="signatures-empty"]')
        .isDisplayed()
        .catch(() => false);
      throw new Error(
        `signature-card never appeared — panel status=${JSON.stringify(status)}, ` +
          `signatures-empty=${empty}. (${(e as Error).message})`,
      );
    }

    const signer = $('[data-testid="signature-signer"]');
    expect(await signer.getText()).toContain('Spectra Test Signer');

    // Cryptographically valid, whole document covered.
    expect(await card.getText()).toContain('Cryptographically valid');

    // The trust caveat must always be present for a signed file — we never
    // imply verified identity.
    const caveat = $('[data-testid="trust-caveat"]');
    await caveat.waitForDisplayed({ timeout: 5_000 });
    expect(await caveat.getText()).toContain('not verified against a trusted authority');
  });
});
