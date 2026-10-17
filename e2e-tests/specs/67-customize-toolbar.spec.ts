import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, invokeAppCommand } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Toolbar customization: per-item show/hide over the toolbar catalog,
// applied live and persisted (spectra-toolbar). The dialog opens from
// View ▸ Customize Toolbar… (also the toolbar's right-click menu).
describe('customize toolbar', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
  });

  it('hides a default item live and shows a default-off one', async () => {
    expect(await $('[data-testid="toolbar-save"]').isExisting()).toBe(true);
    expect(await $('[data-testid="toolbar-nav-pages"]').isExisting()).toBe(false);
    expect(await $('[data-testid="toolbar-edit"]').isExisting()).toBe(false);

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

    await $('[data-testid="customize-item-tools.open.edit"]').click();
    await $('[data-testid="customize-toolbar-close"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="customize-toolbar-dialog"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'the dialog never closed before using the main toolbar' },
    );
    const editButton = await $('[data-testid="toolbar-edit"]');
    await editButton.waitForEnabled({ timeout: 5_000 });
    await editButton.click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tool-edit"]').getAttribute('aria-pressed')) === 'true',
      { timeout: 5_000, timeoutMsg: 'the optional Edit button did not open Edit mode' },
    );
    expect(await invokeAppCommand('tools.close')).toBe(true);

    // Leave the dialog open for the reset case below.
    expect(await invokeAppCommand('view.customizeToolbar')).toBe(true);
    await $('[data-testid="customize-toolbar-dialog"]').waitForDisplayed({ timeout: 5_000 });

    // Persisted — the App mirror wrote the overrides.
    const stored = await browser.execute(() => localStorage.getItem('spectra-toolbar'));
    expect(stored).toContain('file.save');
    expect(stored).toContain('view.navPanel.pages');
    expect(stored).toContain('tools.open.edit');
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
