import React from 'react';
import type { HighlightRect } from '../../lib/flattener';

// What a flatten would do to this page, drawn on the page itself: the regions
// that will rasterize, and the objects that put them there.
//
// It draws and claims nothing — no pointer handlers at all — because the
// preview is a report. A user decides what to rasterize by seeing what would
// be rasterized, and a frame that could be dragged would say the opposite.

export default function FlattenRegionOverlay({
  rects,
}: {
  rects: readonly HighlightRect[];
}): React.ReactElement | null {
  if (rects.length === 0) return null;
  return (
    <>
      {rects.map((rect) => (
        <div
          key={rect.key}
          className={`page-flatten-mark is-${rect.category.replace('_', '-')}`}
          data-testid={`flatten-mark-${rect.key}`}
          data-flatten-category={rect.category}
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
          }}
        />
      ))}
    </>
  );
}
