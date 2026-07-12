/**
 * Accent-derived theming values. Windows accents span dark blues through
 * light yellows, so every derived value has to be direction-aware: text
 * that stays white fails contrast on light accents, and a flat lighten
 * makes hover invisible on them. Pure math — unit-tested.
 */

export interface AccentVars {
  /** The accent itself, as given ("#RRGGBB"). */
  accent: string;
  /** Hover variant — lightened for dark accents, darkened for light ones. */
  hover: string;
  /** 30% alpha wash for selected/active fills. */
  muted: string;
  /** 20% alpha wash for subtle fills. */
  subtle: string;
  /** Text color that keeps contrast on the accent surface. */
  fg: string;
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

// Above this the accent is light enough that white text loses contrast
// (Windows itself switches to dark text there — yellow, spring green);
// saturated mid-tones (default blue, violet, red) stay well below it.
const LIGHT_ACCENT_LUMINANCE = 0.4;

export function deriveAccentVars(hex: string): AccentVars | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const light = relativeLuminance(rgb) > LIGHT_ACCENT_LUMINANCE;
  const shift = light ? -30 : 30;
  const nudge = (v: number) => Math.max(0, Math.min(255, v + shift));
  return {
    accent: hex,
    hover: `rgb(${nudge(r)}, ${nudge(g)}, ${nudge(b)})`,
    muted: `rgba(${r}, ${g}, ${b}, 0.3)`,
    subtle: `rgba(${r}, ${g}, ${b}, 0.2)`,
    fg: light ? '#1a1a1a' : '#ffffff',
  };
}
