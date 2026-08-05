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

    // N12 slice E: `<html lang>` follows the switch. It shipped hardcoded to
    // "en", so a screen reader read Spanish text with English pronunciation
    // rules — the UI language and the language the DOCUMENT claims to be in
    // are the same fact and must not be able to disagree.
    expect(await browser.execute(() => document.documentElement.lang)).toBe('es');

    // And back — the rest of the suite depends on English.
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // Every wave-1 locale. One known menu label each is the cheap proof the
  // catalog is BUNDLED and reachable from the Settings list — the parity,
  // placeholder and plural gates are vitest's job, and repeating them here
  // would buy nothing for the runtime cost. The anchor is View, not File:
  // Italian's File is spelled exactly like English's, so asserting on it
  // would pass against a locale that never loaded. Portuguese's "Exibir" is
  // likewise chosen for being nothing like "View", and for ja/zh any CJK
  // label is unmistakable. The two REGIONAL codes also prove the tag round
  // trips verbatim: `<html lang>` must read `pt-BR` / `zh-CN`, not `pt`/`zh`.
  it('switches to each wave-1 locale and back to English', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['fr', 'Affichage'],
      ['de', 'Ansicht'],
      ['it', 'Visualizza'],
      ['pt-BR', 'Exibir'],
      ['ja', '表示'],
      ['zh-CN', '视图'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);
    }

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });
});
