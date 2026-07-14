import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, getState, openByPaths, invokeAppCommand } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Phase 4 M2: the tab strip (Home | Tools | doc tabs) replaces the old
// Home/Tools/Canvas view switcher. Navigation is tab clicks + Ctrl+Tab
// cycling (driven here through the window.nextTab/prevTab commands).

describe('tab navigation', () => {
  it('navigates Home / Tools / doc tab by clicking the tab strip', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]); // focuses the doc tab
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
    });

    await $('[data-testid="tab-tools"]').click();
    await browser.waitUntil(async () => (await getState()).focusedTab === 'tools', {
      timeoutMsg: 'tab did not switch to Tools',
    });

    await $('[data-testid="tab-home"]').click();
    await browser.waitUntil(async () => (await getState()).focusedTab === 'home', {
      timeoutMsg: 'tab did not switch to Home',
    });

    await $('[data-testid="tab-doc-0"]').click();
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'tab did not switch back to the document',
    });
  });

  it('cycles tabs with the Next/Previous Tab commands (Ctrl+Tab)', async () => {
    // From the doc tab, Next wraps to Home (order: Home, Tools, doc).
    await $('[data-testid="tab-doc-0"]').click();
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'not on the document tab',
    });

    await invokeAppCommand('window.nextTab');
    await browser.waitUntil(async () => (await getState()).focusedTab === 'home', {
      timeoutMsg: 'Next Tab did not wrap to Home',
    });

    await invokeAppCommand('window.nextTab');
    await browser.waitUntil(async () => (await getState()).focusedTab === 'tools', {
      timeoutMsg: 'Next Tab did not advance to Tools',
    });

    await invokeAppCommand('window.prevTab');
    await browser.waitUntil(async () => (await getState()).focusedTab === 'home', {
      timeoutMsg: 'Previous Tab did not return to Home',
    });
  });
});
