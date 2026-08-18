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
  createSerialPublisher,
  flushTabOrder,
  gapIndexFor,
  gapOffsetFor,
  hoverCssX,
  ownStripX,
  physicalPointFor,
  pinGhost,
  planHandOff,
  releaseDrag,
  reorderIndexFor,
  reservationHolds,
  setTabOrderChannel,
  settleDrop,
  stripRectFor,
  tabGapFor,
  tabMoved,
  type ArmRequest,
  type OwnStripFrame,
  type TabBox,
  type TabDragState,
} from '../src/renderer/lib/tab-drag';
import type { TabDragReservation, TabDragResult } from '../src/renderer/lib/tauri-bridge';

/** The pointer that arms every gesture here. */
const POINTER = 7;
/** A second input device — another finger, a pen — touching the same window. */
const OTHER_POINTER = 9;

const press = (over: Partial<ArmRequest> = {}): ArmRequest => ({
  path: 'C:\\docs\\a.pdf',
  pointerId: POINTER,
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
  return advanceDrag(armed, POINTER, 100 + TAB_DRAG_THRESHOLD_PX, 10).state;
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
    const short = advanceDrag(armed, POINTER, 100 + TAB_DRAG_THRESHOLD_PX - 1, 10);
    expect(short.state.phase).toBe('armed');
    expect(short.started).toBe(false);
    expect(short.tracking).toBe(false);

    const far = advanceDrag(armed, POINTER, 100 + TAB_DRAG_THRESHOLD_PX, 10);
    expect(far.state.phase).toBe('dragging');
    expect(far.started).toBe(true);
    expect(far.tracking).toBe(true);
  });

  it('measures travel in both axes, not one', () => {
    const armed = armDrag(NO_DRAG, press());
    // 3px across and 3px down is 4.24px of travel — still a click.
    expect(advanceDrag(armed, POINTER, 103, 13).state.phase).toBe('armed');
    // 5px and 5px is 7.07px — a drag.
    expect(advanceDrag(armed, POINTER, 105, 15).state.phase).toBe('dragging');
  });

  it('reports the start exactly once', () => {
    const first = advanceDrag(armDrag(NO_DRAG, press()), POINTER, 200, 10);
    expect(first.started).toBe(true);
    const second = advanceDrag(first.state, POINTER, 300, 10);
    expect(second.started).toBe(false);
    expect(second.tracking).toBe(true);
  });

  it('ignores moves that never armed', () => {
    const idle = advanceDrag(NO_DRAG, POINTER, 900, 900);
    expect(idle.state).toBe(NO_DRAG);
    expect(idle.tracking).toBe(false);
  });
});

