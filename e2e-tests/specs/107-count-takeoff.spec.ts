// N11 slice C — COUNT & TAKEOFF against the built binary.
//
// The decision under test is the annotation representation: a count mark is a
// real /Stamp carrying /IT /Count + /Subj + /SpectraSymbol, so the tallies are
// DERIVED from what the file holds rather than from app state. The load-bearing
// case is therefore the round trip — count, commit, save, reopen, and find the
// groups reconstituted from the document — plus the CLI's own reading of the
// same file, which is the third independent witness.
//
// Mechanics recorded by slices A and B and used here: measure the page cell
// AFTER arming a mode (the secondary toolbar reflows the canvas), never close
// a popover with Escape (the chain disarms the mode), and keep every gesture
// in the page's TOP BAND — a square page at the default zoom is taller than
// the pane, so a page coordinate much below 0.4 is off-viewport and WebDriver
// raises "move target out of bounds".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  getActiveDocPages,
  getCanvasDocs,
  getPageAnnotations,
  removeAnnotation,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
  takeoffSetGroups,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

const CTRL = String.fromCharCode(0xe009); // W3C Control key

const DOORS = { name: 'Doors', color: '#e0393e', symbol: 'square' };
const WINDOWS = { name: 'Windows', color: '#2f6fed', symbol: 'triangle' };

let tmp: string;
let src: string;
let docId: string;
let pageId: string;
let pr: { x: number; y: number; w: number; h: number };

async function blankFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  writeFileSync(path, await doc.save());
}

async function pageRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return (await browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number } | null;
}

/** Viewport pixels for a display-normalized page point. */
function at(p: [number, number]): { x: number; y: number } {
  return { x: Math.round(pr.x + pr.w * p[0]), y: Math.round(pr.y + pr.h * p[1]) };
}

async function clickPage(p: [number, number]): Promise<void> {
  const { x, y } = at(p);
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x, y })
    .down()
    .pause(40)
    .up()
    .pause(80)
    .perform();
}

async function ctrlMarquee(from: [number, number], to: [number, number]): Promise<void> {
  const a = at(from);
  const b = at(to);
  await browser.performActions([
    { type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: CTRL }] },
  ]);
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: a.x, y: a.y })
    .down()
    .pause(60)
    .move({ x: b.x, y: b.y })
    .pause(120)
    .up()
    .pause(80)
    .perform();
  await browser.performActions([
    { type: 'key', id: 'kb', actions: [{ type: 'keyUp', value: CTRL }] },
  ]);
  await browser.releaseActions();
}

async function marks(): Promise<
  { id: string; kind: string; countGroup?: string; countSeq?: number; countSymbol?: string; color: string }[]
> {
  const all = await getPageAnnotations(docId, pageId);
  return all.filter((a) => a.kind === 'count');
}

async function clearPage(): Promise<void> {
  for (const a of await getPageAnnotations(docId, pageId)) {
    await removeAnnotation(docId, pageId, a.id);
  }
}

