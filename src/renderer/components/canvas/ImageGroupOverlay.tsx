import React, { useEffect, useRef, useState } from 'react';
import {
  displayToUser,
  LOCAL_CORNERS,
  matMul,
  transformPoint,
  userToDisplay,
  type Mat,
  type PageBox,
} from '../../lib/image-transform';

// P7 — group transform of a multi-selected set of image placements. Every
// gesture builds ONE user-space transform D and previews/commits per-member
// M'_i = M_i·D through the multi engine op (one undo entry):
//   member/frame drag → translate
//   corners           → UNIFORM scale about the opposite corner of the group
//                       box (axis scale would shear rotated members — stated
//                       P7 boundary)
//   knob              → rotate about the group box center
// Same mechanics as ImageTransformOverlay: window-level listeners (the canvas
// drag invariant), commit only on a real numeric change, unmount cancels.
// Group mode has no skew/crop — the single-selection overlay owns those.
//
// Hit model: member polygons are painted ON TOP of the frame and take the
// pointer — a modifier click toggles that member out of the group, a plain
// click (no drag) collapses the selection to it (the king's behavior), and
// a plain drag moves the whole group. The frame body catches drags in the
// gaps between members.

export interface ImageGroupCtx {
  pageId: string;
  members: { index: number; matrix: number[] }[];
  box: PageBox;
  bakedRotate: number;
  busy: boolean;
}

interface Props {
  ctx: ImageGroupCtx;
  pendingRotate: number;
  onCommit: (targets: { index: number; matrix: number[] }[]) => void;
  /** Modifier-click on a member: toggle it out of the group. */
  onToggleMember: (index: number) => void;
  /** Plain click (no drag) on a member: collapse the selection to it. */
  onFocusMember: (index: number) => void;
}

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

const isIdentity = (d: Mat): boolean => d.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-6);

/** User-space AABB over every member's quad corners. */
function groupBounds(members: { matrix: number[] }[]): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const pts = members.flatMap((m) =>
    LOCAL_CORNERS.map(([lx, ly]) => transformPoint(m.matrix as Mat, lx, ly)),
  );
  return {
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  };
}

type ComputeD = (startUser: [number, number], curUser: [number, number]) => Mat;

