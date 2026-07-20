import React, { useEffect, useRef, useState } from 'react';
import type { EditImageTransformCtx } from '../../lib/edit-images';
import {
  applyCropEdge,
  applyMove,
  applyResizeCorner,
  applyRotate,
  cropRectFromLocalPoints,
  displayQuad,
  displayToUser,
  invert,
  transformPoint,
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
//
// Phase 9.C3 — crop mode: when armed (toolbar toggle), the body drag draws a
// band in the image's own UNIT space instead of moving; on release the clamped
// unit rect commits to the engine's clip-based crop. Handles hide while armed
// (the quad is the crop canvas).
//
// Phase 9.C3-tail — crop re-edit: a placement whose LISTING carries a tool
// crop shows that rect as a dashed outline with four EDGE handles; dragging
// one commits the new ABSOLUTE unit rect (the engine collapse-replaces its
// own frames, so widening works). Author clips list null — no handles.

interface Props {
  ctx: EditImageTransformCtx;
  /** Pending in-memory page rotation applied at render (like every overlay). */
  pendingRotate: number;
  onCommit: (matrix: number[]) => void;
  /** 9.C3: crop mode armed — the body drag draws the crop band. */
  cropArmed: boolean;
  onCommitCrop: (rect: [number, number, number, number]) => void;
}

type Compute = (startUser: [number, number], curUser: [number, number], base: Mat) => Mat;

const matEq = (a: Mat, b: Mat): boolean => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

export default function ImageTransformOverlay({
  ctx,
  pendingRotate,
  onCommit,
  cropArmed,
  onCommitCrop,
}: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Mat | null>(null);
  const [cropBand, setCropBand] = useState<[number, number, number, number] | null>(null);
  // C3-tail: live preview of an edge-handle drag (null = show ctx.crop).
  const [cropPreview, setCropPreview] = useState<[number, number, number, number] | null>(null);
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

  // 9.C3 crop band: drag in the image's LOCAL unit space (pointer → user →
  // M⁻¹ → clamp), preview the band, commit the clamped rect on release.
  const startCrop = (e: React.PointerEvent): void => {
    if (ctx.busy || active.current) return;
    const inv = invert(base);
    if (!inv) return; // degenerate placement: nothing sane to crop
    e.preventDefault();
    e.stopPropagation();
    active.current = true;
    const toLocal = (clientX: number, clientY: number): [number, number] => {
      const [u, v] = normPointer(clientX, clientY);
      const [ux, uy] = displayToUser(u, v, box, bakedRotate, pendingRotate);
      const [lx, ly] = transformPoint(inv, ux, uy);
      return [Math.max(0, Math.min(1, lx)), Math.max(0, Math.min(1, ly))];
    };
    const s = toLocal(e.clientX, e.clientY);
    let latest: [number, number, number, number] | null = null;
    const onMove = (ev: PointerEvent): void => {
      const c = toLocal(ev.clientX, ev.clientY);
      latest = cropRectFromLocalPoints(s, c);
      // Preview even a below-min-size band (the user sees it forming);
      // only a valid rect commits.
      setCropBand([
        Math.min(s[0], c[0]),
        Math.min(s[1], c[1]),
        Math.max(s[0], c[0]),
        Math.max(s[1], c[1]),
      ]);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      active.current = false;
      cancelRef.current = null;
      setCropBand(null);
      if (commit && latest) onCommitCrop(latest);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelRef.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  // C3-tail: drag one crop edge in the image's local unit space; commit the
  // absolute rect on release (same wire as the band — the engine replaces).
  const startCropEdge = (e: React.PointerEvent, edge: 0 | 1 | 2 | 3): void => {
    const seed = ctx.crop;
    if (ctx.busy || active.current || !seed) return;
    const inv = invert(base);
    if (!inv) return;
    e.preventDefault();
    e.stopPropagation();
    active.current = true;
    const toLocal = (clientX: number, clientY: number): [number, number] => {
      const [u, v] = normPointer(clientX, clientY);
      const [ux, uy] = displayToUser(u, v, box, bakedRotate, pendingRotate);
      return transformPoint(inv, ux, uy);
    };
    let latest: [number, number, number, number] = seed;
    const onMove = (ev: PointerEvent): void => {
      latest = applyCropEdge(seed, edge, toLocal(ev.clientX, ev.clientY));
      setCropPreview(latest);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      active.current = false;
      cancelRef.current = null;
      setCropPreview(null);
      // Same no-churn rule as the matrix gesture: a bare click commits nothing.
      if (commit && latest.some((v, i) => Math.abs(v - seed[i]) > 1e-6)) onCommitCrop(latest);
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelRef.current = onCancel;
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
  // C3-tail: the listed crop (or its live drag preview) in display space.
  const cropRect = cropPreview ?? ctx.crop;
  const cropCorners =
    cropRect && !cropArmed
      ? (
          [
            [cropRect[0], cropRect[1]],
            [cropRect[2], cropRect[1]],
            [cropRect[2], cropRect[3]],
            [cropRect[0], cropRect[3]],
          ] as Array<[number, number]>
        ).map(([lx, ly]) => {
          const [ux, uy] = transformPoint(m, lx, ly);
          return userToDisplay(ux, uy, box, bakedRotate, pendingRotate);
        })
      : null;
  // Edge handle positions: midpoints of left/bottom/right/top crop edges
  // (indexes into cropCorners: 0-3 = BL,BR,TR,TL in local order above).
  const cropEdgeMids: Array<[number, number]> | null = cropCorners
    ? [
        [(cropCorners[0][0] + cropCorners[3][0]) / 2, (cropCorners[0][1] + cropCorners[3][1]) / 2],
        [(cropCorners[0][0] + cropCorners[1][0]) / 2, (cropCorners[0][1] + cropCorners[1][1]) / 2],
        [(cropCorners[1][0] + cropCorners[2][0]) / 2, (cropCorners[1][1] + cropCorners[2][1]) / 2],
        [(cropCorners[2][0] + cropCorners[3][0]) / 2, (cropCorners[2][1] + cropCorners[3][1]) / 2],
      ]
    : null;

  // The live crop band's display quad (unit rect → user via m → display).
  const bandPts = cropBand
    ? (
        [
          [cropBand[0], cropBand[1]],
          [cropBand[2], cropBand[1]],
          [cropBand[2], cropBand[3]],
          [cropBand[0], cropBand[3]],
        ] as Array<[number, number]>
      )
        .map(([lx, ly]) => {
          const [ux, uy] = transformPoint(m, lx, ly);
          const [dx, dy] = userToDisplay(ux, uy, box, bakedRotate, pendingRotate);
          return `${dx * 100},${dy * 100}`;
        })
        .join(' ')
    : null;

  return (
    <div ref={rootRef} className="page-imgtx" data-testid={`img-transform-${ctx.index}`}>
      <svg className="page-imgtx-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {!cropArmed && (
          <line
            x1={topMid[0] * 100}
            y1={topMid[1] * 100}
            x2={rotateHandle[0] * 100}
            y2={rotateHandle[1] * 100}
            className="page-imgtx-arm"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <polygon
          points={pts}
          className={'page-imgtx-quad' + (cropArmed ? ' crop' : '')}
          vectorEffect="non-scaling-stroke"
          onPointerDown={(e) => (cropArmed ? startCrop(e) : start(e, moveGesture))}
        />
        {bandPts && (
          <polygon points={bandPts} className="page-imgtx-cropband" vectorEffect="non-scaling-stroke" />
        )}
        {cropCorners && (
          <polygon
            points={cropCorners.map((p) => `${p[0] * 100},${p[1] * 100}`).join(' ')}
            className="page-imgtx-croprect"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {!cropArmed &&
        [0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="page-imgtx-handle"
            data-testid={`img-transform-handle-${i}`}
            style={dot(quad[i])}
            onPointerDown={(e) => start(e, resizeGesture(i))}
          />
        ))}
      {!cropArmed && (
        <div
          className="page-imgtx-rotate"
          data-testid="img-transform-rotate"
          style={dot(rotateHandle)}
          onPointerDown={(e) => start(e, rotateGesture)}
        />
      )}
      {cropEdgeMids &&
        cropEdgeMids.map((p, i) => (
          <div
            key={`c${i}`}
            className="page-imgtx-crophandle"
            data-testid={`img-crop-edge-${i}`}
            style={dot(p)}
            onPointerDown={(e) => startCropEdge(e, i as 0 | 1 | 2 | 3)}
          />
        ))}
    </div>
  );
}
