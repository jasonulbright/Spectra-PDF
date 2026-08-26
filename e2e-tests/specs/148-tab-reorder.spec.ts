import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  deleteSelectedCanvasPages,
  getState,
  getWorkspacePageIds,
  invokeAppCommand,
  openByPaths,
  pressGlobalKey,
  selectCanvasPages,
  setView,
  tabDragDrop,
  tabDragTrack,
  waitForDisplayedSelector,
  waitForHarness,
  type PhysicalScreenPoint,
} from '../support/harness.js';
import { SESSION_FILE } from '../support/app-data.js';

/**
 * Tab order is the user's order.
 *
 * Within one window the whole gesture is drivable as a REAL pointer drag — it
 * never crosses a window edge, so nothing here needs OS-level input and no seam
 * is used: pointerdown on the tab, past the 6 px threshold, released over the
 * strip it started in. That release asks the far side nothing at all. The strip
 * measured the gap itself, because the alternative is a round trip that answers
 * from a rectangle this window published about geometry this window measured.
 *
 * Across windows the caret is the promise and the drop has to honour it: the
 * hovered window derives the gap from its OWN tabs and reports it, and the
 * document arrives at that position rather than at the end of the lane. That
 * half still goes through the seam directly above the pointer, for the reason
 * `146-tab-drag` gives — a real drag between two windows needs input this
 * driver cannot inject — and, like that spec, it has to TEAR OFF a window
 * before it can aim at one: every workspace window is built centred at one
 * size, so two of them stack exactly and the source wins every shared point.
 *
 * `session.json` is read with Node's `fs` (the 147 pattern): the record is
 * written entirely on the Rust side from the claim table and the order each
 * window published, so asking the renderer about it would only prove what the
 * renderer believes.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf'); // 5 pages
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

/** Where the Rust side records window geometry, each window's paths, and the
 * order it holds them in. */
// `SESSION_FILE` is resolved from the binary's own container: see `support/app-data.ts`.

const TAB_STRIP = '[data-testid="tab-strip"]';
const DROP_CARET = '[data-testid="tab-drop-caret"]';
const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_CANCEL = '[data-testid="confirm-cancel"]';

interface SessionRecord {
  labelKind: 'main' | 'doc';
  files: string[];
}

interface WindowFrame {
  screenX: number;
  screenY: number;
  dpr: number;
  innerWidth: number;
  innerHeight: number;
  strip: { left: number; top: number; width: number; height: number };
  /** Every doc tab, viewport-relative CSS pixels, in strip order. */
  tabs: { path: string; left: number; width: number }[];
}

async function readFrame(): Promise<WindowFrame> {
  return await browser.execute<WindowFrame, [string]>(function (sel) {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    return {
      screenX: window.screenX,
      screenY: window.screenY,
      dpr: window.devicePixelRatio || 1,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      strip: { left: r.left, top: r.top, width: r.width, height: r.height },
      tabs: Array.from(document.querySelectorAll('[data-tab-path]')).map((tab) => {
        const box = (tab as HTMLElement).getBoundingClientRect();
        return {
          path: (tab as HTMLElement).getAttribute('data-tab-path') as string,
          left: box.left,
          width: box.width,
        };
      }),
    };
  }, TAB_STRIP);
}

/** What `physicalPointFor` makes of a CSS screen point. */
function physical(css: { x: number; y: number }, dpr: number): PhysicalScreenPoint {
  return { x: Math.round(css.x * dpr), y: Math.round(css.y * dpr) };
}

/** A point `cssX` into a window's strip, in CSS screen pixels. */
function stripCssPoint(frame: WindowFrame, cssX: number): { x: number; y: number } {
  return {
    x: frame.screenX + cssX,
    y: frame.screenY + frame.strip.top + frame.strip.height / 2,
  };
}

/** The same point, in the physical pixels the seam and the registry speak. */
function stripPoint(frame: WindowFrame, cssX: number): PhysicalScreenPoint {
  return physical(stripCssPoint(frame, cssX), frame.dpr);
}

/** A point inside a window's CONTENT, well below every strip. */
function contentPoint(frame: WindowFrame, cssDY: number): PhysicalScreenPoint {
  return physical({ x: frame.screenX + frame.innerWidth / 2, y: frame.screenY + cssDY }, frame.dpr);
}

