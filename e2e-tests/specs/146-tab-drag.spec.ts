import { expect } from '@wdio/globals';
import { resolve } from 'node:path';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import {
  closeAllFiles,
  deleteSelectedCanvasPages,
  getState,
  getWorkspacePageIds,
  importPagesIntoDoc,
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

/**
 * Dragging a document tab from one workspace window into another.
 *
 * The gesture belongs to the source renderer and the geography belongs to
 * Rust: a held pointer keeps delivering to the window it started in, so the
 * source can follow the cursor anywhere but cannot say whose tab strip is
 * under it, nor who owns the document afterwards. Both answers come from the
 * strip registry and the claim table.
 *
 * A real cross-window drag needs OS-level input — injected synthetics are
 * renderer-local and never establish the capture the gesture depends on — so
 * the seam sits directly above the pointer: `tabDragDrop` is the function
 * pointerup calls, with the release point supplied, and `tabDragTrack` is the
 * call a throttled move makes. Everything below them (commit gate, resolution,
 * claim handover, the tab close, the target's open funnel) is the shipped
 * path. Escape is the one case driven as a real gesture, because only a live
 * arm state owns the key; it stays inside one window, since what crosses is
 * the tracked point rather than the pointer.
 *
 * **A tear-off comes first because it is the only way a spec can place a
 * window.** Every workspace window is built centred at one size, so two of
 * them stack exactly and their strips share every point — where the source
 * window wins by design, and no drop can ever reach the other. Dropping on
 * empty space puts the second window at a point of this spec's choosing, and
 * every later case aims at the strip that lands there.
 *
 * The caret case is the runtime cross-check the A2 probe could not finish on
 * this box: the offset Rust computes from its own registry is compared with
 * where the TARGET window's DOM says its strip is. Scaled and mixed-DPI
 * equality of `scale_factor` and `devicePixelRatio` is assumed throughout this
 * feature; this is where that assumption fails loudly if it ever breaks.
 *
 * What geometry can be driven from here, and what cannot: a tear-off performs
 * a real `set_position`, so the geometry case asserts the rectangle a window
 * was actually placed at against the file. A LIVE window can be neither moved
 * nor resized — the driver commands the WebView2 content, not the host window
 * (`setWindowRect` returns without touching it), and no command or harness
 * seam resizes a window. A relaunch cannot be asserted either: quitting seals
 * the file from the live windows, so a planted rectangle never survives to be
 * restored, and the only rectangle a relaunch could restore is the centred one
 * a fresh launch produces anyway. The placement arithmetic those cases would
 * exercise — the monitor-gone clamp, the work-area centring, what the
 * preference gates — is pinned by the Rust unit tests instead.
 */

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf'); // 5 pages
const BOOKMARKED_PDF = resolve(__dirname, '..', 'fixtures', 'bookmarked.pdf');

/** Where the Rust side records window geometry and each window's paths. */
const SESSION_FILE = resolve(process.env.APPDATA ?? '', 'com.spectrapdf.app', 'session.json');

const TAB_STRIP = '[data-testid="tab-strip"]';
const CONFIRM_MESSAGE = '[data-testid="confirm-message"]';
const CONFIRM_AFFIRM = '[data-testid="confirm-affirm"]';
const COMMIT_ERROR = '[data-testid="commit-error-bar"]';

/** How far inside the drop point a torn-off window is placed. */
const TEAR_OFF_INSET = 24;

interface SessionRecord {
  labelKind: 'main' | 'doc';
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  monitor: string;
  files: string[];
}

/**
 * A window's own view of where it is: its INNER origin (never the outer one —
 * the frame's title bar is taller than the gap between the strip and the
 * toolbar under it), its scale, its viewport and its strip box. Every point a
 * case aims at is computed from one of these, through the same arithmetic the
 * gesture itself uses.
 */
interface WindowFrame {
  screenX: number;
  screenY: number;
  dpr: number;
  innerWidth: number;
  innerHeight: number;
  strip: { left: number; top: number; width: number; height: number };
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
    };
  }, TAB_STRIP);
}

/** A point `cssDX` into a window's strip, in CSS screen pixels. */
function stripCssPoint(frame: WindowFrame, cssDX: number): { x: number; y: number } {
  return {
    x: frame.screenX + frame.strip.left + cssDX,
    y: frame.screenY + frame.strip.top + frame.strip.height / 2,
  };
}

