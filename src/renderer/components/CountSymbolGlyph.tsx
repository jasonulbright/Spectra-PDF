import React from 'react';
import { symbolById } from '../lib/count-marks';

// N11 slice C — a count symbol as an inline SVG.
//
// It draws the SAME unit-square parts `pdfx-build` turns into path operators
// for the annotation's appearance, so the picker, the page and the printed
// sheet cannot show three different markers. Its own module because three
// surfaces need it (the Takeoff panel, the secondary toolbar's group picker,
// and slice D's symbol palette) and none of them should have to import
// another surface to get it.

export function CountSymbolGlyph({
  symbol,
  color,
  size = 16,
}: {
  symbol: string;
  color: string;
  size?: number;
}): React.JSX.Element {
  const s = symbolById(symbol);
  return (
    <svg width={size} height={size} viewBox="0 0 1 1" aria-hidden="true">
      {s.parts.map((part, i) =>
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
