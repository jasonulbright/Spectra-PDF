import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, getState, openByPaths, invokeAppCommand } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// The tab strip (Home | Tools | doc tabs) replaces the old
// Home/Tools/Canvas view switcher. Navigation is tab clicks + Ctrl+Tab
// cycling (driven here through the window.nextTab/prevTab commands).

describe('tab navigation', () => {
  it('navigates Home / doc tab by clicking the tab strip', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]); // focuses the doc tab
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening did not focus the doc tab',
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
    // Slice C: the Tools pseudo-tab is gone — the order is Home + one tab per
    // document. From the doc tab, Next wraps to Home; Next again returns to
    // the document; Previous goes back to Home.
    await $('[data-testid="tab-doc-0"]').click();
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'not on the document tab',
    });

    await invokeAppCommand('window.nextTab');
    await browser.waitUntil(async () => (await getState()).focusedTab === 'home', {
      timeoutMsg: 'Next Tab did not wrap to Home',
    });

    await invokeAppCommand('window.nextTab');
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'Next Tab did not advance back to the document',
    });

    await invokeAppCommand('window.prevTab');
    await browser.waitUntil(async () => (await getState()).focusedTab === 'home', {
      timeoutMsg: 'Previous Tab did not return to Home',
    });
  });
});
