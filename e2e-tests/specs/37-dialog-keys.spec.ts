import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
  getWorkspacePageIds,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// M6.5: the dialog keyboard model + the keys the webview must never steal.

async function activeTestId(): Promise<string | null> {
  return (await browser.execute(() =>
    document.activeElement?.getAttribute('data-testid') ?? null,
  )) as string | null;
}

describe('dialog keyboard model (M6.5)', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
  });

  it('Escape closes every app dialog — one rule, four dialogs', async () => {
    // Properties (Ctrl+D)
    await browser.keys(['Control', 'd']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed();
    await browser.keys(['Escape']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed({
      reverse: true, timeoutMsg: 'Escape did not close Properties',
    });
    // Print (Ctrl+P)
    await browser.keys(['Control', 'p']);
    await $('[data-testid="print-dialog"]').waitForDisplayed();
    await browser.keys(['Escape']);
    await $('[data-testid="print-dialog"]').waitForDisplayed({
      reverse: true, timeoutMsg: 'Escape did not close Print',
    });
    // Preferences (Ctrl+K)
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-close"]').waitForDisplayed();
    await browser.keys(['Escape']);
    await $('[data-testid="prefs-close"]').waitForDisplayed({
      reverse: true, timeoutMsg: 'Escape did not close Preferences',
    });
    // About (Help menu)
    await $('[data-testid="menu-help"]').click();
    await $('[data-testid="menuitem-help-about"]').waitForDisplayed();
    await $('[data-testid="menuitem-help-about"]').click();
    await $('[data-testid="about-dialog"]').waitForDisplayed();
    await browser.keys(['Escape']);
    await $('[data-testid="about-dialog"]').waitForDisplayed({
      reverse: true, timeoutMsg: 'Escape did not close About',
    });
  });

  it('chords behind a modal neither run nor leak: Ctrl+W closes nothing', async () => {
    const files = (await getState()).fileCount;
    await browser.keys(['Control', 'd']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed();
    await browser.keys(['Control', 'w']);
    await browser.pause(200);
    expect((await getState()).fileCount).toBe(files);
    await expect($('[data-testid="properties-dialog"]')).toBeDisplayed();
    await browser.keys(['Escape']);
    await $('[data-testid="properties-dialog"]').waitForDisplayed({ reverse: true });
  });

  it('Tab is TRAPPED inside an open dialog', async () => {
    await browser.keys(['Control', 'p']);
    await $('[data-testid="print-dialog"]').waitForDisplayed();
    for (let i = 0; i < 12; i++) {
      await browser.keys(['Tab']);
      const inside = (await browser.execute(() => {
        const dlg = document.querySelector('[data-testid="print-dialog"]');
        return dlg ? dlg.contains(document.activeElement) : false;
      })) as boolean;
      expect(inside).toBe(true);
    }
    await browser.keys(['Escape']);
    await $('[data-testid="print-dialog"]').waitForDisplayed({ reverse: true });
  });

  it('reload keys never reach the webview — the app state SURVIVES F5 and Ctrl+R', async () => {
    expect((await getState()).fileCount).toBe(1);
    await browser.keys(['F5']);
    await browser.pause(400);
    await browser.keys(['Control', 'r']);
    await browser.pause(400);
    // A real reload would boot a fresh renderer: harness re-installed,
    // fileCount 0. Survival is the discriminator.
    expect((await getState()).fileCount).toBe(1);
  });

  it('…and survives F5 pressed while a MENU is open (the step-aside path)', async () => {
    // The Radix-menu branch stepped aside without suppression — F5 over an
    // open File menu reloaded the whole app (review-caught HIGH).
    await $('[data-testid="menu-file"]').click();
    await $('[data-testid="menuitem-file-open"]').waitForDisplayed();
    await browser.keys(['F5']);
    await browser.pause(400);
    await browser.keys(['Escape']);
    expect((await getState()).fileCount).toBe(1);
  });

  it('Shift+F4 toggles the Tools tab from either side', async () => {
    expect((await getState()).view).toBe('canvas');
    await browser.keys(['Shift', 'F4']);
    await browser.waitUntil(async () => (await getState()).view === 'operations', {
      timeoutMsg: 'Shift+F4 did not open the Tools tab',
    });
    await browser.keys(['Shift', 'F4']);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'Shift+F4 did not toggle back to the document',
    });
  });

  it('Ctrl+Shift+T inserts a blank page (the freeze-verified chord)', async () => {
    const before = (await getWorkspacePageIds()).length;
    await browser.keys(['Control', 'Shift', 't']);
    await browser.waitUntil(
      async () => (await getWorkspacePageIds()).length === before + 1,
      { timeoutMsg: 'Ctrl+Shift+T did not insert a blank page' },
    );
    await browser.keys(['Control', 'z']); // leave the doc as found
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === before);
  });

  it('the main toolbar is ONE tab stop with arrow-key roving', async () => {
    // Exactly one toolbar button is tabbable.
    const tabbables = (await browser.execute(() => {
      const bar = document.querySelector('[data-testid="main-toolbar"]');
      return bar ? bar.querySelectorAll('button[tabindex="0"]').length : -1;
    })) as number;
    expect(tabbables).toBe(1);

    await $('[data-testid="toolbar-open"]').click();
    await browser.keys(['ArrowRight']);
    const after = await activeTestId();
    expect(after).not.toBe('toolbar-open');
    expect(after).not.toBeNull();
    await browser.keys(['Home']);
    expect(await activeTestId()).toBe('toolbar-open');
  });

  it('the tab stop RE-DERIVES when the remembered button disables', async () => {
    // Focus memory landing on a button that then disables stranded the
    // whole toolbar out of Tab (review-caught): make Undo the roving stop,
    // exhaust it, and require a live tab stop to remain.
    await browser.keys(['Control', 'Shift', 't']); // one undoable edit
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 6);
    const undo = $('[data-testid="toolbar-undo"]');
    await undo.waitForEnabled();
    await undo.click(); // focuses it AND undoes the only edit → it disables
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 5);
    await browser.waitUntil(
      async () =>
        ((await browser.execute(() => {
          const bar = document.querySelector('[data-testid="main-toolbar"]');
          return bar
            ? bar.querySelectorAll('button[tabindex="0"]:not([disabled])').length
            : -1;
        })) as number) === 1,
      { timeoutMsg: 'the toolbar lost its (enabled) tab stop' },
    );
  });
});