describe('the armed pointer owns the gesture', () => {
  // A tab held under one finger while a second finger moves elsewhere on the
  // screen: the second finger's events must not drive the first one's drag.
  it('a foreign move neither arms the drag nor reports a position', () => {
    const armed = armDrag(NO_DRAG, press());
    const foreign = advanceDrag(armed, OTHER_POINTER, 900, 900);
    expect(foreign.state).toBe(armed);
    expect(foreign.started).toBe(false);
    expect(foreign.tracking).toBe(false);
  });

  it('a foreign move does not track a drag that is already running', () => {
    const live = dragging();
    const foreign = advanceDrag(live, OTHER_POINTER, 900, 900);
    expect(foreign.tracking).toBe(false);
    // And the pointer that owns it still does.
    expect(advanceDrag(live, POINTER, 900, 900).tracking).toBe(true);
  });

  it('a foreign release leaves the gesture running rather than dropping it', () => {
    const live = dragging();
    const foreign = releaseDrag(live, OTHER_POINTER);
    expect(foreign.foreign).toBe(true);
    expect(foreign.drop).toBe(false);
    expect(foreign.state).toBe(live);
    // The gesture is still there for the pointer that owns it.
    expect(releaseDrag(live, POINTER).drop).toBe(true);
  });

  it('a foreign release does not dissolve an armed press either', () => {
    const armed = armDrag(NO_DRAG, press());
    const foreign = releaseDrag(armed, OTHER_POINTER);
    expect(foreign.foreign).toBe(true);
    expect(foreign.state).toBe(armed);
  });

  it('a foreign pointercancel cancels nothing', () => {
    const live = dragging();
    const foreign = cancelDrag(live, OTHER_POINTER);
    expect(foreign.state).toBe(live);
    expect(foreign.notify).toBe(false);
    // The owning pointer's cancellation still ends it, and still tells the
    // window drawing a caret to stop.
    const mine = cancelDrag(live, POINTER);
    expect(mine.state).toBe(NO_DRAG);
    expect(mine.notify).toBe(true);
  });

  it('a cancel that belongs to no pointer — Escape, teardown — always applies', () => {
    const cancelled = cancelDrag(dragging());
    expect(cancelled.state).toBe(NO_DRAG);
    expect(cancelled.notify).toBe(true);
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
    // And that second press can still become a real drag — under its own
    // pointer, which is now the one the gesture answers to.
    expect(advanceDrag(again, 8, 400, 10).state.phase).toBe('dragging');
    expect(advanceDrag(again, POINTER, 400, 10).state.phase).toBe('armed');
  });

  it('clears the far side when the drag had already started', () => {
    const cancelled = cancelDrag(dragging());
    expect(cancelled.state).toBe(NO_DRAG);
    expect(cancelled.notify).toBe(true);
  });

  it('cannot cancel a drop already resolving', () => {
    const dropping = releaseDrag(dragging(), POINTER).state;
    const cancelled = cancelDrag(dropping);
    expect(cancelled.state).toBe(dropping);
    expect(cancelled.notify).toBe(false);
  });

  it('cannot re-arm over a drop already resolving', () => {
    const dropping = releaseDrag(dragging(), POINTER).state;
    // The commit gate and the handover are running against this path; a press
    // on another tab must not steal the state they are using.
    const state = armDrag(dropping, press({ path: 'C:\\docs\\b.pdf' }));
    expect(state).toBe(dropping);
    expect(state.path).toBe('C:\\docs\\a.pdf');
  });
});

