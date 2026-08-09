import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, getState, openByPaths } from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// The menu bar is a real Radix Menubar rendered from the command
// registry. This smoke drives it through the actual DOM: open a menu, invoke
// a (non-dialog) item, and confirm the observable state change, plus that
// Escape closes an open menu.

describe('menu bar', () => {
  it('opens the File menu and shows its items', async () => {
    await waitForHarness();
    await $('[data-testid="menu-file"]').click();
    await expect($('[data-testid="menuitem-file-open"]')).toBeDisplayed();
    await expect($('[data-testid="menuitem-file-save-as"]')).toBeDisplayed();
    // Escape closes it (Radix owns the key while the menu is open).
    await browser.keys(['Escape']);
    await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'Escape did not close the File menu',
    });
  });

  it('drives a command through a menu item (Document ▸ Watermark)', async () => {
    // Slice C: a doc-targeted panel item with NO document runs the
    // picker-first flow (a native dialog no test can drive) — so exercise the
    // documented flow: with a doc open, the item docks its panel beside it.
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening the sample never focused its doc tab',
    });
    // The doc tab's mount flurry (proxy load, canvas focus) can dismiss a
    // just-opened Radix menu — retry until the menu is OBSERVED open, checking
    // before clicking so the trigger's toggle can't oscillate it shut.
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="menuitem-document-watermark"]').isDisplayed().catch(() => false)) {
          return true;
        }
        await $('[data-testid="menu-document"]').click();
        await browser.pause(150);
        return $('[data-testid="menuitem-document-watermark"]').isDisplayed().catch(() => false);
      },
      { timeout: 15_000, timeoutMsg: 'the Document menu never opened' },
    );
    await $('[data-testid="menuitem-document-watermark"]').click();
    // Slice C: tools.panel.watermark opens the DOCK on the doc tab with the
    // watermark op armed — the document never leaves the screen.
    await $('[data-testid="tool-dock"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'menu item did not open the tool dock',
    });
    await browser.waitUntil(
      async () => (await getState()).activeOp === 'watermark',
      { timeoutMsg: 'menu item did not arm the watermark op' },
    );
  });

  // A menu is torn down and rebuilt on every open, so what it paints the
  // second time is not implied by the first, and a one-open audit cannot see a
  // surface that degrades only on a reopen. Measure it on each open, in each
  // theme, and require the three identical and readable.
  it('paints the same surface on every reopen, in every theme', async () => {
    for (const theme of ['dark', 'light', 'high-contrast']) {
      await browser.execute((t: string) => document.documentElement.setAttribute('data-theme', t), theme);
      await browser.pause(200);
      const seen: string[] = [];
      for (let open = 0; open < 3; open++) {
        await $('[data-testid="menu-file"]').click();
        await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
          timeout: 10_000,
          timeoutMsg: `the File menu did not open (${theme}, open ${open + 1})`,
        });
        const measured = (await browser.execute(() => {
          const content = document.querySelector('.app-menu-content') as HTMLElement | null;
          const item = document.querySelector('.app-menu-content [role="menuitem"]') as HTMLElement | null;
          if (!content || !item) return null;
          // Resolve through a canvas so any colour space the shell uses
          // (oklch among them) comes back as channels.
          const cv = document.createElement('canvas');
          cv.width = 1;
          cv.height = 1;
          const ctx = cv.getContext('2d')!;
          // PAINT the colour and read the pixel back. The shell writes colours
          // in whatever space its palette uses (oklch, and `none` is legal in a
          // computed one); parsing the serialized string means tracking every
          // space, while the painted pixel is always sRGB channels.
          const channels = (c: string): [number, number, number] | null => {
            const normalized = c.replace(/\bnone\b/g, '0');
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = '#010203';
            ctx.fillStyle = normalized;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            if (d[3] === 0) return null;
            return [d[0], d[1], d[2]];
          };
          const lum = (c: [number, number, number]): number => {
            const lin = (ch: number): number => {
              const s = ch / 255;
              return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
          };
          const bg = channels(getComputedStyle(content).backgroundColor);
          const fg = channels(getComputedStyle(item).color);
          if (!bg || !fg) return null;
          const a = lum(bg);
          const b = lum(fg);
          return {
            bg: bg.join(','),
            fg: fg.join(','),
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        })) as { bg: string; fg: string; contrast: number } | null;
        expect(measured).not.toBeNull();
        expect(measured!.contrast).toBeGreaterThan(4.5);
        seen.push(`${measured!.bg} on ${measured!.fg}`);
        await browser.keys(['Escape']);
        await $('[data-testid="menuitem-file-open"]').waitForDisplayed({
          reverse: true,
          timeoutMsg: `Escape did not close the File menu (${theme}, open ${open + 1})`,
        });
      }
      expect(seen[1]).toBe(seen[0]);
      expect(seen[2]).toBe(seen[0]);
    }
    await browser.execute(() => document.documentElement.setAttribute('data-theme', 'dark'));
  });
});
