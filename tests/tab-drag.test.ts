// The renderer half of the cross-window tab drag.
//
// The gesture lives in a module rather than the component for the reason every
// other guard here does: there is no DOM test environment, so what has to be
// provable — when a press becomes a drag, what a `pointercancel` leaves behind,
// which screen point Rust is asked about, and which outcomes close the tab —
// is decided in plain functions the component only calls.
import { describe, expect, it, vi } from 'vitest';

import {
  EMPTY_STRIP,
  NO_DRAG,
  TAB_DRAG_THRESHOLD_PX,
  advanceDrag,
  armDrag,
  cancelDrag,
  createFrameThrottle,
  hoverCssX,
  physicalPointFor,
  pinGhost,
  releaseDrag,
  settleDrop,
  stripRectFor,
  tabMoved,
  type ArmRequest,
  type TabDragState,
} from '../src/renderer/lib/tab-drag';
import type { TabDragResult } from '../src/renderer/lib/tauri-bridge';

const press = (over: Partial<ArmRequest> = {}): ArmRequest => ({
  path: 'C:\\docs\\a.pdf',
  pointerId: 7,
  button: 0,
  clientX: 100,
  clientY: 10,
  grabDX: 20,
  grabDY: 4,
  draggable: true,
  ...over,
});

/** Arm and travel far enough to be a drag. */
const dragging = (): TabDragState => {
  const armed = armDrag(NO_DRAG, press());
  return advanceDrag(armed, 100 + TAB_DRAG_THRESHOLD_PX, 10).state;
};

describe('arm state machine', () => {
  it('arms a primary press on a movable tab and records the grip', () => {
    const state = armDrag(NO_DRAG, press());
    expect(state.phase).toBe('armed');
    expect(state.path).toBe('C:\\docs\\a.pdf');
    expect(state.pointerId).toBe(7);
    expect(state.grabDX).toBe(20);
    expect(state.grabDY).toBe(4);
  });

  it('refuses a secondary button and a tab that never travels', () => {
    expect(armDrag(NO_DRAG, press({ button: 2 }))).toBe(NO_DRAG);
    expect(armDrag(NO_DRAG, press({ button: 1 }))).toBe(NO_DRAG);
    // An import-source ghost has a path but no tab to move.
    expect(armDrag(NO_DRAG, press({ draggable: false }))).toBe(NO_DRAG);
  });

  it('stays a click below the threshold and becomes a drag at it', () => {
    const armed = armDrag(NO_DRAG, press());
    const short = advanceDrag(armed, 100 + TAB_DRAG_THRESHOLD_PX - 1, 10);
    expect(short.state.phase).toBe('armed');
    expect(short.started).toBe(false);
    expect(short.tracking).toBe(false);

    const far = advanceDrag(armed, 100 + TAB_DRAG_THRESHOLD_PX, 10);
    expect(far.state.phase).toBe('dragging');
    expect(far.started).toBe(true);
    expect(far.tracking).toBe(true);
  });

  it('measures travel in both axes, not one', () => {
    const armed = armDrag(NO_DRAG, press());
    // 3px across and 3px down is 4.24px of travel — still a click.
    expect(advanceDrag(armed, 103, 13).state.phase).toBe('armed');
    // 5px and 5px is 7.07px — a drag.
    expect(advanceDrag(armed, 105, 15).state.phase).toBe('dragging');
  });

  it('reports the start exactly once', () => {
    const first = advanceDrag(armDrag(NO_DRAG, press()), 200, 10);
    expect(first.started).toBe(true);
    const second = advanceDrag(first.state, 300, 10);
    expect(second.started).toBe(false);
    expect(second.tracking).toBe(true);
  });

  it('ignores moves that never armed', () => {
    const idle = advanceDrag(NO_DRAG, 900, 900);
    expect(idle.state).toBe(NO_DRAG);
    expect(idle.tracking).toBe(false);
  });
});

