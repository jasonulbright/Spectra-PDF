import { expect } from '@wdio/globals';
import { waitForHarness, getState } from '../support/harness.js';

// The workbench frame — menu bar, main toolbar, tab strip — and
// the Home tab replace the old header/switcher/WelcomeScreen. The app name
// lives in the native title bar; the version lives in Help ▸ About.

describe('boot', () => {
  it('renders the workbench frame: menu bar, toolbar, tab strip', async () => {
    await waitForHarness();
    await expect($('[data-testid="menubar"]')).toBeDisplayed();
    await expect($('[data-testid="main-toolbar"]')).toBeDisplayed();
    await expect($('[data-testid="tab-strip"]')).toBeDisplayed();
    // The seven top-level menus.
    for (const id of ['file', 'edit', 'view', 'document', 'tools', 'window', 'help']) {
      await expect($(`[data-testid="menu-${id}"]`)).toBeDisplayed();
    }
  });

  it('boots onto the Home tab (pure doc tabs — no Tools pseudo-tab)', async () => {
    await expect($('[data-testid="tab-home"]')).toBeDisplayed();
    // The Tools tab is retired; its absence is part of the contract.
    await expect($('[data-testid="tab-tools"]')).not.toBeExisting();
    await expect($('[data-testid="home-tab"]')).toBeDisplayed();
    // The tile grid lives on Home now.
    await expect($('[data-testid="tools-center"]')).toBeDisplayed();
  });

  it('exposes a clean initial state via the harness', async () => {
    const state = await getState();
    expect(state.fileCount).toBe(0);
    expect(state.activeFile).toBeNull();
    expect(state.focusedTab).toBe('home');
    expect(state.view).toBe('welcome'); // legacy projection of Home
  });
});
