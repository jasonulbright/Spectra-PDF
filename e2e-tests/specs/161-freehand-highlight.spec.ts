// F36 — the field flow, end to end, on the document that motivated it.
//
// The report: an image-only scan cannot be highlighted at all, because
// text-markup highlight needs text to select and there is none; and marking
// section after section costs one tool pick per mark. So this spec runs
// EXACTLY that: open an image-only PDF, arm the freehand highlighter ONCE,
// confirm the lock is on, drag across several pages without re-arming, save,
// reopen, and check the marks are there and translucent over the image.
//
// Every gesture is a real pointer drag through the page cell's window-level
// ink listeners — the same capture the pen uses, which is the point: there is
// one ink pipeline, not two.
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  closeAllFiles,
  openMenuItem,
  saveActiveAs,
  getFirstAnnotation,
  getActiveDocPages,
  getPageAnnotations,
} from '../support/harness.js';

// The committed image-only fixture: one page rendered to a JPEG, ZERO
// extractable text. Copied three times so "page after page" is literal.
const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');

async function makeThreePageScan(dest: string): Promise<void> {
  const src = await PDFDocument.load(readFileSync(SCANNED));
  const out = await PDFDocument.create();
  for (let i = 0; i < 3; i++) {
    const [page] = await out.copyPages(src, [0]);
    out.addPage(page);
  }
  writeFileSync(dest, await out.save());
}

/** The displayed rect of one page cell, by its page id. */
async function pageRect(
  pageId: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return (await browser.execute(function (id) {
    const el = document.querySelector(`[data-page-id="${id}"]`);
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, pageId)) as { x: number; y: number; w: number; h: number } | null;
}

async function drawStroke(
  r: { x: number; y: number; w: number; h: number },
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const fx = Math.round(r.x + r.w * from[0]);
  const fy = Math.round(r.y + r.h * from[1]);
  const tx = Math.round(r.x + r.w * to[0]);
  const ty = Math.round(r.y + r.h * to[1]);
  try {
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: fx, y: fy })
      .down()
      .pause(40)
      .move({ x: Math.round((fx + tx) / 2), y: Math.round((fy + ty) / 2) })
      .pause(40)
      .move({ x: tx, y: ty })
      .pause(40)
      .up()
      .perform();
  } finally {
    await browser.releaseActions();
  }
}

const num = (v: unknown): number => (v instanceof PDFNumber ? v.asNumber() : NaN);

/** Every /Ink annotation in a saved file, with what its appearance does. */
function inkMarks(doc: PDFDocument): {
  page: number;
  alpha: number;
  blend: string;
  selectsState: boolean;
  paths: number;
  nib: number;
  /** Does the appearance BBox enclose the whole nib, or clip it? A Form
   *  XObject clips to its BBox, so a pad that ignores the stroke width shaves
   *  the marker down in the file while the canvas keeps drawing all of it. */
  bboxEnclosesNib: boolean;
}[] {
  const out: ReturnType<typeof inkMarks> = [];
  for (let p = 0; p < doc.getPageCount(); p++) {
    const annots = doc.getPage(p).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (!a || String(a.lookup(PDFName.of('Subtype'))) !== '/Ink') continue;
      const stream = a.lookupMaybe(PDFName.of('AP'), PDFDict)!.lookup(PDFName.of('N')) as PDFRawStream;
      const content = new TextDecoder().decode(stream.getContents());
      const gs = stream.dict
        .lookupMaybe(PDFName.of('Resources'), PDFDict)
        ?.lookupMaybe(PDFName.of('ExtGState'), PDFDict)
        ?.lookupMaybe(PDFName.of('GS0'), PDFDict);
      const nib = num(a.lookupMaybe(PDFName.of('BS'), PDFDict)?.lookup(PDFName.of('W')));
      const bboxArr = stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
      const bb = bboxArr ? [0, 1, 2, 3].map((k) => num(bboxArr.lookup(k))) : [NaN, NaN, NaN, NaN];
      const pts = [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      const half = nib / 2;
      out.push({
        page: p,
        alpha: num(a.lookup(PDFName.of('CA'))),
        blend: gs ? String(gs.lookup(PDFName.of('BM'))) : '(none)',
        selectsState: content.startsWith('/GS0 gs'),
        paths: a.lookupMaybe(PDFName.of('InkList'), PDFArray)?.size() ?? 0,
        nib,
        bboxEnclosesNib:
          pts.length > 1 &&
          pts.every(
            ([px, py]) =>
              px - half >= bb[0] && px + half <= bb[2] && py - half >= bb[1] && py + half <= bb[3],
          ),
      });
    }
  }
  return out;
}