/** Just past a tab's midpoint, which is the gap AFTER it. */
function pastMidpoint(frame: WindowFrame, index: number): number {
  const tab = frame.tabs[index];
  return tab.left + tab.width * 0.75;
}

async function tabPaths(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return Array.from(document.querySelectorAll('[data-tab-path]')).map(
      (el) => (el as HTMLElement).getAttribute('data-tab-path') as string,
    );
  });
}

/** The insertion gap this window is painting a caret in, or null. */
async function caretGap(): Promise<number | null> {
  return await browser.execute<number | null, [string]>(function (sel) {
    const value = (document.querySelector(sel) as HTMLElement | null)?.getAttribute(
      'data-tabdrag-gap',
    );
    return value === null || value === undefined ? null : Number(value);
  }, TAB_STRIP);
}

/** How many tabs are showing the dot that means unsaved work. */
async function dirtyTabCount(): Promise<number> {
  return await browser.execute<number, []>(function () {
    return document.querySelectorAll('[data-testid^="tab-dirty-"]').length;
  });
}

async function labelOfCurrentWindow(): Promise<string> {
  return await browser.execute<string, []>(function () {
    return (window as any).__SPECTRA_TEST__.windowLabel();
  });
}

/**
 * A real drag of a tab, held over a client x inside this window's own strip.
 *
 * pointerdown on the tab, then one move past the 6 px threshold. `screenX`/
 * `screenY` are what the gesture reports the pointer's position as, so they are
 * what decides where a release lands; `clientX` is what the ghost follows. Both
 * are given, because a gesture that agreed with itself about only one of them
 * would pass here while the shipped drag failed.
 */
async function dragTabTo(
  path: string,
  clientX: number,
  screen: { x: number; y: number },
): Promise<void> {
  await browser.execute(
    function (tabPath, toClientX, screenX, screenY) {
      const tab = document.querySelector(
        `[data-tab-path="${CSS.escape(tabPath)}"]`,
      ) as HTMLElement;
      const box = tab.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const init = (at: number, extra: Record<string, number>): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
        buttons: 1,
        clientX: at,
        clientY: y,
        screenX,
        screenY,
        ...extra,
      });
      tab.dispatchEvent(new PointerEvent('pointerdown', init(box.left + 8, { button: 0 })));
      window.dispatchEvent(new PointerEvent('pointermove', init(toClientX, { button: -1 })));
    },
    path,
    clientX,
    Math.round(screen.x),
    Math.round(screen.y),
  );
}

/** Let the held tab go where the pointer is. The release point is the pointer's
 * SCREEN position, which is the only thing the drop resolves from. */
async function releaseDragAt(clientX: number, screen: { x: number; y: number }): Promise<void> {
  await browser.execute(
    function (at, screenX, screenY) {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'mouse',
          button: 0,
          buttons: 0,
          clientX: at,
          clientY: 0,
          screenX,
          screenY,
        }),
      );
    },
    clientX,
    Math.round(screen.x),
    Math.round(screen.y),
  );
}

function readSession(): SessionRecord[] {
  expect(existsSync(SESSION_FILE)).toBe(true);
  return (JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as { windows: SessionRecord[] }).windows;
}

/** Poll the record until it says what the caller expects, reporting what it
 * last said when it never does — the record IS the assertion here. */
async function waitForSession(
  predicate: (windows: SessionRecord[]) => boolean,
  what: string,
): Promise<SessionRecord[]> {
  let last: SessionRecord[] = [];
  try {
    await browser.waitUntil(
      async () => {
        last = readSession();
        return predicate(last);
      },
      { timeout: 20_000, interval: 250 },
    );
  } catch {
    throw new Error(`${what} (last read ${JSON.stringify(last)})`);
  }
  return last;
}

const lower = (paths: string[]): string[] => paths.map((p) => p.toLowerCase());

async function waitForTabOrder(paths: string[], what: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const tabs = await tabPaths();
      return tabs.length === paths.length && tabs.every((tab, i) => tab === paths[i]);
    },
    { timeout: 30_000, interval: 200, timeoutMsg: what },
  );
}

async function waitForHandles(count: number): Promise<string[]> {
  let handles: string[] = [];
  await browser.waitUntil(
    async () => {
      handles = await browser.getWindowHandles();
      return handles.length === count;
    },
    { timeout: 30_000, interval: 250, timeoutMsg: `never saw ${count} window handles` },
  );
  return handles;
}

