import { expect } from '@wdio/globals';
import { waitForHarness } from '../support/harness.js';

// N12 slice A (brief 37): the UI language switches LIVE from Preferences ▸
// Appearance, persists in the settings blob, and returns to English the
// same way. VITE_E2E forces the DEFAULT to en, so the suite's other specs
// keep their English asserts; this spec is the explicit switch coverage.

describe('language switch (N12)', () => {
  it('switching to Español re-renders the chrome, and back', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'es');

    // The menu bar re-renders live — File becomes Archivo.
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'Archivo',
      { timeout: 10_000, timeoutMsg: 'the menu bar never re-rendered in Spanish' },
    );
    // The preference persisted (what a relaunch would read).
    const stored = await browser.execute(
      () => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').language,
    );
    expect(stored).toBe('es');

    // And back — the rest of the suite depends on English.
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    await $('[data-testid="prefs-close"]').click();
  });
});
