// A chrome surface (today: the nav-pane Pages panel) that accepts files
// dragged in from outside the app and inserts their pages at a point.
//
// The native file drop is window-wide (Tauri's onDragDropEvent, not HTML5
// DnD), so the surface cannot see the drop itself. It registers here, and
// App's drop handler asks it first: a point over the surface is the surface's
// to resolve, and never falls through to the canvas resolver — the board's
// clientToWorld maps ANY client point, including one over the pane.
//
// Points are webview CSS pixels (App converts Tauri's physical position).

export interface ExternalDropInsert {
  docId: string;
  index: number;
}

export interface ExternalDropSurface {
  /** Whether the point is over this surface at all. */
  contains(clientX: number, clientY: number): boolean;
  /** The insertion point under the point, or null when none can be aimed at. */
  resolve(clientX: number, clientY: number): ExternalDropInsert | null;
  /** Show the insertion marker for a drag hovering at the point; null hides it. */
  hover(point: { x: number; y: number } | null): void;
}

let current: ExternalDropSurface | null = null;

/** Register the surface; returns the unregister (a no-op once replaced). */
export function registerExternalDropSurface(surface: ExternalDropSurface): () => void {
  current = surface;
  return () => {
    if (current === surface) current = null;
  };
}

export function getExternalDropSurface(): ExternalDropSurface | null {
  return current;
}
