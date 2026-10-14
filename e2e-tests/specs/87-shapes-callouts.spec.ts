// Drawing shapes + callouts: real creation gestures per figure
// (band, two-point drag, vertex clicks), vertex editing, the properties-bar
// restyle, commit into REAL subtypes (CLI truth), and the reimport
// round-trip — reopening the saved file brings the shapes back as editable
// annotations via the raw-style sidecar.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { APP_BINARY } from '../support/app-data.js';
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

const APP_EXE = APP_BINARY;
const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

/** The free texts of a saved file's first page: the text a viewer reads from
 * each appearance, and the fonts the appearance holds, by /BaseFont. */
async function savedTextBoxes(path: string): Promise<{ text: string; fonts: string[]; embedded: boolean[] }[]> {
  const bytes = new Uint8Array(readFileSync(path));
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const read = ((await (await pdf.getPage(1)).getAnnotations({ intent: 'display' })) as { subtype: string; textContent?: string[] }[])
    .filter((a) => a.subtype === 'FreeText')
    .map((a) => (a.textContent ?? []).join(' '));
  await pdf.loadingTask.destroy();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const out: { text: string; fonts: string[]; embedded: boolean[] }[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const dict = annots!.lookup(i, PDFDict);
    if (String(dict.lookup(PDFName.of('Subtype'))) !== '/FreeText') continue;
    const normal = dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFStream;
    const held = normal.dict.lookup(PDFName.of('Resources'), PDFDict).lookupMaybe(PDFName.of('Font'), PDFDict);
    const fonts: string[] = [];
    const embedded: boolean[] = [];
    for (const [, value] of held?.entries() ?? []) {
      const font = doc.context.lookup(value, PDFDict);
      fonts.push(String(font.lookup(PDFName.of('BaseFont'))));
      const descendants = font.lookup(PDFName.of('DescendantFonts'));
      const descriptor = descendants instanceof PDFArray
        ? descendants.lookup(0, PDFDict).lookup(PDFName.of('FontDescriptor'))
        : font.lookup(PDFName.of('FontDescriptor'));
      embedded.push(descriptor instanceof PDFDict
        && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.has(PDFName.of(key))));
    }
    out.push({ text: read[out.length] ?? '', fonts, embedded });
  }
  return out;
}

async function pageRect(): Promise<{ x: number; y: number; w: number; h: number }> {
  return (await browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number };
}

type Rect = { x: number; y: number; w: number; h: number };

/** The first page cell's box once two reads 150 ms apart agree. Arming a tool
 * shows its properties bar, which shortens the reading pane; at Fit Page the
 * page then rescales and re-centres, so a box read earlier names a place the
 * page has left. */
async function settledPageRect(): Promise<Rect> {
  let prev: Rect | null = null;
  let held: Rect | null = null;
  await browser.waitUntil(
    async () => {
      const now = await pageRect();
      const same =
        now !== null &&
        prev !== null &&
        Math.abs(now.x - prev.x) < 0.5 &&
        Math.abs(now.y - prev.y) < 0.5 &&
        Math.abs(now.w - prev.w) < 0.5 &&
        Math.abs(now.h - prev.h) < 0.5;
      prev = now;
      held = now;
      return same;
    },
    { timeout: 10_000, interval: 150, timeoutMsg: `the page box never settled; last read: ${JSON.stringify(held)}` },
  );
  return held!;
}

