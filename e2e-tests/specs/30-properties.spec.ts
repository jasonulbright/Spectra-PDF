import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  startOpenByPaths,
  closeAllFiles,
  getState,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
// AES-256, user password "secret" — checked in beside the other fixtures
// (signed.pdf, scanned.pdf) because nothing in the JS toolchain can encrypt a
// PDF, and the Security tab has no discriminating test without one.
const ENCRYPTED_PDF = resolve(__dirname, '..', 'fixtures', 'encrypted.pdf');

// Phase 4 M5.5b: File ▸ Properties… (Ctrl+D) — § 3.2's re-homing of the Metadata
// panel, the PDF-version read and the encryption status into one dialog about
// THIS document. Driven through the real DOM: a dialog is pure UI.

describe('document properties', () => {
  it('Ctrl+D opens it on Description, with the file’s metadata loaded', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.keys(['Control', 'd']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed({
      timeoutMsg: 'Ctrl+D did not open Properties',
    });
    expect(await $('[data-testid="props-tab-description"]').getAttribute('aria-pressed')).toBe('true');
    // The metadata form is here — it is the Metadata panel's body, re-homed.
    await expect($('[data-testid="props-title"]')).toBeDisplayed();
    await expect($('[data-testid="props-author"]')).toBeDisplayed();
    await expect($('[data-testid="props-strip"]')).toBeDisplayed();
  });

  it('Advanced reports the version, pages and size of THIS document', async () => {
    await $('[data-testid="props-tab-advanced"]').click();
    await expect($('[data-testid="props-body-advanced"]')).toBeDisplayed();
    // Real values, not placeholders: the fixture is 5 pages, and the engine
    // answers with a version.
    await browser.waitUntil(
      async () => /^PDF \d\.\d$/.test(await $('[data-testid="props-version"]').getText()),
      { timeoutMsg: 'no PDF version reported' },
    );
    expect(await $('[data-testid="props-pages"]').getText()).toBe('5');
    expect(await $('[data-testid="props-size"]').getText()).toMatch(/\d.*(bytes|KB|MB)/);
    expect(await $('[data-testid="props-path"]').getText()).toBe(SAMPLE_PDF);
  });

  it('Security says "None" for an unprotected file', async () => {
    await $('[data-testid="props-tab-security"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="props-encrypted"]').getText()) !== 'Unknown',
      { timeoutMsg: 'encryption status never resolved' },
    );
    expect(await $('[data-testid="props-encrypted"]').getText()).toBe('None');
    await expect($('[data-testid="props-protect"]')).toBeDisplayed();
  });

  it('Security reports the ORIGINAL file’s protection, not the working copy’s', async () => {
    // THE case that discriminates. Opening an encrypted PDF decrypts the
    // WORKING copy, so a dialog asking the working copy would answer "None" —
    // and would pass the unprotected case above identically. Only a genuinely
    // protected file can tell the two implementations apart.
    await $('[data-testid="props-close"]').click();
    await closeAllFiles();
    // NOT awaited: the open does not resolve until the prompt is answered.
    await startOpenByPaths([ENCRYPTED_PDF]);
    // The password prompt appears on open; answer it, exactly as a user would.
    await $('[data-testid="password-input"]').waitForDisplayed({
      timeoutMsg: 'no password prompt for the encrypted fixture',
    });
    await $('[data-testid="password-input"]').setValue('secret');
    await $('[data-testid="password-submit"]').click();
    await browser.waitUntil(async () => (await getState()).fileCount === 1, {
      timeoutMsg: 'the encrypted fixture never opened',
    });

    await browser.keys(['Control', 'd']);
    await $('[data-testid="props-tab-security"]').waitForDisplayed();
    await $('[data-testid="props-tab-security"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="props-encrypted"]').getText()) !== 'Unknown',
      { timeoutMsg: 'encryption status never resolved for the encrypted file' },
    );
    // The working copy is decrypted by now; the file on disk is not. Asking the
    // working copy would say "None" here — which is the whole point.
    expect(await $('[data-testid="props-encrypted"]').getText()).toBe(
      'This file requires a password to open',
    );
    await $('[data-testid="props-close"]').click();
  });

  it('Ctrl+D is inert with no document to describe', async () => {
    await $('[data-testid="properties-dialog"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'the dialog outlived its Close',
    });
    await closeAllFiles();
    expect((await getState()).fileCount).toBe(0);
    await browser.keys(['Control', 'd']);
    // `when` requires a document. It must refuse, not open an empty shell.
    await expect($('[data-testid="properties-dialog"]')).not.toBeExisting();
  });
});
