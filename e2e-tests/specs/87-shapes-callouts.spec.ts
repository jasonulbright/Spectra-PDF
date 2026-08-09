// Rung 2 — drawing shapes + callouts: real creation gestures per figure
// (band, two-point drag, vertex clicks), vertex editing, the properties-bar
// restyle, commit into REAL subtypes (CLI truth), and the reimport
// round-trip — reopening the saved file brings the shapes back as editable
// annotations via the raw-style sidecar.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  getPageAnnotations,
  getFirstAnnotation,
  commitPendingEdits,
  saveActiveAs,
  closeAllFiles,
} from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function pageRect(): Promise<{ x: number; y: number; w: number; h: number }> {
  return (await browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number };
}

async function dragOnPage(
  pr: { x: number; y: number; w: number; h: number },
  from: [number, number],
  to: [number, number],
): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(pr.x + pr.w * from[0]), y: Math.round(pr.y + pr.h * from[1]) })
    .down()
    .pause(60)
    .move({ x: Math.round(pr.x + pr.w * to[0]), y: Math.round(pr.y + pr.h * to[1]) })
    .pause(60)
    .up()
    .perform();
}

async function clickOnPage(
  pr: { x: number; y: number; w: number; h: number },
  at: [number, number],
  double = false,
): Promise<void> {
  let chain = browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(pr.x + pr.w * at[0]), y: Math.round(pr.y + pr.h * at[1]) })
    .down()
    .up();
  if (double) chain = chain.pause(40).down().up();
  await chain.perform();
}

