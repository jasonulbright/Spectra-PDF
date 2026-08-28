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

/** Places needed to keep the SMALLEST non-zero value in a column non-zero,
 *  in that column's unit — never more than three.
 *
 * Precision, like the unit, is a property of the COLUMN. Deciding it per value
 * put `0.000 MB` next to `0.0 MB` on adjacent rows, which reads as two
 * different measurements rather than as one column; deciding it once for the
 * column keeps every figure at the same resolution while still refusing to
 * round a row that reclaimed something down to zero. */
export function byteColumnPlaces(values: readonly (number | null)[], unit: ByteUnit): number {
  if (unit === 'bytes') return 0;
  const divisor = unit === 'kilobytes' ? 1024 : 1024 * 1024;
  let places = 1;
  for (const v of values) {
    if (v === null || v === 0) continue;
    const scaled = v / divisor;
    const need = scaled >= 0.1 ? 1 : scaled >= 0.01 ? 2 : 3;
    if (need > places) places = need;
  }
  return places;
}

/** One byte count written in a unit — and at a precision — chosen for its
 * whole column.
 *
 * Sub-unit values keep enough decimal places to stay non-zero: a row that
 * reclaims 70 bytes reclaims something, and rounding it to zero is the table
 * reporting a wrong result, not a tidier one. Pass `places` from
 * `byteColumnPlaces` so every row in a column agrees; omitted, the value
 * decides for itself, which is right for a lone figure. */
export function formatBytesIn(n: number | null, unit: ByteUnit, places?: number): string {
  if (n === null) return tChrome('dialog.props.unknown');
  if (unit === 'bytes') return tChromeCount('dialog.props.bytes', n);
  const divisor = unit === 'kilobytes' ? 1024 : 1024 * 1024;
  const scaled = n / divisor;
  const digits = places ?? (n === 0 || scaled >= 0.1 ? 1 : scaled >= 0.01 ? 2 : 3);
  const size = tNumber(scaled, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return tChrome(unit === 'kilobytes' ? 'dialog.props.kilobytes' : 'dialog.props.megabytes', {
    size,
  });
}
