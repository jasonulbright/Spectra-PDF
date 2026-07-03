import { expect } from '@wdio/globals';
import { waitForHarness, getState } from '../support/harness.js';

describe('view switcher', () => {
  it('navigates between Home, Tools, Canvas via header buttons', async () => {
    await waitForHarness();

    await $('[data-testid="view-tools"]').click();
    await browser.waitUntil(async () => (await getState()).view === 'operations', {
      timeoutMsg: 'view did not switch to operations',
    });

    await $('[data-testid="view-home"]').click();
    await browser.waitUntil(async () => (await getState()).view === 'welcome', {
      timeoutMsg: 'view did not switch to welcome',
    });

    await $('[data-testid="view-canvas"]').click();
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'view did not switch to canvas',
    });

    await expect($('[data-testid="view-switcher"]')).toBeDisplayed();
  });
});
