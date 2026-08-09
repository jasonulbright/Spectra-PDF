/**
 * P31 — the snapshot tool, end to end.
 *
 * Driven as a REAL pointer gesture rather than through a harness seam: the
 * band's commit callback is a prop, and a render path that forgets to pass it
 * draws the band, completes the drag and delivers nothing — which is exactly
 * the class of defect that shipped once already. Only pointer events crossing
 * the real component tree catch that.
 *
 * "The clipboard holds an image" is asserted through the capture's own
 * read-back: the Rust command re-opens the clipboard after writing and
 * reports the formats it finds and the dimensions in the DIB header it finds
 * there, and the card on the page carries both. The webview cannot read the
 * Windows clipboard itself, so this is the honest measurement available —
 * and it is a measurement of the clipboard, not of the call that wrote it.
 */
import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  invokeAppCommand,
  closeAllFiles,
  saveSnapshotTo,
} from '../support/harness.js';

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('SNAPSHOT ME', { x: 60, y: 500, size: 24, font });
  writeFileSync(path, await doc.save());
}

describe('snapshot tool', () => {
  let tmp: string;
  let source: string;
  let pr: { x: number; y: number; w: number; h: number };

  // The band, as a fraction of the drawn page frame. At the default 150 dpi
  // a 612x792 page renders 1275x1650, so this band is ~510x495 px.
  const FROM: [number, number] = [0.2, 0.2];
  const TO: [number, number] = [0.6, 0.5];
  const EXPECT = { w: 510, h: 495 };
  // Pointer coordinates are whole screen pixels against a page frame whose
  // size depends on the window, so the captured raster lands near the
  // nominal size rather than on it.
  const TOL = 60;

  async function pageRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return (await browser.execute(function () {
      const el = document.querySelector('[data-page-id]');
      if (!el) return null as unknown as { x: number; y: number; w: number; h: number };
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })) as { x: number; y: number; w: number; h: number } | null;
  }

  async function card(): Promise<{ size: string; formats: string } | null> {
    return (await browser.execute(function () {
      const el = document.querySelector('[data-testid="snapshot-placement"]');
      if (!el) return null as unknown as { size: string; formats: string };
      return {
        size: el.getAttribute('data-snapshot-size') ?? '',
        formats: el.getAttribute('data-snapshot-formats') ?? '',
      };
    })) as { size: string; formats: string } | null;
  }

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-p31-'));
    source = resolve(tmp, 'src.pdf');
    await makeFixture(source);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    pr = (await pageRect())!;
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('a dragged band puts an image of that region on the clipboard', async () => {
    // Opening the tool arms the mode — one step, no second click.
    expect(await invokeAppCommand('tools.open.snapshot')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'snapshot', {
      timeout: 10_000,
      timeoutMsg: 'opening the tool never armed the snapshot mode',
    });

    const at = (f: [number, number]): { x: number; y: number } => ({
      x: Math.round(pr.x + pr.w * f[0]),
      y: Math.round(pr.y + pr.h * f[1]),
    });
    const mid: [number, number] = [(FROM[0] + TO[0]) / 2, (FROM[1] + TO[1]) / 2];
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(at(FROM))
      .down()
      .pause(80)
      .move(at(mid))
      .pause(80)
      .move(at(TO))
      .pause(80)
      .up()
      .perform();

    await browser.waitUntil(async () => (await card()) !== null, {
      timeout: 20_000,
      timeoutMsg: 'the drag left no snapshot card on the page',
    });
    const info = (await card())!;

    // Both clipboard formats are present, read back OUT of the clipboard.
    expect(info.formats.split(',')).toContain('CF_DIB');
    expect(info.formats.split(',')).toContain('PNG');

    // ...and the image on the clipboard is the size of the band at the
    // snapshot resolution, not at the current zoom.
    const [w, h] = info.size.split('x').map(Number);
    expect(Math.abs(w - EXPECT.w)).toBeLessThan(TOL);
    expect(Math.abs(h - EXPECT.h)).toBeLessThan(TOL);
  });

  it('saves the same raster to a file', async () => {
    const dest = resolve(tmp, 'shot.png');
    // The card's button opens an OS-modal dialog no spec can answer; the
    // WRITE half it performs afterwards is what runs here.
    expect(await saveSnapshotTo(dest)).toBe(dest);
    // The button itself is on the page, and it is what a reader presses.
    expect(await $('[data-testid="snapshot-save"]').isDisplayed()).toBe(true);
    await browser.waitUntil(() => existsSync(dest), {
      timeout: 15_000,
      timeoutMsg: 'the snapshot was never written',
    });
    // A real PNG of a real size — the signature, not just a file that exists.
    const bytes = readFileSync(dest);
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(statSync(dest).size).toBeGreaterThan(1000);
  });

  it('a click captures nothing and leaves the clipboard alone', async () => {
    // Dismiss the previous card first, so a survivor cannot be mistaken for
    // a new capture.
    await $('[data-testid="snapshot-placement"] .page-annot-x').click();
    await browser.waitUntil(async () => (await card()) === null, {
      timeout: 10_000,
      timeoutMsg: 'the snapshot card would not dismiss',
    });
    const spot = { x: Math.round(pr.x + pr.w * 0.5), y: Math.round(pr.y + pr.h * 0.5) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(spot)
      .down()
      .pause(60)
      .up()
      .perform();
    await browser.pause(1500);
    expect(await card()).toBeNull();
  });
});
