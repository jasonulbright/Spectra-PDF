// Accent derivation (Phase 3b): Windows accents range from dark blues to
// light yellows, so text-on-accent and the hover variant must be
// luminance-aware — white text and a flat lighten both break on light
// accents.
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

  it('ranks the default Windows blue as dark and accent yellow as light', () => {
    expect(relativeLuminance([0, 120, 212])).toBeLessThan(0.4); // #0078D4
    expect(relativeLuminance([255, 185, 0])).toBeGreaterThan(0.4); // #FFB900
  });
});

describe('deriveAccentVars', () => {
  it('keeps white text and lightens hover on dark accents', () => {
    const vars = deriveAccentVars('#0078D4')!;
    expect(vars.fg).toBe('#ffffff');
    expect(vars.hover).toBe('rgb(30, 150, 242)');
    expect(vars.muted).toBe('rgba(0, 120, 212, 0.3)');
    expect(vars.subtle).toBe('rgba(0, 120, 212, 0.2)');
  });

  it('flips to dark text and darkens hover on light accents', () => {
    // Windows "Gold" — white text fails contrast here and a flat lighten
    // would clamp into invisibility.
    const vars = deriveAccentVars('#FFB900')!;
    expect(vars.fg).toBe('#1a1a1a');
    expect(vars.hover).toBe('rgb(225, 155, 0)');
  });

  it('clamps the hover nudge at the channel bounds', () => {
    expect(deriveAccentVars('#000000')!.hover).toBe('rgb(30, 30, 30)');
    expect(deriveAccentVars('#FFFFFF')!.hover).toBe('rgb(225, 225, 225)');
  });

  it('returns null on malformed input instead of emitting broken CSS', () => {
    expect(deriveAccentVars('not-a-color')).toBeNull();
  });
});
