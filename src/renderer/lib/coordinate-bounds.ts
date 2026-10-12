// An annotation's coordinate arrays (/QuadPoints, /Vertices, /InkList) have no
// size limit, and spreading one into Math.min or Math.max passes every value
// as an argument: past the engine's argument limit that throws and fails the
// whole import or commit. These fold instead, with the same result as the
// spread call, NaN and an empty list included.

export function minOf(values: ArrayLike<number>): number {
  let out = Infinity;
  for (let i = 0; i < values.length; i++) out = Math.min(out, values[i]);
  return out;
}

export function maxOf(values: ArrayLike<number>): number {
  let out = -Infinity;
  for (let i = 0; i < values.length; i++) out = Math.max(out, values[i]);
  return out;
}
