import { expect } from '@wdio/globals';
import { waitForHarness, getState } from '../support/harness.js';

describe('boot', () => {
  it('renders the header with title and version', async () => {
    await waitForHarness();
    await expect($('[data-testid="app-title"]')).toBeDisplayed();
    await expect($('[data-testid="app-title"]')).toHaveText('Open PDF Studio');
    const version = await $('[data-testid="app-version"]').getText();
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('exposes a clean initial state via the harness', async () => {
    const state = await getState();
    expect(state.fileCount).toBe(0);
    expect(state.activeFile).toBeNull();
    expect(['welcome', 'operations']).toContain(state.view);
  });
});
