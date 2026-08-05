// Theme consistency catches fixed dark colors that remain in a light theme.
// The axe gate cannot see this class
// of bug — white-on-black passes a contrast check — so this audit flags it
// structurally: under the LIGHT theme no visible element may keep an opaque
// DARK background, and under HIGH CONTRAST none may keep an opaque LIGHT
// one. Colors are resolved through a canvas (the browser parses oklch and
// every other space for us), which is exactly the capability axe lacked.
//
// Deliberately-colored elements are excused: accent/danger/success fills
// carry their own theme rows, inline-styled swatches and dots ARE colors,
// and page content (canvas/img) is the document's, not the theme's.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness } from '../support/harness.js';
import { WALK_THEMES, walkSurfaces, stampTheme, type WalkTheme } from '../support/surface-walk.js';

const REPORT_PATH = resolve(__dirname, '..', 'a11y-theme-consistency.local.json');

interface Finding {
  theme: string;
  surface: string;
  descriptor: string;
  background: string;
}

const findings: Finding[] = [];
const seen = new Set<string>();

async function auditTheme(theme: WalkTheme, surface: string): Promise<void> {
  if (theme === 'dark') return; // dark is the authoring baseline
  const flagged = (await browser.execute((mode: string) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const resolveColor = (c: string): [number, number, number, number] | null => {
      ctx.fillStyle = '#000000';
      ctx.fillStyle = c;
      const v = ctx.fillStyle as string;
      const hex = /^#([0-9a-f]{6})$/i.exec(v);
      if (hex) {
        const n = parseInt(hex[1], 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 1];
      }
      const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(v);
      if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
      return null;
    };
    const luminance = (rgb: [number, number, number, number]): number => {
      const lin = (ch: number) => {
        const s = ch / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    };
    // Excused: page content, inline-styled color chips/dots, elements whose
    // classes carry deliberate colored fills (accent/danger/success and the
    // annotation color families all have their own theme rows).
    const excused = (el: Element): boolean => {
      if (el.tagName === 'CANVAS' || el.tagName === 'IMG' || el.tagName === 'VIDEO') return true;
      if ((el as HTMLElement).style?.backgroundColor) return true;
      const cls = el.className?.toString() ?? '';
      if (/bg-(blue|red|emerald|green|amber|yellow|purple|pink|orange|cyan|teal)-/.test(cls)) return true;
      if (el.closest('[data-theme-literal]')) return true;
      // Document content owns its presentation rather than inheriting the app
      // theme. Pages remain white in every theme, and the
      // reading surround + thumbnail frames exist to stage them.
      if (el.closest('.docview-scroll')) return true;
      if (cls.includes('thumb-frame')) return true;
      return false;
    };
    const out: { descriptor: string; background: string }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const bg = resolveColor(cs.backgroundColor);
      if (!bg || bg[3] < 0.9) continue; // transparent/washes composite with what's beneath
      // Chromatic fills are COLOR choices (accent selection states, danger
      // fills) with their own contrast story — the theme-leak class is
      // NEUTRAL greys from the opposite theme.
      const spread = Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]);
      if (spread > 40) continue;
      const L = luminance(bg);
      const wrong = mode === 'light' ? L < 0.25 : L > 0.75;
      if (!wrong) continue;
      if (excused(el)) continue;
      const t = el.getAttribute('data-testid');
      out.push({
        descriptor:
          el.tagName.toLowerCase() +
          (t ? `[${t}]` : '') +
          '.' +
          (el.className?.toString().split(/\s+/).slice(0, 4).join('.') || '(no class)'),
        background: cs.backgroundColor,
      });
      if (out.length >= 40) break;
    }
    return out;
  }, theme)) as { descriptor: string; background: string }[];

  for (const f of flagged) {
    const key = `${theme}|${f.descriptor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ theme, surface, descriptor: f.descriptor, background: f.background });
  }
}

describe('theme consistency audit (P21)', () => {
  it('boots with the harness', async () => {
    await waitForHarness();
  });

  for (const theme of WALK_THEMES) {
    it(`audits every surface — ${theme}`, async function () {
      this.timeout(300_000);
      await walkSurfaces(theme, auditTheme);
    });
  }

  it('found no theme-literal surfaces (report: a11y-theme-consistency.local.json)', async () => {
    await stampTheme('dark');
    writeFileSync(
      REPORT_PATH,
      JSON.stringify({ generated: new Date().toISOString(), findings }, null, 2),
    );
    if (findings.length > 0) {
      const lines = findings
        .slice(0, 20)
        .map((f) => `${f.theme} @ ${f.surface}: ${f.descriptor} keeps ${f.background}`)
        .join('\n');
      throw new Error(
        `${findings.length} element(s) keep an opposite-theme literal background:\n${lines}\n(full list in a11y-theme-consistency.local.json)`,
      );
    }
    expect(findings.length).toBe(0);
  });
});
