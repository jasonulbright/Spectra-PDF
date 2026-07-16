import { expect } from '@wdio/globals';
import { waitForHarness, invokeAppCommand } from '../support/harness.js';

// Phase 4 M5.5: Preferences is a CATEGORIZED dialog (§ 7), not a flat scroll of
// every setting. Driven through the real DOM — the dialog is pure UI, so
// nothing else can tell whether it works.

describe('preferences dialog', () => {
  it('Ctrl+K opens it on General', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-general"]').waitForDisplayed({
      timeoutMsg: 'Ctrl+K did not open Preferences',
    });
    expect(await $('[data-testid="prefs-cat-general"]').getAttribute('aria-pressed')).toBe('true');
    await expect($('[data-testid="prefs-body-general"]')).toBeDisplayed();
  });

  it('shows ONE category at a time', async () => {
    // The point of the split: the licence notice is not sharing a column with
    // the Ghostscript picker any more.
    await expect($('[data-testid="licenses-note"]')).not.toBeExisting();
    await $('[data-testid="prefs-cat-engine"]').click();
    await expect($('[data-testid="prefs-body-engine"]')).toBeDisplayed();
    await expect($('[data-testid="prefs-body-general"]')).not.toBeExisting();
    await $('[data-testid="prefs-close"]').click();
    await $('[data-testid="prefs-cat-general"]').waitForDisplayed({ reverse: true });
  });

  it('Help ▸ Third-party Licenses lands ON the licences, not at the top of a scroll', async () => {
    // The reason the category is state rather than a boolean: this entry point
    // used to open the same modal and leave the user to find the notice.
    expect(await invokeAppCommand('help.licenses')).toBe(true);
    await $('[data-testid="licenses-note"]').waitForDisplayed({
      timeoutMsg: 'Help ▸ Licenses did not land on the licences',
    });
    expect(await $('[data-testid="prefs-cat-licenses"]').getAttribute('aria-pressed')).toBe('true');
    await $('[data-testid="prefs-close"]').click();
  });
});