describe('pointercancel', () => {
  // The hazard: a pointerdown that ALSO activates a background window is
  // cancelled by the activation, so the first drag out of an unfocused window
  // is a down/cancel pair with no capture. It has to leave nothing behind.
  it('dissolves an armed press and tells nobody', () => {
    const armed = armDrag(NO_DRAG, press());
    const cancelled = cancelDrag(armed);
    expect(cancelled.state).toBe(NO_DRAG);
    // Nothing was ever tracked, so there is no far-side hover to clear.
    expect(cancelled.notify).toBe(false);
  });

  it('re-arms on the very next press', () => {
    const dissolved = cancelDrag(armDrag(NO_DRAG, press())).state;
    const again = armDrag(dissolved, press({ pointerId: 8 }));
    expect(again.phase).toBe('armed');
    expect(again.pointerId).toBe(8);
    // And that second press can still become a real drag.
    expect(advanceDrag(again, 400, 10).state.phase).toBe('dragging');
  });

  it('clears the far side when the drag had already started', () => {
    const cancelled = cancelDrag(dragging());
    expect(cancelled.state).toBe(NO_DRAG);
    expect(cancelled.notify).toBe(true);
  });

  it('cannot cancel a drop already resolving', () => {
    const dropping = releaseDrag(dragging()).state;
    const cancelled = cancelDrag(dropping);
    expect(cancelled.state).toBe(dropping);
    expect(cancelled.notify).toBe(false);
  });

  it('cannot re-arm over a drop already resolving', () => {
    const dropping = releaseDrag(dragging()).state;
    // The commit gate and the handover are running against this path; a press
    // on another tab must not steal the state they are using.
    const state = armDrag(dropping, press({ path: 'C:\\docs\\b.pdf' }));
    expect(state).toBe(dropping);
    expect(state.path).toBe('C:\\docs\\a.pdf');
  });
});

describe('release', () => {
  it('resolves a drop and names the document', () => {
    const released = releaseDrag(dragging());
    expect(released.drop).toBe(true);
    expect(released.path).toBe('C:\\docs\\a.pdf');
    expect(released.state.phase).toBe('dropping');
  });

  it('lets an untravelled press through as an ordinary click', () => {
    const released = releaseDrag(armDrag(NO_DRAG, press()));
    expect(released.drop).toBe(false);
    expect(released.path).toBe('');
    expect(released.state).toBe(NO_DRAG);
  });

  it('settles only what was dropping', () => {
    expect(settleDrop(releaseDrag(dragging()).state)).toBe(NO_DRAG);
    const armed = armDrag(NO_DRAG, press());
    expect(settleDrop(armed)).toBe(armed);
  });
});

describe('drop outcomes', () => {
  const result = (outcome: TabDragResult['outcome']): TabDragResult => ({
    outcome,
    label: outcome === 'transferred' ? 'doc-1' : '',
    owner: outcome === 'refused' ? 'doc-2' : '',
  });

  it('closes the tab only when the document actually changed hands', () => {
    expect(tabMoved(result('transferred'))).toBe(true);
    expect(tabMoved(result('tornOff'))).toBe(true);
  });

  it('keeps the document where it is on a refusal or a same-window drop', () => {
    // Closing on either of these loses the document: nothing took ownership.
    expect(tabMoved(result('refused'))).toBe(false);
    expect(tabMoved(result('sameWindow'))).toBe(false);
  });
});

