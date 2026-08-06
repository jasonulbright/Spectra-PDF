import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
  invokeAppCommand,
  setReactInputValue,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// The qps pseudo-locale — every en string bracketed and
// vowel-stretched, generated at init, dev/e2e-only. A covered surface
// renders [Ẽẽ...]; a BARE ENGLISH string on a swept surface is a leak this
// spec exists to catch.
//
// The sweep is CONTAINER-scoped, not element-scoped: every button, label,
// heading, option and every title / aria-label / placeholder inside a named
// region, so a string nobody thought to list is caught by the same pass. A
// hand-picked element list only ever catches what its author was looking
// for. The hand-picked
// checks stay where a specific element carries the point (a heading that
// used to glue a raw mode id into English, a stamp preset whose test id must
// NOT move when its word does).
//
// What is DELIBERATELY not a leak, and why (get this wrong and the spec
// invents them). `notCatalog` below is the machine-readable form of this
// list; every entry is a string that never passes through the catalog, so it
// is bare under qps BY CONSTRUCTION:
//   • OCR RECOGNITION LANGUAGE NAMES. They come from `Intl.DisplayNames`
//     (i18n.ts `tOcrLanguage`), never from a catalog key — hand-translating
//     47 names per locale is 47 chances to be wrong when every locale's ICU
//     data already spells them.
//   • Document CONTENT — file names, page labels, signer names, bookmark
//     titles, and the ENGINE's own refusal text (the slice-D boundary).
//     None of it is ours to bracket.
//   • NOTATION: the align/z-order GLYPHS, the find-mode toggles (Aa, \b, .*),
//     measure UNIT symbols, PDF blend-mode VALUES, bundled FACE NAMES
//     (Liberation Sans), format names (PDF/A, XFA, PKCS#11), unit suffixes
//     (pt, KB, MB), COLOUR VALUES (#ffd54a — a swatch names itself by its
//     hex) and the keyboard NOTATION a chord is written in (Ctrl, Esc, Tab
//     and single letters — the letters engraved on the reader's own
//     keyboard; only the modifier and named keys localize).
//   • The PRODUCT NAME.
//   • The LANGUAGE PICKER's own options. Every locale is listed in ITS OWN
//     language (English · Español · Français · Deutsch · Italiano — i18n.ts
//     LOCALE_NATIVE_NAMES), which is
//     the whole convention: a reader hunting for their language finds it by
//     its native name, so these are proper names and never translated.
//
// The pseudo-locale marker is the LEADING '[': `pseudo()` in i18n.ts wraps
// every value, so "starts with [" is exactly "came from the catalog".

/** A collected string: where it was found, and what it said. */
type Found = [label: string, text: string];

/** Strings that legitimately never pass through the catalog (see header). */
const notCatalog = (text: string): boolean => {
  // No Latin letter at all: a number, a glyph, a symbol, punctuation.
  if (!/[A-Za-z]/.test(text)) return true;
  // Document content the fixtures put on screen.
  if (/sample|\.pdf|\.json|Untitled/i.test(text)) return true;
  // A FILE PATH is content, whatever it ends in. Create PDF's source rows
  // carry the full path as their `title`, and those sources are deliberately
  // not PDFs — so the rule has to be about being a path, not about which
  // extensions the fixtures happen to use.
  if (/^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{1,2}[^\\/]/.test(text)) return true;
  // A colour VALUE: a swatch's tooltip is its own hex.
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;
  const exact = new Set([
    'Spectra PDF',
    'Liberation Sans', 'Liberation Serif', 'Liberation Mono',
    'Aa', '\\b', '.*', 'A-1',
    'Ctrl', 'Esc', 'Tab', 'Alt', 'AV',
    'pt', 'KB', 'MB', '%',
    'PDF', 'PDF/A', 'PDF/X', 'XFA', 'AcroForm', 'OCR', 'ICC', 'CMYK', 'RGB',
    'Normal', 'Color', 'Serif', 'Sans', 'Mono', 'Radial',
    // The language picker names every locale in its own language. This list
    // tracks LOCALE_NATIVE_NAMES in i18n.ts — a wave-1 locale that lands
    // without its row here fails this sweep, which is the intended nudge.
    'English', 'Español', 'Français', 'Deutsch', 'Italiano',
    'Português (Brasil)', '日本語', '简体中文',
  ]);
  if (exact.has(text)) return true;
  // A REDACTION CODE row: the statutory citation, an em dash,
  // then the description. The citation — `(b)(6)`, `(k)(2)` — is the
  // statute's own text AND the exact string drawn into the redaction box, so
  // translating it would misname the exemption a release is checked against;
  // it never passes through the catalog by design. The DESCRIPTION after the
  // dash is our prose and must, so this returns "not a leak" only when that
  // half is bracketed, and lets a bare-English description through to be
  // reported like any other.
  const codeRow = /^\([^)]*\)[^—]*—\s*(.+)$/.exec(text);
  if (codeRow) return codeRow[1].startsWith('[');
  // A single character is notation (a keyboard letter, a maths sign).
  if (text.length === 1) return true;
  return false;
};

