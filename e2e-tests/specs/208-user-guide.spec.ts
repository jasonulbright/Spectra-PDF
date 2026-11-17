import { expect } from '@wdio/globals';
import { waitForHarness } from '../support/harness.js';

// Help > User Guide opens the bundled guide in a dialog: a contents list on
// one side, the rendered guide on the other. A contents entry scrolls the
// guide to its heading, and Escape closes the dialog.

describe('user guide dialog', () => {
  it('opens from the Help menu and shows the guide', async () => {
    await waitForHarness();
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="menuitem-help-user-guide"]').isDisplayed().catch(() => false)) {
          return true;
        }
        await $('[data-testid="menu-help"]').click();
        await browser.pause(150);
        return $('[data-testid="menuitem-help-user-guide"]').isDisplayed().catch(() => false);
      },
      { timeoutMsg: 'the Help menu never showed User Guide' },
    );
    await $('[data-testid="menuitem-help-user-guide"]').click();
    await $('[data-testid="help-dialog"]').waitForDisplayed({ timeoutMsg: 'the guide did not open' });
    const heading = await $('[data-testid="help-body"] h1');
    await expect(heading).toHaveText('Spectra PDF User Guide');
    const entries = await $$('[data-testid="help-contents"] button');
    expect(entries.length).toBeGreaterThan(10);
  });

  it('jumps to a heading from the contents list', async () => {
    const before = await browser.execute(
      () => (document.querySelector('[data-testid="help-body"]') as HTMLElement).scrollTop,
    );
    expect(before).toBe(0);
    const entries = await $$('[data-testid="help-contents"] button');
    const last = entries[entries.length - 1];
    await last.click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (document.querySelector('[data-testid="help-body"]') as HTMLElement).scrollTop,
        )) > 0,
      { timeoutMsg: 'the contents entry did not scroll the guide' },
    );
  });

  it('never turns guide text into markup', async () => {
    const found = await browser.execute(
      () => document.querySelectorAll('[data-testid="help-body"] script, [data-testid="help-body"] img, [data-testid="help-body"] a').length,
    );
    expect(found).toBe(0);
  });

  it('closes with Escape', async () => {
    await browser.keys(['Escape']);
    await $('[data-testid="help-dialog"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'Escape did not close the guide',
    });
  });
});
