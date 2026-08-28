import { tChrome, tChromeCount, tNumber } from '../i18n';

/** A byte count as text, in the reader's language.
 *
 * Numbers go through Intl — the decimal separator and the digit grouping are
 * locale properties, never hand-rolled — and the unit lives inside the
 * catalog string rather than being appended to it. */
export function formatBytes(n: number | null): string {
  if (n === null) return tChrome('dialog.props.unknown');
  if (n < 1024) return tChromeCount('dialog.props.bytes', n);
  const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (n < 1024 * 1024) return tChrome('dialog.props.kilobytes', { size: tNumber(n / 1024, opts) });
  return tChrome('dialog.props.megabytes', { size: tNumber(n / (1024 * 1024), opts) });
}

/** The three units a byte column can be written in. */
export type ByteUnit = 'bytes' | 'kilobytes' | 'megabytes';

/** The ONE unit a column of byte counts is written in: the unit the largest
 * value in it would choose on its own.
 *
 * Per-value formatting is right for a lone figure and wrong for a column. A
 * column that reads 6.0 KB / 1.1 KB / 280 bytes / 128 bytes / 70 bytes / 0
 * bytes cannot be scanned or compared at all: the reader has to convert every
 * row before two of them can be ranked, which is the one job a size column
 * has. Choosing off the largest value keeps the biggest rows — the ones a
 * space audit is read for — at a readable magnitude. */
export function byteColumnUnit(values: readonly (number | null)[]): ByteUnit {
  const max = values.reduce<number>((a, v) => (v !== null && v > a ? v : a), 0);
  if (max >= 1024 * 1024) return 'megabytes';
  if (max >= 1024) return 'kilobytes';
  return 'bytes';
}

/** One byte count written in a unit chosen for its whole column.
 *
 * Sub-unit values keep a decimal place rather than collapsing to "0.0": a row
 * that reclaims 70 bytes reclaims something, and rounding it to zero is the
 * table reporting a wrong result, not a tidier one. */
export function formatBytesIn(n: number | null, unit: ByteUnit): string {
  if (n === null) return tChrome('dialog.props.unknown');
  if (unit === 'bytes') return tChromeCount('dialog.props.bytes', n);
  const divisor = unit === 'kilobytes' ? 1024 : 1024 * 1024;
  const scaled = n / divisor;
  // Below the unit's own resolution, show enough places to keep a non-zero
  // value non-zero — never more than three.
  const places = n === 0 || scaled >= 0.1 ? 1 : scaled >= 0.01 ? 2 : 3;
  const size = tNumber(scaled, { minimumFractionDigits: places, maximumFractionDigits: places });
  return tChrome(unit === 'kilobytes' ? 'dialog.props.kilobytes' : 'dialog.props.megabytes', {
    size,
  });
}
