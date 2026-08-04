// N11 slice D — SYMBOL PALETTES against the built binary.
//
// The decision under test is that a placed symbol carries its own GEOMETRY.
// A firm's set is imported from a JSON file on one machine; the drawing it
// marks up travels to a machine that never saw that set, and the symbol must
// still be the symbol. So the load-bearing case is the round trip — import,
// place, commit, save, reopen — plus the refusal path, because an import that
// half-succeeded would leave a set the drafter cannot trust.
//
// Mechanics inherited from slices A–C and used here: measure the page cell
// AFTER arming a mode (the secondary toolbar reflows the canvas), keep every
// gesture in the page's TOP BAND (a square page at the default zoom is taller
// than the pane, and WebDriver raises "move target out of bounds" below
// roughly 0.4), never close a popover with Escape, and seed persisted
// preferences through the HARNESS rather than clicking them up (both the count
// groups and the symbol sets live in localStorage, so a spec that built them
// by hand would inherit whatever the last run left behind).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  setReactInputValue,
  symbolImportFromPath,
  symbolResetSets,
  symbolSets,
  takeoffSetGroups,
} from '../support/harness.js';

// A firm's own set — one symbol, drawn as a part list in the unit square.
// Deliberately NOT a shape any built-in carries, so "which artwork is this?"
// has an unambiguous answer.
const FIRM_SET = {
  id: 'firm',
  name: 'Firm standard',
  symbols: [
    {
      id: 'fs-panelboard',
      name: 'Panelboard',
      parts: [
        { kind: 'poly', points: [0.15, 0.2, 0.85, 0.2, 0.85, 0.8, 0.15, 0.8], closed: true },
        { kind: 'poly', points: [0.15, 0.5, 0.85, 0.5], closed: false },
        { kind: 'circle', cx: 0.5, cy: 0.35, r: 0.08 },
      ],
    },
  ],
};

const OUTLETS = { name: 'Outlets', color: '#2f6fed', symbol: 'circle' };
const FIXTURES = { name: 'Fixtures', color: '#2fbf71', symbol: 'square' };

let tmp: string;
let src: string;
let setPath: string;
let badPath: string;
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

function at(p: [number, number]): { x: number; y: number } {
  return { x: Math.round(pr.x + pr.w * p[0]), y: Math.round(pr.y + pr.h * p[1]) };
}

/** Drag a palette item onto the page. Pointer events with real intermediate
 * moves: the drag only ARMS past a few pixels of travel (below that the press
 * is a click), and the drop hit-tests whatever is under the pointer. */
async function dragSymbolToPage(testId: string, to: [number, number]): Promise<void> {
  const item = await $(`[data-testid="${testId}"]`);
  await item.waitForDisplayed({ timeout: 10_000 });
  const box = (await browser.execute(
    function (sel: string) {
      const el = document.querySelector(sel);
      if (!el) return null as any;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    `[data-testid="${testId}"]`,
  )) as { x: number; y: number } | null;
  expect(box).not.toBeNull();
  const target = at(to);
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: box!.x, y: box!.y })
    .down()
    .pause(60)
    .move({ x: Math.round((box!.x + target.x) / 2), y: Math.round((box!.y + target.y) / 2) })
    .pause(60)
    .move({ x: target.x, y: target.y })
    .pause(80)
    .up()
    .pause(120)
    .perform();
}

async function annotations(): Promise<Awaited<ReturnType<typeof getPageAnnotations>>> {
  return await getPageAnnotations(docId, pageId);
}

async function clearPage(): Promise<void> {
  for (const a of await annotations()) await removeAnnotation(docId, pageId, a.id);
}