describe('tab reorder', () => {
  let mainHandle = '';
  let secondHandle = '';
  let alpha = '';
  let bravo = '';
  let charlie = '';
  let delta = '';

  it('boots one workspace window holding four documents in open order', async () => {
    await waitForHarness();
    const handles = await browser.getWindowHandles();
    expect(handles).toHaveLength(1);
    mainHandle = handles[0];
    expect(await labelOfCurrentWindow()).toBe('main');

    // Private copies: a claim is keyed by canonical path, so sharing a fixture
    // with the rest of the battery would make this spec order-dependent.
    const dir = mkdtempSync(resolve(tmpdir(), 'tab-reorder-'));
    alpha = resolve(dir, 'alpha.pdf');
    bravo = resolve(dir, 'bravo.pdf');
    charlie = resolve(dir, 'charlie.pdf');
    delta = resolve(dir, 'delta.pdf');
    copyFileSync(SAMPLE_PDF, alpha);
    copyFileSync(BOOKMARKED_PDF, bravo);
    copyFileSync(SAMPLE_PDF, charlie);
    copyFileSync(BOOKMARKED_PDF, delta);

    await openByPaths([alpha, bravo, charlie, delta]);
    await waitForTabOrder([alpha, bravo, charlie, delta], 'the four documents never opened');
  });

  it('a real drag inside one window moves the tab to the gap the caret marks', async () => {
    const frame = await readFrame();
    // Past charlie's midpoint: the gap after it, which for a tab dragged from
    // the front of the lane is the third position.
    const toClientX = pastMidpoint(frame, 2);
    const at = stripCssPoint(frame, toClientX);

    // The gesture, held: the caret follows the pointer to the gap the release
    // will honour, which is the whole difference from the end-of-lane caret
    // this replaced.
    await dragTabTo(alpha, toClientX, at);
    await browser.waitUntil(async () => (await caretGap()) === 3, {
      timeout: 15_000,
      timeoutMsg: 'the drag never painted a caret at the gap it was over',
    });
    expect(await $(DROP_CARET).isDisplayed()).toBe(true);

    // Released there. Nothing crossed a window boundary, so nothing was asked
    // of the far side and no document changed hands.
    await releaseDragAt(toClientX, at);
    await waitForTabOrder([bravo, charlie, alpha, delta], 'the dragged tab never moved');
    // And the caret stops being painted the moment the gesture ends.
    await browser.waitUntil(async () => (await caretGap()) === null, {
      timeout: 15_000,
      timeoutMsg: 'the caret survived the release',
    });
  });

  it('Escape mid-drag leaves the order exactly as it was', async () => {
    const before = await tabPaths();
    const frame = await readFrame();
    const toClientX = pastMidpoint(frame, 3);

    await dragTabTo(bravo, toClientX, stripCssPoint(frame, toClientX));
    await browser.waitUntil(async () => (await caretGap()) === 4, {
      timeout: 15_000,
      timeoutMsg: 'the cancelled drag never reached the gap it was aimed at',
    });

    await pressGlobalKey('Escape');
    await browser.waitUntil(async () => (await caretGap()) === null, {
      timeout: 15_000,
      timeoutMsg: 'the cancelled drag left a caret painted',
    });
    expect(await tabPaths()).toEqual(before);
  });

  it('a reorder writes nothing to disk and is not something to undo', async () => {
    const sizes = [alpha, bravo, charlie, delta].map((p) => readFileSync(p).length);
    const frame = await readFrame();
    // The seam, aimed at this window's own strip: the same release path the
    // pointer takes, so what it proves about writes is about the shipped drop.
    expect(await tabDragDrop(delta, stripPoint(frame, pastMidpoint(frame, 0)))).toBe(false);
    await waitForTabOrder([bravo, delta, charlie, alpha], 'the seam release never reordered');

    // Arrangement is not an edit: no file was written, and no document became
    // dirty — the dot a tab shows when it has unsaved work is on none of them.
    expect([alpha, bravo, charlie, delta].map((p) => readFileSync(p).length)).toEqual(sizes);
    expect(await dirtyTabCount()).toBe(0);
    expect((await getState()).fileCount).toBe(4);
    // Undo belongs to the documents, not to the strip: pressing it here must
    // not put the tab back, and must not reach past the arrangement into
    // whatever the user last actually did.
    await pressGlobalKey('z', { ctrl: true });
    await browser.pause(500);
    expect(await tabPaths()).toEqual([bravo, delta, charlie, alpha]);
  });

  it('records the arranged order in session.json, not the order it holds them in', async () => {
    // The paths come off the claim table, which answers sorted; the order
    // comes from what this window published. A restore reads this file, so the
    // arrangement has to survive in it or it does not survive at all.
    const arranged = await tabPaths();
    const record = await waitForSession(
      (windows) => {
        const main = windows.find((w) => w.labelKind === 'main');
        return (
          main !== undefined &&
          main.files.length === arranged.length &&
          lower(main.files).join('|') === lower(arranged).join('|')
        );
      },
      'session.json never recorded the arranged tab order',
    );
    const main = record.find((w) => w.labelKind === 'main')!;
    expect(lower(main.files)).toEqual(lower(arranged));
    // With teeth: the arrangement is not the sorted order the claim table
    // would have produced on its own.
    expect(lower(main.files)).not.toEqual(lower([...arranged].sort()));
  });

  it('a tear-off places a second window to aim at', async () => {
    // The only way a spec can put a window somewhere: freshly built windows
    // stack at one centred rect, so their strips share every point and the
    // source wins all of them.
    const frame = await readFrame();
    expect(await tabDragDrop(charlie, contentPoint(frame, frame.innerHeight / 2))).toBe(true);
    const handles = await waitForHandles(2);
    secondHandle = handles.find((h) => h !== mainHandle)!;

    await browser.switchToWindow(secondHandle);
    await waitForHarness(30_000);
    await waitForTabOrder([charlie], 'the torn-off document never arrived');
  });

  it('a drop from another window lands at the gap that window painted', async () => {
    const INSET = 8;
    await browser.switchToWindow(secondHandle);
    const target = await readFrame();
    const targetLabel = await labelOfCurrentWindow();
    // Left of the only tab's midpoint: the gap BEFORE it, which is the one
    // position an append could never produce.
    const aimAt = target.tabs[0].left + INSET;

    await browser.switchToWindow(mainHandle);
    const source = await readFrame();
    const point = stripPoint(target, aimAt);
    expect(await tabDragTrack(point)).toBe(targetLabel);
    expect(source.screenX).not.toBe(target.screenX);

    // The hovered window derives the gap from its OWN tabs and reports it —
    // this side sent an offset and nothing else.
    await browser.switchToWindow(secondHandle);
    await browser.waitUntil(async () => (await caretGap()) === 0, {
      timeout: 15_000,
      timeoutMsg: 'the hovered window never painted a caret at the first gap',
    });

    await browser.switchToWindow(mainHandle);
    expect(await tabDragDrop(alpha, point)).toBe(true);
    await waitForTabOrder([bravo, delta], 'the dragged document never left the source window');

    await browser.switchToWindow(secondHandle);
    // Before the document that was already there. Appending — what every open
    // that names no position does — would have put it after.
    await waitForTabOrder([alpha, charlie], 'the drop did not land where the caret promised');
  });

  it('gives the second window unsaved work, so an Exit has something to wait on', async () => {
    // The seal is only observable while the app is still running, and only a
    // window with a question to ask keeps it running: the initiating window
    // closes itself the moment the request is acknowledged.
    await browser.switchToWindow(secondHandle);
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(alpha));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the moved document never indexed in the window it arrived in',
    });
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });
  });

  it('an Exit taken straight after a reorder seals the order the user just made', async () => {
    // The defect: the order publishes through a serial channel that nothing
    // waits on, and Exit SEALS the session record. A reorder still waiting
    // behind an in-flight publish was therefore sealed over, and the restored
    // session arranged the tabs the way they were before the drag. Nothing
    // waits between the drag and the Exit here — no session poll, no pause —
    // because the wait is the bug.
    await browser.switchToWindow(mainHandle);
    const before = await tabPaths();
    expect(before).toHaveLength(2);
    const frame = await readFrame();
    const toClientX = pastMidpoint(frame, 1);
    await dragTabTo(before[0], toClientX, stripCssPoint(frame, toClientX));
    await releaseDragAt(toClientX, stripCssPoint(frame, toClientX));
    const arranged = [before[1], before[0]];
    await waitForTabOrder(arranged, 'the reorder before the exit never landed');

    expect(await invokeAppCommand('file.exit')).toBe(true);

    // Off the initiating window before anything else is awaited: it is clean,
    // so it closes itself, and a driver command against a closed handle is an
    // error rather than a slow answer.
    await browser.switchToWindow(secondHandle);
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 30_000 });
    await waitForHandles(1);

    // Read once, not polled: the record is frozen at the moment the exit was
    // decided, so a later write cannot rescue an order that was not in it.
    const sealed = readSession();
    const main = sealed.find((w) => w.labelKind === 'main');
    expect(main).toBeDefined();
    expect(lower(main!.files)).toEqual(lower(arranged));
    expect(lower(main!.files)).not.toEqual(lower(before));
  });

  it('leaves one window standing', async () => {
    // Cancelled, so the app survives the spec: the window that asked keeps
    // itself and everything else that was still open.
    await waitForDisplayedSelector(CONFIRM_CANCEL, { timeout: 15_000 });
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });
    // Undone, so the rest of the battery and the teardown see a clean document
    // rather than a second prompt.
    await pressGlobalKey('z', { ctrl: true });
    expect((await labelOfCurrentWindow()).startsWith('doc-')).toBe(true);
  });

  it('a reorder made in ANOTHER window is in the record the exit seals', async () => {
    // The case above is the initiating window's own flush. This is the half it
    // could not reach: the capture used to run before any peer was asked
    // anything, so a reorder made in window B was sealed over whenever window A
    // hit Exit — B only ever flushed when it heard the CLOSE request, which the
    // seal already preceded.
    //
    // The quit is two rounds now with the capture between them, and this is
    // what the first round is for: every peer finishes publishing what it has
    // measured and says so, and only then is the record taken.
    const peer = await browser.getWindowHandles();
    expect(peer).toHaveLength(1);
    const peerHandle = peer[0];

    // Unsaved work in the peer, so the app is still up when the sealed record
    // is read: the initiating window is clean and closes itself the moment its
    // request is acknowledged.
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(alpha));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the peer document never indexed',
    });
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });

    // The window the Exit comes from. It holds nothing, so nothing stops it.
    expect(await invokeAppCommand('window.newWindow')).toBe(true);
    const handles = await waitForHandles(2);
    const initiator = handles.find((h) => h !== peerHandle)!;
    await browser.switchToWindow(initiator);
    await waitForHarness(30_000);

    // Back in the peer: reorder, and then leave. Nothing is awaited between the
    // reorder and the Exit but the switch itself — the wait is the bug.
    await browser.switchToWindow(peerHandle);
    await setView('canvas');
    const before = await tabPaths();
    expect(before).toHaveLength(2);
    const frame = await readFrame();
    const toClientX = pastMidpoint(frame, 1);
    await dragTabTo(before[0], toClientX, stripCssPoint(frame, toClientX));
    await releaseDragAt(toClientX, stripCssPoint(frame, toClientX));
    const arranged = [before[1], before[0]];
    await waitForTabOrder(arranged, 'the peer reorder never landed');

    await browser.switchToWindow(initiator);
    expect(await invokeAppCommand('file.exit')).toBe(true);

    // Off the initiating window before anything else is awaited: it closes
    // itself, and a driver command against a closed handle is an error rather
    // than a slow answer.
    await browser.switchToWindow(peerHandle);
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 30_000 });
    await waitForHandles(1);

    // Read once, not polled: the record is frozen at the moment the exit was
    // decided, so a later write cannot rescue an order that was not in it.
    const sealed = readSession();
    const held = sealed.find((w) => w.files.length === arranged.length);
    expect(held).toBeDefined();
    expect(lower(held!.files)).toEqual(lower(arranged));
    expect(lower(held!.files)).not.toEqual(lower(before));

    // Cancelled, so the app survives the spec.
    await waitForDisplayedSelector(CONFIRM_CANCEL, { timeout: 15_000 });
    await $(CONFIRM_CANCEL).click();
    await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000, reverse: true });
    await pressGlobalKey('z', { ctrl: true });
  });
});
