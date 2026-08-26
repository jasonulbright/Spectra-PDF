import { app } from './tauri-bridge';

/**
 * Tell the backend this window has painted its first laid-out frame.
 *
 * Workspace windows are created hidden: they are transparent (the backdrop
 * design), so a window shown before its renderer has painted composites the
 * desktop through an empty client area, and one shown before layout settles
 * composites a half-arranged shell. The show waits for this signal.
 *
 * Two nested frames, not one: the first callback runs before the frame that
 * carries the initial commit has been produced, so the second is the earliest
 * point at which the laid-out content actually exists on screen.
 *
 * Fire-and-forget by construction. A refused or wedged signal must not stop
 * the app — the backend shows the window on its own deadline instead.
 */
export function signalFirstPaint(
  schedule: (cb: () => void) => void = (cb) => {
    requestAnimationFrame(cb);
  },
  notify: () => Promise<unknown> = () => app.rendererReady(),
): void {
  schedule(() => {
    schedule(() => {
      try {
        void notify().catch(() => {});
      } catch {
        // No bridge — nothing is waiting on the signal.
      }
    });
  });
}
