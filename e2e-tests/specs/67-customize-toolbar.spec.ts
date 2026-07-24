import { expect } from '@wdio/globals';
import { waitForHarness, invokeAppCommand } from '../support/harness.js';

// Toolbar customization (I.6): per-item show/hide over the toolbar catalog,
// applied live and persisted (spectra-toolbar). The dialog opens from
// View ▸ Customize Toolbar… (also the toolbar's right-click menu).
describe('customize toolbar (I.6)', () => {
  before(async () => {
    await waitForHarness();
  });

  it('hides a default item live and shows a default-off one', async () => {
    expect(await $('[data-testid="toolbar-save"]').isExisting()).toBe(true);
    expect(await $('[data-testid="toolbar-nav-pages"]').isExisting()).toBe(false);

    expect(await invokeAppCommand('view.customizeToolbar')).toBe(true);
    await $('[data-testid="customize-toolbar-dialog"]').waitForDisplayed({ timeout: 10_000 });

    await $('[data-testid="customize-item-file.save"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="toolbar-save"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'unchecking Save never hid its button' },
    );

    await $('[data-testid="customize-item-view.navPanel.pages"]').click();
    await browser.waitUntil(
      async () => await $('[data-testid="toolbar-nav-pages"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'checking Pages never showed its button' },
    );

    // Persisted — the App mirror wrote the overrides.
    const stored = await browser.execute(() => localStorage.getItem('spectra-toolbar'));
    expect(stored).toContain('file.save');
    expect(stored).toContain('view.navPanel.pages');
  });

  it('reset returns the shipped default and clears the stored key', async () => {
    await $('[data-testid="customize-toolbar-reset"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="toolbar-save"]').isExisting()) &&
        !(await $('[data-testid="toolbar-nav-pages"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'reset never restored the default layout' },
    );
    expect(await browser.execute(() => localStorage.getItem('spectra-toolbar'))).toBeNull();

    await $('[data-testid="customize-toolbar-close"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="customize-toolbar-dialog"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'the dialog never closed' },
    );
  });
});
