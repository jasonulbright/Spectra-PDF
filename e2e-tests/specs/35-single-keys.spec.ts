import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
  setReactInputValue,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// M6.4: Acrobat's single-key tool accelerators — pref-gated, DEFAULT OFF.

async function setSingleKeyPref(on: boolean): Promise<void> {
  await browser.keys(['Control', 'k']);
  const box = $('[data-testid="pref-single-key"]');
  await box.waitForDisplayed({ timeoutMsg: 'no single-key pref in General' });
  if ((await box.isSelected()) !== on) await box.click();
  await $('[data-testid="prefs-close"]').click();
  await $('[data-testid="pref-single-key"]').waitForDisplayed({ reverse: true });
}

describe('single-key accelerators (M6.4)', () => {
  before(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE_PDF]);
  });

  after(async () => {
    // The e2e profile persists localStorage across spec files — leave the
    // preset the way the suite found it.
    await setSingleKeyPref(false);
  });

  it('OFF by default: bare letters do not arm tools', async () => {
    expect((await getState()).tool).toBe('select');
    await browser.keys(['h']);
    await browser.pause(150);
    expect((await getState()).tool).toBe('select');
  });

  it('the Preferences switch turns them on — H, U, V pick tools', async () => {
    await setSingleKeyPref(true);

    await browser.keys(['h']);
    await browser.waitUntil(async () => (await getState()).tool === 'hand', {
      timeoutMsg: 'H did not arm Hand with the pref on',
    });
    await browser.keys(['u']);
    await browser.waitUntil(async () => (await getState()).tool === 'highlight', {
      timeoutMsg: 'U did not arm Highlight',
    });
    // Arming a mode opens its owning tool (the M5.3 invariant).
    expect((await getState()).activeToolId).toBe('comment');
    await browser.keys(['v']);
    await browser.waitUntil(async () => (await getState()).tool === 'select', {
      timeoutMsg: 'V did not return to Select',
    });
  });

  it('a letter typed into a FIELD stays a letter', async () => {
    await browser.keys(['Control', 'f']);
    await $('[data-testid="find-input"]').waitForDisplayed();
    await setReactInputValue('[data-testid="find-input"]', '');
    await $('[data-testid="find-input"]').click();
    await browser.keys(['h']);
    await browser.waitUntil(
      async () => (await $('[data-testid="find-input"]').getValue()) === 'h',
      { timeoutMsg: 'typing h in the find field did not type' },
    );
    expect((await getState()).tool).toBe('select');
    await browser.keys(['Escape']);
  });

  it('reserved letters stay dead even with the pref on', async () => {
    for (const k of ['z', 's', 'e']) {
      await browser.keys([k]);
    }
    await browser.pause(150);
    expect((await getState()).tool).toBe('select');
  });
});
