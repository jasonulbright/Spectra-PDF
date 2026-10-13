import { useCallback, useEffect, useRef, useState } from 'react';
import { recordAsksRepaint, subscribeUprightRecord, uprightStampsOn } from '../../lib/upright-record';
import type { PageRenderTask } from '../../lib/upright-stamps';
import type { UprightStamp } from '../../lib/upright-record';

/** A raster that is rendered once and then turned by CSS holds a NoRotate
 *  stamp turned back by the turn it was rendered for. `epoch` changes when
 *  the painted raster holds such a stamp for another turn than the one
 *  shown, so the raster renders again; a raster with no such stamp never
 *  renders again for a turn. */
export function useUprightTurn(rotation: number): {
  epoch: number;
  /** The turn shown now. */
  shown: { readonly current: number };
  /** The painted raster holds `count` upright stamps, drawn for `turn`. */
  drawn: (count: number, turn: number) => void;
} {
  const shown = useRef(rotation);
  const painted = useRef<number | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    shown.current = rotation;
    if (painted.current !== null && painted.current !== rotation) setEpoch((value) => value + 1);
  }, [rotation]);
  const drawn = useCallback((count: number, turn: number): void => {
    painted.current = count > 0 ? turn : null;
    if (count > 0 && turn !== shown.current) setEpoch((value) => value + 1);
  }, []);
  return { epoch, shown, drawn };
}

/** `epoch` changes when the upright stamps known for the page differ from
 *  those the last render of the raster had, so the raster renders again: a
 *  record that lists a stamp after a plain render, or a record that differs
 *  from what a read of the page gave. A record equal to what the render had
 *  changes nothing, so a page with no upright stamp never renders again.
 *  Nothing is polled: the record calls its listeners. */
export function useUprightRecord(pdf: object | null | undefined, pageNumber: number): {
  epoch: number;
  /** A render of the page started as `task`. */
  began: (task: PageRenderTask) => void;
} {
  const started = useRef<PageRenderTask | null>(null);
  const asked = useRef<readonly UprightStamp[] | undefined>(undefined);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    started.current = null;
    asked.current = undefined;
    if (!pdf) return;
    return subscribeUprightRecord(() => {
      const now = uprightStampsOn(pdf, pageNumber - 1);
      const task = started.current;
      if (!recordAsksRepaint(now, task !== null, asked.current ?? task?.upright)) return;
      asked.current = now;
      setEpoch((value) => value + 1);
    });
  }, [pdf, pageNumber]);
  const began = useCallback((task: PageRenderTask): void => {
    started.current = task;
    asked.current = undefined;
  }, []);
  return { epoch, began };
}

/** What a painted raster shows: a page of a document. */
export interface RasterSource {
  document: object;
  pageNumber: number;
}

/** Whether a new render shows what the painted raster shows. The raster then
 *  stays visible until the new pixels replace it in one step; a render of
 *  another page or document hides it at once. */
export function keepsPaintedRaster(painted: RasterSource | null, next: RasterSource): boolean {
  return painted !== null && painted.document === next.document && painted.pageNumber === next.pageNumber;
}
