import { expect } from '@wdio/globals';
import { waitForHarness, getState } from '../support/harness.js';

// Phase 4 M2: the menu bar is a real Radix Menubar rendered from the command
// registry. This smoke drives it through the actual DOM: open a menu, invoke
// a (non-dialog) item, and confirm the observable state change, plus that
// Escape closes an open menu.

describe('menu bar', () => {
  it('opens the File menu and shows its items', async () => {
    await waitForHarness();
    await $('[data-testid="menu-file"]').click();
    await expect($('[data-testid="menuitem-file-open"]')).toBeDisplayed();
    await expect($('[data-testid="menuitem-file-save-as"]')).toBeDisplayed();
    // Escape closes it (Radix owns the key while the menu is open).
    await browser.keys(['Escape']);
    await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'Escape did not close the File menu',
    });
  });

  it('drives a command through a menu item (Document ▸ Watermark)', async () => {
    await $('[data-testid="menu-document"]').click();
    await $('[data-testid="menuitem-document-watermark"]').waitForDisplayed();
    await $('[data-testid="menuitem-document-watermark"]').click();
    // tools.panel.watermark focuses the Tools tab and arms the watermark op.
    await browser.waitUntil(
      async () => {
        const s = await getState();
        return s.focusedTab === 'tools' && s.activeOp === 'watermark';
      },
      { timeoutMsg: 'menu item did not focus Tools with the watermark op armed' },
    );
  });
});
