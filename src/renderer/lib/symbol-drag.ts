// N11 slice D — dragging a symbol out of the palette onto a page.
//
// POINTER EVENTS with WINDOW-LEVEL native listeners, per the canvas invariant:
// HTML5 drag-and-drop cannot complete in this webview while Tauri's native
// file-drop is enabled, and React synthetic pointermove does not deliver
// reliably mid-gesture. This module is the whole gesture — the palette starts
// it, the page cells register where a drop can land, and nothing in between
// knows about either.
//
// Two decisions worth stating:
//
//   • **The drop resolves through a REGISTRY, not through a React pointerup on
//     the page.** The controller hit-tests with `elementFromPoint` and calls
//     the handler the page cell registered for that page id. That keeps the
//     drop independent of synthetic-event delivery and of which element the
//     browser decides a pointerup belongs to.
//   • **The ghost is moved by direct DOM writes, never by React state.** A
//     store update per pointermove would re-render every mounted page cell for
//     a cursor that moved three pixels.
//
// The placement itself still goes through the page cell's `pagePoint` choke
// point, so a dropped symbol snaps exactly like a clicked one.

import type { SymbolPart } from './count-marks';

export interface SymbolDragPayload {
  symbolId: string;
  name: string;
  parts: readonly SymbolPart[];
  color: string;
}

/**
 * A page cell's drop handler: the cell ELEMENT the drop landed on, the
 * viewport coordinates, and what was dropped.
 *
 * The element travels with the call because the page cell's choke point takes
 * one (`pagePoint(el, cx, cy)`), and the hit test already holds exactly the
 * node it hit — re-finding it from a page id would be a second answer to
 * "which box is this page drawn in".
 */
type DropHandler = (
  el: HTMLElement,
  clientX: number,
  clientY: number,
  payload: SymbolDragPayload,
) => void;

const handlers = new Map<string, DropHandler>();

/** Page cells register while mounted; the returned function unregisters. */
export function registerSymbolDrop(pageId: string, handler: DropHandler): () => void {
  handlers.set(pageId, handler);
  return () => {
    if (handlers.get(pageId) === handler) handlers.delete(pageId);
  };
}

/** Movement before a press becomes a DRAG. Below it the press is a click,
 * which arms the symbol instead — both gestures live on the same button, so
 * the threshold is what tells them apart. */
const DRAG_THRESHOLD_PX = 4;

const GHOST_PX = 40;

function ghostSvg(payload: SymbolDragPayload): string {
  const parts = payload.parts
    .map((part) =>
      part.kind === 'circle'
        ? `<circle cx="${part.cx}" cy="${part.cy}" r="${part.r}" fill="none" stroke="${payload.color}" stroke-width="0.07"/>`
        : `<polyline points="${polyPoints(part.points, part.closed)}" fill="none" stroke="${payload.color}" stroke-width="0.07" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  return `<svg width="${GHOST_PX}" height="${GHOST_PX}" viewBox="0 0 1 1">${parts}</svg>`;
}

function polyPoints(points: readonly number[], closed: boolean): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push(`${points[i]},${points[i + 1]}`);
  if (closed && out.length > 0) out.push(out[0]);
  return out.join(' ');
}

let active = false;

/** True while a symbol drag is live — the palette suppresses the click that
 * would otherwise follow the release. */
export function symbolDragActive(): boolean {
  return active;
}

/**
 * Begin a palette drag. Returns immediately; the gesture runs on window
 * listeners until pointerup / pointercancel / Escape.
 *
 * `onEnd(placed)` lets the palette suppress the trailing click when the press
 * turned into a drag.
 */
export function startSymbolDrag(
  payload: SymbolDragPayload,
  startX: number,
  startY: number,
  onEnd?: (dragged: boolean) => void,
): void {
  let dragging = false;
  let ghost: HTMLDivElement | null = null;
  // Where the pointer last actually WAS. The drop uses this rather than the
  // pointerup's own coordinates: a press can be pointer-CAPTURED by the
  // element it started on (WebView2 retargets the release to the palette
  // button, and WebDriver's releaseActions does the same), and a release
  // reported at the drag's origin would drop the symbol back on the palette
  // it came from. A pointer cannot move without a pointermove, so the last
  // move IS the release position.
  let lastX = startX;
  let lastY = startY;

  const showGhost = (x: number, y: number): void => {
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'symbol-drag-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.innerHTML = ghostSvg(payload);
      document.body.appendChild(ghost);
    }
    ghost.style.left = `${x - GHOST_PX / 2}px`;
    ghost.style.top = `${y - GHOST_PX / 2}px`;
  };

  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey);
    ghost?.remove();
    ghost = null;
    active = false;
    onEnd?.(dragging);
  };

  function onMove(ev: PointerEvent): void {
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      active = true;
    }
    showGhost(ev.clientX, ev.clientY);
  }

  function onUp(): void {
    const wasDragging = dragging;
    // The ghost must be gone BEFORE the hit test: it sits under the cursor,
    // and `pointer-events: none` in CSS is a promise the hit test should not
    // have to depend on.
    ghost?.remove();
    ghost = null;
    if (wasDragging) drop(lastX, lastY, payload);
    cleanup();
  }

  function onCancel(): void {
    dragging = false;
    cleanup();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    // An abandoned drag places nothing, and the Escape must not travel on to
    // disarm the tool underneath it.
    ev.preventDefault();
    ev.stopPropagation();
    onCancel();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

/** Hit-test the drop point and hand it to the page cell under it. Exported
 * for the drag above only; a drop outside every page places nothing, which is
 * how a drag is abandoned by aiming away from the paper. */
function drop(clientX: number, clientY: number, payload: SymbolDragPayload): void {
  const el = document.elementFromPoint(clientX, clientY);
  const cell = el?.closest('[data-page-id]') as HTMLElement | null;
  const pageId = cell?.getAttribute('data-page-id');
  if (!cell || !pageId) return;
  handlers.get(pageId)?.(cell, clientX, clientY, payload);
}
