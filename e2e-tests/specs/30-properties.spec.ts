import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, closeAllFiles, getState } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

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

  it('Security reports the ORIGINAL file’s protection, not the working copy’s', async () => {
    // The working copy is decrypted on open, so asking IT would always answer
    // "None" — confidently and uselessly. The fixture isn't protected, so
    // "None" is right here; the point is which file was asked.
    await $('[data-testid="props-tab-security"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="props-encrypted"]').getText()) !== 'Unknown',
      { timeoutMsg: 'encryption status never resolved' },
    );
    expect(await $('[data-testid="props-encrypted"]').getText()).toBe('None');
    await expect($('[data-testid="props-protect"]')).toBeDisplayed();
  });

  it('closes, and Ctrl+D is inert with no document to describe', async () => {
    await $('[data-testid="props-close"]').click();
    await $('[data-testid="properties-dialog"]').waitForDisplayed({ reverse: true });
    await closeAllFiles();
    expect((await getState()).fileCount).toBe(0);
    await browser.keys(['Control', 'd']);
    // `when` requires a document. It must refuse, not open an empty shell.
    await expect($('[data-testid="properties-dialog"]')).not.toBeExisting();
  });
});
