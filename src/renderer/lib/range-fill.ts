/**
 * The filled share of a range input's track, as a CSS percentage. Bounds that
 * are absent take the HTML defaults (0 and 100); a value outside them clamps
 * the way the element clamps it; an empty or reversed range reads as empty.
 */
export function rangeFillPercent(
  value: number | string | readonly string[] | undefined,
  min: number | string | undefined,
  max: number | string | undefined,
): string {
  const lo = min === undefined || min === '' ? 0 : Number(min);
  const hi = max === undefined || max === '' ? 100 : Number(max);
  const v = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(v) || hi <= lo) return '0%';
  const share = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo);
  return `${Math.round(share * 10000) / 100}%`;
}
