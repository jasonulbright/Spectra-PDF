import { zoomIdentity } from 'd3-zoom';
import { MIN_SCALE, FIT_MARGIN, FIT_MAX_SCALE, FIT_TOP_PAD } from './zoom-constants';

interface Dims {
  contentWidth: number;
  contentHeight: number;
  slotHeight: number;
}

// Fit-to-width. Row wrapping caps content width (layout.ts MAX_ROW_WIDTH), so
// width-fit keeps pages legible regardless of document length; tall content
// overflows downward and scrolls like a document. Never scales past 1:1 —
// blowing a single page up to fill a 4K window isn't a useful default.
export function computeFitTransform(
  vp: HTMLDivElement,
  dims: Dims,
): ReturnType<typeof zoomIdentity.translate> {
  const W = vp.clientWidth;
  const H = vp.clientHeight;
  const { contentWidth: cw, contentHeight: ch } = dims;
  const k = Math.max(MIN_SCALE, Math.min(FIT_MAX_SCALE, (W * FIT_MARGIN) / cw));
  const tx = (W - cw * k) / 2;
  // Center short content vertically; top-align overflowing content so the
  // first document is what the fit lands on.
  const scaledH = ch * k;
  const ty = scaledH <= H ? (H - scaledH) / 2 : FIT_TOP_PAD;
  return zoomIdentity.translate(tx, ty).scale(k);
}
