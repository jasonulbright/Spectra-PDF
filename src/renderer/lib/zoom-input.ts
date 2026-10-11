// Parses what a reader types into the status bar's zoom box. Pure: no DOM,
// no app state.

export const ZOOM_PERCENT_MIN = 1;
export const ZOOM_PERCENT_MAX = 6400;

// The zero of every decimal-digit block in Unicode that a locale's
// numbering system can name. A digit's value is its offset from its zero.
const DIGIT_ZEROS: readonly number[] = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66,
  0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946,
  0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
  0xa9f0, 0xaa50, 0xabf0, 0xff10,
];

const PERCENT_SIGNS = new Set(['%', '٪', '﹪', '％']);

function digitValue(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  for (const zero of DIGIT_ZEROS) {
    if (cp >= zero && cp <= zero + 9) return cp - zero;
  }
  return null;
}

interface Separators {
  decimal: string;
  group: string;
  percent: string;
}

function separatorsFor(locale: string): Separators {
  const read = (tag: string): Separators => {
    const number = new Intl.NumberFormat(tag, { useGrouping: true }).formatToParts(12345.6);
    const percent = new Intl.NumberFormat(tag, { style: 'percent' }).formatToParts(1);
    return {
      decimal: number.find((p) => p.type === 'decimal')?.value ?? '.',
      group: number.find((p) => p.type === 'group')?.value ?? ',',
      percent: percent.find((p) => p.type === 'percentSign')?.value ?? '%',
    };
  };
  try {
    return read(locale);
  } catch {
    // An Intl constructor throws RangeError on a tag that is not BCP 47.
    return read('en');
  }
}

/**
 * The zoom a typed entry asks for, in percent of actual size, clamped to
 * 1..6400; null when the entry is not a number.
 *
 * Accepted: "125", "125%", "125 %", the percent sign before the number, the
 * locale's own digits, decimal separator and group separator. A full stop
 * that the locale does not use for grouping reads as a decimal separator. A
 * sign is refused.
 */
export function parseZoomPercentInput(text: string, locale: string): number | null {
  const sep = separatorsFor(locale);
  let body = '';
  for (const ch of text) {
    if (/\s/u.test(ch) || /\p{Cf}/u.test(ch)) continue;
    if (PERCENT_SIGNS.has(ch) || ch === sep.percent) continue;
    if (ch === sep.group) continue;
    const d = /\p{Nd}/u.test(ch) ? digitValue(ch) : null;
    if (d !== null) {
      body += String(d);
      continue;
    }
    if (ch === sep.decimal) {
      body += '.';
      continue;
    }
    if (ch === '.') {
      body += '.';
      continue;
    }
    return null;
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(body)) return null;
  // A digit string past the double range reads as Infinity, which clamps.
  const value = Number(body);
  return Math.min(ZOOM_PERCENT_MAX, Math.max(ZOOM_PERCENT_MIN, value));
}
