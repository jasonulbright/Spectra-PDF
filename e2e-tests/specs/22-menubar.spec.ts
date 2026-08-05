import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, getState, openByPaths } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// The menu bar is a real Radix Menubar rendered from the command
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
    // Slice C: a doc-targeted panel item with NO document runs the
    // picker-first flow (a native dialog no test can drive) — so exercise the
    // documented flow: with a doc open, the item docks its panel beside it.
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening the sample never focused its doc tab',
    });
    // The doc tab's mount flurry (proxy load, canvas focus) can dismiss a
    // just-opened Radix menu — retry until the menu is OBSERVED open, checking
    // before clicking so the trigger's toggle can't oscillate it shut.
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="menuitem-document-watermark"]').isDisplayed().catch(() => false)) {
          return true;
        }
        await $('[data-testid="menu-document"]').click();
        await browser.pause(150);
        return $('[data-testid="menuitem-document-watermark"]').isDisplayed().catch(() => false);
      },
      { timeout: 15_000, timeoutMsg: 'the Document menu never opened' },
    );
    await $('[data-testid="menuitem-document-watermark"]').click();
    // Slice C: tools.panel.watermark opens the DOCK on the doc tab with the
    // watermark op armed — the document never leaves the screen.
    await $('[data-testid="tool-dock"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'menu item did not open the tool dock',
    });
    await browser.waitUntil(
      async () => (await getState()).activeOp === 'watermark',
      { timeoutMsg: 'menu item did not arm the watermark op' },
    );
  });
});
