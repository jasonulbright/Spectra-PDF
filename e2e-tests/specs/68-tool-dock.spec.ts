import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, invokeAppCommand } from '../support/harness.js';

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Phase 10 slice B1: ops-tool panels open in the RIGHT DOCK beside an
// always-visible document. The full-page Tools tab survives as the
// no-document fallback (slice C retires it) — asserted here too, because the
// intermediate state must be redundant-but-working, never half-broken.
describe('right tool dock (Phase 10 B1)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE]);
    await setView('canvas');
    // The suite shares one workspace and an earlier spec may leave the board
    // (Organize) mode active; `document-view` exists only in the reading
    // view, so pin the mode instead of assuming it (order-dependence caught
    // by the full-suite gate — solo runs passed).
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  it('an ops tool opens in the dock with the document still visible', async () => {
    expect(await invokeAppCommand('tools.open.accessibility')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    // The whole point: the document did NOT go away.
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="tool-dock-title"]').getText()).toBe('Accessibility');

    // The owning tool's op switcher works inside the dock: Tags renders the
    // TagsPanel (sample.pdf is untagged — its honest empty state is the proof).
    await $('[data-testid="dock-op-tags"]').click();
    await $('[data-testid="tool-dock"] [data-testid="tags-untagged"]').waitForDisplayed({
      timeout: 10_000,
    });
  });

  it('the ⊞ grid is the dock-native all-tools view', async () => {
    await $('[data-testid="tool-dock-grid"]').click();
    await $('[data-testid="tool-dock"] [data-testid="tools-center"]').waitForDisplayed({
      timeout: 10_000,
    });
    await $('[data-testid="tool-dock"] [data-testid="tool-tile-optimize"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tool-dock-title"]').getText()) === 'Optimize',
      { timeout: 10_000, timeoutMsg: 'picking a tile never seated its tool in the dock' },
    );
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });

  it('a menu panel command re-opens the closed dock on the doc tab', async () => {
    await $('[data-testid="tool-dock-close"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: 'the dock never closed',
    });
    expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="tool-dock-title"]').getText()).toBe('Organize Pages');
    expect(await $('[data-testid="dock-op-rotate"]').getAttribute('aria-pressed')).toBe('true');
    expect(await $('[data-testid="document-view"]').isDisplayed()).toBe(true);
  });

  it('reading mode collapses the dock and restores it on exit', async () => {
    expect(await invokeAppCommand('view.readingMode')).toBe(true);
    await browser.waitUntil(async () => !(await $('[data-testid="tool-dock"]').isExisting()), {
      timeout: 5_000,
      timeoutMsg: 'reading mode did not collapse the dock',
    });
    await browser.keys(['Escape']);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 5_000 });
  });

  it('the legacy Tools tab still works (redundant, complete — until slice C)', async () => {
    await setView('operations');
    // A tool is open from the previous leg (Organize, via tools.panel.rotate),
    // so the tab correctly shows its PANE — the op switcher proves the legacy
    // surface still renders. (The tile grid shows only with no tool open.)
    await $('[data-testid="tool-op-switch"]').waitForDisplayed({ timeout: 10_000 });
    // Back to the document for later specs (shared workspace).
    await setView('canvas');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 10_000 });
  });
});