const qps = async (lang: string): Promise<void> => {
  await browser.execute((l) => {
    (window as unknown as { __SPECTRA_TEST__: { setLanguage: (x: string) => void } })
      .__SPECTRA_TEST__.setLanguage(l);
  }, lang);
};

/**
 * Every user-visible string inside `selector`: the own text of every control
 * and heading, plus every title / aria-label / placeholder. One round-trip —
 * a per-element wdio call over a whole dialog is minutes, not seconds.
 */
async function collect(selector: string): Promise<Found[] | null> {
  return (await browser.execute((sel: string) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const out: [string, string][] = [];
    const push = (label: string, text: string | null): void => {
      const t = (text ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push([label, t]);
    };
    const where = (el: Element): string => {
      const id = el.getAttribute('data-testid');
      return `${sel} ${el.tagName.toLowerCase()}${id ? `#${id}` : ''}`;
    };
    for (const el of Array.from(root.querySelectorAll('[title], [aria-label], [placeholder]'))) {
      push(`${where(el)}@title`, el.getAttribute('title'));
      push(`${where(el)}@aria-label`, el.getAttribute('aria-label'));
      push(`${where(el)}@placeholder`, el.getAttribute('placeholder'));
    }
    push(`${sel}@aria-label`, root.getAttribute('aria-label'));
    const OWN = 'button, label, option, h1, h2, h3, h4, legend, summary, th';
    for (const el of Array.from(root.querySelectorAll(OWN))) {
      // OWN text only: a button's nested <span> would otherwise be counted
      // twice, and a label wrapping an input would swallow its value.
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join(' ');
      push(where(el), own);
    }
    return out;
  }, selector)) as Found[] | null;
}

/** Collect `selector` and append every bare-English string to `leaks`. */
async function sweep(selector: string, leaks: string[]): Promise<void> {
  const found = await collect(selector);
  if (found === null) {
    leaks.push(`${selector}: MISSING (the surface never rendered)`);
    return;
  }
  if (found.length === 0) {
    leaks.push(`${selector}: EMPTY (nothing collected — the selector is wrong)`);
    return;
  }
  for (const [label, text] of found) {
    if (notCatalog(text)) continue;
    if (!text.startsWith('[')) leaks.push(`${label}: "${text}"`);
  }
}

