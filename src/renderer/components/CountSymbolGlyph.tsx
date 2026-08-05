import React, { useSyncExternalStore } from 'react';
import { symbolById, type SymbolPart } from '../lib/count-marks';
import { getSymbolSets, subscribeSymbolSets, symbolParts } from '../lib/symbol-library';

// A vector symbol as an inline SVG.
//
// It draws the SAME unit-square parts `pdfx-build` turns into path operators
// for the annotation's appearance, so the picker, the page and the printed
// sheet cannot show three different markers. Its own module because four
// surfaces need it (the Takeoff panel, the secondary toolbar's group picker,
// the symbol palette, and the comment list) and none of them should have to
// import another surface to get it.
//
// Slice D widened the resolution rather than the API: an id is looked up in
// the whole symbol REGISTRY (built-in markers, the built-in AEC set, and every
// imported set), and an explicit `parts` wins over any lookup — that is how an
// annotation carrying its own geometry draws correctly on a machine that never
// imported the set it came from.

export function CountSymbolGlyph({
  symbol,
  parts,
  color,
  size = 16,
}: {
  symbol?: string;
  /** The geometry, when the caller already holds it (an annotation's carried
   * snapshot). Beats the registry lookup. */
  parts?: readonly SymbolPart[];
  color: string;
  size?: number;
}): React.JSX.Element {
  // Re-render when a set is imported or removed: a group's marker can be a
  // symbol that only exists after an import.
  useSyncExternalStore(subscribeSymbolSets, getSymbolSets, getSymbolSets);
  const resolved = parts ?? symbolParts(symbol) ?? symbolById(symbol).parts;
  return (
    <svg width={size} height={size} viewBox="0 0 1 1" aria-hidden="true">
      {resolved.map((part, i) =>
        part.kind === 'circle' ? (
          <circle
            key={i}
            cx={part.cx}
            cy={part.cy}
            r={part.r}
            fill="none"
            stroke={color}
            strokeWidth={0.08}
          />
        ) : (
          <polyline
            key={i}
            points={polyPoints(part.points, part.closed)}
            fill="none"
            stroke={color}
            strokeWidth={0.08}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </svg>
  );
}

/** Unit-square points as an SVG `points` list, closing the ring for a closed
 * part (which `polyline` does not do by itself). */
function polyPoints(points: readonly number[], closed: boolean): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push(`${points[i]},${points[i + 1]}`);
  if (closed && out.length > 0) out.push(out[0]);
  return out.join(' ');
}
