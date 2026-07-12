import { type ZoomTransform } from 'd3-zoom';

export type Extent = [[number, number], [number, number]];

// d3-zoom's default constrain, with one change: when the content fits inside
// the viewport on an axis (`d1 > d0` — the inverted-extent span exceeds the
// content span), the default applies NO constraint on that axis, so extreme
// zoom-out let a pan fling the whole workspace off-screen with only "Fit" to
// recover (PDFx-inherited; punchlist polish item). The fitted case now
// CENTER-clamps instead — d3's own documented centered-constrain variant —
// so a smaller-than-viewport workspace stays centered on that axis while
// larger-than-viewport panning keeps the ordinary edge clamping.
export function reversibleConstrain(
  transform: ZoomTransform,
  extent: Extent,
  translateExtent: Extent,
): ZoomTransform {
  const dx0 = transform.invertX(extent[0][0]) - translateExtent[0][0];
  const dx1 = transform.invertX(extent[1][0]) - translateExtent[1][0];
  const dy0 = transform.invertY(extent[0][1]) - translateExtent[0][1];
  const dy1 = transform.invertY(extent[1][1]) - translateExtent[1][1];
  return transform.translate(
    dx1 > dx0 ? (dx0 + dx1) / 2 : Math.min(0, dx0) || Math.max(0, dx1),
    dy1 > dy0 ? (dy0 + dy1) / 2 : Math.min(0, dy0) || Math.max(0, dy1),
  );
}
