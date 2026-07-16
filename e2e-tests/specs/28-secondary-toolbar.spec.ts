import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  focusTab,
  invokeAppCommand,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Phase 4 M5.4: the floating tool pill is GONE. It listed all eight canvas
// modes flat and permanently; the secondary toolbar (§ 3.1) shows one TOOL's
// modes, and appears only while that tool is armed.
//
// This exists because the pill's retirement removed the only doc-tab way to arm
// Comment or Redact, and its replacement — Tools menu → the twelve tools — has
// to actually work. Every assertion below runs through the real DOM (menus,
// buttons) rather than the harness: the harness can set `tool` directly, which
// would prove nothing about whether a user can reach it.

describe('secondary toolbar', () => {
  it('is absent until a tool is armed', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    // A document is open with nothing armed: no tool, so no strip.
    expect((await getState()).focusedTab).toEqual({ doc: SAMPLE_PDF });
    await expect($('[data-testid="secondary-toolbar"]')).not.toBeExisting();
    // ...and the retired pill is not lurking either.
    await expect($('[data-testid="tool-highlight"]')).not.toBeExisting();
  });

  it('Tools ▸ Comment arms the tool from the document, and the strip shows ITS modes', async () => {
    await $('[data-testid="menu-tools"]').click();
    await $('[data-testid="menuitem-tool-comment"]').waitForDisplayed();
    await $('[data-testid="menuitem-tool-comment"]').click();

    // Still on the document — a canvas tool must not yank you to the Tools tab.
    await browser.waitUntil(
      async () => {
        const s = await getState();
        return typeof s.focusedTab === 'object' && s.focusedTab.doc === SAMPLE_PDF;
      },
      { timeoutMsg: 'Tools ▸ Comment left the document tab' },
    );

    const bar = $('[data-testid="secondary-toolbar"]');
    await bar.waitForDisplayed({ timeoutMsg: 'no secondary toolbar after arming Comment' });
    expect(await bar.getAttribute('data-tool')).toBe('comment');

    // Comment's four modes are here, and Comment's first is armed.
    for (const m of ['highlight', 'freetext', 'ink', 'stamp']) {
      await expect($(`[data-testid="tool-${m}"]`)).toBeDisplayed();
    }
    expect(await $('[data-testid="tool-highlight"]').getAttribute('aria-pressed')).toBe('true');

    // Modes belonging to OTHER tools are not here — that's the whole difference
    // from the pill, which showed all eight regardless of what you picked.
    await expect($('[data-testid="tool-redact"]')).not.toBeExisting();
    await expect($('[data-testid="tool-forms"]')).not.toBeExisting();
  });

  it('picking another of the tool’s modes switches the mode, not the tool', async () => {
    await $('[data-testid="tool-ink"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tool-ink"]').getAttribute('aria-pressed')) === 'true',
      { timeoutMsg: 'clicking Draw did not arm it' },
    );
    expect(await $('[data-testid="tool-highlight"]').getAttribute('aria-pressed')).toBe('false');
    // Same tool — the strip must not flip to another one.
    expect(await $('[data-testid="secondary-toolbar"]').getAttribute('data-tool')).toBe('comment');
  });

  it('a mode option (the stamp presets) rides with its mode', async () => {
    // Stamp presets used to be a floating satellite. They configure the armed
    // mode, so they belong to the tool — and only to that mode.
    await expect($('[data-testid="stamp-preset-approved"]')).not.toBeExisting();
    await $('[data-testid="tool-stamp"]').click();
    await $('[data-testid="stamp-preset-approved"]').waitForDisplayed({
      timeoutMsg: 'stamp presets did not follow the stamp mode into the strip',
    });
  });

  it('Close Tool disarms, and the strip goes with it', async () => {
    await $('[data-testid="secondary-action-tools.close"]').click();
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'the strip outlived the tool it belongs to',
    });
  });

  it('Escape disarms the MODE but keeps the tool open', async () => {
    // Escape means "stop drawing", not "close Comment". With the pill gone, a
    // strip that vanished on Escape would leave no way to re-arm short of the
    // Tools menu — so the strip belongs to the open TOOL, not the armed mode.
    await $('[data-testid="menu-tools"]').click();
    await $('[data-testid="menuitem-tool-comment"]').click();
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed();
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => (await getState()).tool === 'select',
      { timeoutMsg: 'Escape did not disarm the mode' },
    );
    // The tool is still open, and its modes are still one click away.
    await expect($('[data-testid="secondary-toolbar"]')).toBeDisplayed();
    expect(await $('[data-testid="tool-highlight"]').getAttribute('aria-pressed')).toBe('false');
    await $('[data-testid="tool-highlight"]').click();
    await browser.waitUntil(
      async () => (await getState()).tool === 'highlight',
      { timeoutMsg: 'could not re-arm from the strip after Escape' },
    );
    await $('[data-testid="secondary-action-tools.close"]').click();
  });

  it('Prepare Form arms ON the document and shows its single mode button', async () => {
    // It owns exactly one mode, and § 3.2 names its "+ Add Field" control. It
    // also has ops — which used to send it to the Tools tab, i.e. away from the
    // page it had just armed a mode on.
    await $('[data-testid="menu-tools"]').click();
    await $('[data-testid="menuitem-tool-prepareform"]').click();
    await browser.waitUntil(
      async () => {
        const s = await getState();
        return typeof s.focusedTab === 'object' && s.focusedTab.doc === SAMPLE_PDF;
      },
      { timeoutMsg: 'Prepare Form left the document tab' },
    );
    const bar = $('[data-testid="secondary-toolbar"]');
    await bar.waitForDisplayed();
    expect(await bar.getAttribute('data-tool')).toBe('prepareform');
    // The lone mode has a button — gating the row on >1 deleted it.
    await expect($('[data-testid="tool-formfields"]')).toBeDisplayed();
    expect(await $('[data-testid="tool-formfields"]').getAttribute('aria-pressed')).toBe('true');
    await $('[data-testid="secondary-action-tools.close"]').click();
  });

  it('Tools ▸ Redact arms a DIFFERENT tool, and the strip follows', async () => {
    await $('[data-testid="menu-tools"]').click();
    await $('[data-testid="menuitem-tool-redact"]').waitForDisplayed();
    await $('[data-testid="menuitem-tool-redact"]').click();
    const bar = $('[data-testid="secondary-toolbar"]');
    await bar.waitForDisplayed({ timeoutMsg: 'no secondary toolbar after arming Redact' });
    expect(await bar.getAttribute('data-tool')).toBe('redact');
    await expect($('[data-testid="tool-redact"]')).toBeDisplayed();
    // Comment's modes belong to Comment.
    await expect($('[data-testid="tool-highlight"]')).not.toBeExisting();
  });

  it('the Tools tab greys a tool that needs a document, instead of a dead click', async () => {
    // `invokeCommand` no-ops silently on a failed `when`, so an ungated tile is
    // a dead click that looks exactly like a live one. The menu bar already
    // greyed these; the grid invokes the SAME command and must agree.
    await closeAllFiles();
    await focusTab('tools');
    await $('[data-testid="tools-center"]').waitForDisplayed({
      timeoutMsg: 'no tile grid with nothing open',
    });
    // Work-on-the-page tools: disabled. A form tool: still live (its panel
    // prompts for a file).
    for (const id of ['comment', 'redact', 'ocr', 'fillsign', 'prepareform']) {
      await expect($(`[data-testid="tool-tile-${id}"]`)).toBeDisabled();
    }
    await expect($('[data-testid="tool-tile-protect"]')).toBeEnabled();
  });

  it('an ops-less tool left open outlives its document without stranding the Tools tab', async () => {
    // `activeToolId` deliberately outlives the document (Escape disarms the
    // mode, not the tool). Comment's Tools-tab pane is a fence saying "this
    // works on the page" — with no page, its only button is one that cannot
    // run. Fall back to the grid rather than show a dead end.
    await openByPaths([SAMPLE_PDF]);
    // The menu path is proven above; this case is about what the Tools TAB does
    // with a tool that outlives its document, so drive the command directly.
    expect(await invokeAppCommand('tools.open.comment')).toBe(true);
    await browser.waitUntil(async () => (await getState()).activeToolId === 'comment', {
      timeoutMsg: 'Comment did not open',
    });
    await closeAllFiles();
    await focusTab('tools');
    // The tool is still open in state...
    expect((await getState()).activeToolId).toBe('comment');
    // ...but the tab shows the grid, not a fence with an inert button.
    await expect($('[data-testid="tools-center"]')).toBeDisplayed();
    await expect($('[data-testid="tool-on-canvas"]')).not.toBeExisting();
    await openByPaths([SAMPLE_PDF]);
  });
});