/** What `physicalPointFor` makes of a CSS screen point. */
function physical(css: { x: number; y: number }, dpr: number): PhysicalScreenPoint {
  return { x: Math.round(css.x * dpr), y: Math.round(css.y * dpr) };
}

/**
 * A point inside a window's CONTENT, `cssDY` below its top — which is in no
 * strip at all, as long as no torn-off window has been parked at that depth.
 * Taking the point off a live window rather than off the screen's corners
 * keeps it on a monitor whatever the display arrangement is.
 */
function contentPoint(frame: WindowFrame, cssDY: number): PhysicalScreenPoint {
  return physical(
    { x: frame.screenX + frame.innerWidth / 2, y: frame.screenY + cssDY },
    frame.dpr,
  );
}

async function labelOfCurrentWindow(): Promise<string> {
  return await browser.execute<string, []>(function () {
    return (window as any).__SPECTRA_TEST__.windowLabel();
  });
}

/** The document tabs this window's strip is showing, in order. */
async function tabPaths(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return Array.from(document.querySelectorAll('[data-tab-path]')).map(
      (el) => (el as HTMLElement).getAttribute('data-tab-path') as string,
    );
  });
}

/** The insertion caret this window is painting, in its own CSS pixels. */
async function caretCssX(): Promise<number | null> {
  return await browser.execute<number | null, [string]>(function (sel) {
    const el = document.querySelector(sel) as HTMLElement | null;
    const value = el?.getAttribute('data-tabdrag-x');
    return value === null || value === undefined ? null : Number(value);
  }, TAB_STRIP);
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

async function waitForFileCount(count: number, what: string): Promise<void> {
  await browser.waitUntil(async () => (await getState()).fileCount === count, {
    timeout: 30_000,
    interval: 200,
    timeoutMsg: what,
  });
}

async function waitForTabs(paths: string[], what: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const tabs = await tabPaths();
      return tabs.length === paths.length && paths.every((p) => tabs.includes(p));
    },
    { timeout: 30_000, interval: 200, timeoutMsg: what },
  );
}

/**
 * Dismiss the "another window has this open" refusal.
 *
 * The dialog is a claim READ: it can only appear while some other window holds
 * the path, so a window that is refused is a window that does not own the
 * document — which is how a spec observes a handover that happened entirely
 * inside Rust.
 */
async function dismissClaimRefusal(name: string): Promise<void> {
  await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 15_000 });
  expect(await $(CONFIRM_MESSAGE).getText()).toContain(name);
  await $(CONFIRM_AFFIRM).click();
  await waitForDisplayedSelector(CONFIRM_MESSAGE, { timeout: 10_000, reverse: true });
}

function readSession(): SessionRecord[] {
  expect(existsSync(SESSION_FILE)).toBe(true);
  return (JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as { windows: SessionRecord[] }).windows;
}

const holds = (record: SessionRecord, path: string): boolean =>
  record.files.some((f) => f.toLowerCase() === path.toLowerCase());

/**
 * How many pages the file ON DISK has.
 *
 * The discriminator every reservation-gate case turns on: a hand-off writes the
 * source's working copy back over the user's own file between the reservation
 * and the commit, so the document the target opens has a different page count
 * from the one that was on disk when the gesture started.
 */
async function diskPageCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(path), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  return doc.getPageCount();
}

