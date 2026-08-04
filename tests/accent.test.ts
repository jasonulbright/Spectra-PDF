// Accent derivation (Phase 3b, contrast-corrected in the P21 WCAG round):
// Windows accents range from dark blues to light yellows. Text-on-accent is
// pure WCAG arithmetic (white holds 4.5:1 only up to L 0.1833 — the old
// 0.4 "when Windows flips" threshold shipped white-on-cyan at 2.45:1), and
// hover shifts AWAY from the text color so the hover state never has less
// contrast than rest.
import { describe, expect, it } from 'vitest';
import { deriveAccentVars, parseHex, relativeLuminance } from '../src/renderer/lib/accent';

describe('parseHex', () => {
  it('parses #RRGGBB in either case', () => {
    expect(parseHex('#0078D4')).toEqual([0, 120, 212]);
    expect(parseHex('#ffb900')).toEqual([255, 185, 0]);
  });

  it('rejects malformed input', () => {
    expect(parseHex('')).toBeNull();
    expect(parseHex('#fff')).toBeNull();
    expect(parseHex('#0078D')).toBeNull();
    expect(parseHex('#0078D4FF')).toBeNull();
    expect(parseHex('0078D4')).toBeNull();
    expect(parseHex('#00xx00')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('spans black to white', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it('puts cyan and gold above the white-text ceiling', () => {
    // White text mathematically fails 4.5:1 above L 0.1833 — both of these
    // shipped with white text under the old Windows-flip threshold.
    expect(relativeLuminance([0, 183, 195])).toBeGreaterThan(0.182); // #00B7C3
    expect(relativeLuminance([255, 185, 0])).toBeGreaterThan(0.182); // #FFB900
  });
});

/** WCAG contrast ratio between two sRGB colors. */
function ratio(fg: [number, number, number], bg: [number, number, number]): number {
  const [l1, l2] = [relativeLuminance(fg), relativeLuminance(bg)];
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function parseRgb(s: string): [number, number, number] {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(s)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe('deriveAccentVars', () => {
  it('keeps white text on the default Windows blue — and hover DARKENS so white still passes there', () => {
    const vars = deriveAccentVars('#0078D4')!;
    expect(vars.fg).toBe('#ffffff');
    expect(vars.hover).toBe('rgb(0, 90, 182)');
    expect(vars.muted).toBe('rgba(0, 120, 212, 0.3)');
    expect(vars.subtle).toBe('rgba(0, 120, 212, 0.2)');
    // The invariant behind the direction change: rest AND hover both >= AA.
    expect(ratio([255, 255, 255], [0, 120, 212])).toBeGreaterThanOrEqual(4.5);
    expect(ratio([255, 255, 255], parseRgb(vars.hover))).toBeGreaterThanOrEqual(4.5);
  });

  it('flips to black text on cyan — the accent that shipped at 2.45:1 with white', () => {
    const vars = deriveAccentVars('#00B7C3')!;
    expect(vars.fg).toBe('#000000');
    expect(ratio([0, 0, 0], [0, 183, 195])).toBeGreaterThanOrEqual(4.5);
    expect(ratio([0, 0, 0], parseRgb(vars.hover))).toBeGreaterThanOrEqual(4.5);
  });

  it('uses black text and a lightening hover on light accents', () => {
    // Windows "Gold" — white text fails contrast here, and hover moves away
    // from black (lighter), never toward it.
    const vars = deriveAccentVars('#FFB900')!;
    expect(vars.fg).toBe('#000000');
    expect(vars.hover).toBe('rgb(255, 215, 30)');
  });

  it('falls back to a toward-shift when the away-shift clamps to a no-op', () => {
    // A hover with no visible change is worse than a slightly brighter one.
    expect(deriveAccentVars('#000000')!.hover).toBe('rgb(30, 30, 30)');
    expect(deriveAccentVars('#FFFFFF')!.hover).toBe('rgb(225, 225, 225)');
  });

  it('lifts accent-as-text until it clears AA on the dark shell', () => {
    // Dark navy is illegible as link text on #171717 unlifted.
    const navy = deriveAccentVars('#001F3F')!;
    expect(ratio(parseRgb(navy.text), [0x17, 0x17, 0x17])).toBeGreaterThanOrEqual(4.5);
    // A light accent already passes and is used verbatim.
    expect(deriveAccentVars('#FFB900')!.text).toBe('rgb(255, 185, 0)');
  });

  it('returns null on malformed input instead of emitting broken CSS', () => {
    expect(deriveAccentVars('not-a-color')).toBeNull();
  });

  it('emits the accent as #RRGGBB — spec 21 pins the shape', () => {
    expect(deriveAccentVars('#00b7c3', 'dark')!.accent).toMatch(/^#[0-9A-F]{6}$/);
  });
});

// The derivation is a function of (accent, THEME): one accent still serves
// every theme, but the shell it is drawn against differs, and a value lifted
// for one shell is wrong on another. Every case below was live before the
// theme argument existed — the light column shipped the DARK lift.
describe('deriveAccentVars per theme', () => {
  const WHITE: [number, number, number] = [0xff, 0xff, 0xff];
  const DARK_SHELL: [number, number, number] = [0x17, 0x17, 0x17];
  const BLACK: [number, number, number] = [0, 0, 0];

  it('DARKENS accent-as-text for the light shell instead of lifting it', () => {
    // The bug this pins: cyan lifted for #171717 was then drawn on white at
    // 2.47:1 — every .text-blue-* consumer in the light theme.
    const dark = deriveAccentVars('#00B7C3', 'dark')!;
    const light = deriveAccentVars('#00B7C3', 'light')!;
    expect(ratio(parseRgb(dark.text), DARK_SHELL)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(parseRgb(light.text), WHITE)).toBeGreaterThanOrEqual(4.5);
    // Same accent, opposite directions.
    expect(relativeLuminance(parseRgb(light.text))).toBeLessThan(
      relativeLuminance(parseRgb(dark.text)),
    );
  });

  it('holds AAA for accent-as-text under high contrast', () => {
    for (const hex of ['#00B7C3', '#0078D4', '#001F3F', '#FFB900']) {
      const hc = deriveAccentVars(hex, 'high-contrast')!;
      expect(ratio(parseRgb(hc.text), BLACK)).toBeGreaterThanOrEqual(7);
    }
  });

  it('floors the ACCENT itself against the contrast theme, and leaves it alone elsewhere', () => {
    // A user's system accent is arbitrary: navy on black is 1.6:1 and simply
    // is not there. Under high contrast the theme's requirement wins.
    const navy = parseHex('#001F3F')!;
    expect(ratio(navy, BLACK)).toBeLessThan(3);
    const hc = deriveAccentVars('#001F3F', 'high-contrast')!;
    expect(ratio(parseHex(hc.accent)!, BLACK)).toBeGreaterThanOrEqual(3);
    // The washes and the foreground describe the accent actually shown.
    expect(hc.muted).toBe(
      `rgba(${parseHex(hc.accent)![0]}, ${parseHex(hc.accent)![1]}, ${parseHex(hc.accent)![2]}, 0.3)`,
    );
    // The ordinary themes take the system value verbatim — one accent.
    expect(deriveAccentVars('#001F3F', 'dark')!.accent).toBe('#001F3F');
    expect(deriveAccentVars('#001F3F', 'light')!.accent).toBe('#001F3F');
    // An accent that already clears the floor is untouched under HC too.
    expect(deriveAccentVars('#00B7C3', 'high-contrast')!.accent).toBe('#00B7C3');
  });

  it('keeps text-on-accent legible in every theme', () => {
    for (const theme of ['light', 'dark', 'high-contrast'] as const) {
      for (const hex of ['#00B7C3', '#0078D4', '#001F3F', '#FFB900', '#000000', '#FFFFFF']) {
        const vars = deriveAccentVars(hex, theme)!;
        const fg = vars.fg === '#ffffff' ? WHITE : BLACK;
        expect(ratio(fg, parseHex(vars.accent)!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
