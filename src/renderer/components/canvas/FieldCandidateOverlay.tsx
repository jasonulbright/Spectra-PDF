import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../../i18n';

// A provisional field candidate on the page: a dashed box with its inferred
// name, a delete affordance, and four corner handles.
//
// The treatment is deliberately NOT the widget treatment. A candidate is a
// suggestion that has written nothing, and a user who cannot tell it apart from
// a field that exists has no review step at all.
//
// Drags run on window-level pointer listeners: React synthetic pointermove via
// setPointerCapture does not deliver in the WebView, which is the canvas's
// standing drag rule.

export interface CandidateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
const MIN_SIDE = 0.004;

interface Props {
  id: string;
  rect: CandidateBox;
  name: string;
  kind: string;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onCommit: (id: string, rect: CandidateBox) => void;
}

function clampBox(box: CandidateBox): CandidateBox {
  const w = Math.max(box.w, MIN_SIDE);
  const h = Math.max(box.h, MIN_SIDE);
  const x = Math.min(Math.max(box.x, 0), 1 - w);
  const y = Math.min(Math.max(box.y, 0), 1 - h);
  return { x, y, w, h };
}

export default function FieldCandidateOverlay({
  id,
  rect,
  name,
  kind,
  selected,
  onSelect,
  onRemove,
  onCommit,
}: Props): React.ReactElement {
  useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<CandidateBox | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    // A rect that changed underneath a finished drag must win; a live drag owns
    // the preview until it releases.
    if (!dragging.current) setPreview(null);
  }, [rect]);

  const beginDrag = useCallback(
    (event: React.PointerEvent, corner: Corner | null) => {
      event.stopPropagation();
      event.preventDefault();
      const cell = rootRef.current?.parentElement;
      if (!cell) return;
      const bounds = cell.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const base = rect;
      dragging.current = true;
      onSelect(id);
      let latest = base;
      const move = (ev: PointerEvent): void => {
        const dx = (ev.clientX - startX) / bounds.width;
        const dy = (ev.clientY - startY) / bounds.height;
        if (corner === null) {
          latest = clampBox({ ...base, x: base.x + dx, y: base.y + dy });
        } else {
          const left = corner === 'nw' || corner === 'sw';
          const top = corner === 'nw' || corner === 'ne';
          const x0 = left ? base.x + dx : base.x;
          const y0 = top ? base.y + dy : base.y;
          const x1 = left ? base.x + base.w : base.x + base.w + dx;
          const y1 = top ? base.y + base.h : base.y + base.h + dy;
          latest = clampBox({
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            w: Math.abs(x1 - x0),
            h: Math.abs(y1 - y0),
          });
        }
        setPreview(latest);
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        dragging.current = false;
        setPreview(null);
        onCommit(id, latest);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [id, onCommit, onSelect, rect],
  );

  const shown = preview ?? rect;
  return (
    <div
      ref={rootRef}
      className={`page-candidate${selected ? ' is-selected' : ''}`}
      data-testid={`field-candidate-${id}`}
      data-candidate-kind={kind}
      style={{
        left: `${shown.x * 100}%`,
        top: `${shown.y * 100}%`,
        width: `${shown.w * 100}%`,
        height: `${shown.h * 100}%`,
      }}
      onPointerDown={(e) => beginDrag(e, null)}
    >
      <span className="page-candidate-label">{name}</span>
      <button
        className="page-annot-x"
        title={tChrome('canvas.candidate.remove')}
        aria-label={tChrome('canvas.candidate.remove')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(id);
        }}
      >
        ×
      </button>
      {selected &&
        CORNERS.map((corner) => (
          <span
            key={corner}
            className={`page-candidate-handle is-${corner}`}
            onPointerDown={(e) => beginDrag(e, corner)}
          />
        ))}
    </div>
  );
}
