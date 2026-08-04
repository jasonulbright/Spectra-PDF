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
//   • NOTATION on the canvas: the align/z-order GLYPHS, the find-mode toggle
//     labels (Aa, \b, .*), measure UNIT symbols, PDF blend-mode VALUES and
//     bundled FACE NAMES (Liberation Sans). Symbols and proper nouns are the
//     same in every locale, so they are bare under qps by construction.

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

  // Slice C widened it again: the CANVAS and its overlays — the contextual
  // secondary toolbar (its title, its modes, a mode's options), the properties
  // bar, and the find bar. All of it lives OVER the page, so it needs a
  // document open and a tool armed.
  it('the canvas overlays render no bare English under qps', async () => {
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

    // Arm Comment BEFORE switching locale: the Tools menu item is matched by
    // its stable test id, but reading the menu in qps buys nothing here.
    expect(await invokeAppCommand('tools.open.comment')).toBe(true);
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'arming Comment did not raise the secondary toolbar',
    });

    await qps('qps');
    try {
      // ── SECONDARY TOOLBAR: the owning tool's name (read through the COMMAND
      // key, not a second copy) and each mode button (likewise).
      check(
        'secondary toolbar title',
        await $('[data-testid="secondary-toolbar"] .secondary-toolbar-title').getText(),
      );
      for (const m of ['highlight', 'freetext', 'ink', 'stamp']) {
        check(`secondary mode ${m}`, await $(`[data-testid="tool-${m}"]`).getText());
      }
      check(
        'secondary modes group aria',
        await $('[data-testid="secondary-toolbar"] .secondary-toolbar-modes')
          .getAttribute('aria-label'),
      );

      // ── A MODE OPTION: the stamp presets. Their WORDS localize (a stamp's
      // label is written into the document) while their test ids do not — the
      // whole point of giving STAMP_PRESETS a stable id in slice C.
      await $('[data-testid="tool-stamp"]').click();
      await $('[data-testid="stamp-preset-approved"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the stamp presets never appeared',
      });
      check('stamp preset approved', await $('[data-testid="stamp-preset-approved"]').getText());
      check('stamp new', await $('[data-testid="stamp-new-text"]').getText());

      // ── PROPERTIES BAR (Ctrl+E). Nothing is SELECTED but a comment mode is
      // armed, so it shows the tool-defaults branch — the "New <mode> color"
      // heading that used to glue a raw mode id into an English sentence.
      expect(await invokeAppCommand('view.propertiesBar')).toBe(true);
      await $('[data-testid="properties-bar"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the properties bar never opened',
      });
      check('pbar kind', await $('[data-testid="pbar-kind"]').getText());
      check(
        'pbar new-colour group aria',
        await $('[data-testid="properties-bar"] .properties-bar-swatches')
          .getAttribute('aria-label'),
      );
      check('pbar close title', await $('[data-testid="pbar-close"]').getAttribute('title'));
      check(
        'pbar toolbar aria',
        await $('[data-testid="properties-bar"]').getAttribute('aria-label'),
      );
      expect(await invokeAppCommand('view.propertiesBar')).toBe(true);

      // ── FIND BAR: its placeholder is a catalog string; the OCR language
      // names inside it are not (see the header) and are not read here.
      expect(await invokeAppCommand('edit.find')).toBe(true);
      await $('[data-testid="find-bar"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the find bar never opened',
      });
      check('find placeholder', await $('[data-testid="find-input"]').getAttribute('placeholder'));

      expect(leaks).toEqual([]);
    } finally {
      await qps('en');
      await browser.keys(['Escape']);
      await closeAllFiles();
    }
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the chrome never returned to English' },
    );
  });
});
