/**
 * Accent-derived theming values. Windows accents span dark blues through
 * light yellows, so every derived value has to be direction-aware: text
 * that stays white fails contrast on light accents, and a flat lighten
 * makes hover invisible on them. Pure math — unit-tested.
 */

export interface AccentVars {
  /** The accent itself, as given ("#RRGGBB"). */
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
  /** The accent used AS text on the dark shell (#171717): lightened until
   * it reaches AA there. Light accents pass as-is; dark ones (navy, maroon)
   * are illegible unlifted. */
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

/** AA floor for accent-as-text on the dark shell (#171717, L 0.0144):
 * (L + 0.05) / 0.0644 >= 4.5 needs L >= 0.24. */
const DARK_SHELL_TEXT_LUMINANCE = 0.24;

const clamp = (v: number) => Math.max(0, Math.min(255, v));

export function deriveAccentVars(hex: string): AccentVars | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
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

  // Accent as TEXT on the dark shell: lift in steps until it clears AA
  // there. Bounded — 17 steps of +15 reach white from black.
  let text: [number, number, number] = [r, g, b];
  while (relativeLuminance(text) < DARK_SHELL_TEXT_LUMINANCE) {
    const lifted: [number, number, number] = [
      clamp(text[0] + 15),
      clamp(text[1] + 15),
      clamp(text[2] + 15),
    ];
    if (lifted[0] === text[0] && lifted[1] === text[1] && lifted[2] === text[2]) break;
    text = lifted;
  }

  return {
    accent: hex,
    hover: `rgb(${hover[0]}, ${hover[1]}, ${hover[2]})`,
    muted: `rgba(${r}, ${g}, ${b}, 0.3)`,
    subtle: `rgba(${r}, ${g}, ${b}, 0.2)`,
    fg: whiteFg ? '#ffffff' : '#000000',
    text: `rgb(${text[0]}, ${text[1]}, ${text[2]})`,
  };
}