describe('strip rect', () => {
  it('anchors the CSS box to the window inner origin in physical pixels', () => {
    // The origin the probe recorded: inner (128, 151) for an outer (120, 120).
    const rect = stripRectFor(
      { left: 0, top: 64, width: 884, height: 32 },
      { x: 128, y: 151 },
      1,
    );
    expect(rect).toEqual({ x: 128, y: 215, width: 884, height: 32 });
  });

  it('scales the box but not the origin — the origin is already physical', () => {
    const rect = stripRectFor({ left: 10, top: 20, width: 400, height: 32 }, { x: 200, y: 300 }, 1.5);
    expect(rect).toEqual({ x: 215, y: 330, width: 600, height: 48 });
  });

  it('collapses a strip with no area so it can never take a drop', () => {
    // Reading mode unmounts the strip; a hidden element measures zero.
    expect(stripRectFor({ left: 0, top: 0, width: 884, height: 0 }, { x: 128, y: 151 }, 1)).toBe(
      EMPTY_STRIP,
    );
    expect(stripRectFor({ left: 0, top: 0, width: 0, height: 32 }, { x: 128, y: 151 }, 1)).toBe(
      EMPTY_STRIP,
    );
  });
});

describe('screen coordinates', () => {
  it('scales a pointer screen position into physical pixels', () => {
    // screenX/screenY are CSS pixels in the SCREEN's space, so only the scale
    // is missing — the window position is already in them.
    expect(physicalPointFor(1850, 482, 1)).toEqual({ x: 1850, y: 482 });
    expect(physicalPointFor(1000, 500, 1.25)).toEqual({ x: 1250, y: 625 });
  });

  it('divides a hover offset by the RECEIVING window ratio', () => {
    // The offset crosses in physical pixels precisely so the source's scale
    // factor never has to travel with the drag.
    expect(hoverCssX(220, 1)).toBe(220);
    expect(hoverCssX(220, 2)).toBe(110);
  });
});

describe('ghost pinning', () => {
  const ghost = { width: 160, height: 32 };
  const viewport = { width: 1000, height: 700 };

  it('follows the grip inside the window', () => {
    expect(pinGhost(500, 20, 40, 8, ghost, viewport)).toEqual({ x: 460, y: 12 });
  });

  it('pins to the edge once the cursor is past it', () => {
    // The source window cannot paint outside itself; the pinned ghost is what
    // says the drag is still live while the cursor is over another window.
    expect(pinGhost(2000, 900, 40, 8, ghost, viewport)).toEqual({ x: 840, y: 668 });
    expect(pinGhost(-300, -80, 40, 8, ghost, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('pins to the origin when the ghost is wider than the window', () => {
    expect(pinGhost(500, 20, 40, 8, { width: 2000, height: 900 }, viewport)).toEqual({ x: 0, y: 0 });
  });
});

describe('frame throttle', () => {
  const fakeFrames = () => {
    const queued = new Map<number, () => void>();
    let next = 1;
    return {
      schedule: (cb: () => void): number => {
        const handle = next++;
        queued.set(handle, cb);
        return handle;
      },
      unschedule: (handle: number): void => {
        queued.delete(handle);
      },
      run: (): void => {
        const pending = [...queued.values()];
        queued.clear();
        pending.forEach((cb) => cb());
      },
      size: (): number => queued.size,
    };
  };

  it('delivers only the newest position once per frame', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const throttle = createFrameThrottle<number>(run, frames.schedule, frames.unschedule);

    throttle.post(1);
    throttle.post(2);
    throttle.post(3);
    // Every move would otherwise be its own IPC round trip.
    expect(run).not.toHaveBeenCalled();
    expect(frames.size()).toBe(1);
    frames.run();
    expect(run.mock.calls).toEqual([[3]]);
  });

  it('schedules again after the frame ran', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const throttle = createFrameThrottle<number>(run, frames.schedule, frames.unschedule);
    throttle.post(1);
    frames.run();
    throttle.post(2);
    frames.run();
    expect(run.mock.calls).toEqual([[1], [2]]);
  });

  it('runs nothing after a cancel', () => {
    const frames = fakeFrames();
    const run = vi.fn();
    const throttle = createFrameThrottle<number>(run, frames.schedule, frames.unschedule);
    throttle.post(1);
    throttle.cancel();
    frames.run();
    expect(run).not.toHaveBeenCalled();
    // And the next post still schedules — cancel ends a gesture, not the hook.
    throttle.post(2);
    frames.run();
    expect(run.mock.calls).toEqual([[2]]);
  });
});