describe('qps pseudo-locale leak sweep', () => {
  it('the docless chrome renders no bare English under qps', async () => {
    await waitForHarness();
    await qps('qps');
    // Leaks collect into one list so the failure NAMES every bare-English
    // surface at once (wdio's expect takes no message argument).
    const leaks: string[] = [];
    const check = (label: string, text: string): void => {
      if (!text.startsWith('[')) leaks.push(`${label}: "${text}"`);
    };
    try {
      // Menu bar: every top-level trigger, then one menu OPENED so its own
      // items and submenu labels are read too.
      for (const id of ['file', 'edit', 'view', 'document', 'tools', 'window', 'help']) {
        check(`menu ${id}`, await $(`[data-testid="menu-${id}"]`).getText());
      }
      await $('[data-testid="menu-file"]').click();
      await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the File menu never opened',
      });
      await sweep('[data-testid="menubar"]', leaks);
      await browser.keys(['Escape']);

      // Home tab: the hero, the quick actions, the recents section.
      await $('[data-testid="tab-home"]').click();
      await $('[data-testid="home-tab"]').waitForDisplayed({ timeout: 10_000 });
      check('home title', await $('[data-testid="home-tab"] .home-title').getText());
      check('home open button', await $('[data-testid="home-open-btn"]').getText());
      check('home tab', await $('[data-testid="tab-home"]').getText());
      await sweep('[data-testid="home-tab"]', leaks);

      // The main toolbar and the tab strip live above every view.
      await sweep('[data-testid="main-toolbar"]', leaks);
      await sweep('[data-testid="tab-strip"]', leaks);

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

  // The WORKBENCH: tool dock (picker AND an open panel), the nav pane's seven
  // panels, the status bar, and two dialogs. All of it needs a document open.
  it('the workbench, the dock panels and the dialogs render no bare English under qps', async () => {
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
      // ── NAV PANE: every panel, not just Pages. The header comes from the
      // NAV_PANEL_TITLES table, the icon tooltip from the same key, and each
      // panel body from its own record.
      for (const id of ['pages', 'bookmarks', 'attachments', 'layers', 'tags', 'signatures', 'search']) {
        await $(`[data-testid="navicon-${id}"]`).click();
        await $('[data-testid="nav-panel-body"]').waitForDisplayed({
          timeout: 10_000,
          timeoutMsg: `the nav pane never opened on ${id}`,
        });
        check(`nav panel title (${id})`, await $('[data-testid="nav-panel-title"]').getText());
        check(`navicon title (${id})`, await $(`[data-testid="navicon-${id}"]`).getAttribute('title'));
        await sweep('[data-testid="nav-panel-body"]', leaks);
      }
      // The find-mode toggles inside Search are NOTATION (Aa, \b, .*); only
      // their tooltips are catalog strings, which the sweep above read.
      check('search placeholder', await $('[data-testid="search-input"]').getAttribute('placeholder'));

      // ── STATUS BAR: the DOCKED one under the canvas —
      // page nav, zoom, the organize/read toggle. (`status-bar` is the
      // transient message strip and only exists while something is running.)
      await sweep('[data-testid="canvas-status-bar"]', leaks);

      // ── TOOL DOCK, both halves: the PICKER grid (every tool tile and its
      // blurb) and an OPEN panel (dock chrome + the panel's own controls).
      expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the tool dock never opened',
      });
      check('dock title', await $('[data-testid="tool-dock-title"]').getText());
      check('dock close title', await $('[data-testid="tool-dock-close"]').getAttribute('title'));
      check('dock op switcher', await $('[data-testid="dock-op-rotate"]').getText());
      await sweep('[data-testid="tool-dock"]', leaks);

      // The Takeoff panel is a container of its own — its empty
      // state, its column headings and its two actions are all catalog
      // strings, and its group NAMES are user data that must stay bare (the
      // sweep reads the chrome around them, not them).
      expect(await invokeAppCommand('tools.panel.takeoff')).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
      await browser.pause(200);
      await sweep('[data-testid="tool-dock"]', leaks);
      expect(await invokeAppCommand('tools.close')).toBe(true);
      expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });

      // The Compress panel's MRC branch is a surface that only exists
      // once the quality select is on it — the preset radios, their hints and
      // the two checkboxes are hidden behind a choice, which is exactly the
      // kind of surface a sweep of the DEFAULT state never reaches.
      //
      // `tools.panel.*` SWITCHES the docked panel on its own — no `tools.close`
      // between them, and deliberately not: that command's `when` requires the
      // open tool to have canvas modes, which Rotate's and Compress's owner do
      // not, so a close here reports "disabled" and fails the step (it did, on
      // the first battery run).
      expect(await invokeAppCommand('tools.panel.compress')).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
      await $('[data-testid="compress-quality"]').waitForDisplayed({ timeout: 10_000 });
      await $('[data-testid="compress-quality"]').selectByAttribute('value', 'mrc');
      await $('[data-testid="compress-mrc-options"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'choosing MRC did not reveal its options',
      });
      await sweep('[data-testid="tool-dock"]', leaks);

      // Search & Redact is the widest new dock surface — scope,
      // the eight pattern names, the three `expand` choices WITH their
      // consequence hints, and two COLLAPSED groups (the word list and the
      // redaction properties, whose colour/alignment/code controls only exist
      // once opened). The Compress-MRC lesson generalized: a sweep of the
      // default state never reaches a surface hidden behind a disclosure.
      expect(await invokeAppCommand('tools.panel.search_redact')).toBe(true);
      await $('[data-testid="search-redact-panel"]').waitForDisplayed({ timeout: 10_000 });
      await $('[data-testid="search-redact-wordlist-toggle"]').click();
      await $('[data-testid="search-redact-wordlist"]').waitForDisplayed({ timeout: 10_000 });
      await $('[data-testid="search-redact-properties-toggle"]').click();
      await $('[data-testid="redaction-properties"]').waitForDisplayed({ timeout: 10_000 });
      // The overlay half of the properties (alignment, size, colour, repeat)
      // only renders once there IS an overlay — another disclosure.
      await setReactInputValue('[data-testid="redact-props-overlay"]', 'CODE');
      await $('[data-testid="redact-props-align"]').waitForDisplayed({ timeout: 10_000 });
      await browser.pause(200);
      await sweep('[data-testid="tool-dock"]', leaks);
      await setReactInputValue('[data-testid="redact-props-overlay"]', '');
      await $('[data-testid="redact-props-reset"]').click();

      expect(await invokeAppCommand('tools.panel.rotate')).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });

      // Back to the picker: the tile grid is a surface of its own.
      await $('[data-testid="tool-dock-grid"]').click();
      await browser.pause(200);
      await sweep('[data-testid="tool-dock"]', leaks);

      // ── DIALOG 1: Preferences. Its shell strings are App's; its body is
      // the Settings panel, so one open covers both records.
      await browser.keys(['Control', 'k']);
      await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'Preferences never opened',
      });
      await $('[data-testid="prefs-cat-appearance"]').click();
      await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });
      check('prefs language aria', await $('[data-testid="prefs-language"]').getAttribute('aria-label'));
      await sweep('[data-testid="prefs-body-appearance"]', leaks);
      await $('[data-testid="prefs-close"]').click();

      // ── DIALOG 2: Document Properties — a data-heavy dialog whose VALUES
      // are document content (bare by construction) while every label,
      // tab and button is a catalog string.
      expect(await invokeAppCommand('file.properties')).toBe(true);
      await $('[data-testid="properties-dialog"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the Properties dialog never opened',
      });
      await sweep('[data-testid="properties-dialog"]', leaks);
      await $('[data-testid="props-close"]').click();

      // ── DIALOG 3: Create PDF. 33 new strings in one dialog, and two
      // of its surfaces only exist once the LIST does — the per-row kind
      // badge and the unsupported-row message. So the empty state is swept
      // first, then rows are injected through the harness (a refused source,
      // which leaves the rows on screen) and it is swept again.
      expect(await invokeAppCommand('file.createPdf')).toBe(true);
      await $('[data-testid="create-pdf-dialog"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the Create PDF dialog never opened',
      });
      await $('[data-testid="create-pdf-empty"]').waitForDisplayed({ timeout: 10_000 });
      await sweep('[data-testid="create-pdf-dialog"]', leaks);

      // Scratch inside the app's static fs scope ($TEMP/spectrapdf/**) — the
      // harness injects the path without a native dialog, so the runtime
      // scope extension a real pick gets never runs for it.
      const scoped = resolve(tmpdir(), 'spectrapdf');
      mkdirSync(scoped, { recursive: true });
      const bogus = resolve(mkdtempSync(resolve(scoped, 'e2e-createpdf-')), 'thing.zip');
      writeFileSync(bogus, Buffer.from('PKnot a document'));
      await browser.executeAsync<null, [string[], string]>(
        function (srcs, out, done) {
          (window as any).__SPECTRA_TEST__.createPdfRun(srcs, out)
            .then(() => done(null))
            .catch(() => done(null));
        },
        [bogus, SAMPLE_PDF],
        resolve(mkdtempSync(resolve(tmpdir(), 'spectrapdf', 'e2e-createpdf-out-')), 'never.pdf'),
      );
      await $('[data-testid="create-pdf-unsupported"]').waitForDisplayed({ timeout: 15_000 });
      await sweep('[data-testid="create-pdf-dialog"]', leaks);
      await $('[data-testid="create-pdf-close"]').click();

      // ── DIALOG 4: Combine Files. 36 more strings, and the
      // same shape of problem — the per-row converter line, the page-range
      // field's placeholder and the blocked message only exist once the LIST
      // does. Empty state first, then a refused row injected through the
      // harness (which the dialog's own blocker stops before any engine
      // call, leaving the rows on screen), then swept again.
      expect(await invokeAppCommand('document.combineFiles')).toBe(true);
      await $('[data-testid="combine-dialog"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the Combine dialog never opened',
      });
      await $('[data-testid="combine-empty"]').waitForDisplayed({ timeout: 10_000 });
      await sweep('[data-testid="combine-dialog"]', leaks);

      await browser.executeAsync<null, [string[], string]>(
        function (srcs, out, done) {
          (window as any).__SPECTRA_TEST__.combineRun(srcs, out, { target: 'new' })
            .then(() => done(null))
            .catch(() => done(null));
        },
        [bogus, SAMPLE_PDF],
        resolve(mkdtempSync(resolve(tmpdir(), 'spectrapdf', 'e2e-combine-out-')), 'never.pdf'),
      );
      await $('[data-testid="combine-blocked"]').waitForDisplayed({ timeout: 15_000 });
      await sweep('[data-testid="combine-dialog"]', leaks);
      await $('[data-testid="combine-close"]').click();

      // ── DIALOG 5: Search & Redact Folder. Its setup phase carries the whole
      // search form plus the two consent surfaces, and it is reachable with no
      // document open — which is exactly why it has to be swept: nothing else
      // in this spec renders it.
      expect(await invokeAppCommand('tools.diskRedact')).toBe(true);
      await $('[data-testid="disk-redact-dialog"]').waitForDisplayed({
        timeout: 15_000,
        timeoutMsg: 'the Search & Redact folder dialog never opened',
      });
      await $('[data-testid="disk-redact-wordlist-toggle"]').click();
      await $('[data-testid="disk-redact-properties-toggle"]').click();
      await sweep('[data-testid="disk-redact-dialog"]', leaks);
      await $('[data-testid="disk-redact-x"]').click();

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

  // The CANVAS and its overlays — the contextual secondary toolbar (its
  // title, its modes, a mode's options), the properties bar, and the find
  // bar. All of it lives OVER the page, so it needs a document open and a
  // tool armed.
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
      await sweep('[data-testid="secondary-toolbar"]', leaks);

      // ── A MODE OPTION: the stamp presets. Their WORDS localize (a stamp's
      // label is written into the document) while their test ids do not — the
      // whole point of giving STAMP_PRESETS a stable id.
      await $('[data-testid="tool-stamp"]').click();
      await $('[data-testid="stamp-preset-approved"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the stamp presets never appeared',
      });
      check('stamp preset approved', await $('[data-testid="stamp-preset-approved"]').getText());
      check('stamp new', await $('[data-testid="stamp-new-text"]').getText());
      await sweep('[data-testid="secondary-toolbar"]', leaks);

      // ── PROPERTIES BAR (Ctrl+E). Nothing is SELECTED but a comment mode is
      // armed, so it shows the tool-defaults branch — the "New <mode> color"
      // heading that used to glue a raw mode id into an English sentence.
      expect(await invokeAppCommand('view.propertiesBar')).toBe(true);
      await $('[data-testid="properties-bar"]').waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'the properties bar never opened',
      });
      check('pbar kind', await $('[data-testid="pbar-kind"]').getText());
      check('pbar close title', await $('[data-testid="pbar-close"]').getAttribute('title'));
      await sweep('[data-testid="properties-bar"]', leaks);
      expect(await invokeAppCommand('view.propertiesBar')).toBe(true);

      // ── FIND BAR: its placeholder is a catalog string; the OCR language
      // names inside it are NOT (see the header) — `notCatalog` cannot know
      // them by value, so the find bar is swept by its named elements only.
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

  // Slice E's own tail: the refusals the RENDERER builds in its leaf libs.
  // They never render as chrome — they arrive as a thrown message — so no
  // container sweep can see them; each is driven to its throw and the
  // MESSAGE is checked for the pseudo-locale marker.
  it('the renderer\'s own refusals are localized under qps', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeout: 15_000,
      timeoutMsg: 'opening did not focus the doc tab',
    });
    // Scratch lives INSIDE the app's static fs scope ($TEMP/spectrapdf/**) —
    // the import bridge injects the path without a native dialog, so the
    // runtime scope extension a real pick gets never runs for it.
    const scoped = resolve(tmpdir(), 'spectrapdf');
    mkdirSync(scoped, { recursive: true });
    const scratch = mkdtempSync(resolve(scoped, 'e2e-qps-'));
    const badAction = resolve(scratch, 'bad-action.json');
    writeFileSync(
      badAction,
      JSON.stringify({ name: 'Leak probe', steps: [{ op: 'explode', params: {} }] }),
    );

    const leaks: string[] = [];
    await qps('qps');
    try {
      // (1) lib/guided-actions.ts — the action-file import refusals. The op
      // id 'explode' rides a {{var}} and stays verbatim INSIDE the bracketed
      // message; the sentence around it must be localized.
      expect(await invokeAppCommand('tools.open.actions')).toBe(true);
      await $('[data-testid="action-new"]').waitForDisplayed({ timeout: 10_000 });
      const importErr = (await browser.executeAsync(
        function (p: string, done: (r: string) => void) {
          (window as unknown as {
            __SPECTRA_TEST__: { guidedImportFromPath: (x: string) => Promise<void> };
          }).__SPECTRA_TEST__
            .guidedImportFromPath(p)
            .then(() => done(''))
            .catch((e: unknown) => done(e instanceof Error ? e.message : String(e)));
        },
        badAction,
      )) as string;
      if (!importErr.startsWith('[')) leaks.push(`guided import refusal: "${importErr}"`);
      if (!importErr.includes('explode')) {
        leaks.push(`guided import refusal dropped the op id: "${importErr}"`);
      }

      // (2) lib/form-authoring.ts — FieldSpecError. A '.' in a field name is
      // the AcroForm hierarchy separator, so validateSpec refuses before any
      // mutation and every problem comes back at once.
      await $('[data-testid="tool-dock-close"]').click();
      await browser.executeAsync(function (done: (r: unknown) => void) {
        (window as unknown as {
          __SPECTRA_TEST__: {
            placeNewField: (r: { x: number; y: number; w: number; h: number }) => Promise<void>;
          };
        }).__SPECTRA_TEST__
          .placeNewField({ x: 0.2, y: 0.2, w: 0.3, h: 0.08 })
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      });
      const fieldErr = (await browser.executeAsync(function (done: (r: string) => void) {
        (window as unknown as {
          __SPECTRA_TEST__: {
            createPlacedField: (p: { name: string; type: string }) => Promise<void>;
          };
        }).__SPECTRA_TEST__
          .createPlacedField({ name: 'parent.child', type: 'text' })
          .then(() => done(''))
          .catch((e: unknown) => done(e instanceof Error ? e.message : String(e)));
      })) as string;
      if (!fieldErr.startsWith('[')) leaks.push(`field spec refusal: "${fieldErr}"`);

      expect(leaks).toEqual([]);
    } finally {
      await qps('en');
      await browser.keys(['Escape']);
      await browser.execute(() => localStorage.removeItem('guided-actions'));
      await closeAllFiles();
    }
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the chrome never returned to English' },
    );
  });
});
