import React, { useCallback, useEffect, useRef, useState } from 'react';
import { dragTargetIndex, edgeScrollStep } from '../lib/create-pdf';

// HTML5 drag-and-drop never completes in the webview while native file drop
// is enabled, so a list reorder is pointer-driven with window-level listeners.
// Row positions are re-measured on every move and scroll, because the list
// scrolls under a held drag (wheel or edge auto-scroll).

export interface RowDrag {
  from: number;
  to: number;
}

/**
 * Pointer reorder for a vertical list. `rowSelector` matches the list's row
 * elements in list order; `onDrop` receives the original index and the index
 * the row lands at, and runs only for a released drag that moved.
 */
export function useRowDrag(
  listRef: React.RefObject<HTMLElement | null>,
  rowSelector: string,
  onDrop: (from: number, to: number) => void,
): { drag: RowDrag | null; startRowDrag: (event: React.PointerEvent, from: number) => void } {
  const [drag, setDrag] = useState<RowDrag | null>(null);
  const endDragRef = useRef<(() => void) | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const startRowDrag = useCallback((event: React.PointerEvent, from: number) => {
    const list = listRef.current;
    if (event.button !== 0 || !list) return;
    event.preventDefault();
    endDragRef.current?.();
    let to = from;
    let pointerY = event.clientY;
    let frame = 0;
    const retarget = () => {
      const midpoints = Array.from(list.querySelectorAll<HTMLElement>(rowSelector)).map((item) => {
        const rect = item.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      to = dragTargetIndex(midpoints, from, pointerY);
      setDrag({ from, to });
    };
    const tick = () => {
      const box = list.getBoundingClientRect();
      const step = edgeScrollStep(box.top, box.bottom, pointerY);
      if (step !== 0) list.scrollTop += step;
      frame = requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      pointerY = e.clientY;
      retarget();
    };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      list.removeEventListener('scroll', retarget);
      endDragRef.current = null;
      setDrag(null);
      if (commit && to !== from) onDropRef.current(from, to);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    list.addEventListener('scroll', retarget);
    endDragRef.current = onCancel;
    setDrag({ from, to });
    frame = requestAnimationFrame(tick);
  }, [listRef, rowSelector]);

  useEffect(() => () => endDragRef.current?.(), []);

  return { drag, startRowDrag };
}

/** The row classes a drag paints: the dragged row dims, the landing row
 * shows an insertion edge on the side the dragged row will occupy. */
export function rowDragClass(drag: RowDrag | null, index: number): string {
  if (!drag) return '';
  if (drag.from === index) return 'opacity-50 ';
  if (drag.to !== index) return '';
  return drag.to > drag.from ? 'border-b-2 border-b-blue-500' : 'border-t-2 border-t-blue-500';
}