describe('drawing shapes and callouts', () => {
  let tmp: string;
  let doc: { docId: string; pageId: string };
  let pr: { x: number; y: number; w: number; h: number };

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'shapes-'));
    const src = resolve(tmp, 'shapes.pdf');
    copyFileSync(FIXTURE, src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    pr = await pageRect();
    doc = { docId: '', pageId: '' }; // resolved from the first drawn annotation
  });

  it('draws a rectangle with the band gesture', async () => {
    await invokeAppCommand('tools.shape'); // arms 'shape', default figure: rect
    await dragOnPage(pr, [0.1, 0.1], [0.3, 0.25]);
    const first = await getFirstAnnotation();
    expect(first).not.toBeNull();
    doc = { docId: first!.docId, pageId: first!.pageId };
    const annots = await getPageAnnotations(doc.docId, doc.pageId);
    const rect = annots.find((a) => a.id === first!.annotationId)!;
    expect(rect.kind).toBe('shape');
    expect(rect.shapeType).toBe('rect');
    expect(rect.strokeWidth).toBe(2);
    expect(Math.abs(rect.x - 0.1)).toBeLessThan(0.03);
    expect(Math.abs(rect.w - 0.2)).toBeLessThan(0.03);
  });

  it('draws an arrow with a two-point drag', async () => {
    await browser.$('[data-testid="shape-type-arrow"]').click();
    await dragOnPage(pr, [0.5, 0.1], [0.8, 0.1]); // deliberately FLAT
    const annots = await getPageAnnotations(doc.docId, doc.pageId);
    const arrow = annots.find((a) => a.shapeType === 'arrow')!;
    expect(arrow).toBeDefined();
    // The flat line's box was padded to a clickable minimum.
    expect(arrow.h).toBeGreaterThan(0.005);
  });

  it('draws a polygon with vertex clicks finished by a double-click', async () => {
    await browser.$('[data-testid="shape-type-polygon"]').click();
    await clickOnPage(pr, [0.1, 0.45]);
    await clickOnPage(pr, [0.3, 0.45]);
    await clickOnPage(pr, [0.2, 0.58]);
    await clickOnPage(pr, [0.2, 0.58], true); // double-click the last vertex
    await browser.waitUntil(
      async () => (await getPageAnnotations(doc.docId, doc.pageId)).some((a) => a.shapeType === 'polygon'),
      { timeout: 5_000, timeoutMsg: 'the vertex sequence never committed a polygon' },
    );
  });

  it('draws a cloud with vertex clicks', async () => {
    await browser.$('[data-testid="shape-type-cloud"]').click();
    await clickOnPage(pr, [0.58, 0.45]);
    await clickOnPage(pr, [0.8, 0.45]);
    await clickOnPage(pr, [0.8, 0.56]);
    await clickOnPage(pr, [0.58, 0.56]);
    await clickOnPage(pr, [0.58, 0.56], true);
    await browser.waitUntil(
      async () => (await getPageAnnotations(doc.docId, doc.pageId)).some((a) => a.shapeType === 'cloud'),
      { timeout: 5_000, timeoutMsg: 'the vertex sequence never committed a cloud' },
    );
    const cloud = (await getPageAnnotations(doc.docId, doc.pageId)).find((a) => a.shapeType === 'cloud')!;
    expect(cloud.points!.length).toBe(8);
  });

  // A vertex sequence belongs to the figure that started it. The figure
  // changes without the TOOL changing, so nothing that watches the tool sees
  // it: a sequence left live goes on collecting clicks under a figure nobody
  // armed and commits the one it started with — pick Cloud part-way through a
  // polygon and what lands is another polygon.
  it('ends a live vertex sequence when the figure changes', async () => {
    const before = (await getPageAnnotations(doc.docId, doc.pageId)).length;
    await browser.$('[data-testid="shape-type-polygon"]').click();
    await clickOnPage(pr, [0.36, 0.44]);
    await clickOnPage(pr, [0.48, 0.44]);
    // Switch mid-sequence. The half-drawn polygon is abandoned, not banked.
    await browser.$('[data-testid="shape-type-cloud"]').click();
    await browser.pause(300);
    await clickOnPage(pr, [0.36, 0.5]);
    await clickOnPage(pr, [0.48, 0.5]);
    await clickOnPage(pr, [0.48, 0.57]);
    await clickOnPage(pr, [0.48, 0.57], true);
    await browser.waitUntil(
      async () => (await getPageAnnotations(doc.docId, doc.pageId)).length > before,
      { timeout: 5_000, timeoutMsg: 'nothing committed after the figure switch' },
    );
    const added = (await getPageAnnotations(doc.docId, doc.pageId)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].shapeType).toBe('cloud');
    // Three clicks after the switch, so the abandoned polygon's two vertices
    // cannot have joined this one.
    expect(added[0].points!.length).toBe(6);
  });

  it('draws a callout whose editor opens for the text', async () => {
    await invokeAppCommand('tools.callout');
    await dragOnPage(pr, [0.55, 0.32], [0.85, 0.4]);
    const editor = await browser.$('.page-annot-editor');
    await editor.waitForDisplayed({ timeout: 5_000 });
    await browser.keys('review this');
    // Click empty page area to blur-commit the text.
    await clickOnPage(pr, [0.42, 0.2]);
    await browser.waitUntil(
      async () =>
        (await getPageAnnotations(doc.docId, doc.pageId)).some(
          (a) => a.kind === 'callout' && a.note === 'review this',
        ),
      { timeout: 5_000, timeoutMsg: 'the callout text never landed' },
    );
    const callout = (await getPageAnnotations(doc.docId, doc.pageId)).find((a) => a.kind === 'callout')!;
    expect(callout.x).toBeLessThan(0.55); // leader extends left of the box // bbox includes the leader, left of the box
  });

  it('restyles the selection from the properties bar', async () => {
    await invokeAppCommand('tools.close'); // back to Select
    const annots = await getPageAnnotations(doc.docId, doc.pageId);
    const rect = annots.find((a) => a.shapeType === 'rect')!;
    // Click the rect's body center to select it.
    const body = (await browser.execute(function (id: string) {
      const el = Array.from(document.querySelectorAll('[data-annot-id]')).find(
        (e) => e.getAttribute('data-annot-id') === id,
      );
      if (!el) return null as any;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, rect.id)) as { x: number; y: number };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(body.x), y: Math.round(body.y) })
      .down()
      .up()
      .perform();
    await invokeAppCommand('view.propertiesBar');
    const widthSelect = await browser.$('[data-testid="pbar-stroke-width"]');
    await widthSelect.waitForDisplayed({ timeout: 5_000 });
    await widthSelect.selectByAttribute('value', '4');
    const fillBtn = await browser.$('[data-testid="pbar-fill-2f6fed"]');
    await fillBtn.click();
    const after = (await getPageAnnotations(doc.docId, doc.pageId)).find((a) => a.id === rect.id)!;
    expect(after.strokeWidth).toBe(4);
    expect(after.fillColor).toBe('#2f6fed');
  });

  it('commits as REAL subtypes and reimports as editable shapes (sidecar round-trip)', async () => {
    await commitPendingEdits();
    const dest = resolve(tmp, 'shapes-committed.pdf');
    await saveActiveAs(dest);
    const out = execFileSync(APP_EXE, ['comments-list', dest], { encoding: 'utf-8' });
    const listed = JSON.parse(out.slice(out.indexOf('{'))) as {
      annotations: { kind: string }[];
      by_type: Record<string, number>;
    };
    expect(listed.by_type['Square']).toBeGreaterThanOrEqual(1);
    expect(listed.by_type['Line']).toBeGreaterThanOrEqual(1);
    expect(listed.by_type['Polygon']).toBeGreaterThanOrEqual(1);
    expect(listed.by_type['FreeText']).toBeGreaterThanOrEqual(1);

    // Reopen the SAVED file — the sidecar-backed import must bring the
    // shapes back as first-class editable annotations, styles intact.
    await closeAllFiles();
    await openByPaths([dest]);
    await setView('canvas');
    let reimported: Awaited<ReturnType<typeof getPageAnnotations>> = [];
    await browser.waitUntil(
      async () => {
        const first = await getFirstAnnotation(2_000);
        if (!first) return false;
        reimported = await getPageAnnotations(first.docId, first.pageId);
        return reimported.length >= 4;
      },
      { timeout: 20_000, timeoutMsg: 'the saved shapes never reimported' },
    );
    const rect = reimported.find((a) => a.shapeType === 'rect');
    expect(rect).toBeDefined();
    expect(rect!.strokeWidth).toBe(4);
    expect(rect!.fillColor).toBe('#2f6fed');
    expect(reimported.some((a) => a.shapeType === 'arrow')).toBe(true);
    expect(reimported.some((a) => a.shapeType === 'polygon')).toBe(true);
    const callout = reimported.find((a) => a.kind === 'callout');
    expect(callout).toBeDefined();
    expect(callout!.note).toBe('review this');
  });
});
