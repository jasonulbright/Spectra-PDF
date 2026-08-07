import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../../i18n';
import {
  clampRect,
  columnFractionAt,
  placeColumn,
  placeRow,
  type NormalizedRect,
} from '../../lib/table-review';

// A detected table on the page: a dashed frame carrying its caption, a rule per
// column boundary, a hairline per row, and four corner handles.
//
// The treatment is deliberately NOT the widget or candidate treatment. Nothing
// here is written to the document at all — the frame describes what a
// spreadsheet export WOULD read — and a user who cannot tell it apart from
// content has no review step.
//
// Rows draw and claim nothing. A row is a cluster of baselines the page states
// directly, so a handle on one would offer to change a fact.
//
// Drags run on window-level pointer listeners: React synthetic pointermove via
// setPointerCapture does not deliver in the WebView, which is the canvas's
// standing drag rule.

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];

interface Props {
  id: string;
  rect: NormalizedRect;
  /** Rotation between un-rotated user space and this cell, right now. */
  rotation: number;
  columns: readonly number[];
  rows: readonly number[];
  label: string;
  accepted: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMoveBounds: (id: string, rect: NormalizedRect) => void;
  onMoveColumn: (id: string, index: number, fraction: number) => void;
  onAddColumn: (id: string, fraction: number) => void;
  onRemoveColumn: (id: string, index: number) => void;
}

export default function TableRegionOverlay({
  id,
  rect,
  rotation,
  columns,
  rows,
  label,
  accepted,
  selected,
  onSelect,
  onToggle,
  onMoveBounds,
  onMoveColumn,
  onAddColumn,
  onRemoveColumn,
}: Props): React.ReactElement {
  useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<NormalizedRect | null>(null);
  const [columnPreview, setColumnPreview] = useState<{ index: number; at: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    // A rect that changed underneath a finished drag must win; a live drag owns
    // the preview until it releases.
    if (!dragging.current) setPreview(null);
  }, [rect]);

  const cellBounds = useCallback((): DOMRect | null => {
    const cell = rootRef.current?.parentElement;
    if (!cell) return null;
    const bounds = cell.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 ? bounds : null;
  }, []);

  const beginBoundsDrag = useCallback(
    (event: React.PointerEvent, corner: Corner | null) => {
      event.stopPropagation();
      event.preventDefault();
      const bounds = cellBounds();
      if (!bounds) return;
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
          latest = clampRect({ ...base, x: base.x + dx, y: base.y + dy });
        } else {
          const left = corner === 'nw' || corner === 'sw';
          const top = corner === 'nw' || corner === 'ne';
          const x0 = left ? base.x + dx : base.x;
          const y0 = top ? base.y + dy : base.y;
          const x1 = left ? base.x + base.w : base.x + base.w + dx;
          const y1 = top ? base.y + base.h : base.y + base.h + dy;
          latest = clampRect({
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
        onMoveBounds(id, latest);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [cellBounds, id, onMoveBounds, onSelect, rect],
  );

  const shown = preview ?? rect;

  const beginColumnDrag = useCallback(
    (event: React.PointerEvent, index: number, axis: 'x' | 'y') => {
      event.stopPropagation();
      event.preventDefault();
      const bounds = cellBounds();
      if (!bounds) return;
      // The frame the boundary lives in is the table's own drawn rect, so the
      // pointer delta is measured against that side rather than the page's.
      const side =
        axis === 'x' ? bounds.width * shown.w : bounds.height * shown.h;
      if (side <= 0) return;
      const start = axis === 'x' ? event.clientX : event.clientY;
      const drawn = placeColumn(columns[index], rotation);
      onSelect(id);
      let latest = drawn.at;
      const move = (ev: PointerEvent): void => {
        const delta = ((axis === 'x' ? ev.clientX : ev.clientY) - start) / side;
        latest = Math.min(Math.max(drawn.at + delta, 0), 1);
        setColumnPreview({ index, at: latest });
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setColumnPreview(null);
        onMoveColumn(id, index, columnFractionAt(latest, rotation));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [cellBounds, columns, id, onMoveColumn, onSelect, rotation, shown.h, shown.w],
  );

  // A double-click inside the frame adds a boundary where it landed. The frame
  // itself is the only surface that can say where a NEW boundary goes, because
  // there is no element there yet to aim at.
  const addAtPointer = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const frame = event.currentTarget.getBoundingClientRect();
      if (frame.width <= 0 || frame.height <= 0) return;
      const axis = placeColumn(0, rotation).axis;
      const at =
        axis === 'x'
          ? (event.clientX - frame.left) / frame.width
          : (event.clientY - frame.top) / frame.height;
      onAddColumn(id, columnFractionAt(at, rotation));
    },
    [id, onAddColumn, rotation],
  );

  return (
    <div
      ref={rootRef}
      className={`page-table-region${selected ? ' is-selected' : ''}${
        accepted ? ' is-accepted' : ''
      }`}
      data-testid={`table-region-${id}`}
      data-table-accepted={accepted ? 'yes' : 'no'}
      data-table-columns={columns.length}
      style={{
        left: `${shown.x * 100}%`,
        top: `${shown.y * 100}%`,
        width: `${shown.w * 100}%`,
        height: `${shown.h * 100}%`,
      }}
      onPointerDown={(e) => beginBoundsDrag(e, null)}
      onDoubleClick={addAtPointer}
    >
      <span className="page-table-label">{label}</span>
      <button
        className="page-table-accept"
        data-testid={`table-accept-${id}`}
        title={
          accepted
            ? tChrome('canvas.tableReview.reject')
            : tChrome('canvas.tableReview.accept')
        }
        aria-label={
          accepted
            ? tChrome('canvas.tableReview.reject')
            : tChrome('canvas.tableReview.accept')
        }
        aria-pressed={accepted}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(id);
        }}
      >
        {accepted ? '✓' : '·'}
      </button>
      {rows.map((fraction, index) => {
        const line = placeRow(fraction, rotation);
        return (
          <span
            key={`row-${index}`}
            className={`page-table-row is-${line.axis}`}
            style={
              line.axis === 'x'
                ? { left: `${line.at * 100}%` }
                : { top: `${line.at * 100}%` }
            }
          />
        );
      })}
      {columns.map((fraction, index) => {
        const line = placeColumn(fraction, rotation);
        const at = columnPreview?.index === index ? columnPreview.at : line.at;
        // Index 0 is the table's leading edge: it moves with the bounds and is
        // not a boundary between two columns, so it carries no handle.
        const leading = index === 0;
        return (
          <span
            key={`column-${index}`}
            className={`page-table-column is-${line.axis}${leading ? ' is-leading' : ''}`}
            data-testid={leading ? undefined : `table-column-${id}-${index}`}
            style={
              line.axis === 'x' ? { left: `${at * 100}%` } : { top: `${at * 100}%` }
            }
            onPointerDown={
              leading ? undefined : (e) => beginColumnDrag(e, index, line.axis)
            }
            onDoubleClick={
              leading
                ? undefined
                : (e) => {
                    e.stopPropagation();
                    onRemoveColumn(id, index);
                  }
            }
          />
        );
      })}
      {selected &&
        CORNERS.map((corner) => (
          <span
            key={corner}
            className={`page-table-handle is-${corner}`}
            onPointerDown={(e) => beginBoundsDrag(e, corner)}
          />
        ))}
    </div>
  );
}
