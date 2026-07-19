import React, { useEffect, useRef, useState } from 'react';
import type { EditImageTransformCtx } from '../../lib/edit-images';
import {
  applyMove,
  applyResizeCorner,
  applyRotate,
  displayQuad,
  displayToUser,
  userCenter,
  userToDisplay,
  type Mat,
} from '../../lib/image-transform';

// Phase 9.C1 — direct-manipulation transform of the selected image placement.
// The outline + move body are an SVG polygon (crisp via non-scaling-stroke,
// correct for a rotated placement); the four corner handles + rotate handle are
// HTML dots. Every gesture composes from the COMMITTED matrix and computes in
// USER space (rotation-agnostic), previews live via CSS, and commits the
// absolute matrix M' on release. Pointer drags use window listeners (the canvas
// drag invariant — synthetic pointermove doesn't deliver in the WebView).

interface Props {
  ctx: EditImageTransformCtx;
  /** Pending in-memory page rotation applied at render (like every overlay). */
  pendingRotate: number;
  onCommit: (matrix: number[]) => void;
}

type Compute = (startUser: [number, number], curUser: [number, number], base: Mat) => Mat;

const matEq = (a: Mat, b: Mat): boolean => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

export default function ImageTransformOverlay({
  ctx,
  pendingRotate,
  onCommit,
}: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Mat | null>(null);
  const active = useRef(false);
  // Teardown for an in-flight gesture, so an unmount mid-drag (e.g. a keyboard
  // tool switch) cancels it — a stale window pointerup must not commit against
  // a document the user has navigated away from (the usePageDrag precedent).
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  const base = ctx.matrix as Mat;
  const m = preview ?? base;
  const { box, bakedRotate } = ctx;

  const quad = displayQuad(m, box, bakedRotate, pendingRotate);
  const [ucx, ucy] = userCenter(m);
  const center = userToDisplay(ucx, ucy, box, bakedRotate, pendingRotate);
  // Rotate handle: outward from center past the top edge midpoint (local y=1 =
  // corners TL(3), TR(2)).
  const topMid: [number, number] = [(quad[2][0] + quad[3][0]) / 2, (quad[2][1] + quad[3][1]) / 2];
  const rotateHandle: [number, number] = [
    topMid[0] + (topMid[0] - center[0]) * 0.3,
    topMid[1] + (topMid[1] - center[1]) * 0.3,
  ];

  const normPointer = (clientX: number, clientY: number): [number, number] => {
    const r = rootRef.current!.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  };

  const start = (e: React.PointerEvent, compute: Compute): void => {
    if (ctx.busy || active.current) return;
    e.preventDefault();
    e.stopPropagation();
    active.current = true;
    const [su, sv] = normPointer(e.clientX, e.clientY);
    const startUser = displayToUser(su, sv, box, bakedRotate, pendingRotate);
    let latest = base;
    const onMove = (ev: PointerEvent): void => {
      const [u, v] = normPointer(ev.clientX, ev.clientY);
      const curUser = displayToUser(u, v, box, bakedRotate, pendingRotate);
      latest = compute(startUser, curUser, base);
      setPreview(latest);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      active.current = false;
      cancelRef.current = null;
      setPreview(null);
      // Commit only a NUMERIC change — a bare click, or a drag that returns to
      // the start pixel, must not churn an undo entry (reference-!== fired on
      // the returned-to-start case; matEq is the fix).
      if (commit && !matEq(latest, base)) onCommit([...latest]);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelRef.current = onCancel; // unmount mid-drag → cancel, don't commit
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const moveGesture: Compute = (s, c, b) => applyMove(b, c[0] - s[0], c[1] - s[1]);
  const resizeGesture = (corner: number): Compute => (_s, c, b) =>
    applyResizeCorner(b, corner, c[0], c[1]) ?? b;
  const rotateGesture: Compute = (s, c, b) => {
    const [cx, cy] = userCenter(b);
    return applyRotate(b, Math.atan2(c[1] - cy, c[0] - cx) - Math.atan2(s[1] - cy, s[0] - cx));
  };

  const pts = quad.map((p) => `${p[0] * 100},${p[1] * 100}`).join(' ');
  const dot = (p: [number, number]): React.CSSProperties => ({
    left: `${p[0] * 100}%`,
    top: `${p[1] * 100}%`,
  });

  return (
    <div ref={rootRef} className="page-imgtx" data-testid={`img-transform-${ctx.index}`}>
      <svg className="page-imgtx-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line
          x1={topMid[0] * 100}
          y1={topMid[1] * 100}
          x2={rotateHandle[0] * 100}
          y2={rotateHandle[1] * 100}
          className="page-imgtx-arm"
          vectorEffect="non-scaling-stroke"
        />
        <polygon
          points={pts}
          className="page-imgtx-quad"
          vectorEffect="non-scaling-stroke"
          onPointerDown={(e) => start(e, moveGesture)}
        />
      </svg>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="page-imgtx-handle"
          data-testid={`img-transform-handle-${i}`}
          style={dot(quad[i])}
          onPointerDown={(e) => start(e, resizeGesture(i))}
        />
      ))}
      <div
        className="page-imgtx-rotate"
        data-testid="img-transform-rotate"
        style={dot(rotateHandle)}
        onPointerDown={(e) => start(e, rotateGesture)}
      />
    </div>
  );
}