describe('cross-window tab drag', () => {
  let mainHandle = '';
  let secondHandle = '';
  /** The document torn off into the second window, and the one moved into it. */
  let tornPdf = '';
  let movedPdf = '';
  /** Stays in the first window, so both windows always have something open. */
  let keepPdf = '';
  let dirtyPdf = '';
  let ghostPdf = '';
  /** The reservation-gate block's own documents, opened after the cases above
   * have given every earlier fixture back. */
  let seedPdf = '';
  let handoffPdf = '';
  let tearPdf = '';
  let lockedPdf = '';

  it('boots one workspace window holding three documents', async () => {
    await waitForHarness();
    const handles = await browser.getWindowHandles();
    expect(handles).toHaveLength(1);
    mainHandle = handles[0];
    expect(await labelOfCurrentWindow()).toBe('main');

    // Private copies: a claim is keyed by canonical path, so sharing a fixture
    // with the rest of the battery would make this spec order-dependent.
    const dir = mkdtempSync(resolve(tmpdir(), 'tab-drag-'));
    tornPdf = resolve(dir, 'torn.pdf');
    movedPdf = resolve(dir, 'moved.pdf');
    keepPdf = resolve(dir, 'keep.pdf');
    dirtyPdf = resolve(dir, 'dirty.pdf');
    ghostPdf = resolve(dir, 'ghost.pdf');
    copyFileSync(SAMPLE_PDF, tornPdf);
    copyFileSync(BOOKMARKED_PDF, movedPdf);
    copyFileSync(SAMPLE_PDF, keepPdf);
    copyFileSync(SAMPLE_PDF, dirtyPdf);
    copyFileSync(BOOKMARKED_PDF, ghostPdf);

    await openByPaths([tornPdf, movedPdf, keepPdf]);
    await waitForFileCount(3, 'the first window never opened all three documents');
  });

  it('a drop on no strip at all tears off a window at the point', async () => {
    const frame = await readFrame();
    // Half way down the window's content: below every strip, and on a monitor
    // by construction.
    const point = contentPoint(frame, frame.innerHeight / 2);

    expect(await tabDragDrop(tornPdf, point)).toBe(true);
    const handles = await waitForHandles(2);
    secondHandle = handles.find((h) => h !== mainHandle)!;

    await waitForTabs([movedPdf, keepPdf], 'the torn-off document never left the first window');

    await browser.switchToWindow(secondHandle);
    await waitForHarness(30_000);
    expect((await labelOfCurrentWindow()).startsWith('doc-')).toBe(true);
    // Delivered through the pending-open queue and drained by the one open
    // funnel — the window had no renderer at all when the claim moved to it.
    await waitForFileCount(1, 'the torn-off document never arrived in its new window');
    expect((await getState()).activeFile?.path.toLowerCase()).toBe(tornPdf.toLowerCase());

    // Placed at the drop point, inset so the cursor lands inside the window
    // rather than on the corner it would resize from. A window is positioned
    // by its OUTER origin and reports its INNER one, so the border and the
    // title bar sit between the two.
    const placed = await readFrame();
    expect(Math.abs(placed.screenX * placed.dpr - (point.x - TEAR_OFF_INSET))).toBeLessThan(40);
    expect(Math.abs(placed.screenY * placed.dpr - (point.y - TEAR_OFF_INSET))).toBeLessThan(80);
  });

  it("a drop in another window's strip moves the document AND its claim", async () => {
    await browser.switchToWindow(secondHandle);
    const target = await readFrame();

    await browser.switchToWindow(mainHandle);
    const source = await readFrame();
    const point = physical(stripCssPoint(target, 40), source.dpr);

    expect(await tabDragDrop(movedPdf, point)).toBe(true);
    await waitForTabs([keepPdf], 'the dragged document never left the source window');

    // The tab closed WITHOUT releasing, because the receiving window already
    // owns the path: this window is now refused by the claim it just gave up.
    // Had the close released it, this open would succeed and two windows would
    // be editing private working copies of one file.
    await openByPaths([movedPdf]);
    await dismissClaimRefusal('moved.pdf');
    await browser.switchToWindow(mainHandle);
    expect(await tabPaths()).toEqual([keepPdf]);

    await browser.switchToWindow(secondHandle);
    await waitForTabs([tornPdf, movedPdf], 'the dragged document never arrived in the second window');
    expect((await getState()).activeFile?.path.toLowerCase()).toBe(movedPdf.toLowerCase());
  });

  it('gives each window its own engine answer for request id 4242 after the move', async () => {
    // The renderer's request-id counter is per window, so both windows number
    // from 1 and correlate a reply by that number alone. Moving a document
    // changes which window is waiting on which id; the Rust-side rewrite is
    // what stops one window resolving the other's promise with the wrong
    // file's answer — `get_page_count` echoes the file it read.
    const ID = 4242;

    await browser.switchToWindow(mainHandle);
    const mainWorking = (await getState()).activeFile!.workingPath;
    await browser.execute(
      function (path, id) {
        (window as any).__U5_MAIN = null;
        (window as any).__SPECTRA_TEST__.engineRequestWithId('get_page_count', { file: path }, id)
          .then((r: unknown) => { (window as any).__U5_MAIN = r; })
          .catch((e: unknown) => { (window as any).__U5_MAIN = { file: `error: ${String(e)}` }; });
      },
      mainWorking,
      ID,
    );

    await browser.switchToWindow(secondHandle);
    const movedWorking = (await getState()).activeFile!.workingPath;
    const movedResult = await browser.executeAsync<{ file: string }, [string, number]>(
      function (path, id, done) {
        (window as any).__SPECTRA_TEST__.engineRequestWithId('get_page_count', { file: path }, id)
          .then((r: unknown) => done(r as { file: string }))
          .catch((e: unknown) => done({ file: `error: ${String(e)}` }));
      },
      movedWorking,
      ID,
    );

    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(
      async () => Boolean(await browser.execute(() => (window as any).__U5_MAIN)),
      { timeout: 30_000, timeoutMsg: 'the first window never got its own engine reply' },
    );
    const mainResult = await browser.execute<{ file: string }, []>(function () {
      return (window as any).__U5_MAIN;
    });

    expect(mainResult.file).toBe(mainWorking);
    expect(movedResult.file).toBe(movedWorking);
    expect(mainWorking).not.toBe(movedWorking);
  });

  it('dragging the last tab out leaves the source window open and empty', async () => {
    // Give the second window a single document by moving one back — the
    // transfer in the other direction, which is also what leaves it with a
    // last tab to drag out.
    await browser.switchToWindow(mainHandle);
    const mainFrame = await readFrame();
    const backPoint = physical(stripCssPoint(mainFrame, 40), mainFrame.dpr);

    await browser.switchToWindow(secondHandle);
    expect(await tabDragDrop(movedPdf, backPoint)).toBe(true);
    await waitForTabs([tornPdf], 'the returned document never left the second window');

    // The only tab, dragged onto empty space.
    const point = contentPoint(mainFrame, mainFrame.innerHeight * 0.75);
    expect(await tabDragDrop(tornPdf, point)).toBe(true);
    const handles = await waitForHandles(3);

    // The user dragged a tab, not closed a window: this one stays, empty, and
    // quit-on-last is untouched — the app is still up on three windows.
    await waitForFileCount(0, 'the last document never left the window it was dragged out of');
    expect(await tabPaths()).toEqual([]);
    expect((await labelOfCurrentWindow()).startsWith('doc-')).toBe(true);

    const spawned = handles.find((h) => h !== mainHandle && h !== secondHandle)!;
    await browser.switchToWindow(spawned);
    await waitForHarness(30_000);
    await waitForFileCount(1, 'the last-tab document never arrived in its new window');
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(2);
    expect(await labelOfCurrentWindow()).toBe('main');
    expect(await tabPaths()).toContain(movedPdf);
  });

  it("a drop back on this window's own strip writes nothing and keeps the undo", async () => {
    // A drag that ends where it started is not a hand-off. It used to run the
    // whole move anyway — the working copy written over the user's own file and
    // the document marked saved, which discards its undo and redo history —
    // because the destination was only learned after the write.
    await browser.switchToWindow(mainHandle);
    await openByPaths([dirtyPdf]);
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(dirtyPdf));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });
    const onDisk = readFileSync(dirtyPdf).length;

    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });

    const own = await readFrame();
    expect(await tabDragDrop(dirtyPdf, physical(stripCssPoint(own, 40), own.dpr))).toBe(false);

    // The tab is still here, the file on disk is untouched, and the commit the
    // gate ran is still undoable. The page tier flushes into the WORKING copy,
    // which is a different write from overwriting the user's own file — only
    // the second one is what a move costs.
    expect(await tabPaths()).toContain(dirtyPdf);
    expect(readFileSync(dirtyPdf).length).toBe(onDisk);
    expect((await getState()).activeFile?.dirty).toBe(true);
    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the commit the drag ran could not be undone',
    });
    // Left open, clean and whole, which is where the next case starts.
    await browser.waitUntil(async () => (await getState()).activeFile?.dirty === false, {
      timeout: 30_000,
      timeoutMsg: 'the undo never took the document back to its saved state',
    });
  });

  it('a dirty page tier commits into the moved document; a refused commit keeps it here', async () => {
    await browser.switchToWindow(mainHandle);
    await openByPaths([dirtyPdf]);
    await setView('canvas');
    const ownPages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(dirtyPdf));
    await browser.waitUntil(async () => (await ownPages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });
    await selectCanvasPages([(await ownPages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await ownPages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });

    // Make the commit fail for real rather than stubbing it: every dirty file
    // is staged beside its working copy as `<working>.commit-tmp-N` before
    // anything is renamed into place, and a directory sitting on that name is
    // a write the OS refuses. The run counter advances per attempt, so the
    // first several names are blocked together.
    const working = (await getState()).activeFile!.workingPath;
    const blocked = [1, 2, 3, 4, 5].map((n) => `${working}.commit-tmp-${n}`);
    for (const dir of blocked) mkdirSync(dir, { recursive: true });

    await browser.switchToWindow(secondHandle);
    const target = await readFrame();
    await browser.switchToWindow(mainHandle);
    const source = await readFrame();
    const point = physical(stripCssPoint(target, 40), source.dpr);

    expect(await tabDragDrop(dirtyPdf, point)).toBe(false);
    // A refusal is a result: the notice says why, the document is still here
    // with its edits still pending, and nothing crossed.
    await waitForDisplayedSelector(COMMIT_ERROR, { timeout: 15_000 });
    expect(await tabPaths()).toContain(dirtyPdf);
    expect(await ownPages()).toHaveLength(4);

    // The claim did not move either — the other window is still refused by name.
    await browser.switchToWindow(secondHandle);
    await openByPaths([dirtyPdf]);
    await dismissClaimRefusal('dirty.pdf');
    await browser.switchToWindow(secondHandle);
    expect((await getState()).fileCount).toBe(0);

    // Unblock the staging and drop again: the commit runs, and what the other
    // window opens is the document as this one was showing it.
    for (const dir of blocked) rmSync(dir, { recursive: true, force: true });
    await browser.switchToWindow(mainHandle);
    expect(await tabDragDrop(dirtyPdf, point)).toBe(true);
    expect(await tabPaths()).not.toContain(dirtyPdf);

    await browser.switchToWindow(secondHandle);
    await waitForFileCount(1, 'the committed document never arrived in the second window');
    await browser.waitUntil(async () => (await getState()).activeFile?.pageCount === 4, {
      timeout: 30_000,
      timeoutMsg: 'the moved document did not carry its committed page edits',
    });

    // Leave the second window empty for the cases that follow.
    await closeAllFiles();
    await waitForFileCount(0, 'the second window never gave the document back up');
  });

  it('an import-only ghost never arms: it has no tab to arm from', async () => {
    await browser.switchToWindow(mainHandle);
    await setView('canvas');
    const hostPages = (await getWorkspacePageIds()).filter((id) => id.startsWith(keepPdf));
    expect(hostPages.length).toBeGreaterThan(0);
    const docId = hostPages[0].replace(/#p\d+$/, '#0');
    const before = (await getState()).fileCount;

    await importPagesIntoDoc(ghostPdf, docId, 0);
    await browser.waitUntil(async () => (await getState()).fileCount === before + 1, {
      timeout: 30_000,
      timeoutMsg: 'the import source was never registered',
    });

    // The source is a `files` entry with bytes and a read claim, and no tab.
    // Arming is a pointerdown on a TAB, so a ghost has no gesture surface at
    // all — and the read claim underneath it is not the exclusive write claim
    // a handover requires, so nothing below the gesture could move it either.
    const tabs = await tabPaths();
    expect(tabs).toContain(keepPdf);
    expect(tabs).not.toContain(ghostPdf);

    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(
      async () =>
        (await getWorkspacePageIds()).filter((id) => id.startsWith(keepPdf)).length ===
        hostPages.length,
      { timeout: 30_000, timeoutMsg: 'the import never undid' },
    );
  });

  it("the hover caret lands where the target window's own DOM says its strip is", async () => {
    // The A2 cross-check. Rust hit-tests a rectangle it holds in physical
    // screen pixels, anchored to `inner_position` and scaled by the publishing
    // window's device pixel ratio; the caret comes back as an offset the
    // target divides by ITS ratio. Aiming at a point computed from the
    // target's own DOM and requiring the caret to land on it is what proves
    // those scales are the same number — the half of A2 no probe could run on
    // this box.
    const INSET = 60;
    await browser.switchToWindow(secondHandle);
    const target = await readFrame();
    const targetLabel = await labelOfCurrentWindow();

    await browser.switchToWindow(mainHandle);
    const source = await readFrame();
    const point = physical(stripCssPoint(target, INSET), source.dpr);
    expect(await tabDragTrack(point)).toBe(targetLabel);

    await browser.switchToWindow(secondHandle);
    await browser.waitUntil(async () => (await caretCssX()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the hovered window never painted an insertion caret',
    });
    expect(Math.abs(((await caretCssX()) as number) - INSET)).toBeLessThanOrEqual(1);

    // Leaving every strip clears it, in the window that was drawing it.
    await browser.switchToWindow(mainHandle);
    expect(await tabDragTrack(contentPoint(source, source.innerHeight / 2))).toBeNull();
    await browser.switchToWindow(secondHandle);
    await browser.waitUntil(async () => (await caretCssX()) === null, {
      timeout: 15_000,
      timeoutMsg: 'the caret survived the pointer leaving the strip',
    });
  });

  it('Escape cancels a live drag with no cross-window effect', async () => {
    await browser.switchToWindow(secondHandle);
    const target = await readFrame();
    const targetFiles = (await getState()).fileCount;

    await browser.switchToWindow(mainHandle);
    const over = stripCssPoint(target, 80);
    // A real gesture this time — arm state, the 6 px threshold, the ghost, the
    // frame-throttled track — because Escape is owned only by a drag that is
    // actually running.
    await browser.execute(
      function (path, screenX, screenY) {
        const tab = document.querySelector(
          `[data-tab-path="${CSS.escape(path)}"]`,
        ) as HTMLElement;
        const box = tab.getBoundingClientRect();
        const init = (clientX: number, extra: Record<string, number>): PointerEventInit => ({
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'mouse',
          buttons: 1,
          clientX,
          clientY: box.top + box.height / 2,
          ...extra,
        });
        tab.dispatchEvent(new PointerEvent('pointerdown', init(box.left + 8, { button: 0 })));
        window.dispatchEvent(
          new PointerEvent('pointermove', init(box.left + 68, { button: -1, screenX, screenY })),
        );
      },
      keepPdf,
      over.x,
      over.y,
    );

    await browser.switchToWindow(secondHandle);
    await browser.waitUntil(async () => (await caretCssX()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'the live drag never reached the other window strip',
    });

    await browser.switchToWindow(mainHandle);
    await pressGlobalKey('Escape');

    await browser.switchToWindow(secondHandle);
    await browser.waitUntil(async () => (await caretCssX()) === null, {
      timeout: 15_000,
      timeoutMsg: 'the cancelled drag left a caret painted',
    });
    // Nothing crossed: the hovered window's documents are exactly what they
    // were before the drag started.
    expect((await getState()).fileCount).toBe(targetFiles);

    await browser.switchToWindow(mainHandle);
    expect(await tabPaths()).toContain(keepPdf);
  });

  it('records each window geometry and the paths it holds in session.json', async () => {
    await browser.switchToWindow(mainHandle);
    const frame = await readFrame();
    // A quarter of the way down: clear of every strip, including the one the
    // window torn off half way down is showing.
    const point = contentPoint(frame, frame.innerHeight / 4);
    expect(await tabDragDrop(keepPdf, point)).toBe(true);
    const handles = await waitForHandles(3);
    const spawned = handles.find((h) => h !== mainHandle && h !== secondHandle)!;
    await browser.switchToWindow(spawned);
    await waitForHarness(30_000);
    await waitForFileCount(1, 'the torn-off document never arrived');

    // The record is written from the Rust side, debounced behind the move that
    // produced it: no renderer is asked anything, so a window whose renderer
    // stopped answering still contributes its rectangle and its documents. The
    // wait is on the RECTANGLE, not on the record existing — a window is
    // recorded from the moment it is built, at the centred position it is
    // built at, and the position it was asked for lands a debounce later.
    let record: SessionRecord | undefined;
    try {
      await browser.waitUntil(
        async () => {
          record = readSession().find((w) => w.labelKind === 'doc' && holds(w, keepPdf));
          return (
            record !== undefined &&
            Math.abs(record.x - (point.x - TEAR_OFF_INSET)) <= 2 &&
            Math.abs(record.y - (point.y - TEAR_OFF_INSET)) <= 2
          );
        },
        { timeout: 20_000, interval: 500, timeoutMsg: 'never recorded' },
      );
    } catch {
      throw new Error(
        `session.json never recorded the torn-off window at the drop point ` +
          `(wanted ${point.x - TEAR_OFF_INSET},${point.y - TEAR_OFF_INSET}; ` +
          `last read ${JSON.stringify(record)})`,
      );
    }
    // The size is the window's INNER size against its OUTER origin, the pair
    // `set_position`/`set_size` read and write, so the frame cannot accumulate
    // across a save-and-restore round trip.
    expect(record!.width).toBeGreaterThan(0);
    expect(record!.height).toBeGreaterThan(0);

    const windows = readSession();

    // The main window is recorded first and by kind, because it is restored in
    // place while every other record builds a window with a fresh label.
    expect(windows[0].labelKind).toBe('main');
    expect(windows.filter((w) => w.labelKind === 'main')).toHaveLength(1);
    // Paths only: an id minted against one renderer's generation counter names
    // a different physical page in the next run.
    expect(JSON.stringify(windows)).not.toContain('#g');

    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(secondHandle);
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(1);
  });

  // ── The reservation gate: WHAT the target opens, and WHEN ────────────────
  //
  // A hand-off writes the source's working copy back over the user's own file
  // BETWEEN taking the reservation and committing it. The queued open is
  // therefore held out of the target's drain until the commit releases it: the
  // renderer drains on mount and on every open signal, and a drain that landed
  // in that window would open the bytes the write was about to replace — and
  // would take with it the queue entry a destruction rollback needs.
  //
  // The discriminator is the page count. Each case edits its document to a
  // count nothing else in this spec uses, so "the target opened the pre-move
  // bytes" and "the target opened what the move wrote" are different numbers
  // rather than the same file read twice.

  it('opens four fresh documents and places a window to hand them to', async () => {
    await browser.switchToWindow(mainHandle);
    await closeAllFiles();
    await waitForFileCount(0, 'the first window never gave its earlier documents up');

    const dir = mkdtempSync(resolve(tmpdir(), 'tab-drag-reserve-'));
    seedPdf = resolve(dir, 'seed.pdf');
    handoffPdf = resolve(dir, 'handoff.pdf');
    tearPdf = resolve(dir, 'tear.pdf');
    lockedPdf = resolve(dir, 'locked.pdf');
    for (const p of [seedPdf, handoffPdf, tearPdf, lockedPdf]) copyFileSync(SAMPLE_PDF, p);

    await openByPaths([seedPdf, handoffPdf, tearPdf, lockedPdf]);
    await waitForFileCount(4, 'the reservation-gate documents never opened');

    // A tear-off is still the only way to place a window somewhere this spec
    // can aim at, for the reason the file header gives.
    const frame = await readFrame();
    expect(await tabDragDrop(seedPdf, contentPoint(frame, frame.innerHeight / 2))).toBe(true);
    const handles = await waitForHandles(2);
    secondHandle = handles.find((h) => h !== mainHandle)!;
    await browser.switchToWindow(secondHandle);
    await waitForHarness(30_000);
    await waitForFileCount(1, 'the placed window never received the document that placed it');
  });

  it('a dirty document arrives in the other window as the bytes the move WROTE', async () => {
    await browser.switchToWindow(mainHandle);
    await openByPaths([handoffPdf]);
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(handoffPdf));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });

    // Two pages, so the count the target must report is one no other case in
    // this spec produces.
    const ids = await pages();
    await selectCanvasPages([ids[0], ids[1]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 3, {
      timeout: 30_000,
      timeoutMsg: 'the page deletes never landed in the page tier',
    });
    // The user's own file is untouched so far: the page tier flushes into the
    // WORKING copy, and writing that back over the path is what the MOVE costs.
    expect(await diskPageCount(handoffPdf)).toBe(5);

    await browser.switchToWindow(secondHandle);
    const target = await readFrame();
    await browser.switchToWindow(mainHandle);
    const source = await readFrame();
    const point = physical(stripCssPoint(target, 40), source.dpr);
    expect(await tabDragDrop(handoffPdf, point)).toBe(true);
    await waitForTabs([tearPdf, lockedPdf], 'the handed-off document never left the source window');

    // The move's write landed, and what the other window is showing is that
    // file — not the five-page document that was on disk when the drag began.
    expect(await diskPageCount(handoffPdf)).toBe(3);
    await browser.switchToWindow(secondHandle);
    await waitForFileCount(2, 'the handed-off document never arrived');
    // The arriving document is the one the window is showing.
    await browser.waitUntil(
      async () => {
        const active = (await getState()).activeFile;
        return active?.path.toLowerCase() === handoffPdf.toLowerCase() && active.pageCount === 3;
      },
      {
        timeout: 30_000,
        timeoutMsg: 'the receiving window opened bytes the hand-off had not written yet',
      },
    );
  });

  it('a dirty TEAR-OFF shows the edit, in a window that was built before the write', async () => {
    // The window a tear-off delivers to is built at the RESERVATION and mounts
    // — and drains — while the source is still writing. It is the case the
    // gate exists for: a drain that took the entry there would open the file
    // as it stood before the move, in a window with no way to be told.
    await browser.switchToWindow(mainHandle);
    await openByPaths([tearPdf]);
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(tearPdf));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });
    expect(await diskPageCount(tearPdf)).toBe(5);

    const frame = await readFrame();
    expect(await tabDragDrop(tearPdf, contentPoint(frame, frame.innerHeight * 0.75))).toBe(true);
    const handles = await waitForHandles(3);
    const torn = handles.find((h) => h !== mainHandle && h !== secondHandle)!;

    expect(await diskPageCount(tearPdf)).toBe(4);
    await browser.switchToWindow(torn);
    await waitForHarness(30_000);
    await waitForFileCount(1, 'the torn-off document never arrived in its new window');
    await browser.waitUntil(async () => (await getState()).activeFile?.pageCount === 4, {
      timeout: 30_000,
      timeoutMsg: 'the torn-off window opened the file as it stood before the move',
    });

    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(2);
  });

  it('a hand-off whose write fails delivers nothing and gives the document back', async () => {
    // The other half of the gate. The reservation moves the claim and queues
    // the open BEFORE the write; when the write then fails there is a document
    // owned by a window that must never open it. Nothing may be delivered, and
    // the source has to get its document back — which is what the release the
    // failure path takes is for.
    await browser.switchToWindow(mainHandle);
    await openByPaths([lockedPdf]);
    await setView('canvas');
    const pages = async (): Promise<string[]> =>
      (await getWorkspacePageIds()).filter((id) => id.startsWith(lockedPdf));
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the document never indexed',
    });
    await selectCanvasPages([(await pages())[0]]);
    await deleteSelectedCanvasPages();
    await browser.waitUntil(async () => (await pages()).length === 4, {
      timeout: 30_000,
      timeoutMsg: 'the page delete never landed in the page tier',
    });

    // Make the write fail for real rather than stubbing it: the move copies the
    // working copy over the user's own path, and a read-only destination is a
    // copy the OS refuses.
    chmodSync(lockedPdf, 0o444);

    await browser.switchToWindow(secondHandle);
    const target = await readFrame();
    const targetFiles = (await getState()).fileCount;
    await browser.switchToWindow(mainHandle);
    const source = await readFrame();
    const point = physical(stripCssPoint(target, 40), source.dpr);

    let failed = '';
    try {
      await tabDragDrop(lockedPdf, point);
    } catch (e) {
      failed = String(e);
    } finally {
      chmodSync(lockedPdf, 0o666);
    }
    expect(failed).not.toBe('');

    // Nothing crossed: the tab is still here with its page edits pending, and
    // the file the write could not reach is the file it always was.
    expect(await tabPaths()).toContain(lockedPdf);
    expect(await pages()).toHaveLength(4);
    expect(await diskPageCount(lockedPdf)).toBe(5);

    // And the claim came back with it — the other window is refused by name,
    // which it could not be if the reservation had left the path owned there.
    await browser.switchToWindow(secondHandle);
    expect((await getState()).fileCount).toBe(targetFiles);
    await openByPaths([lockedPdf]);
    await dismissClaimRefusal('locked.pdf');
    await browser.switchToWindow(secondHandle);
    expect((await getState()).fileCount).toBe(targetFiles);

    // Leave the document as the rest of the file found it.
    await browser.switchToWindow(mainHandle);
    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(async () => (await pages()).length === 5, {
      timeout: 30_000,
      timeoutMsg: 'the commit the failed hand-off ran could not be undone',
    });
    await browser.switchToWindow(secondHandle);
    await browser.execute(() => {
      void (window as any).__SPECTRA_TEST__.closeThisWindow();
    });
    await browser.switchToWindow(mainHandle);
    await waitForHandles(1);
  });
});
