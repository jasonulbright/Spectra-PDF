import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  invokeAppCommand,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// N12 (brief 37): the qps pseudo-locale — every en string bracketed and
// vowel-stretched, generated at init, dev/e2e-only. A covered surface
// renders [Ẽẽ...]; a BARE ENGLISH string on a swept surface is a leak this
// spec exists to catch. Sweeps the slice-A chrome; grows with each slice.
//
// What is DELIBERATELY not swept, and why (get this wrong and the spec
// invents leaks):
//   • OCR RECOGNITION LANGUAGE NAMES. They come from `Intl.DisplayNames`,
//     never from the catalog (i18n.ts `tOcrLanguage`), so they are bare by
//     construction under qps. A bare language name is CORRECT here.
//   • Document CONTENT — file names, page labels, signer names, the engine's
//     own refusal text (the slice-D boundary). None of it is ours to bracket.

const qps = async (lang: string): Promise<void> => {
  await browser.execute((l) => {
    (window as unknown as { __SPECTRA_TEST__: { setLanguage: (x: string) => void } })
      .__SPECTRA_TEST__.setLanguage(l);
  }, lang);
};

describe('qps pseudo-locale leak sweep (N12)', () => {
  it('slice-A chrome renders no bare English under qps', async () => {
    await waitForHarness();
    await qps('qps');
    // Leaks collect into one list so the failure NAMES every bare-English
    // surface at once (wdio's expect takes no message argument).
    const leaks: string[] = [];
    const check = (label: string, text: string): void => {
      if (!text.startsWith('[')) leaks.push(`${label}: "${text}"`);
    };
    try {
      // Menu bar: every top-level trigger is bracketed.
      for (const id of ['file', 'edit', 'view', 'document', 'tools', 'window', 'help']) {
        check(`menu ${id}`, await $(`[data-testid="menu-${id}"]`).getText());
      }
      // Home tab: the hero + sections.
      await $('[data-testid="tab-home"]').click();
      await $('[data-testid="home-tab"]').waitForDisplayed({ timeout: 10_000 });
      check('home title', await $('[data-testid="home-tab"] .home-title').getText());
      check('home open button', await $('[data-testid="home-open-btn"]').getText());
      // The Home TAB label itself.
      check('home tab', await $('[data-testid="tab-home"]').getText());
      expect(leaks).toEqual([]);
    } finally {
      // The rest of the suite depends on English — restore even on failure.
      await qps('en');
    }
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the chrome never returned to English' },
    );
  });

  // Slice B widened the sweep past the chrome: the WORKBENCH (tool dock + nav
  // pane), a real dock PANEL, and a DIALOG. These need a document open — the
  // dock and the nav pane only exist on a doc tab.
  it('the workbench, a dock panel and a dialog render no bare English under qps', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeout: 15_000,
      timeoutMsg: 'opening did not focus the doc tab',
    });

    const leaks: string[] = [];
    const check = (label: string, text: string | null): void => {
      if (!text || !text.startsWith('[')) leaks.push(`${label}: "${text ?? '(null)'}"`);
    };

    await qps('qps');
    try {
      // ── NAV PANE: the panel header comes from the NAV_PANEL_TITLES table,
      // the aria-label from the panel's own record.
      const pressed = await $('[data-testid="navicon-pages"]').getAttribute('aria-pressed');
      if (pressed !== 'true') await $('[data-testid="navicon-pages"]').click();
      await $('[data-testid="nav-panel-body"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the nav pane never opened on Pages',
      });
      check('nav panel title', await $('[data-testid="nav-panel-title"]').getText());
      check('navicon pages title', await $('[data-testid="navicon-pages"]').getAttribute('title'));
      check('pages panel aria', await $('[data-testid="pages-panel"]').getAttribute('aria-label'));

      // ── SEARCH nav panel: scope buttons, the query placeholder, and the
      // shared find-mode toggles (whose LABELS — Aa, \b, .* — are notation
      // and stay verbatim; only their tooltips are catalog strings).
      await $('[data-testid="navicon-search"]').click();
      await $('[data-testid="search-scope-open"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the Search nav panel never rendered',
      });
      check('search scope open', await $('[data-testid="search-scope-open"]').getText());
      check('search scope disk', await $('[data-testid="search-scope-disk"]').getText());
      check('search placeholder', await $('[data-testid="search-input"]').getAttribute('placeholder'));
      check('find match-case title', await $('[data-testid="search-case"]').getAttribute('title'));

      // ── TOOL DOCK + a dock PANEL. Opening an operation's panel puts the
      // dock's own chrome (header, back control, op switcher) and a slice-B
      // panel on screen at once.
      expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the tool dock never opened',
      });
      check('dock title', await $('[data-testid="tool-dock-title"]').getText());
      check('dock back control', await $('[data-testid="tool-dock-grid"]').getText());
      check('dock close title', await $('[data-testid="tool-dock-close"]').getAttribute('title'));
      check('dock op switcher', await $('[data-testid="dock-op-rotate"]').getText());
      // The Rotate panel itself: its labels, its select's aria, its button.
      const dockLabels = await $$('[data-testid="tool-dock"] .tool-dock-body label');
      expect(dockLabels.length).toBeGreaterThan(0);
      for (const [i, el] of dockLabels.entries()) {
        check(`rotate panel label ${i}`, await el.getText());
      }
      check(
        'rotate angle aria',
        await $('[data-testid="tool-dock"] .tool-dock-body select').getAttribute('aria-label'),
      );

      // ── DIALOG: Preferences. Its shell strings are App's; its body is the
      // Settings panel, so one open covers both records.
      await browser.keys(['Control', 'k']);
      await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'Preferences never opened',
      });
      check('prefs category', await $('[data-testid="prefs-cat-appearance"]').getText());
      check('prefs close', await $('[data-testid="prefs-close"]').getText());
      await $('[data-testid="prefs-cat-appearance"]').click();
      await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });
      // The first label in the Appearance body is Theme; the Language select
      // right below it carries its own aria (added in slice A).
      check(
        'prefs appearance first label',
        await $('[data-testid="prefs-body-appearance"] label').getText(),
      );
      check(
        'prefs language aria',
        await $('[data-testid="prefs-language"]').getAttribute('aria-label'),
      );
      await $('[data-testid="prefs-close"]').click();

      expect(leaks).toEqual([]);
    } finally {
      await qps('en');
      await closeAllFiles();
    }
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the chrome never returned to English' },
    );
  });
});