describe('release', () => {
  it('resolves a drop and names the document', () => {
    const released = releaseDrag(dragging(), POINTER);
    expect(released.drop).toBe(true);
    expect(released.path).toBe('C:\\docs\\a.pdf');
    expect(released.state.phase).toBe('dropping');
    expect(released.foreign).toBe(false);
  });

  it('lets an untravelled press through as an ordinary click', () => {
    const released = releaseDrag(armDrag(NO_DRAG, press()), POINTER);
    expect(released.drop).toBe(false);
    expect(released.path).toBe('');
    expect(released.state).toBe(NO_DRAG);
    expect(released.foreign).toBe(false);
  });

  it('settles only what was dropping', () => {
    expect(settleDrop(releaseDrag(dragging(), POINTER).state)).toBe(NO_DRAG);
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
  it('scales the CSS box and carries no screen origin at all', () => {
    // The origin is read on the far side, under the lock it re-anchors with.
    // Composing here from a separately sampled origin is what leaves the drop
    // rect offset for good when the window moves between the two reads.
    expect(stripRectFor({ left: 0, top: 64, width: 884, height: 32 }, 1)).toEqual({
      x: 0,
      y: 64,
      width: 884,
      height: 32,
    });
  });

  it('scales every side by the publishing window ratio', () => {
    expect(stripRectFor({ left: 10, top: 20, width: 400, height: 32 }, 1.5)).toEqual({
      x: 15,
      y: 30,
      width: 600,
      height: 48,
    });
  });

  it('collapses a strip with no area so it can never take a drop', () => {
    // Reading mode unmounts the strip; a hidden element measures zero.
    expect(stripRectFor({ left: 0, top: 0, width: 884, height: 0 }, 1)).toBe(EMPTY_STRIP);
    expect(stripRectFor({ left: 0, top: 0, width: 0, height: 32 }, 1)).toBe(EMPTY_STRIP);
  });
});

describe('hand-off plan', () => {
  // The defect this pins: a drag that ended where it started used to run the
  // full move — the working copy written over the user's own file and the
  // document marked saved, which discards its undo and redo history.
  it('writes nothing at all when the release stays in this window', () => {
    expect(planHandOff(false, true)).toEqual({ hand: false, saveFirst: false });
    expect(planHandOff(false, false)).toEqual({ hand: false, saveFirst: false });
  });

  it('writes the file back only for a document that is actually leaving', () => {
    expect(planHandOff(true, true)).toEqual({ hand: true, saveFirst: true });
  });

  it('hands over a clean document without writing it', () => {
    expect(planHandOff(true, false)).toEqual({ hand: true, saveFirst: false });
  });
});

describe('reservations', () => {
  const reserved = (
    outcome: TabDragResult['outcome'],
    token: number,
  ): TabDragReservation => ({
    outcome,
    label: token === 0 ? '' : 'doc-1',
    owner: outcome === 'refused' ? 'doc-2' : '',
    token,
  });

  // The defect this pins is the successor to the one above: the release used to
  // be CLASSIFIED and then resolved a second time, with the write in between.
  // Whatever the second answer was, the file had already been written over and
  // the document marked saved — so a release the far side then resolved as a
  // same-window drop, or refused, had cost the user their undo history for a
  // document that never moved. Only a held destination is written for.
  it('writes the file only for a destination that is actually held', () => {
    expect(planHandOff(reservationHolds(reserved('transferred', 4)), true)).toEqual({
      hand: true,
      saveFirst: true,
    });
    expect(planHandOff(reservationHolds(reserved('tornOff', 9)), true)).toEqual({
      hand: true,
      saveFirst: true,
    });
  });

  it('holds nothing when the release stayed in this window or was refused', () => {
    expect(reservationHolds(reserved('sameWindow', 0))).toBe(false);
    expect(reservationHolds(reserved('refused', 0))).toBe(false);
    expect(planHandOff(reservationHolds(reserved('sameWindow', 0)), true)).toEqual({
      hand: false,
      saveFirst: false,
    });
  });

  it('treats a move that named no token as holding nothing', () => {
    // There is nothing to commit and nothing to cancel, so there is nothing to
    // write the user's file for either.
    expect(reservationHolds(reserved('transferred', 0))).toBe(false);
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

describe('insertion gaps', () => {
  /**
   * A real strip, measured out of the running app: the Home button then four
   * doc tabs, in CSS pixels from the strip's own left edge.
   *
   * Snapshot rather than round numbers, because the arithmetic has to hold for
   * the boxes the app actually produces — tabs are not a uniform width (a name
   * is as wide as it is, up to the cap) and the lane does not start at zero.
   */
  const STRIP: TabBox[] = [
    { left: 89, width: 132 },
    { left: 221, width: 96 },
    { left: 317, width: 220 },
    { left: 537, width: 104 },
  ];

  it('names the gap the pointer has passed the midpoint of', () => {
    // Before the first tab, and anywhere left of the lane.
    expect(gapIndexFor(STRIP, 0)).toBe(0);
    expect(gapIndexFor(STRIP, 89)).toBe(0);
    expect(gapIndexFor(STRIP, 154)).toBe(0);
    // The midpoint itself belongs to the gap after the tab, so a pointer
    // sitting exactly on it names one gap rather than flickering between two.
    expect(gapIndexFor(STRIP, 155)).toBe(1);
    expect(gapIndexFor(STRIP, 268)).toBe(1);
    expect(gapIndexFor(STRIP, 269)).toBe(2);
    expect(gapIndexFor(STRIP, 427)).toBe(3);
    expect(gapIndexFor(STRIP, 589)).toBe(4);
    // Past the last tab, and past the strip.
    expect(gapIndexFor(STRIP, 9000)).toBe(4);
  });

  it('paints the caret on the boundary the gap names', () => {
    expect(gapOffsetFor(STRIP, 0)).toBe(89);
    expect(gapOffsetFor(STRIP, 1)).toBe(221);
    expect(gapOffsetFor(STRIP, 3)).toBe(537);
    expect(gapOffsetFor(STRIP, 4)).toBe(641);
    // An index past either end still has to paint somewhere on the strip.
    expect(gapOffsetFor(STRIP, 40)).toBe(641);
    expect(gapOffsetFor(STRIP, -1)).toBe(89);
  });

  it('has an answer for a strip with no tabs at all', () => {
    // The window a last tab was dragged out of, and the window a tear-off
    // built: both take drops.
    expect(gapIndexFor([], 400)).toBe(0);
    expect(gapOffsetFor([], 0)).toBe(0);
    expect(tabGapFor([], 400)).toEqual({ index: 0, offset: 0 });
  });

  it('resolves a pointer to a gap and its caret in one step', () => {
    expect(tabGapFor(STRIP, 400)).toEqual({ index: 2, offset: 317 });
  });

  it('corrects for the dragged tab still being in the list', () => {
    // A gap counts the tabs before it, and the tab being dragged is one of
    // them: released past its own place, every tab it passed has already
    // shifted left by one. Dropped in either gap it already touches, it does
    // not move at all.
    expect(reorderIndexFor(0, 0)).toBe(0);
    expect(reorderIndexFor(0, 1)).toBe(0);
    expect(reorderIndexFor(0, 4)).toBe(3);
    expect(reorderIndexFor(3, 0)).toBe(0);
    expect(reorderIndexFor(2, 2)).toBe(2);
    expect(reorderIndexFor(2, 3)).toBe(2);
    expect(reorderIndexFor(2, 4)).toBe(3);
    // A document arriving from another window is not in the list yet, which is
    // why its gap IS its index and it never comes through here.
  });
});

describe('a point over this window own strip', () => {
  // A 1200×800 window at (100, 60) whose strip is 32 CSS px tall, 64 down.
  const frame = (over: Partial<OwnStripFrame> = {}): OwnStripFrame => ({
    originX: 100,
    originY: 60,
    devicePixelRatio: 1,
    strip: { left: 0, top: 64, width: 1200, height: 32 },
    ...over,
  });

  it('measures from the strip left edge', () => {
    expect(ownStripX({ x: 100, y: 130 }, frame())).toBe(0);
    expect(ownStripX({ x: 400, y: 130 }, frame())).toBe(300);
  });

  it('answers null for a point that is not over the strip', () => {
    // Above the strip is the window frame; below it is the toolbar, and a
    // release there is a hand-off the far side resolves.
    expect(ownStripX({ x: 400, y: 100 }, frame())).toBeNull();
    expect(ownStripX({ x: 400, y: 400 }, frame())).toBeNull();
    // Another monitor entirely.
    expect(ownStripX({ x: -900, y: 130 }, frame())).toBeNull();
  });

  it('is half-open on the far edges, exactly as the far side is', () => {
    // Two strips that abut share no point, so a release can never be inside
    // this one and inside the next.
    expect(ownStripX({ x: 100, y: 124 }, frame())).toBe(0);
    expect(ownStripX({ x: 1299, y: 155 }, frame())).toBe(1199);
    expect(ownStripX({ x: 1300, y: 130 }, frame())).toBeNull();
    expect(ownStripX({ x: 400, y: 156 }, frame())).toBeNull();
    expect(ownStripX({ x: 99, y: 130 }, frame())).toBeNull();
    expect(ownStripX({ x: 400, y: 123 }, frame())).toBeNull();
  });

  it('divides the physical point by this window own ratio', () => {
    // The point crosses in physical pixels precisely so no window's scale has
    // to travel with the drag.
    const scaled = frame({ devicePixelRatio: 2 });
    expect(ownStripX({ x: 800, y: 260 }, scaled)).toBe(300);
    expect(ownStripX({ x: 800, y: 200 }, scaled)).toBeNull();
  });

  it('cannot be over a strip with no area', () => {
    // Reading mode unmounts the strip; a hidden element measures zero, and the
    // far side has already forgotten this window.
    expect(ownStripX({ x: 400, y: 130 }, frame({ strip: { left: 0, top: 64, width: 0, height: 0 } }))).toBeNull();
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

describe('serial publisher', () => {
  const deferred = () => {
    const settle: Array<() => void> = [];
    const sent: number[] = [];
    const send = (value: number): Promise<void> => {
      sent.push(value);
      return new Promise<void>((resolve) => settle.push(resolve));
    };
    return { send, sent, settle };
  };

  it('keeps one publish outstanding at a time', async () => {
    const { send, sent, settle } = deferred();
    const publisher = createSerialPublisher(send);
    publisher.post(1);
    publisher.post(2);
    // Two in flight can be applied in either order, and the loser leaves a
    // stale rect standing until the next relayout.
    expect(sent).toEqual([1]);
    settle[0]();
    await Promise.resolve();
    expect(sent).toEqual([1, 2]);
  });

  it('publishes only the newest value that was waiting', async () => {
    const { send, sent, settle } = deferred();
    const publisher = createSerialPublisher(send);
    publisher.post(1);
    publisher.post(2);
    publisher.post(3);
    settle[0]();
    await Promise.resolve();
    expect(sent).toEqual([1, 3]);
  });

  it('publishes straight away once nothing is outstanding', async () => {
    const { send, sent, settle } = deferred();
    const publisher = createSerialPublisher(send);
    publisher.post(1);
    settle[0]();
    await Promise.resolve();
    publisher.post(2);
    expect(sent).toEqual([1, 2]);
  });

  it('keeps publishing after one is rejected', async () => {
    const sent: number[] = [];
    let fail: ((reason: Error) => void) | null = null;
    const publisher = createSerialPublisher<number>((value) => {
      sent.push(value);
      return value === 1 ? new Promise<void>((_, reject) => (fail = reject)) : Promise.resolve();
    });
    publisher.post(1);
    publisher.post(2);
    (fail as unknown as (reason: Error) => void)(new Error('no window origin'));
    await Promise.resolve();
    // A window that could not take one rect must still take the next: the
    // last one published is what says the strip is gone.
    expect(sent).toEqual([1, 2]);
  });

  // The defect this pins: the quit SEALS the session record and takes whatever
  // tab order arrived last, while the publisher's newest value can still be
  // waiting behind an in-flight publish. Exit right after a reorder therefore
  // persisted the arrangement the user had just changed. The flush is what the
  // exit path awaits before the seal — and the seal is the seal, so it has to
  // finish BEFORE, not be forgiven after.
  it('does not finish while the newest order is still waiting to be published', async () => {
    const { send, sent, settle } = deferred();
    const publisher = createSerialPublisher(send);
    publisher.post(1);
    publisher.post(2);
    expect(sent).toEqual([1]);

    let flushed = false;
    const done = publisher.flush().then(() => {
      flushed = true;
    });
    settle[0]();
    await Promise.resolve();
    // The second publish is only now in flight: finishing here would seal the
    // record on the order the reorder replaced.
    expect(sent).toEqual([1, 2]);
    expect(flushed).toBe(false);

    settle[1]();
    await done;
    expect(flushed).toBe(true);
  });

  it('finishes immediately when nothing is outstanding', async () => {
    const { send, sent, settle } = deferred();
    const publisher = createSerialPublisher(send);
    // An idle publisher must not make a quit wait for a publish that will
    // never be posted.
    await publisher.flush();
    publisher.post(1);
    settle[0]();
    await publisher.flush();
    expect(sent).toEqual([1]);
  });

  it('waits for an order posted while it is already flushing', async () => {
    const { send, sent, settle } = deferred();
    const publisher = createSerialPublisher(send);
    publisher.post(1);
    let flushed = false;
    const done = publisher.flush().then(() => {
      flushed = true;
    });
    publisher.post(2);
    settle[0]();
    await Promise.resolve();
    expect(flushed).toBe(false);
    settle[1]();
    await done;
    expect(sent).toEqual([1, 2]);
  });

  it('finishes on a publish that failed rather than waiting for one that cannot come', async () => {
    let fail: ((reason: Error) => void) | null = null;
    const publisher = createSerialPublisher<number>(
      () => new Promise<void>((_, reject) => (fail = reject)),
    );
    publisher.post(1);
    const done = publisher.flush();
    (fail as unknown as (reason: Error) => void)(new Error('no window'));
    // A window that cannot answer must not hold the quit open.
    await done;
  });
});

describe('the tab order flush', () => {
  it('is a no-op for a window whose strip never registered one', async () => {
    setTabOrderChannel(null);
    await flushTabOrder();
  });

  it('drains the strip publisher the exit path cannot reach itself', async () => {
    const sent: string[][] = [];
    const settle: Array<() => void> = [];
    const publisher = createSerialPublisher<string[]>((order) => {
      sent.push(order);
      return new Promise<void>((resolve) => settle.push(resolve));
    });
    setTabOrderChannel(publisher);
    try {
      publisher.post(['a', 'b']);
      // The reorder: the newest order is waiting behind the publish above it,
      // which is exactly the state Exit used to seal over.
      publisher.post(['b', 'a']);
      let flushed = false;
      const done = flushTabOrder().then(() => {
        flushed = true;
      });
      settle[0]();
      await Promise.resolve();
      expect(flushed).toBe(false);
      settle[1]();
      await done;
      expect(sent).toEqual([
        ['a', 'b'],
        ['b', 'a'],
      ]);
    } finally {
      setTabOrderChannel(null);
    }
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
