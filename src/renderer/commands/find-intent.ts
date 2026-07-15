import type { CanvasServices } from './types';

// A one-slot "open Find as soon as there's a canvas showing THIS document".
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
// The park is KEYED TO ITS TARGET, and the drain checks that the canvas which
// mounted is showing that target. A bare boolean would fire on whatever canvas
// mounted next: park for a.pdf, change your mind, open b.pdf an hour later, and
// Find springs open there for no reason the user can see. The first draft
// documented "callers must guarantee a doc tab lands" as the mitigation — but an
// invariant that depends on future writers remembering is one that will break
// (the same lesson M4.1c and this slice's own activeToolId fix already paid
// for), so the module enforces it rather than asking.
//
// This lives in its own module rather than in `context.ts` because `context`
// imports `COMMANDS` from `registry`, and `registry` is what needs to request a
// find — routing it through context would close an import cycle.

/** The document path a parked request is waiting for; null = nothing parked. */
let pendingFor: string | null = null;

/**
 * Open the find bar on `path`, now if its canvas is mounted, else on its mount.
 *
 * `current` is the caller's live services (null when no canvas is mounted).
 * Passing them in rather than reading a module slot keeps this module a leaf.
 */
export function openFindWhenCanvasReady(
  current: CanvasServices | null,
  path: string,
): void {
  if (current) {
    current.find.open();
    return;
  }
  pendingFor = path;
}

/**
 * Called by `registerCanvasServices` — the moment the find service exists.
 *
 * `shownDoc` is the document that canvas is showing (null if it isn't showing
 * one). A park only drains onto the document it was taken for; any other
 * navigation DISCARDS it, so a forgotten request can't ambush a later document.
 */
export function drainPendingFind(
  services: CanvasServices | null,
  shownDoc: string | null,
): void {
  if (!services || pendingFor === null) return;
  const target = pendingFor;
  pendingFor = null;
  if (target === shownDoc) services.find.open();
}

/** Test seam: drop a parked request so cases can't leak into each other. */
export function resetPendingFind(): void {
  pendingFor = null;
}
