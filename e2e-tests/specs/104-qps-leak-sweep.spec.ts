import { expect } from '@wdio/globals';
import { waitForHarness } from '../support/harness.js';

// N12 (brief 37): the qps pseudo-locale — every en string bracketed and
// vowel-stretched, generated at init, dev/e2e-only. A covered surface
// renders [Ẽẽ...]; a BARE ENGLISH string on a swept surface is a leak this
// spec exists to catch. Sweeps the slice-A chrome; grows with each slice.

const qps = async (lang: string): Promise<void> => {
  await browser.execute((l) => {
    (window as unknown as { __SPECTRA_TEST__: { setLanguage: (x: string) => void } })
      .__SPECTRA_TEST__.setLanguage(l);
  }, lang);
};

describe('qps pseudo-locale leak sweep (N12)', () => {
  it('slice-A chrome renders no bare English under qps', async () => {
    await waitForHarness();
    await qps('qps');
    // Leaks collect into one list so the failure NAMES every bare-English
    // surface at once (wdio's expect takes no message argument).
    const leaks: string[] = [];
    const check = (label: string, text: string): void => {
      if (!text.startsWith('[')) leaks.push(`${label}: "${text}"`);
    };
    try {
      // Menu bar: every top-level trigger is bracketed.
      for (const id of ['file', 'edit', 'view', 'document', 'tools', 'window', 'help']) {
        check(`menu ${id}`, await $(`[data-testid="menu-${id}"]`).getText());
      }
      // Home tab: the hero + sections.
      await $('[data-testid="tab-home"]').click();
      await $('[data-testid="home-tab"]').waitForDisplayed({ timeout: 10_000 });
      check('home title', await $('[data-testid="home-tab"] .home-title').getText());
      check('home open button', await $('[data-testid="home-open-btn"]').getText());
      // The Home TAB label itself.
      check('home tab', await $('[data-testid="tab-home"]').getText());
      expect(leaks).toEqual([]);
    } finally {
      // The rest of the suite depends on English — restore even on failure.
      await qps('en');
    }
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the chrome never returned to English' },
    );
  });
});
