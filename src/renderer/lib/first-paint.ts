import { platformCapability } from './platform-capabilities';
import { app } from './tauri-bridge';

/**
 * Tell the backend this window has painted its first laid-out frame.
 *
 * Workspace windows are created hidden: they are transparent (the backdrop
 * design), so a window shown before its renderer has painted composites the
 * desktop through an empty client area, and one shown before layout settles
 * composites a half-arranged shell. The show waits for this signal.
 *
 * Two nested scheduling steps, not one: the first callback runs before the
 * frame that carries the initial commit has been produced, so the second is
 * the earliest point at which the laid-out content actually exists on screen.
 * Each step is one `scheduleFrame`, so a hidden window on a platform without
 * hidden frames takes two timer steps instead.
 *
 * Fire-and-forget by construction. A refused or wedged signal must not stop
 * the app — the backend shows the window on its own deadline instead.
 */
export function signalFirstPaint(
  schedule: (cb: () => void) => void = scheduleFrame,
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

/** Configured fallback budget: how long a hidden document waits for a frame
 * before the timer stands in for it. */
export const HIDDEN_FRAME_MS = 50;

export interface FrameEnv {
  frame: (cb: () => void) => void;
  timer: (cb: () => void, ms: number) => void;
  hidden: () => boolean;
  framesWhileHidden: () => boolean;
}

export const defaultFrameEnv: FrameEnv = {
  frame: (f) => {
    requestAnimationFrame(() => f());
  },
  timer: (f, ms) => {
    setTimeout(f, ms);
  },
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  framesWhileHidden: () => platformCapability('hiddenAnimationFrames'),
};

/**
 * Runs `cb` once, at the next animation frame.
 *
 * WebKitGTK produces no animation frames for a view whose window is not
 * mapped, and every workspace window starts hidden, so on that engine a
 * frame-only wait never ends and the show falls through to the backend's
 * deadline. Where the platform reports no frames while hidden and the
 * document reports itself hidden, a timer stands in for the frame; whichever
 * arrives first runs the callback. Everywhere else the wait is frame-only: a
 * timer there can report a transparent window ready before anything is
 * painted in it.
 */
export function scheduleFrame(cb: () => void, env: FrameEnv = defaultFrameEnv): void {
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    cb();
  };
  env.frame(once);
  if (!env.framesWhileHidden() && env.hidden()) env.timer(once, HIDDEN_FRAME_MS);
}
