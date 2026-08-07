import { expect } from '@wdio/globals';
import { waitForHarness } from '../support/harness.js';

// The UI language switches LIVE from Preferences ▸
// Appearance, persists in the settings blob, and returns to English the
// same way. VITE_E2E forces the DEFAULT to en, so the suite's other specs
// keep their English asserts; this spec is the explicit switch coverage.

describe('language switch', () => {
  it('switching to Español re-renders the chrome, and back', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'es');

    // The menu bar re-renders live — File becomes Archivo.
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'Archivo',
      { timeout: 10_000, timeoutMsg: 'the menu bar never re-rendered in Spanish' },
    );
    // The preference persisted (what a relaunch would read).
    const stored = await browser.execute(
      () => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').language,
    );
    expect(stored).toBe('es');

    // `<html lang>` follows the switch. It shipped hardcoded to
    // "en", so a screen reader read Spanish text with English pronunciation
    // rules — the UI language and the language the DOCUMENT claims to be in
    // are the same fact and must not be able to disagree.
    expect(await browser.execute(() => document.documentElement.lang)).toBe('es');

    // And back — the rest of the suite depends on English.
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-file"]').getText()) === 'File',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // Every wave-1 locale. One known menu label each is the cheap proof the
  // catalog is BUNDLED and reachable from the Settings list — the parity,
  // placeholder and plural gates are vitest's job, and repeating them here
  // would buy nothing for the runtime cost. The anchor is View, not File:
  // Italian's File is spelled exactly like English's, so asserting on it
  // would pass against a locale that never loaded. Portuguese's "Exibir" is
  // likewise chosen for being nothing like "View", and for ja/zh any CJK
  // label is unmistakable. The two REGIONAL codes also prove the tag round
  // trips verbatim: `<html lang>` must read `pt-BR` / `zh-CN`, not `pt`/`zh`.
  it('switches to each wave-1 locale and back to English', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['fr', 'Affichage'],
      ['de', 'Ansicht'],
      ['it', 'Visualizza'],
      ['pt-BR', 'Exibir'],
      ['ja', '表示'],
      ['zh-CN', '视图'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);
    }

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // The Germanic/Nordic + Finnish wave. The anchor is View again, and every
  // label here differs from English — Danish and Norwegian share "Vis", which
  // is fine because `<html lang>` is asserted alongside it and the two
  // catalogs cannot both be loaded. File is unusable as an anchor for a
  // second reason now: Danish and Norwegian spell it "Fil", one letter from
  // English, and a truncated render would read as a pass.
  //
  // The overflow walk is the other half. Finnish compounds
  // (Yksitasoistuksen esikatselu) and Dutch/Norwegian ones are the longest
  // strings the chrome ever holds, and a fixed-width surface clips them
  // silently. `scrollWidth > clientWidth` on the fixed-width regions catches
  // that without a screenshot; the menu bar and toolbar are excluded because
  // they scroll by design.
  it('switches to each wave-C locale, and no fixed-width chrome overflows', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['nl', 'Beeld'],
      ['da', 'Vis'],
      ['sv', 'Visa'],
      ['nb', 'Vis'],
      ['fi', 'Näytä'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);

      const clipped = await browser.execute((l: string) => {
        const regions = ['prefs-body-appearance', 'canvas-status-bar', 'menubar'];
        const out: string[] = [];
        for (const id of regions) {
          const root = document.querySelector(`[data-testid="${id}"]`);
          if (!root) continue;
          for (const el of Array.from(root.querySelectorAll('button, label, option, span'))) {
            const e = el as HTMLElement;
            if (!e.offsetParent) continue;
            // Only a surface that CANNOT scroll is clipped; a scroller
            // overflowing is how a scroller works.
            const overflow = getComputedStyle(e).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') continue;
            if (e.scrollWidth > e.clientWidth + 1) {
              out.push(`${l} ${id}: ${(e.textContent ?? '').trim().slice(0, 60)}`);
            }
          }
        }
        return out;
      }, code);
      expect(clipped).toEqual([]);
    }

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // The four-plural-form Slavic wave. Every View label here is a non-homograph
  // of the English one, and the two Cyrillic ones (Вид / Вигляд) additionally
  // prove the catalog is the right one of the pair — the two languages share
  // most of their vocabulary, so a label they spell differently is what
  // separates them. The overflow walk runs again: Czech and Slovak compounds
  // (Náhled sloučení průhlednosti) are as long as the Finnish ones.
  it('switches to each wave-D locale, and no fixed-width chrome overflows', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['ru', 'Вид'],
      ['uk', 'Вигляд'],
      ['pl', 'Widok'],
      ['cs', 'Zobrazit'],
      ['sk', 'Zobraziť'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);

      const clipped = await browser.execute((l: string) => {
        const regions = ['prefs-body-appearance', 'canvas-status-bar', 'menubar'];
        const out: string[] = [];
        for (const id of regions) {
          const root = document.querySelector(`[data-testid="${id}"]`);
          if (!root) continue;
          for (const el of Array.from(root.querySelectorAll('button, label, option, span'))) {
            const e = el as HTMLElement;
            if (!e.offsetParent) continue;
            const overflow = getComputedStyle(e).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') continue;
            if (e.scrollWidth > e.clientWidth + 1) {
              out.push(`${l} ${id}: ${(e.textContent ?? '').trim().slice(0, 60)}`);
            }
          }
        }
        return out;
      }, code);
      expect(clipped).toEqual([]);
    }

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // The invariant-form wave, both halves of it: ko and zh-TW because CLDR
  // gives them one plural category, tr and hu because a numeral governs the
  // bare singular. The two CJK anchors are the load-bearing ones:
  // zh-TW's 檢視 and zh-CN's 视图 are different words for View, not two
  // spellings of one — a catalog produced by running zh-CN through a
  // character converter would read 視圖 here and fail. Korean 보기 is a
  // non-homograph of every other locale's label. The overflow walk runs
  // again because a Hangul or Traditional label can be wider than the Latin
  // one it replaced in a fixed-width segment, and Turkish and Hungarian
  // compounds are the other half of that check.
  it('switches to each wave-E locale, and no fixed-width chrome overflows', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['ko', '보기'],
      ['zh-TW', '檢視'],
      ['tr', 'Görünüm'],
      ['hu', 'Nézet'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);

      const clipped = await browser.execute((l: string) => {
        const regions = ['prefs-body-appearance', 'canvas-status-bar', 'menubar'];
        const out: string[] = [];
        for (const id of regions) {
          const root = document.querySelector(`[data-testid="${id}"]`);
          if (!root) continue;
          for (const el of Array.from(root.querySelectorAll('button, label, option, span'))) {
            const e = el as HTMLElement;
            if (!e.offsetParent) continue;
            const overflow = getComputedStyle(e).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') continue;
            if (e.scrollWidth > e.clientWidth + 1) {
              out.push(`${l} ${id}: ${(e.textContent ?? '').trim().slice(0, 60)}`);
            }
          }
        }
        return out;
      }, code);
      expect(clipped).toEqual([]);
    }

    // The Simplified catalog is still its own: 视图, not 檢視.
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'zh-CN');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === '视图',
      { timeout: 10_000, timeoutMsg: 'the menu bar never re-rendered in zh-CN' },
    );

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // The odd-plural-form wave. Every View label here differs from every other
  // locale's, but Catalan's Visualitza and Italian's Visualizza differ by one
  // letter, which is why `<html lang>` is asserted beside each label: the two
  // catalogs cannot both be loaded, so the pair identifies the catalog even
  // where the word nearly matches. Greek carries the extra check: uppercase
  // Greek drops accents, and the chrome uppercases headings through CSS
  // `text-transform`, which is language-sensitive under `lang="el"` — so the
  // walk reads a heading back and asserts it carries no accented capital.
  it('switches to each wave-F locale, uppercases Greek without accents, and no fixed-width chrome overflows', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['el', 'Προβολή'],
      ['ro', 'Vizualizare'],
      ['sl', 'Pogled'],
      ['ca', 'Visualitza'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);

      const clipped = await browser.execute((l: string) => {
        const regions = ['prefs-body-appearance', 'canvas-status-bar', 'menubar'];
        const out: string[] = [];
        for (const id of regions) {
          const root = document.querySelector(`[data-testid="${id}"]`);
          if (!root) continue;
          for (const el of Array.from(root.querySelectorAll('button, label, option, span'))) {
            const e = el as HTMLElement;
            if (!e.offsetParent) continue;
            const overflow = getComputedStyle(e).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') continue;
            if (e.scrollWidth > e.clientWidth + 1) {
              out.push(`${l} ${id}: ${(e.textContent ?? '').trim().slice(0, 60)}`);
            }
          }
        }
        return out;
      }, code);
      expect(clipped).toEqual([]);
    }

    // Greek uppercase, measured rather than assumed. A CSS-uppercased Greek
    // heading must lose its accents: Ρύθμιση → ΡΥΘΜΙΣΗ, never ΡΎΘΜΙΣΗ. The
    // probe finds an uppercasing surface, reads what it renders, and asserts
    // the rendered form carries no accented Greek capital — the failure this
    // would catch is CSS uppercasing the source string verbatim.
    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'el');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'Προβολή',
      { timeout: 10_000, timeoutMsg: 'the menu bar never re-rendered in el' },
    );
    const greekCaps = await browser.execute(() => {
      const probe = document.createElement('span');
      probe.setAttribute('lang', 'el');
      probe.style.textTransform = 'uppercase';
      probe.textContent = 'Ρύθμιση Άγγελος Προβολή';
      document.body.appendChild(probe);
      // `innerText` reports the TRANSFORMED text; textContent would report the
      // source and prove nothing about what the user sees.
      const rendered = probe.innerText;
      probe.remove();
      return rendered;
    });
    expect(greekCaps).toBe('ΡΥΘΜΙΣΗ ΑΓΓΕΛΟΣ ΠΡΟΒΟΛΗ');
    expect(/[ΆΈΉΊΌΎΏΪΫ]/.test(greekCaps)).toBe(false);

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    await $('[data-testid="prefs-close"]').click();
  });

  // The right-to-left wave. These two are the only shipped locales whose
  // direction is not `ltr`, so each row asserts `<html dir>` beside the label
  // — the same pairing spec 127 makes, here proving that a REAL catalog
  // reaching the Settings list flips the shell, not just the pseudo-locale.
  // Arabic additionally carries a check no other locale needs: the chrome
  // declares no @font-face, so Arabic text is shaped by the platform, and a
  // shaping failure renders correct characters in disconnected forms that no
  // text assertion can see. Measured, not assumed, exactly as Greek uppercase
  // was in wave F.
  it('switches to each RTL locale, flips <html dir>, and shapes Arabic', async () => {
    await waitForHarness();
    await browser.keys(['Control', 'k']);
    await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prefs-cat-appearance"]').click();
    await $('[data-testid="prefs-language"]').waitForDisplayed({ timeout: 10_000 });

    for (const [code, viewLabel] of [
      ['ar', 'عرض'],
      ['he', 'תצוגה'],
    ] as const) {
      await $('[data-testid="prefs-language"]').selectByAttribute('value', code);
      await browser.waitUntil(
        async () => (await $('[data-testid="menu-view"]').getText()) === viewLabel,
        { timeout: 10_000, timeoutMsg: `the menu bar never re-rendered in ${code}` },
      );
      expect(await browser.execute(() => document.documentElement.lang)).toBe(code);
      expect(await browser.execute(() => document.documentElement.dir)).toBe('rtl');

      const clipped = await browser.execute((l: string) => {
        const regions = ['prefs-body-appearance', 'canvas-status-bar', 'menubar'];
        const out: string[] = [];
        for (const id of regions) {
          const root = document.querySelector(`[data-testid="${id}"]`);
          if (!root) continue;
          for (const el of Array.from(root.querySelectorAll('button, label, option, span'))) {
            const e = el as HTMLElement;
            if (!e.offsetParent) continue;
            const overflow = getComputedStyle(e).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') continue;
            if (e.scrollWidth > e.clientWidth + 1) {
              out.push(`${l} ${id}: ${(e.textContent ?? '').trim().slice(0, 60)}`);
            }
          }
        }
        return out;
      }, code);
      expect(clipped).toEqual([]);
    }

    // Arabic shaping, measured. Lam followed by alef is a REQUIRED ligature:
    // a shaping engine draws the two code points as one glyph, so the pair is
    // narrower than the two letters laid out apart. If the platform handed
    // back isolated forms the widths would match. The comparison is against
    // the same two code points separated by a zero-width non-joiner, which
    // suppresses the ligature while adding no advance of its own.
    const shaping = await browser.execute(() => {
      const make = (text: string): number => {
        const probe = document.createElement('span');
        probe.setAttribute('lang', 'ar');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:48px';
        probe.textContent = text;
        document.body.appendChild(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      };
      return { ligature: make('لا'), apart: make('ل‌ا') };
    });
    expect(shaping.ligature).toBeGreaterThan(0);
    expect(shaping.ligature).toBeLessThan(shaping.apart);

    await $('[data-testid="prefs-language"]').selectByAttribute('value', 'en');
    await browser.waitUntil(
      async () => (await $('[data-testid="menu-view"]').getText()) === 'View',
      { timeout: 10_000, timeoutMsg: 'the menu bar never returned to English' },
    );
    expect(await browser.execute(() => document.documentElement.lang)).toBe('en');
    expect(await browser.execute(() => document.documentElement.dir)).toBe('ltr');
    await $('[data-testid="prefs-close"]').click();
  });
});