async function dragOnPage(from: [number, number], to: [number, number]): Promise<void> {
  const pr = await settledPageRect();
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

async function clickOnPage(at: [number, number], double = false): Promise<void> {
  const pr = await settledPageRect();
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
    doc = { docId: '', pageId: '' }; // resolved from the first drawn annotation
  });

  it('draws a rectangle with the band gesture', async () => {
    await invokeAppCommand('tools.shape'); // arms 'shape', default figure: rect
    await dragOnPage([0.1, 0.1], [0.3, 0.25]);
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
    await dragOnPage([0.5, 0.1], [0.8, 0.1]); // deliberately FLAT
    const annots = await getPageAnnotations(doc.docId, doc.pageId);
    const arrow = annots.find((a) => a.shapeType === 'arrow')!;
    expect(arrow).toBeDefined();
    // The flat line's box was padded to a clickable minimum.
    expect(arrow.h).toBeGreaterThan(0.005);
  });

  it('draws a polygon with vertex clicks finished by a double-click', async () => {
    await browser.$('[data-testid="shape-type-polygon"]').click();
    await clickOnPage([0.1, 0.45]);
    await clickOnPage([0.3, 0.45]);
    await clickOnPage([0.2, 0.58]);
    await clickOnPage([0.2, 0.58], true); // double-click the last vertex
    await browser.waitUntil(
      async () => (await getPageAnnotations(doc.docId, doc.pageId)).some((a) => a.shapeType === 'polygon'),
      { timeout: 5_000, timeoutMsg: 'the vertex sequence never committed a polygon' },
    );
  });

  it('draws a cloud with vertex clicks', async () => {
    await browser.$('[data-testid="shape-type-cloud"]').click();
    await clickOnPage([0.58, 0.45]);
    await clickOnPage([0.8, 0.45]);
    await clickOnPage([0.8, 0.56]);
    await clickOnPage([0.58, 0.56]);
    await clickOnPage([0.58, 0.56], true);
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
    await clickOnPage([0.36, 0.44]);
    await clickOnPage([0.48, 0.44]);
    // Switch mid-sequence. The half-drawn polygon is abandoned, not banked.
    await browser.$('[data-testid="shape-type-cloud"]').click();
    await browser.pause(300);
    await clickOnPage([0.36, 0.5]);
    await clickOnPage([0.48, 0.5]);
    await clickOnPage([0.48, 0.57]);
    await clickOnPage([0.48, 0.57], true);
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
    await dragOnPage([0.55, 0.32], [0.85, 0.4]);
    const editor = await browser.$('.page-annot-editor');
    await editor.waitForDisplayed({ timeout: 5_000 });
    await browser.keys('review this');
    // Click empty page area to blur-commit the text.
    await clickOnPage([0.42, 0.2]);
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

describe('a text box with text outside the standard font', () => {
  // A Polish word and a Hebrew word: neither is in WinAnsiEncoding, and the
  // Hebrew word runs from right to left.
  const TEXT = 'Zażółć שלום';
  let tmp: string;

  before(async () => {
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'text-box-scripts-'));
    const src = resolve(tmp, 'scripts.pdf');
    copyFileSync(FIXTURE, src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
  });

  const textBox = async (): Promise<(Awaited<ReturnType<typeof getPageAnnotations>>[number] & { docId: string; pageId: string }) | null> => {
    const first = await getFirstAnnotation(2_000);
    if (!first) return null;
    const found = (await getPageAnnotations(first.docId, first.pageId)).find((a) => a.kind === 'freetext');
    return found ? { ...found, docId: first.docId, pageId: first.pageId } : null;
  };

  it('shows the lines the engine wraps, and commits the glyphs of both words', async () => {
    await invokeAppCommand('tools.freetext');
    await dragOnPage([0.15, 0.55], [0.7, 0.66]);
    const editor = await browser.$('.page-annot-editor');
    await editor.waitForDisplayed({ timeout: 5_000 });
    await browser.keys(TEXT);
    await clickOnPage([0.5, 0.9]);
    await browser.waitUntil(async () => (await textBox())?.note === TEXT, {
      timeout: 5_000,
      timeoutMsg: 'the text of the text box never landed',
    });
    // The canvas shows the engine's lines, in the base direction of the text.
    const shown: { body: { lines: number; dir: string | null; text: string } | null } = { body: null };
    await browser.waitUntil(
      async () => {
        shown.body = (await browser.execute(function () {
          const el = document.querySelector('.page-annot-text-body[data-text-via="engine"]');
          if (!el) return null;
          return { lines: el.querySelectorAll('.page-annot-text-line').length, dir: el.getAttribute('dir'), text: el.textContent ?? '' };
        })) as typeof shown.body;
        return shown.body !== null;
      },
      { timeout: 15_000, timeoutMsg: 'the text box never showed the lines of the engine' },
    );
    expect(shown.body!.lines).toBe(1);
    expect(shown.body!.dir).toBe('ltr');
    expect(shown.body!.text).toBe(TEXT);

    await commitPendingEdits();
    const dest = resolve(tmp, 'scripts-committed.pdf');
    await saveActiveAs(dest);
    const boxes = await savedTextBoxes(dest);
    expect(boxes).toHaveLength(1);
    // A viewer reads each word whole; the order it gives two directions in
    // one line is its own.
    expect(boxes[0].text).toContain('Zażółć');
    expect(boxes[0].text).toContain('שלום');
    expect([...boxes[0].text].sort().join('')).toBe([...TEXT].sort().join(''));
    expect(boxes[0].fonts.every((name) => /^\/[A-Z]{6}\+LiberationSans$/.test(name))).toBe(true);
    expect(boxes[0].embedded).toEqual(boxes[0].fonts.map(() => true));
  });

  it('keeps both words in the same face after a resize and a second commit', async () => {
    // The committed text box comes back as an import of the file.
    await browser.waitUntil(async () => (await textBox())?.originalAppearance === true, {
      timeout: 20_000,
      timeoutMsg: 'the committed text box was never read back',
    });
    const before = (await textBox())!;
    await invokeAppCommand('tools.select');
    const pr = await settledPageRect();
    await clickOnPage([before.x + before.w / 2, before.y + before.h / 2]);
    const grip: { box: Rect | null } = { box: null };
    await browser.waitUntil(
      async () => {
        grip.box = (await browser.execute(function () {
          const el = document.querySelector('[data-testid="annot-handle-se"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        })) as Rect | null;
        return grip.box !== null;
      },
      { timeout: 5_000, timeoutMsg: 'the selected text box showed no resize handle' },
    );
    const from = { x: Math.round(grip.box!.x + grip.box!.w / 2), y: Math.round(grip.box!.y + grip.box!.h / 2) };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(from)
      .down()
      .pause(60)
      .move({ x: from.x + 8, y: from.y + 8 })
      .pause(60)
      .move({ x: Math.round(from.x + pr.w * 0.05), y: Math.round(from.y + pr.h * 0.06) })
      .pause(90)
      .up()
      .perform();
    await browser.waitUntil(async () => ((await textBox())?.h ?? 0) > before.h + 0.03, {
      timeout: 5_000,
      timeoutMsg: 'the resize of the text box never landed',
    });
    expect((await textBox())!.note).toBe(TEXT);
    // No refusal: the resize is an edit the commit can draw.
    expect(await browser.$('[data-testid="page-edit-refused-bar"]').isExisting()).toBe(false);

    await commitPendingEdits();
    const dest = resolve(tmp, 'scripts-resized.pdf');
    await saveActiveAs(dest);
    const boxes = await savedTextBoxes(dest);
    expect(boxes).toHaveLength(1);
    // A viewer reads each word whole; the order it gives two directions in
    // one line is its own.
    expect(boxes[0].text).toContain('Zażółć');
    expect(boxes[0].text).toContain('שלום');
    expect([...boxes[0].text].sort().join('')).toBe([...TEXT].sort().join(''));
    expect(boxes[0].fonts.every((name) => /^\/[A-Z]{6}\+LiberationSans$/.test(name))).toBe(true);
    expect(boxes[0].embedded).toEqual(boxes[0].fonts.map(() => true));
  });

  it('keeps the editor open and focused with the typed text when the text is refused, and Escape cancels', async () => {
    // Thai: no font of the editor draws it.
    const REFUSED = 'ภาษาไทย';
    const boxes = async (): Promise<number> => {
      const first = await getFirstAnnotation(2_000);
      return first ? (await getPageAnnotations(first.docId, first.pageId)).filter((a) => a.kind === 'freetext').length : 0;
    };
    const before = await boxes();
    await invokeAppCommand('tools.freetext');
    await dragOnPage([0.15, 0.2], [0.7, 0.3]);
    const editor = await browser.$('.page-annot-editor');
    await editor.waitForDisplayed({ timeout: 5_000 });
    await browser.keys(REFUSED);
    await browser.keys(['Control', 'Enter']);
    // The notice shows beside an editor that still holds the text.
    await browser.waitUntil(
      async () =>
        (await browser.execute(function (text: string) {
          const field = document.querySelector('.page-annot-editor') as HTMLTextAreaElement | null;
          return !!document.querySelector('[data-testid="page-edit-refused-bar"]') && field !== null && field.value === text;
        }, REFUSED)) === true,
      { timeout: 5_000, timeoutMsg: 'the refused text did not stay in an open editor beside the notice' },
    );
    // The open editor holds the focus. When the focus leaves it with the
    // refused text, the editor takes the focus back and keeps the text.
    const focusedWith = async (text: string): Promise<boolean> =>
      (await browser.execute(function (expected: string) {
        const field = document.querySelector('.page-annot-editor') as HTMLTextAreaElement | null;
        return field !== null && document.activeElement === field && field.value === expected;
      }, text)) === true;
    expect(await focusedWith(REFUSED)).toBe(true);
    await browser.execute(function () {
      (document.querySelector('.page-annot-editor') as HTMLTextAreaElement).blur();
    });
    await browser.waitUntil(() => focusedWith(REFUSED), {
      timeout: 5_000, timeoutMsg: 'the editor did not take the focus back with its text after a refused blur',
    });
    await browser.keys('Escape');
    // The box never had a text: it leaves with its editor.
    await browser.waitUntil(
      async () => !(await browser.$('.page-annot-editor').isExisting()) && (await boxes()) === before,
      { timeout: 5_000, timeoutMsg: 'Escape did not close the editor and remove the empty text box' },
    );
  });

  it('takes the focus back once for a refused text: a second blur closes the editor and gives the text up', async () => {
    const REFUSED = 'ภาษาไทย';
    const boxes = async (): Promise<number> => {
      const first = await getFirstAnnotation(2_000);
      return first ? (await getPageAnnotations(first.docId, first.pageId)).filter((a) => a.kind === 'freetext').length : 0;
    };
    const before = await boxes();
    // The previous refusal case leaves a canvas tool armed after Escape.
    // Start from Select so this placement doesn't depend on that test's mode.
    await invokeAppCommand('tools.select');
    await invokeAppCommand('tools.freetext');
    await dragOnPage([0.15, 0.35], [0.7, 0.45]);
    const editor = await browser.$('.page-annot-editor');
    await editor.waitForDisplayed({ timeout: 5_000 });
    await browser.keys(REFUSED);
    const blur = (): Promise<void> =>
      browser.execute(function () {
        (document.querySelector('.page-annot-editor') as HTMLTextAreaElement).blur();
      });
    await blur();
    await browser.waitUntil(
      async () =>
        (await browser.execute(function (text: string) {
          const field = document.querySelector('.page-annot-editor') as HTMLTextAreaElement | null;
          return !!document.querySelector('[data-testid="page-edit-refused-bar"]') && field !== null
            && document.activeElement === field && field.value === text;
        }, REFUSED)) === true,
      { timeout: 5_000, timeoutMsg: 'the editor did not take the focus back with its text and the notice after the first blur' },
    );
    await blur();
    // The box never had a text: it leaves with its editor.
    await browser.waitUntil(
      async () => !(await browser.$('.page-annot-editor').isExisting()) && (await boxes()) === before,
      { timeout: 5_000, timeoutMsg: 'the second blur did not close the editor and remove the empty text box' },
    );
  });
});
