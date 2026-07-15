import type { CanvasServices } from './types';

// A one-slot "open Find as soon as there's a canvas to open it on".
//
// `CanvasServices` only exist while WorkspaceCanvasView is mounted, i.e. while a
// DOCUMENT tab is focused. A command that focuses a doc tab and then wants Find
// cannot simply call `find.open()` afterwards: the dispatch only SCHEDULES the
// tab change, so the canvas stays unmounted for the rest of that synchronous run
// and `ctx.canvas` is null. M5.1 shipped exactly that bug — `tools.open.ocr` was
// a dead click, and its test passed only because the test pre-registered
// services, a precondition that cannot hold at the tool's real entry point (the
// Tools tab, where the canvas is by definition not mounted).
//
// So park the intent and let the mount drain it — the same park-then-flush shape
// M4.1c used for cross-document find jumps.
//
// This lives in its own module rather than in `context.ts` because `context`
// imports `COMMANDS` from `registry`, and `registry` is what needs to request a
// find — routing it through context would close an import cycle.

let pending = false;

/**
 * Open the find bar, now if the canvas is mounted, else on its next mount.
 *
 * The park is consumed by the next registration and does not expire on its own,
 * so every caller must be one that GUARANTEES a document tab lands (i.e. it
 * gates on a real, non-import-only active file). A caller that focuses nothing
 * would leave the bar to spring open on whatever document the user opened next.
 */
export function openFindWhenCanvasReady(current: CanvasServices | null): void {
  if (current) {
    current.find.open();
    return;
  }
  pending = true;
}

/** Called by `registerCanvasServices` — the moment the find service exists. */
export function drainPendingFind(services: CanvasServices | null): void {
  if (!services || !pending) return;
  pending = false;
  services.find.open();
}

/** Test seam: drop a parked request so cases can't leak into each other. */
export function resetPendingFind(): void {
  pending = false;
}
