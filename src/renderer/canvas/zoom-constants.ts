export const MIN_SCALE = 0.02;
export const MAX_SCALE = 90;
export const PAN_MARGIN = 3;
export const FIT_MARGIN = 0.86;
export const FIT_MAX_SCALE = 1;
export const FIT_TOP_PAD = 24;
// A full 50 CSS-pixel wheel step is a 10% zoom change. Smaller trackpad
// deltas retain their continuous, proportional feel.
export const WHEEL_ZOOM_SPEED = 0.00275;
export const BUTTON_ZOOM_FACTOR = 1.35;

/** Multiplicative Ctrl/Meta-wheel zoom for a CSS-pixel delta. */
export function wheelZoomFactor(deltaPx: number): number {
  const clamped = Math.max(-50, Math.min(50, deltaPx));
  return Math.pow(2, -clamped * WHEEL_ZOOM_SPEED);
}
