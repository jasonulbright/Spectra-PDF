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
});