describe('count & takeoff (N11 slice C)', () => {
  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-takeoff-'));
    src = resolve(tmp, 'plan.pdf');
    await blankFixture(src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await invokeAppCommand('view.documentView');
    // A persisted preference: seed it rather than inherit whatever the last
    // run left in localStorage, or the group NAMES drift between runs.
    await takeoffSetGroups([DOORS, WINDOWS], DOORS.name);
    // One command both seats the Takeoff panel in the dock and arms `count`
    // (an op's owning tool opens with it — the `ui.tool` rule).
    expect(await invokeAppCommand('tools.panel.takeoff')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    // AFTER arming: the mode opens the secondary toolbar, which moves the page.
    await browser.pause(400);
    pr = (await pageRect())!;
    const docs = await getCanvasDocs();
    docId = docs[0].id;
    pageId = (await getActiveDocPages())[0].id;
  });

  after(async () => {
    await browser.releaseActions();
    await invokeAppCommand('tools.close');
    await closeAllFiles();
  });

  it('a click places a mark of the ARMED group, numbered in sequence', async () => {
    await clearPage();
    await clickPage([0.2, 0.15]);
    await clickPage([0.35, 0.15]);
    await clickPage([0.5, 0.15]);
    const m = await marks();
    expect(m).toHaveLength(3);
    expect(m.every((x) => x.countGroup === 'Doors')).toBe(true);
    expect(m.every((x) => x.countSymbol === 'square')).toBe(true);
    expect(m.map((x) => x.countSeq)).toEqual([1, 2, 3]);
    expect(m[0].color.toLowerCase()).toBe(DOORS.color);
  });

  it('clicking a mark again UN-COUNTS it, and the next number does not reuse its own', async () => {
    // The sequence is a LABEL a user reads off the sheet: reusing 2 would put
    // two marks in the document claiming to be the same one.
    await clickPage([0.35, 0.15]);
    let m = await marks();
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.countSeq)).toEqual([1, 3]);
    await clickPage([0.65, 0.15]);
    m = await marks();
    expect(m.map((x) => x.countSeq)).toEqual([1, 3, 4]);
  });

  it('the panel tallies what is on the page, per group and in total', async () => {
    const doors = await $('[data-testid="takeoff-count-Doors"]');
    await doors.waitForDisplayed({ timeout: 10_000 });
    await browser.waitUntil(async () => (await doors.getText()).trim() === '3', {
      timeout: 10_000,
      timeoutMsg: 'the Doors tally never reached 3',
    });
    expect(await $('[data-testid="takeoff-total"]').getText()).toContain('3');
    // Windows has no marks yet — a group with nothing counted reads zero
    // rather than vanishing.
    expect((await $('[data-testid="takeoff-count-Windows"]').getText()).trim()).toBe('0');
  });

  it('a Ctrl-marquee re-files the marks it covers into the armed group', async () => {
    await $('[data-testid="takeoff-arm-Windows"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="takeoff-arm-Windows"]').getAttribute('aria-pressed')) === 'true',
      { timeout: 5_000, timeoutMsg: 'Windows never armed' },
    );
    await ctrlMarquee([0.1, 0.08], [0.45, 0.25]);
    const m = await marks();
    const moved = m.filter((x) => x.countGroup === 'Windows');
    // The two marks inside the band moved; the one at 0.65 did not.
    expect(moved).toHaveLength(1);
    expect(moved[0].countSymbol).toBe('triangle');
    expect(moved[0].color.toLowerCase()).toBe(WINDOWS.color);
    // Renumbered at the END of the target group — its old number belonged to
    // the group it left.
    expect(moved[0].countSeq).toBe(1);
    expect(m.filter((x) => x.countGroup === 'Doors')).toHaveLength(2);
  });

  it('Place legend stamps a snapshot table onto the page', async () => {
    await $('[data-testid="takeoff-place-legend"]').click();
    await browser.waitUntil(
      async () => (await getPageAnnotations(docId, pageId)).some((a) => a.kind === 'countlegend'),
      { timeout: 10_000, timeoutMsg: 'no legend was placed' },
    );
    await $('[data-testid="count-legend"]').waitForDisplayed({ timeout: 10_000 });
    const text = await $('[data-testid="count-legend"]').getText();
    expect(text).toContain('Doors');
    expect(text).toContain('Windows');
    expect(text).toContain('Total');
  });

  it('the marks survive save + reopen, reconstituted from the FILE', async () => {
    await commitPendingEdits();
    const saved = resolve(tmp, 'counted.pdf');
    await saveActiveAs(saved);
    await closeAllFiles();
    await openByPaths([saved]);
    await setView('canvas');
    await invokeAppCommand('view.documentView');
    const docs = await getCanvasDocs();
    const reopenedDoc = docs[0].id;
    const reopenedPage = (await getActiveDocPages())[0].id;
    await browser.waitUntil(
      async () =>
        (await getPageAnnotations(reopenedDoc, reopenedPage)).filter((a) => a.kind === 'count')
          .length === 3,
      { timeout: 20_000, timeoutMsg: 'the count marks never re-imported' },
    );
    const reopened = (await getPageAnnotations(reopenedDoc, reopenedPage)).filter(
      (a) => a.kind === 'count',
    );
    // Groups come back from /Subj, symbols from /SpectraSymbol, sequences off
    // /Contents — no app state involved.
    expect(reopened.filter((a) => a.countGroup === 'Doors')).toHaveLength(2);
    expect(reopened.filter((a) => a.countGroup === 'Windows')).toHaveLength(1);
    expect(reopened.find((a) => a.countGroup === 'Windows')?.countSymbol).toBe('triangle');
    expect(
      reopened
        .filter((a) => a.countGroup === 'Doors')
        .map((a) => a.countSeq)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
      // 1 left for Windows in the marquee case above; 3 and 4 stayed Doors,
      // and their labels came back exactly as they were written.
    ).toEqual([3, 4]);
    // The legend came back too — as a legend, not as a plain text box.
    expect(
      (await getPageAnnotations(reopenedDoc, reopenedPage)).some((a) => a.kind === 'countlegend'),
    ).toBe(true);
    docId = reopenedDoc;
    pageId = reopenedPage;
  });

  it('the CLI reads the same file and writes the takeoff CSV', async () => {
    const saved = resolve(tmp, 'counted.pdf');
    const csv = resolve(tmp, 'takeoff.csv');
    const out = execFileSync(APP_EXE, ['count-summary', saved, '-o', csv], { encoding: 'utf-8' });
    const report = JSON.parse(out.slice(out.indexOf('{'))) as {
      total: number;
      groups: number;
      rows: number;
    };
    expect(report.total).toBe(3);
    expect(report.groups).toBe(2);
    const text = readFileSync(csv, 'utf-8');
    expect(text.split(/\r?\n/)[0]).toBe('Group,Symbol,Page,Count');
    expect(text).toContain('Doors,square,1,2');
    expect(text).toContain('Windows,triangle,1,1');
    expect(text).toContain('Total,,,3');
  });

  it('the legend is NOT counted as a mark', async () => {
    // A /FreeText legend and a /Stamp count mark live on the same page; only
    // /IT /Count is a count.
    const all = await getPageAnnotations(docId, pageId);
    expect(all.filter((a) => a.kind === 'count')).toHaveLength(3);
    expect(all.filter((a) => a.kind === 'countlegend')).toHaveLength(1);
  });
});
