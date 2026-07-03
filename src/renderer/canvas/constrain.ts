import { type ZoomTransform } from 'd3-zoom';

export type Extent = [[number, number], [number, number]];

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
    dx1 > dx0 ? 0 : Math.min(0, dx0) || Math.max(0, dx1),
    dy1 > dy0 ? 0 : Math.min(0, dy0) || Math.max(0, dy1),
  );
}
