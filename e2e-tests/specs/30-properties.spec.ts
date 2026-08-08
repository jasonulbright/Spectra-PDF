import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  startOpenByPaths,
  closeAllFiles,
  getState,
  saveActiveAs,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
// AES-256, user password "secret" — checked in beside the other fixtures
// (signed.pdf, scanned.pdf) because nothing in the JS toolchain can encrypt a
// PDF, and the Security tab has no discriminating test without one.
const ENCRYPTED_PDF = resolve(__dirname, '..', 'fixtures', 'encrypted.pdf');
// Two fonts, neither embedded: a simple Type1 and a composite CIDFontType2.
const TWO_FONTS_PDF = resolve(__dirname, '..', 'fixtures', 'vertical-orientations.pdf');
// One font, embedded as a subset — the other half of the Fonts tab's states.
const EMBEDDED_SUBSET_PDF = resolve(__dirname, '..', 'fixtures', 'mongolian-columns.pdf');

// File ▸ Properties… (Ctrl+D) — the re-homing of the Metadata
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

// The Fonts, Initial View and Advanced tabs. Everything here runs against the
// real engine through the real dialog: the reads walk the document, the writes
// are undoable in-place edits, and the persistence claims are proven by SAVING
// the file and OPENING IT AGAIN — an assertion against the still-open working
// copy would pass on a setter that never reached the bytes.
describe('document properties: fonts, initial view and advanced', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-props-'));
    await waitForHarness();
    await closeAllFiles();
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function openProperties(tab: string): Promise<void> {
    await browser.keys(['Control', 'd']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed({
      timeoutMsg: 'Ctrl+D did not open Properties',
    });
    await $(`[data-testid="props-tab-${tab}"]`).click();
    await $(`[data-testid="props-body-${tab}"]`).waitForDisplayed({
      timeoutMsg: `the ${tab} tab never rendered`,
    });
  }

  it('Fonts lists every font the document uses, with type, encoding and program status', async () => {
    await openByPaths([TWO_FONTS_PDF]);
    await openProperties('fonts');
    await $('[data-testid="props-fonts"]').waitForDisplayed({
      timeoutMsg: 'the font list never arrived',
    });
    // Both fonts, found through the page's own resources — one simple, one
    // composite, which is the split the tab groups by.
    const helvetica = $('[data-testid="props-font-helvetica-type1-winansiencoding"]');
    const vertical = $('[data-testid="props-font-vertface-cidfonttype2-identity-v"]');
    await expect(helvetica).toBeDisplayed();
    await expect(vertical).toBeDisplayed();
    expect(await helvetica.getText()).toContain('Type1');
    expect(await helvetica.getText()).toContain('WinAnsiEncoding');
    expect(await vertical.getText()).toContain('CIDFontType2');
    // Neither program is in the file, so both rows say so.
    expect(await helvetica.getText()).toContain('Not embedded');
    expect(await vertical.getText()).toContain('Not embedded');
    await $('[data-testid="props-close"]').click();
    await closeAllFiles();
  });

  it('Fonts reports an embedded subset as embedded, not as a substitution', async () => {
    await openByPaths([EMBEDDED_SUBSET_PDF]);
    await openProperties('fonts');
    await $('[data-testid="props-fonts"]').waitForDisplayed({
      timeoutMsg: 'the font list never arrived',
    });
    const listed = await $('[data-testid="props-fonts"]').getText();
    expect(listed).toContain('NotoSansMongolian');
    expect(listed).toContain('Embedded subset');
    expect(listed).not.toContain('Not embedded');
    await $('[data-testid="props-close"]').click();
    await closeAllFiles();
  });

  it('Advanced reports the file’s own facts', async () => {
    await openByPaths([SAMPLE_PDF]);
    await openProperties('advanced');
    await browser.waitUntil(
      async () => /^PDF \d\.\d$/.test(await $('[data-testid="props-version"]').getText()),
      { timeoutMsg: 'no PDF version reported' },
    );
    // Every new row resolves to a real value, never a placeholder.
    for (const id of ['props-linearized', 'props-tagged', 'props-open-action']) {
      const text = await $(`[data-testid="${id}"]`).getText();
      expect(text).not.toBe('');
      expect(text).not.toBe('Unknown');
    }
    expect(await $('[data-testid="props-page-sizes"]').getText()).toMatch(/Letter/);
    expect(await $('[data-testid="props-search-index"]').getText()).toBe('None recorded');
    await $('[data-testid="props-close"]').click();
  });

  it('Advanced writes Trapped and the base URL, and they survive a save and reopen', async () => {
    const out = resolve(tmp, 'advanced.pdf');
    await openProperties('advanced');
    await setReactSelectValue('[data-testid="props-trapped"]', 'true');
    await setReactInputValue('[data-testid="props-base-url"]', 'https://example.invalid/docs/');
    await $('[data-testid="props-advanced-apply"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="props-status"]').getText()) === 'Saved to the document',
      { timeoutMsg: 'the advanced write never reported success' },
    );
    await $('[data-testid="props-close"]').click();

    await saveActiveAs(out);
    await closeAllFiles();
    await openByPaths([out]);
    await openProperties('advanced');
    await browser.waitUntil(
      async () => (await $('[data-testid="props-trapped"]').getValue()) === 'true',
      { timeoutMsg: 'the trapped flag did not survive the save' },
    );
    expect(await $('[data-testid="props-base-url"]').getValue()).toBe(
      'https://example.invalid/docs/',
    );
    await $('[data-testid="props-close"]').click();
    await closeAllFiles();
  });

  it('Initial View writes the layout, pane, opening page and magnification', async () => {
    const out = resolve(tmp, 'initial-view.pdf');
    await openByPaths([SAMPLE_PDF]);
    await openProperties('initialView');
    await setReactSelectValue('[data-testid="props-iv-layout"]', 'two-column-right');
    await setReactSelectValue('[data-testid="props-iv-mode"]', 'outlines');
    await setReactInputValue('[data-testid="props-iv-page"]', '3');
    await setReactSelectValue('[data-testid="props-iv-zoom"]', 'percent');
    await setReactInputValue('[data-testid="props-iv-zoom-percent"]', '125');
    await $('[data-testid="props-iv-hide-toolbar"]').click();
    await $('[data-testid="props-iv-apply"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="props-status"]').getText()) === 'Saved to the document',
      { timeoutMsg: 'the initial-view write never reported success' },
    );
    await $('[data-testid="props-close"]').click();

    await saveActiveAs(out);
    await closeAllFiles();
    await openByPaths([out]);
    await openProperties('initialView');
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="props-iv-layout"]').getValue()) === 'two-column-right',
      { timeoutMsg: 'the page layout did not survive the save' },
    );
    expect(await $('[data-testid="props-iv-mode"]').getValue()).toBe('outlines');
    expect(await $('[data-testid="props-iv-page"]').getValue()).toBe('3');
    expect(await $('[data-testid="props-iv-zoom"]').getValue()).toBe('percent');
    expect(await $('[data-testid="props-iv-zoom-percent"]').getValue()).toBe('125');
    expect(await $('[data-testid="props-iv-hide-toolbar"]').isSelected()).toBe(true);
    // A window option this app cannot obey says so rather than implying an effect.
    expect(await $('[data-testid="props-body-initialView"]').getText()).toContain(
      'written to the document for other readers',
    );
    await $('[data-testid="props-close"]').click();
    await closeAllFiles();
  });

  it('the app HONORS a document’s own initial view when it opens it', async () => {
    const out = resolve(tmp, 'initial-view.pdf');
    // The file written by the previous test: two-up with a cover page, the
    // bookmarks pane, opening on page 3.
    await openByPaths([out]);
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="navicon-bookmarks"]').getAttribute('aria-pressed')) === 'true',
      { timeoutMsg: 'the document’s /PageMode did not open the bookmarks pane' },
    );
    await expect($('[data-testid="bookmarks-panel"]')).toBeDisplayed();
    // The layout the document asked for is the one the reading view uses: with
    // the cover alone, page 1 is its own row and pages 2-3 share the next.
    await browser.waitUntil(
      async () =>
        (await browser.execute(function () {
          const rows = document.querySelectorAll('.docview-row');
          return Array.from(rows).some((r) => r.querySelectorAll('[data-page-id]').length === 2);
        })) === true,
      { timeoutMsg: 'the document’s /PageLayout did not produce a two-up spread' },
    );
    await closeAllFiles();
  });

  it('an ordinary document leaves the workbench’s own view alone', async () => {
    // sample.pdf states no layout and no page mode. Opening it must not undo
    // what the previous document set — the "default" values mean "the
    // application's preference", not "single page, pane closed".
    await openByPaths([SAMPLE_PDF]);
    await browser.pause(300);
    expect(await $('[data-testid="navicon-bookmarks"]').getAttribute('aria-pressed')).toBe('true');
    await closeAllFiles();
  });
});
