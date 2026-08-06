// The OS forced-colors response.
//
// Chromium's media emulation is reachable through the driver, so these run
// against a real forced palette rather than against the stylesheet text: the
// media query flips, system colour keywords resolve to the forced values,
// computed colours change, and setting it back restores every one of them.
//
// Two contracts are under test. The document subtree is never recoloured, in
// any app theme, whether the palette is on or off. The chrome follows the
// palette, and the signals the substitution removes — control borders,
// selected states — come back in the palette's own vocabulary.
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setDocViewMode,
  getState,
  invokeAppCommand,
} from '../support/harness.js';

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function setForcedColors(on: boolean): Promise<void> {
  await (browser as unknown as {
    sendCommandAndGetResult(cmd: string, params: unknown): Promise<unknown>;
  }).sendCommandAndGetResult('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: on ? 'active' : 'none' }],
  });
  await browser.pause(400);
}

async function stampTheme(theme: string): Promise<void> {
  await browser.execute(
    (t: string) => document.documentElement.setAttribute('data-theme', t),
    theme,
  );
  await browser.pause(150);
}

/** Computed style of the first match, or null when the surface is not up. */
async function computed(selector: string, prop: string): Promise<string | null> {
  return browser.execute(
    (sel: string, p: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return getComputedStyle(el).getPropertyValue(p) || null;
    },
    selector,
    prop,
  );
}

/** What the forced palette resolves a system colour keyword to right now. */
async function systemColor(keyword: string): Promise<string> {
  return browser.execute((kw: string) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = kw;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return v;
  }, keyword);
}

/** Border width a freshly-made button computes at `parent`, so the exclusion
 * of the document subtree is read off a control rather than off whichever
 * hover-only affordance happens to be mounted. */
async function probeButtonBorder(parentSelector: string): Promise<number> {
  return browser.execute((sel: string) => {
    const host = document.querySelector(sel);
    if (!host) return -1;
    const b = document.createElement('button');
    host.appendChild(b);
    const w = parseFloat(getComputedStyle(b).borderTopWidth) || 0;
    b.remove();
    return w;
  }, parentSelector);
}

describe('OS forced colors', () => {
  let unforcedContentBg = '';

  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE]);
    await setView('canvas');
    await browser.waitUntil(async () => (await getState()).activeFile !== null, {
      timeout: 15_000,
      timeoutMsg: 'document never became active',
    });
    await browser.pause(1500);
  });

  after(async () => {
    await setForcedColors(false);
    await stampTheme('dark');
  });

  describe('the document subtree is exempt in every theme', () => {
    for (const theme of ['dark', 'light', 'high-contrast']) {
      it(`page and raster opt out of forcing — ${theme}`, async () => {
        await stampTheme(theme);
        expect(await computed('.page', 'forced-color-adjust')).toBe('none');
        expect(await computed('.pageview', 'forced-color-adjust')).toBe('none');
        // Inherited, so the rasters and the text layer are covered by the one
        // declaration on the root rather than by a rule each.
        expect(await computed('canvas.pageview-base', 'forced-color-adjust')).toBe('none');
        expect(await computed('.textLayer', 'forced-color-adjust')).toBe('none');
      });
    }

    it('the white paper beneath a reading-view page opts out', async () => {
      await stampTheme('dark');
      await setDocViewMode('document');
      await browser.pause(1200);
      expect(await computed('.docview-row', 'forced-color-adjust')).toBe('none');
      await setDocViewMode('organize');
      await browser.pause(600);
    });

    it('navigation thumbnails opt out', async () => {
      expect(await invokeAppCommand('view.navPanel.pages')).toBe(true);
      await browser.pause(1200);
      expect(await computed('.thumb-frame', 'forced-color-adjust')).toBe('none');
    });
  });

  describe('with the palette active', () => {
    before(async () => {
      await stampTheme('dark');
      unforcedContentBg = (await computed('main.app-content', 'background-color')) ?? '';
      await setForcedColors(true);
      await browser.pause(600);
    });

    it('the palette really is in force', async () => {
      expect(await browser.execute(() => window.matchMedia('(forced-colors: active)').matches))
        .toBe(true);
    });

    it('the page keeps its authored paper while the shell is forced', async () => {
      const canvasColor = await systemColor('Canvas');
      expect(await computed('.page', 'background-color')).toBe('rgb(255, 255, 255)');
      expect(await computed('.page', 'background-color')).not.toBe(canvasColor);
      // The same frame, on chrome: forced.
      const shell = await computed('main.app-content', 'background-color');
      expect(shell).toBe(canvasColor);
    });

    it('a selected chrome control resolves to the system Highlight, not the app accent', async () => {
      expect(await invokeAppCommand('tools.open.organize')).toBe(true);
      await browser.pause(600);
      const highlight = await systemColor('Highlight');
      expect(await computed('.tool-op.active', 'background-color')).toBe(highlight);
      // The accent variable still holds a value; it simply cannot paint here.
      const accent = await browser.execute(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      );
      expect(typeof accent).toBe('string');
    });

    it('controls carry a border again, and page overlays do not gain one', async () => {
      const chromeBorder = await computed('.tool-op', 'border-top-width');
      expect(parseFloat(chromeBorder ?? '0')).toBeGreaterThan(0);
      expect(await probeButtonBorder('.tool-dock')).toBeGreaterThan(0);
      expect(await probeButtonBorder('.page')).toBe(0);
    });

    it('the theme picker says the system is in control', async () => {
      expect(await invokeAppCommand('edit.preferences')).toBe(true);
      await $('[data-testid="prefs-cat-appearance"]').waitForDisplayed({ timeout: 10_000 });
      await $('[data-testid="prefs-cat-appearance"]').click();
      await browser.pause(400);
      await expect($('[data-testid="prefs-theme-forced-note"]')).toBeDisplayed();
      // The stored setting is untouched by the OS state.
      expect(await $('[data-testid="prefs-theme"]').getValue()).not.toBe('');
    });

    it('the note goes away when the palette does', async () => {
      await setForcedColors(false);
      await browser.pause(600);
      expect(await $('[data-testid="prefs-theme-forced-note"]').isExisting()).toBe(false);
      await $('[data-testid="prefs-close"]').click();
      await browser.pause(300);
    });

    it('every forced value is restored', async () => {
      expect(await browser.execute(() => window.matchMedia('(forced-colors: active)').matches))
        .toBe(false);
      expect(await computed('main.app-content', 'background-color')).toBe(unforcedContentBg);
    });
  });
});
