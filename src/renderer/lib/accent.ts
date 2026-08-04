/**
 * Accent-derived theming values. Windows accents span dark blues through
 * light yellows, so every derived value has to be direction-aware: text
 * that stays white fails contrast on light accents, and a flat lighten
 * makes hover invisible on them. Pure math — unit-tested.
 *
 * The derivation is a function of (accent, THEME), not of the accent alone.
 * One accent still serves every theme (owner direction 2026-08-02), but the
 * shell it is drawn against is not the same in all three: an accent lifted
 * for the dark shell is the WRONG direction on white, and the contrast theme
 * needs a floor no arbitrary system accent is guaranteed to clear. Deriving
 * per theme is what keeps "one accent" from meaning "one derivation" — the
 * theme conditions the accent, the accent does not condition the theme.
 */

/** The three explicit shells `data-theme` can carry. */
export type ThemeName = 'light' | 'dark' | 'high-contrast';

export interface AccentVars {
  /** The accent itself, as "#RRGGBB" — the given value in the ordinary
   * themes, lifted to the contrast theme's floor under high contrast. */
  accent: string;
  /** Hover variant — shifted AWAY from the text color (darker under white
   * text, lighter under black), so the hover state never has LESS contrast
   * than rest. A same-direction shift did: the default Windows blue sits
   * just under the white-text ceiling, and lightening it pushed white text
   * to 3.1:1 on hover. */
  hover: string;
  /** 30% alpha wash for selected/active fills. */
  muted: string;
  /** 20% alpha wash for subtle fills. */
  subtle: string;
  /** Text color that keeps contrast on the accent surface. */
  fg: string;
  /** The accent drawn ON the shell — as text, and as the focus indicator.
   * Moved toward whichever end of the range the shell is not: lightened on
   * the dark shells (navy and maroon are illegible on #171717 unlifted),
   * DARKENED on the light one (the dark-shell lift is the exact wrong
   * direction on white — it shipped cyan at 2.47:1 there). */
  text: string;
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

/** WCAG contrast ratio between two sRGB colors. */
export function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text-color decision is pure WCAG arithmetic, not "when Windows flips":
 * white text holds 4.5:1 up to background luminance 0.1833, black text holds
 * it from 0.175 — the bands overlap, so one threshold inside the overlap
 * gives every accent a passing side. 0.182 keeps white exactly as long as
 * white passes (the default Windows blue, L≈0.1819, stays white at 4.53:1;
 * cyan #00B7C3, L≈0.378, flips to black — it shipped at 2.45:1 under the old
 * 0.4 threshold, which was tuned to Windows' own flip point and left the
 * brighter half of that range sub-AA). The dark side is PURE black: with a
 * softened dark (#1a1a1a) there is a luminance band where neither text color
 * reaches 4.5:1.
 */
const CONTRAST_FG_LUMINANCE = 0.182;

/** What each theme paints behind accent-colored text and focus indicators:
 * the dark shell (#171717), the light shell (#ffffff), the contrast theme's
 * pure black. */
const SHELL: Record<ThemeName, [number, number, number]> = {
  dark: [0x17, 0x17, 0x17],
  light: [0xff, 0xff, 0xff],
  'high-contrast': [0x00, 0x00, 0x00],
};

/** Accent-as-text floor per theme: AA on the ordinary shells, AAA under high
 * contrast — a contrast theme that only reached AA would not be one. */
const TEXT_RATIO: Record<ThemeName, number> = {
  dark: 4.5,
  light: 4.5,
  'high-contrast': 7,
};

/** The contrast theme's floor for the accent AS A SURFACE/LINE (WCAG 1.4.11
 * non-text contrast) against its black shell. A user's system accent is
 * arbitrary — navy at 1.6:1 on black simply disappears — so under high
 * contrast the THEME's requirement wins over the raw system value. */
const HIGH_CONTRAST_ACCENT_RATIO = 3;

const clamp = (v: number) => Math.max(0, Math.min(255, v));

const toHex = (rgb: [number, number, number]) =>
  `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/**
 * Step a color toward white or black — away from `shell` — until it clears
 * `ratio` against it. Bounded: 17 steps of 15 span black to white, and a
 * clamped step ends the walk, so an unreachable target degrades to the
 * highest-contrast value available instead of looping.
 */
function liftForShell(
  rgb: [number, number, number],
  shell: [number, number, number],
  ratio: number,
): [number, number, number] {
  const step = relativeLuminance(shell) > 0.5 ? -15 : 15;
  let out = rgb;
  while (contrastRatio(out, shell) < ratio) {
    const moved: [number, number, number] = [
      clamp(out[0] + step),
      clamp(out[1] + step),
      clamp(out[2] + step),
    ];
    if (moved[0] === out[0] && moved[1] === out[1] && moved[2] === out[2]) break;
    out = moved;
  }
  return out;
}

export function deriveAccentVars(hex: string, theme: ThemeName = 'dark'): AccentVars | null {
  const parsed = parseHex(hex);
  if (!parsed) return null;
  const shell = SHELL[theme] ?? SHELL.dark;

  // Under high contrast the accent itself is floored against the black shell
  // BEFORE anything derives from it, so the washes, the hover and the
  // foreground all describe the accent the user will actually see.
  const rgb =
    theme === 'high-contrast'
      ? liftForShell(parsed, shell, HIGH_CONTRAST_ACCENT_RATIO)
      : parsed;
  const [r, g, b] = rgb;
  const whiteFg = relativeLuminance(rgb) <= CONTRAST_FG_LUMINANCE;

  // Hover: away from the text color; if the accent is already at that end
  // of the range (pure black under white text), shift the other way — a
  // hover with no visible change is worse than a slightly brighter one.
  const away = whiteFg ? -30 : 30;
  let hover: [number, number, number] = [clamp(r + away), clamp(g + away), clamp(b + away)];
  if (hover[0] === r && hover[1] === g && hover[2] === b) {
    hover = [clamp(r - away), clamp(g - away), clamp(b - away)];
  }

  const text = liftForShell(rgb, shell, TEXT_RATIO[theme] ?? TEXT_RATIO.dark);

  return {
    accent: toHex(rgb),
    hover: `rgb(${hover[0]}, ${hover[1]}, ${hover[2]})`,
    muted: `rgba(${r}, ${g}, ${b}, 0.3)`,
    subtle: `rgba(${r}, ${g}, ${b}, 0.2)`,
    fg: whiteFg ? '#ffffff' : '#000000',
    text: `rgb(${text[0]}, ${text[1]}, ${text[2]})`,
  };
}