describe('freehand highlighting on a scanned document', () => {
  let tmp: string;
  let scan: string;
  let saved: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-f36-'));
    scan = resolve(tmp, 'three-page-scan.pdf');
    saved = resolve(tmp, 'highlighted.pdf');
  });

  it('one arming gesture marks page after page, and the marks survive a save', async () => {
    await makeThreePageScan(scan);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([scan]);
    await setView('canvas');

    // Arm Comment ▸ Freehand Highlight through the real menu and strip — the
    // user's own path, not a dispatch.
    await openMenuItem('menu-tools', 'menuitem-tool-comment');
    await $('[data-testid="menuitem-tool-comment"]').click();
    await $('[data-testid="tool-inkhighlight"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="tool-inkhighlight"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="tool-inkhighlight"]').getAttribute('aria-pressed')) === 'true',
      { timeoutMsg: 'the freehand highlighter never armed' },
    );

    // The lock is the other half of the report. It ships on; assert that
    // rather than clicking it, because the flow being tested is the one a user
    // gets without touching it.
    const lock = $('[data-testid="tool-lock"]');
    await lock.waitForDisplayed({ timeout: 10_000 });
    expect(await lock.getAttribute('aria-pressed')).toBe('true');

    const pages = await getActiveDocPages();
    expect(pages.length).toBe(3);

    // ── Mark all three pages WITHOUT re-arming. Targets stay in each cell's
    // top band: a W3C pointer move outside the viewport hard-fails, the
    // standing trap in every canvas spec.
    for (const page of pages) {
      await browser.execute(function (id) {
        document.querySelector(`[data-page-id="${id}"]`)?.scrollIntoView({ block: 'center' });
      }, page.id);
      await browser.pause(250);
      const r = await pageRect(page.id);
      expect(r).not.toBeNull();
      await drawStroke(r!, [0.15, 0.2], [0.75, 0.22]);
      // The mode is still armed for the NEXT page — that is the whole claim.
      expect(await $('[data-testid="tool-inkhighlight"]').getAttribute('aria-pressed')).toBe(
        'true',
      );
    }

    // Each page carries one freehand HIGHLIGHT (not a pen stroke). Every page
    // of one file belongs to one document, so the first mark names it.
    const first = await getFirstAnnotation();
    expect(first).not.toBeNull();
    const docId = first!.docId;
    for (const page of pages) {
      const marks = await getPageAnnotations(docId, page.id);
      const highlights = marks.filter((a) => a.kind === 'ink' && a.inkStyle === 'highlighter');
      expect(highlights).toHaveLength(1);
      expect(highlights[0].strokeCount).toBe(1);
      expect(highlights[0].opacity).toBeLessThan(1);
    }

    // ── Save, then read the FILE back. The saved bytes are the deliverable;
    // the pending tier is not.
    await saveActiveAs(saved);
    const out = await PDFDocument.load(readFileSync(saved));
    const marks = inkMarks(out);
    expect(marks).toHaveLength(3);
    for (const m of marks) {
      expect(m.paths).toBe(1);
      // Translucent over the page IMAGE: the multiply darkens toward the scan
      // instead of painting over it, and the state is selected before any
      // path is stroked or it applies to nothing.
      expect(m.blend).toBe('/Multiply');
      expect(m.selectsState).toBe(true);
      expect(m.alpha).toBeGreaterThan(0);
      expect(m.alpha).toBeLessThan(1);
      // The nib the marker was drawn with reaches the file whole. The screen
      // draws the stroke with overflow visible, so a BBox that clips it is a
      // divergence nothing on screen would ever reveal.
      expect(m.nib).toBeGreaterThan(2);
      expect(m.bboxEnclosesNib).toBe(true);
    }
    expect(marks.map((m) => m.page).sort()).toEqual([0, 1, 2]);
  });

  it('reopening the saved file gives the marks back as highlighter marks', async () => {
    await closeAllFiles();
    await openByPaths([saved]);
    await setView('canvas');
    const pages = await getActiveDocPages();
    const reopened = await getFirstAnnotation();
    expect(reopened).not.toBeNull();
    const docId = reopened!.docId;
    for (const page of pages) {
      await browser.waitUntil(
        async () => {
          const marks = await getPageAnnotations(docId, page.id);
          return marks.some((a) => a.kind === 'ink' && a.inkStyle === 'highlighter');
        },
        { timeoutMsg: `page ${page.id} lost its highlight across save + reopen` },
      );
    }
    await closeAllFiles();
  });

  it('unlocking makes each mark cost its own arming gesture', async () => {
    await closeAllFiles();
    await openByPaths([scan]);
    await setView('canvas');
    await openMenuItem('menu-tools', 'menuitem-tool-comment');
    await $('[data-testid="menuitem-tool-comment"]').click();
    await $('[data-testid="tool-inkhighlight"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="tool-inkhighlight"]').click();

    const lock = $('[data-testid="tool-lock"]');
    await lock.waitForDisplayed({ timeout: 10_000 });
    if ((await lock.getAttribute('aria-pressed')) === 'true') await lock.click();
    await browser.waitUntil(async () => (await lock.getAttribute('aria-pressed')) === 'false', {
      timeoutMsg: 'the lock never turned off',
    });

    const pages = await getActiveDocPages();
    const r = await pageRect(pages[0].id);
    await drawStroke(r!, [0.15, 0.2], [0.75, 0.22]);
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="tool-inkhighlight"]').getAttribute('aria-pressed')) === 'false',
      { timeoutMsg: 'an unlocked placement left the mode armed' },
    );

    // Turn it back on so nothing after this spec inherits an unlocked tool:
    // the preference is persisted per window.
    await lock.click();
    await browser.waitUntil(async () => (await lock.getAttribute('aria-pressed')) === 'true', {
      timeoutMsg: 'the lock never turned back on',
    });
    await closeAllFiles();
  });
});
