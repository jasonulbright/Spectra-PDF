// A column of byte counts is written in ONE unit, chosen for the column.
//
// Per-value formatting is right for a lone figure and wrong for a table: the
// space audit shipped a size column reading 6.0 KB / 1.1 KB / 280 bytes /
// 128 bytes / 70 bytes / 0 bytes, which cannot be scanned or ranked without
// converting every row by hand — the one job a size column has.
import { describe, it, expect, vi } from 'vitest';

// The formatter goes through the i18n layer (the unit lives in the catalog
// string, and the number through Intl). The catalog is not what is under test
// here — the UNIT CHOICE and the rounding are — so the seam is stubbed with a
// shape that makes both readable in the assertion.
vi.mock('../src/renderer/i18n', () => ({
  tChrome: (key: string, vars?: Record<string, unknown>) =>
    key === 'dialog.props.kilobytes'
      ? `${String(vars?.size)} KB`
      : key === 'dialog.props.megabytes'
        ? `${String(vars?.size)} MB`
        : 'unknown',
  tChromeCount: (_key: string, n: number) => `${n} bytes`,
  tNumber: (n: number, opts?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat('en-US', opts).format(n),
}));

const { byteColumnUnit, formatBytesIn } = await import('../src/renderer/lib/format-bytes');

describe('byteColumnUnit', () => {
  it('takes the unit the LARGEST value would choose', () => {
    // The big rows are what a space audit is read for, so they set the scale.
    expect(byteColumnUnit([70, 128, 280, 1150, 6200])).toBe('kilobytes');
    expect(byteColumnUnit([70, 128, 280])).toBe('bytes');
    expect(byteColumnUnit([70, 4 * 1024 * 1024])).toBe('megabytes');
  });

  it('ignores holes and survives an empty column', () => {
    expect(byteColumnUnit([null, null])).toBe('bytes');
    expect(byteColumnUnit([])).toBe('bytes');
    expect(byteColumnUnit([null, 2048, null])).toBe('kilobytes');
  });

  it('switches at the unit boundary, not near it', () => {
    expect(byteColumnUnit([1023])).toBe('bytes');
    expect(byteColumnUnit([1024])).toBe('kilobytes');
    expect(byteColumnUnit([1024 * 1024 - 1])).toBe('kilobytes');
    expect(byteColumnUnit([1024 * 1024])).toBe('megabytes');
  });
});

describe('formatBytesIn', () => {
  it('writes every row of one column in that column’s unit', () => {
    const rows = [6200, 1150, 280, 128, 70, 0];
    const unit = byteColumnUnit(rows);
    const written = rows.map((n) => formatBytesIn(n, unit));
    // The property that matters: one unit, top to bottom.
    expect(written.every((s) => s.endsWith(' KB'))).toBe(true);
  });

  it('never rounds a non-zero row to zero', () => {
    // A row that reclaims 70 bytes reclaims something. Collapsing it to
    // "0.0 KB" is the table reporting a wrong result, not a tidier one.
    for (const n of [70, 12, 1]) {
      const written = formatBytesIn(n, 'kilobytes');
      expect(written, `${n} bytes`).not.toMatch(/^0(\.0+)? /);
    }
    expect(formatBytesIn(0, 'kilobytes')).toBe('0.0 KB');
  });

  it('keeps one decimal place once the value is at the unit’s own scale', () => {
    expect(formatBytesIn(6200, 'kilobytes')).toBe('6.1 KB');
    expect(formatBytesIn(1024 * 1024 * 3.5, 'megabytes')).toBe('3.5 MB');
  });

  it('writes a bytes column as whole bytes', () => {
    expect(formatBytesIn(280, 'bytes')).toBe('280 bytes');
    expect(formatBytesIn(0, 'bytes')).toBe('0 bytes');
  });

  it('reports an absent measurement rather than printing it as zero', () => {
    expect(formatBytesIn(null, 'kilobytes')).toBe('unknown');
  });
});
