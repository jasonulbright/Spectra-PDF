import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// Left-dock candidates: Attachments, Layers, and Tags join the nav
// pane. The nav panels MOUNT THE SAME components the tool dock uses (one
// implementation per capability — the surfaces cannot disagree), so the
// assertion here is the real panel's own honest state on the untagged,
// attachment-free, layer-free sample — not a lookalike stub. Pane state is
// restored to Pages at the end (cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Each new panel proves itself by its component's OWN distinctive testid.
const PANELS = [
  { id: 'attachments', title: 'Attachments', proof: 'attach-empty' },
  { id: 'layers', title: 'Layers', proof: 'layers-empty' },
  { id: 'tags', title: 'Tags', proof: 'tags-untagged' },
] as const;

describe('navigation pane — docked Attachments / Layers / Tags (left-dock candidates)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await $('[data-testid="nav-icon-strip"]').waitForDisplayed({ timeout: 10_000 });
  });

  after(async () => {
    // Leave the pane open on Pages — the state other specs drive from.
    if ((await $('[data-testid="navicon-pages"]').getAttribute('aria-pressed')) !== 'true') {
      await $('[data-testid="navicon-pages"]').click();
    }
  });

  it('the icon strip carries all three, and each opens the REAL panel', async () => {
    for (const p of PANELS) {
      const icon = await $(`[data-testid="navicon-${p.id}"]`);
      await icon.waitForDisplayed();
      await icon.click();
      await browser.waitUntil(
        async () => (await $(`[data-testid="navicon-${p.id}"]`).getAttribute('aria-pressed')) === 'true',
        { timeoutMsg: `${p.id} icon never showed pressed` },
      );
      // The header text-transforms to uppercase — compare case-insensitively.
      expect((await $('[data-testid="nav-panel-title"]').getText()).toLowerCase()).toBe(
        p.title.toLowerCase(),
      );
      // The mounted component is the tool panel itself: its honest empty
      // state on the clean sample is the proof (no stub could show it).
      await $(`[data-testid="nav-panel-body"] [data-testid="${p.proof}"]`).waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: `${p.id}: the real panel's ${p.proof} state never appeared`,
      });
    }
  });

  it('the generated view.navPanel commands drive them too', async () => {
    expect(await invokeAppCommand('view.navPanel.layers')).toBe(true);
    await browser.waitUntil(
      async () => (await $('[data-testid="navicon-layers"]').getAttribute('aria-pressed')) === 'true',
      { timeoutMsg: 'view.navPanel.layers did not open the Layers panel' },
    );
    await $('[data-testid="nav-panel-body"] [data-testid="layers-empty"]').waitForDisplayed({
      timeout: 10_000,
    });
  });
});