export default function ImageGroupOverlay({
  ctx,
  pendingRotate,
  onCommit,
  onToggleMember,
  onFocusMember,
}: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const [previewD, setPreviewD] = useState<Mat | null>(null);
  const active = useRef(false);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  const { box, bakedRotate } = ctx;
  const d = previewD ?? IDENTITY;
  const bounds = groupBounds(ctx.members);

  const project = (px: number, py: number): [number, number] =>
    userToDisplay(px, py, box, bakedRotate, pendingRotate);

  // The group frame's four user-space corners under the live preview D,
  // in LOCAL_CORNERS order (BL, BR, TR, TL) so handle math lines up.
  const frameUser: Array<[number, number]> = (
    [
      [bounds.x0, bounds.y0],
      [bounds.x1, bounds.y0],
      [bounds.x1, bounds.y1],
      [bounds.x0, bounds.y1],
    ] as Array<[number, number]>
  ).map(([x, y]) => transformPoint(d, x, y));
  const frame = frameUser.map(([x, y]) => project(x, y));
  const center = transformPoint(d, (bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2);
  const centerDisp = project(center[0], center[1]);
  const topMid: [number, number] = [
    (frame[2][0] + frame[3][0]) / 2,
    (frame[2][1] + frame[3][1]) / 2,
  ];
  const rotateHandle: [number, number] = [
    topMid[0] + (topMid[0] - centerDisp[0]) * 0.3,
    topMid[1] + (topMid[1] - centerDisp[1]) * 0.3,
  ];

  const normPointer = (clientX: number, clientY: number): [number, number] => {
    const r = rootRef.current!.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  };

  const start = (e: React.PointerEvent, compute: ComputeD, onBareClick?: () => void): void => {
    if (ctx.busy || active.current) return;
    e.preventDefault();
    e.stopPropagation();
    active.current = true;
    const [su, sv] = normPointer(e.clientX, e.clientY);
    const startUser = displayToUser(su, sv, box, bakedRotate, pendingRotate);
    let latest: Mat = IDENTITY;
    let moved = false;
    const onMove = (ev: PointerEvent): void => {
      moved = true;
      const [u, v] = normPointer(ev.clientX, ev.clientY);
      latest = compute(startUser, displayToUser(u, v, box, bakedRotate, pendingRotate));
      setPreviewD(latest);
    };
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      active.current = false;
      cancelRef.current = null;
      setPreviewD(null);
      if (!commit) return;
      if (!moved || isIdentity(latest)) {
        onBareClick?.();
        return;
      }
      onCommit(
        ctx.members.map((m) => ({
          index: m.index,
          matrix: [...matMul(m.matrix as Mat, latest)],
        })),
      );
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    cancelRef.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const moveGesture: ComputeD = (s, c) => [1, 0, 0, 1, c[0] - s[0], c[1] - s[1]];
  const resizeGesture = (corner: number): ComputeD => {
    // Anchor = the opposite corner of the COMMITTED group box (gestures
    // compose from the committed state, the single-overlay rule).
    const anchors: Array<[number, number]> = [
      [bounds.x0, bounds.y0],
      [bounds.x1, bounds.y0],
      [bounds.x1, bounds.y1],
      [bounds.x0, bounds.y1],
    ];
    const [ax, ay] = anchors[(corner + 2) % 4];
    return (s, c) => {
      const d0 = Math.hypot(s[0] - ax, s[1] - ay);
      if (d0 < 1e-6) return IDENTITY;
      const scale = Math.max(0.02, Math.hypot(c[0] - ax, c[1] - ay) / d0);
      return [scale, 0, 0, scale, ax * (1 - scale), ay * (1 - scale)];
    };
  };
  const rotateGesture: ComputeD = (s, c) => {
    const cx = (bounds.x0 + bounds.x1) / 2;
    const cy = (bounds.y0 + bounds.y1) / 2;
    const a = Math.atan2(c[1] - cy, c[0] - cx) - Math.atan2(s[1] - cy, s[0] - cx);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
  };

  const framePts = frame.map((p) => `${p[0] * 100},${p[1] * 100}`).join(' ');
  const dot = (p: [number, number]): React.CSSProperties => ({
    left: `${p[0] * 100}%`,
    top: `${p[1] * 100}%`,
  });

  return (
    <div ref={rootRef} className="page-imgtx" data-testid="img-group-frame">
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
          points={framePts}
          className="page-imgtx-groupframe"
          vectorEffect="non-scaling-stroke"
          onPointerDown={(e) => start(e, moveGesture)}
        />
        {/* Members AFTER the frame: painted on top, so they own the pointer
            where they overlap it. */}
        {ctx.members.map((m) => {
          const pts = LOCAL_CORNERS.map(([lx, ly]) => {
            const [ux, uy] = transformPoint(m.matrix as Mat, lx, ly);
            const [px, py] = transformPoint(d, ux, uy);
            const [dx, dy] = project(px, py);
            return `${dx * 100},${dy * 100}`;
          }).join(' ');
          return (
            <polygon
              key={m.index}
              points={pts}
              className="page-imgtx-member"
              data-testid={`img-group-member-${m.index}`}
              vectorEffect="non-scaling-stroke"
              onPointerDown={(e) => {
                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleMember(m.index);
                  return;
                }
                start(e, moveGesture, () => onFocusMember(m.index));
              }}
            />
          );
        })}
      </svg>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="page-imgtx-handle"
          data-testid={`img-group-handle-${i}`}
          style={dot(frame[i])}
          onPointerDown={(e) => start(e, resizeGesture(i))}
        />
      ))}
      <div
        className="page-imgtx-rotate"
        data-testid="img-group-rotate"
        style={dot(rotateHandle)}
        onPointerDown={(e) => start(e, rotateGesture)}
      />
    </div>
  );
}