describe('symbol palettes (N11 slice D)', () => {
  before(async () => {
    await waitForHarness();
    // The set file is read through the app's OWN fs bridge (the native picker
    // is the only step the harness skips), so the scratch has to live inside
    // the static fs scope `$TEMP/spectrapdf/**` — the runtime scope extension
    // that a real pick grants never runs for an injected path. Spec 78's
    // recorded mechanic, and the first thing this spec hit.
    const scoped = resolve(tmpdir(), 'spectrapdf');
    mkdirSync(scoped, { recursive: true });
    tmp = mkdtempSync(resolve(scoped, 'e2e-symbols-'));
    src = resolve(tmp, 'plan.pdf');
    setPath = resolve(tmp, 'firm-symbols.json');
    badPath = resolve(tmp, 'broken-symbols.json');
    await blankFixture(src);
    writeFileSync(setPath, JSON.stringify(FIRM_SET, null, 2));
    // A file whose ARTWORK is the problem — the class that matters, because
    // these numbers become PDF path operators.
    writeFileSync(
      badPath,
      JSON.stringify({
        name: 'Broken',
        symbols: [{ id: 'bs-x', parts: [{ kind: 'poly', points: ['0 0 m 1 1 l S'] }] }],
      }),
    );
    await symbolResetSets();
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await invokeAppCommand('view.documentView');
    await takeoffSetGroups([OUTLETS], OUTLETS.name);
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
    await symbolResetSets();
    await invokeAppCommand('tools.close');
    await closeAllFiles();
  });

  it('ships built-in sets before anything is imported', async () => {
    const sets = await symbolSets();
    expect(sets.map((s) => s.id)).toEqual(['markers', 'aec']);
    expect(sets.every((s) => s.builtin)).toBe(true);
    // Our own artwork, not a third party's library — and the count markers
    // and the AEC symbols are ONE registry, which is what lets a count group
    // choose either.
    expect(sets[0].symbols).toContain('circle');
    expect(sets[1].symbols).toContain('aec-door');
  });

  it('imports a set file, and the palette lists it', async () => {
    const res = await symbolImportFromPath(setPath);
    expect(typeof res).not.toBe('string');
    expect(res).toEqual({ id: 'firm', outcome: 'added' });
    const sets = await symbolSets();
    expect(sets.map((s) => s.id)).toEqual(['markers', 'aec', 'firm']);
    expect(sets[2].symbols).toEqual(['fs-panelboard']);
    // The dock palette shows it — the set name is the user's own text and is
    // NOT translated, while its hooks are ids.
    await $('[data-testid="symbol-set-firm"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="symbol-item-fs-panelboard"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="symbol-set-firm"]').getText()).toContain('Firm standard');
  });

  it('re-importing the same set UPDATES it rather than adding a twin', async () => {
    const res = await symbolImportFromPath(setPath);
    expect(res).toEqual({ id: 'firm', outcome: 'updated' });
    expect((await symbolSets()).filter((s) => s.id === 'firm')).toHaveLength(1);
  });

  it('refuses a malformed set LOUDLY, and imports nothing', async () => {
    const res = await symbolImportFromPath(badPath);
    // The refusal names the offending symbol id — the file's own vocabulary,
    // so the reader can find it.
    expect(typeof res).toBe('string');
    expect(res as string).toContain('bs-x');
    expect((await symbolSets()).map((s) => s.id)).toEqual(['markers', 'aec', 'firm']);
  });

  it('search filters the palette', async () => {
    await setReactInputValue('[data-testid="symbol-search"]', 'panelboard');
    await browser.waitUntil(
      async () => !(await $('[data-testid="symbol-item-aec-door"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'the search never narrowed the palette' },
    );
    expect(await $('[data-testid="symbol-item-fs-panelboard"]').isExisting()).toBe(true);
    await setReactInputValue('[data-testid="symbol-search"]', '');
    await $('[data-testid="symbol-item-aec-door"]').waitForExist({ timeout: 5_000 });
  });

  it('dragging a symbol out of the stamp picker places it on the page', async () => {
    await clearPage();
    expect(await invokeAppCommand('tools.stamp')).toBe(true);
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="stamp-symbols-toggle"]').click();
    await $('[data-testid="stamp-symbol-palette"]').waitForDisplayed({ timeout: 10_000 });
    // Search first, and not for convenience: the palette SCROLLS, and an item
    // scrolled out of its own overflow box still answers `waitForDisplayed`
    // while a press at its rect lands on whatever is painted there instead.
    // Narrowing to one hit is what puts the target under the pointer.
    await setReactInputValue('[data-testid="stamp-symbol-search"]', 'panelboard');
    await browser.pause(300);
    pr = (await pageRect())!;

    await dragSymbolToPage('stamp-symbol-item-fs-panelboard', [0.3, 0.25]);
    await browser.waitUntil(async () => (await annotations()).length > 0, {
      timeout: 10_000,
      timeoutMsg: 'the dragged symbol never landed',
    });
    const placed = (await annotations())[0];
    expect(placed.kind).toBe('stamp');
    expect(placed.symbolId).toBe('fs-panelboard');
    // The GEOMETRY travelled with it — three parts, exactly what the file said.
    expect(placed.symbolParts).toBe(3);
    expect(placed.note).toBe('Panelboard');
  });

  it('the placed symbol survives save + reopen as a SYMBOL, not a text stamp', async () => {
    await commitPendingEdits();
    const saved = resolve(tmp, 'symbols.pdf');
    await saveActiveAs(saved);
    await closeAllFiles();
    // Reopening with the SET REMOVED is the real case: a drawing marked up on
    // one machine, opened on another that never imported the firm's set.
    await symbolResetSets();
    expect((await symbolSets()).map((s) => s.id)).toEqual(['markers', 'aec']);
    await openByPaths([saved]);
    await setView('canvas');
    await invokeAppCommand('view.documentView');
    const docs = await getCanvasDocs();
    docId = docs[0].id;
    pageId = (await getActiveDocPages())[0].id;
    await browser.waitUntil(
      async () => (await annotations()).some((a) => a.kind === 'stamp'),
      { timeout: 20_000, timeoutMsg: 'the symbol stamp never re-imported' },
    );
    const back = (await annotations()).find((a) => a.kind === 'stamp')!;
    expect(back.symbolId).toBe('fs-panelboard');
    // The artwork came out of the FILE, not out of a registry this build no
    // longer has — which is the whole point of carrying it.
    expect(back.symbolParts).toBe(3);
  });

  it('a count group takes an imported symbol as its marker, and the mark carries the artwork', async () => {
    await symbolImportFromPath(setPath);
    expect(await invokeAppCommand('tools.panel.takeoff')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="symbol-item-fs-panelboard"]').waitForDisplayed({ timeout: 10_000 });
    // Clicking a symbol in the dock palette makes it the ARMED group's marker
    // — one registry, two consumers.
    await $('[data-testid="symbol-item-fs-panelboard"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="takeoff-status"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'the panel never confirmed the marker' },
    );
    expect(await $('[data-testid="takeoff-status"]').getText()).toContain('Outlets');

    await browser.pause(300);
    pr = (await pageRect())!;
    const before = (await annotations()).length;
    const { x, y } = at([0.6, 0.2]);
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x, y })
      .down()
      .pause(40)
      .up()
      .pause(120)
      .perform();
    await browser.waitUntil(async () => (await annotations()).length > before, {
      timeout: 10_000,
      timeoutMsg: 'the count mark never landed',
    });
    const mark = (await annotations()).find((a) => a.kind === 'count')!;
    expect(mark.countGroup).toBe('Outlets');
    expect(mark.countSymbol).toBe('fs-panelboard');
    // A marker from an IMPORTED set carries its geometry; a built-in one does
    // not need to, and the next case proves that half.
    expect(mark.symbolParts).toBe(3);
  });

  it('a BUILT-IN marker carries no geometry — the id already names it', async () => {
    // A FRESH group name, deliberately: the FILE is the authority on how a
    // group it already carries looks (the slice-C rule), so re-seeding
    // "Outlets" with a built-in marker would still place the imported one the
    // sheet is already drawn with.
    await takeoffSetGroups([FIXTURES], FIXTURES.name);
    await browser.pause(200);
    const before = (await annotations()).length;
    const { x, y } = at([0.75, 0.2]);
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x, y })
      .down()
      .pause(40)
      .up()
      .pause(120)
      .perform();
    await browser.waitUntil(async () => (await annotations()).length > before, {
      timeout: 10_000,
      timeoutMsg: 'the built-in count mark never landed',
    });
    const marks = (await annotations()).filter((a) => a.kind === 'count');
    const builtin = marks.find((m) => m.countGroup === FIXTURES.name);
    expect(builtin?.countSymbol).toBe('square');
    expect(builtin).toBeDefined();
    // `undefined` crosses the WebDriver bridge as `null` — the assertion is
    // "no geometry travelled", not which absent value it arrived as.
    expect(builtin!.symbolParts ?? null).toBeNull();
  });
});
