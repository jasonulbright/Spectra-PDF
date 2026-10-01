// The first-paint signal is what makes the window visible, so it must fire
// exactly once, a full frame after the mount, and must never propagate a
// failure into boot.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { rendererReady: vi.fn() },
}));

import {
  defaultFrameEnv,
  HIDDEN_FRAME_MS,
  scheduleFrame,
  signalFirstPaint,
  type FrameEnv,
} from '../src/renderer/lib/first-paint';
import { resetPlatformCapabilities, setPlatformCapabilities } from '../src/renderer/lib/platform-capabilities';

afterEach(() => {
  resetPlatformCapabilities();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A manual frame clock: nothing runs until a frame is actually produced. */
function frames() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
    },
    tick: () => {
      const due = queue.splice(0, queue.length);
      due.forEach((cb) => {
        cb();
      });
    },
  };
}

function drain(queue: Array<() => void>): void {
  queue.splice(0, queue.length).forEach((f) => {
    f();
  });
}

/** Manual frame and timer queues behind a `FrameEnv`. */
function manualEnv(opts: { hidden: boolean; framesWhileHidden: boolean }) {
  const frameQueue: Array<() => void> = [];
  const timerQueue: Array<() => void> = [];
  const env: FrameEnv = {
    frame: (cb) => {
      frameQueue.push(cb);
    },
    timer: (cb, ms) => {
      expect(ms).toBe(HIDDEN_FRAME_MS);
      timerQueue.push(cb);
    },
    hidden: () => opts.hidden,
    framesWhileHidden: () => opts.framesWhileHidden,
  };
  return {
    env,
    frameQueue,
    timerQueue,
    tickFrames: () => {
      drain(frameQueue);
    },
    tickTimers: () => {
      drain(timerQueue);
    },
  };
}

describe('signalFirstPaint', () => {
  it('waits a second frame before reporting', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const clock = frames();
    signalFirstPaint(clock.schedule, notify);
    expect(notify).not.toHaveBeenCalled();
    clock.tick();
    // One frame in: the commit's frame has been produced, the content it
    // carries has not been composited yet.
    expect(notify).not.toHaveBeenCalled();
    clock.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('reports once, not once per later frame', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const clock = frames();
    signalFirstPaint(clock.schedule, notify);
    clock.tick();
    clock.tick();
    clock.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected signal', () => {
    const notify = vi.fn().mockRejectedValue(new Error('unknown command'));
    const clock = frames();
    signalFirstPaint(clock.schedule, notify);
    clock.tick();
    expect(() => {
      clock.tick();
    }).not.toThrow();
  });

  it('swallows a bridge that is not there at all', () => {
    const notify = vi.fn(() => {
      throw new Error('no bridge');
    });
    const clock = frames();
    signalFirstPaint(clock.schedule, notify as unknown as () => Promise<unknown>);
    clock.tick();
    expect(() => {
      clock.tick();
    }).not.toThrow();
  });

  it('reports after two frames and never arms a timer where hidden views produce frames', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const m = manualEnv({ hidden: true, framesWhileHidden: true });
    signalFirstPaint((cb) => {
      scheduleFrame(cb, m.env);
    }, notify);
    expect(m.timerQueue).toHaveLength(0);
    m.tickFrames();
    expect(notify).not.toHaveBeenCalled();
    expect(m.timerQueue).toHaveLength(0);
    m.tickFrames();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('reports after two timer steps where a hidden view produces no frames', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const m = manualEnv({ hidden: true, framesWhileHidden: false });
    signalFirstPaint((cb) => {
      scheduleFrame(cb, m.env);
    }, notify);
    m.tickTimers();
    expect(notify).not.toHaveBeenCalled();
    m.tickTimers();
    expect(notify).toHaveBeenCalledTimes(1);
    // A frame that arrives late must not report a second time.
    m.tickFrames();
    m.tickFrames();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('default scheduler: a hidden document is frame-only unless the report lacks hidden frames', () => {
    vi.useFakeTimers();
    const rafQueue: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    const framesOnly = vi.fn().mockResolvedValue(undefined);
    signalFirstPaint(undefined, framesOnly);
    vi.advanceTimersByTime(HIDDEN_FRAME_MS * 4);
    expect(framesOnly).not.toHaveBeenCalled();
    drain(rafQueue);
    expect(framesOnly).not.toHaveBeenCalled();
    drain(rafQueue);
    expect(framesOnly).toHaveBeenCalledTimes(1);

    setPlatformCapabilities({ hiddenAnimationFrames: false });
    const timed = vi.fn().mockResolvedValue(undefined);
    signalFirstPaint(undefined, timed);
    vi.advanceTimersByTime(HIDDEN_FRAME_MS);
    expect(timed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HIDDEN_FRAME_MS);
    expect(timed).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleFrame', () => {
  it('waits only for a frame while the document is visible', () => {
    const cb = vi.fn();
    const m = manualEnv({ hidden: false, framesWhileHidden: false });
    scheduleFrame(cb, m.env);
    expect(m.timerQueue).toHaveLength(0);
    m.tickFrames();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('never arms the timer where hidden views produce frames, even while hidden', () => {
    const cb = vi.fn();
    const m = manualEnv({ hidden: true, framesWhileHidden: true });
    scheduleFrame(cb, m.env);
    expect(m.timerQueue).toHaveLength(0);
    m.tickFrames();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('runs on the timer when a hidden view produces no frame', () => {
    const cb = vi.fn();
    const m = manualEnv({ hidden: true, framesWhileHidden: false });
    scheduleFrame(cb, m.env);
    m.tickTimers();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('runs once when both the frame and the timer arrive', () => {
    const cb = vi.fn();
    const m = manualEnv({ hidden: true, framesWhileHidden: false });
    scheduleFrame(cb, m.env);
    m.tickFrames();
    m.tickTimers();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('defaultFrameEnv', () => {
  it('reads hidden from the document visibility state', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    expect(defaultFrameEnv.hidden()).toBe(true);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    expect(defaultFrameEnv.hidden()).toBe(false);
    vi.stubGlobal('document', undefined);
    expect(defaultFrameEnv.hidden()).toBe(false);
  });

  it('reads hidden-frame production from the platform capability report', () => {
    expect(defaultFrameEnv.framesWhileHidden()).toBe(true);
    setPlatformCapabilities({ hiddenAnimationFrames: false });
    expect(defaultFrameEnv.framesWhileHidden()).toBe(false);
  });
});
