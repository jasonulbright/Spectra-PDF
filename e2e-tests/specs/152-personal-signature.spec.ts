import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFDict, PDFStream } from 'pdf-lib';
import {
  answerImagePicker,
  getFirstAnnotation,
  getState,
  invokeAppCommand,
  openByPaths,
  pressGlobalKey,
  setReactInputValue,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

// F31 — THE PERSONAL SIGNATURE, all three capture doors and both consumers.
//
// The claim under test is that a personal signature reaches a page through the
// machinery that was already there: a drawn one is an ordinary `ink`
// annotation, a typed one is a `stamp` carrying a bundled script face, an
// imported one is the existing image-stamp path. So the assertions are made on
// the WRITTEN FILE with the CLI and pdf-lib, not on the dialog's own preview —
// a capture dialog that draws beautifully and commits nothing would pass every
// screen-level check.
//
// The capture canvas is driven with WebDriver pointer actions rather than a
// harness injection, because the draw door's whole substance is the
// window-level pointer listeners the canvas-drag invariant requires: an
// injected stroke set would prove the store and skip the door.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

/**
 * A small RGBA PNG, built rather than pasted: a white sheet with a black bar
 * across the middle. The import door needs a background to remove and a mark
 * to keep after removing it, and a hand-copied base64 blob that is subtly
 * malformed fails as "the picker did nothing", which is a bad diagnosis.
 */
function markPng(): Buffer {
  const w = 16;
  const h = 16;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const ink = y >= 6 && y < 10;
      const p = row + 1 + x * 4;
      raw[p] = ink ? 0 : 255;
      raw[p + 1] = ink ? 0 : 255;
      raw[p + 2] = ink ? 0 : 255;
      raw[p + 3] = 255;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface StoredAsset {
  id: string;
  name: string;
  kind: 'ink' | 'typed' | 'image';
  role: string;
  aspect: number;
  strokes?: number[][];
  text?: string;
  face?: string;
  imageData?: string;
}

let SCRATCH = '';

async function storedAssets(): Promise<StoredAsset[]> {
  return browser.execute(() => {
    try {
      return JSON.parse(localStorage.getItem('spectra-signatures') ?? '[]');
    } catch {
      return [];
    }
  }) as Promise<StoredAsset[]>;
}

/** What the capture dialog is currently complaining about, or '' when it is
 * not. A refusal the dialog renders is the diagnosis a timed-out wait needs. */
async function dialogError(): Promise<string> {
  const el = await $('[data-testid="signature-error"]');
  return (await el.isExisting()) ? el.getText() : '';
}

/** The asset ids the strip is currently offering as pills. */
async function stripPresetIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid^="signature-preset-"]')).map(
      (el) => (el.getAttribute('data-testid') ?? '').replace('signature-preset-', ''),
    ),
  ) as Promise<string[]>;
}

/** Arm an asset from the strip, waiting for the strip to be showing it. The
 * strip re-reads the store when the capture dialog closes rather than
 * subscribing to it, so a pill can be one beat behind the store. */
async function armPreset(id: string): Promise<void> {
  await browser.waitUntil(async () => (await stripPresetIds()).includes(id), {
    timeout: 15_000,
    timeoutMsg: `the strip never offered ${id}; it offered ${(await stripPresetIds()).join(', ') || '(nothing)'}`,
  });
  const pill = $(`[data-testid="signature-preset-${id}"]`);
  // The pill TOGGLES, so clicking one that is already armed disarms it.
  if ((await pill.getAttribute('aria-pressed')) !== 'true') await pill.click();
  expect(await pill.getAttribute('aria-pressed')).toBe('true');
}

async function clearAssets(): Promise<void> {
  await browser.execute(() => localStorage.removeItem('spectra-signatures'));
}

/** The capture canvas's box in client coordinates. */
async function canvasBox(): Promise<{ left: number; top: number; width: number; height: number }> {
  const box = (await browser.execute(() => {
    const el = document.querySelector('[data-testid="signature-draw-canvas"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  })) as { left: number; top: number; width: number; height: number } | null;
  expect(box).not.toBeNull();
  return box!;
}

/**
 * One pen lift: down, a few moves, up — through window-level pointer events,
 * which is the only delivery path this WebView gives a canvas drag.
 *
 * The fractions are of the canvas box, so the stroke lands inside it whatever
 * the dialog's rendered width is.
 */
async function drawStroke(points: [number, number][]): Promise<void> {
  const b = await canvasBox();
  const at = (p: [number, number]): { x: number; y: number } => ({
    x: Math.round(b.left + b.width * p[0]),
    y: Math.round(b.top + b.height * p[1]),
  });
  let action = browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move(at(points[0]))
    .down()
    .pause(30);
  for (const p of points.slice(1)) action = action.move(at(p)).pause(20);
  await action.up().perform();
}

/**
 * Show the stamp strip, which is where the signature controls live.
 *
 * `tools.stamp` TOGGLES the mode, so invoking it while stamp is already armed
 * disarms it and takes the strip away — a spec that assumed it was an
 * idempotent "arm" would find an empty strip and blame the store.
 */
async function armStampTool(): Promise<void> {
  if (await $('[data-testid="signature-create"]').isExisting()) return;
  expect(await invokeAppCommand('tools.stamp')).toBe(true);
  await waitForDisplayedSelector('[data-testid="signature-create"]', { timeout: 10_000 });
}

/** Open the capture dialog from the canvas's stamp strip — the only door the
 * product offers, so the only one a spec may use. */
async function openCaptureDialog(): Promise<void> {
  await armStampTool();
  await waitForDisplayedSelector('[data-testid="secondary-toolbar"]', { timeout: 10_000 });
  await $('[data-testid="signature-create"]').click();
  await waitForDisplayedSelector('[data-testid="signature-save"]', { timeout: 10_000 });
}

async function closeCaptureDialog(): Promise<void> {
  await browser.keys(['Escape']);
  await waitForDisplayedSelector('[data-testid="signature-save"]', {
    reverse: true,
    timeout: 10_000,
  });
}

/** Click the middle of the first visible page in the document view. With a
 * signature armed this is the placement gesture and nothing else. */
async function clickPage(xFrac = 0.5, yFrac = 0.35): Promise<void> {
  const rect = (await browser.execute(() => {
    const el = document.querySelector('[data-testid="document-view"] [data-page-id]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  })) as { left: number; top: number; width: number; height: number } | null;
  expect(rect).not.toBeNull();
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({
      x: Math.round(rect!.left + rect!.width * xFrac),
      y: Math.round(rect!.top + rect!.height * yFrac),
    })
    .down()
    .pause(40)
    .up()
    .perform();
}

async function commitPendingEdits(): Promise<void> {
  await browser.executeAsync(function (done: (r: unknown) => void) {
    (window as any).__SPECTRA_TEST__
      .commitPendingEdits()
      .then(() => done(null))
      .catch((e: Error) => done(String(e)));
  });
}

async function saveActiveAs(dest: string): Promise<void> {
  const failure = await browser.executeAsync(
    function (d: string, done: (r: unknown) => void) {
      (window as any).__SPECTRA_TEST__
        .saveActiveAs(d)
        .then(() => done(null))
        .catch((e: Error) => done(String(e)));
    },
    dest,
  );
  expect(failure).toBeNull();
}

function annotationSubtypes(path: string): string[] {
  const out = execFileSync(APP_EXE, ['comments-list', path], { encoding: 'utf-8' });
  const listed = JSON.parse(out) as { annotations?: { subtype: string; contents?: string }[] };
  return (listed.annotations ?? []).map((a) => a.subtype);
}

function annotationContents(path: string): string[] {
  const out = execFileSync(APP_EXE, ['comments-list', path], { encoding: 'utf-8' });
  const listed = JSON.parse(out) as { annotations?: { contents?: string }[] };
  return (listed.annotations ?? []).map((a) => a.contents ?? '');
}

describe('the personal signature: three capture doors, two consumers', () => {
  before(async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'spectra-e2e-signature-'));
    await waitForHarness();
    await clearAssets();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await invokeAppCommand('view.documentView');
    await waitForDisplayedSelector('[data-testid="document-view"]', { timeout: 15_000 });
  });

  after(async () => {
    // The store is shared with every other window and every later spec — the
    // cross-spec-leak rule. The armed mode goes too: a signature left armed
    // would place itself on the next spec's first page click.
    await clearAssets();
    await invokeAppCommand('tools.select');
    await invokeAppCommand('tools.close');
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  });

  // A modal left open covers the strip behind it, so a failing case would
  // make every later one fail at a click that never reached the chrome. Each
  // test therefore starts from a bare window whatever its own verdict was.
  afterEach(async () => {
    if (await $('[data-testid="signature-save"]').isExisting()) await closeCaptureDialog();
  });

  // ── Door 1: draw ─────────────────────────────────────────────────────

  it('captures a drawn signature and lists it', async () => {
    await openCaptureDialog();
    await drawStroke([
      [0.15, 0.7],
      [0.3, 0.3],
      [0.45, 0.7],
      [0.6, 0.35],
    ]);
    await setReactInputValue('[data-testid="signature-label"]', 'Drawn mark');
    await $('[data-testid="signature-save"]').click();

    await browser.waitUntil(async () => (await storedAssets()).length === 1, {
      timeoutMsg: 'the drawn signature never reached the store',
    });
    const [asset] = await storedAssets();
    expect(asset.kind).toBe('ink');
    expect(asset.name).toBe('Drawn mark');
    expect(asset.strokes!.length).toBe(1);
    // Normalized into the drawing's own box: every coordinate inside the unit
    // square, and the box actually filled on at least one axis.
    for (const s of asset.strokes!) {
      for (const n of s) expect(n).toBeGreaterThanOrEqual(-0.001);
      for (const n of s) expect(n).toBeLessThanOrEqual(1.001);
    }
    expect(asset.aspect).toBeGreaterThan(0);
    await expect($('[data-testid="signature-list"]')).toBeDisplayed();
  });

  it('undo drops the last pen lift and clear empties the canvas', async () => {
    // Two lifts, one undo: what SAVES is the first stroke alone. Asserted on
    // the stored asset rather than on the canvas pixels — the store is what a
    // placement will draw from.
    await openCaptureDialog();
    await drawStroke([
      [0.2, 0.6],
      [0.35, 0.4],
    ]);
    await drawStroke([
      [0.5, 0.4],
      [0.65, 0.6],
    ]);
    await $('[data-testid="signature-undo-stroke"]').click();
    await setReactInputValue('[data-testid="signature-label"]', 'One lift');
    await $('[data-testid="signature-save"]').click();
    await browser.waitUntil(async () => (await storedAssets()).length === 2, {
      timeoutMsg: 'the undone drawing never saved',
    });
    const saved = (await storedAssets()).find((a) => a.name === 'One lift');
    expect(saved).toBeDefined();
    expect(saved!.strokes!.length).toBe(1);

    // Clear empties the capture surface: both stroke controls go dead, which
    // is the state a drawing-free canvas is in, and Save has nothing to take.
    await drawStroke([
      [0.2, 0.5],
      [0.4, 0.5],
    ]);
    expect(await $('[data-testid="signature-clear"]').isEnabled()).toBe(true);
    await $('[data-testid="signature-clear"]').click();
    expect(await $('[data-testid="signature-clear"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="signature-undo-stroke"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="signature-save"]').isEnabled()).toBe(false);
  });

  // ── Door 2: type ─────────────────────────────────────────────────────

  it('types a name in each bundled script face', async () => {
    const faces = ['greatvibes', 'sacramento', 'parisienne'] as const;
    await openCaptureDialog();
    await $('[data-testid="signature-door-type"]').click();
    await waitForDisplayedSelector('[data-testid="signature-typed-text"]', { timeout: 10_000 });

    // Each face must be REGISTERED under its own prefixed family before any
    // of this means anything. The pills declare `"SpectraSignature-x",
    // cursive`, so an unloaded face falls back to the platform's cursive and
    // all three previews render in the SAME hand — which looks like a working
    // picker and is not one. Asked of `document.fonts`, not of pixels: the
    // question is whether the bundled face is there, and that has an answer.
    const registered = (await browser.executeAsync(function (done: (r: unknown) => void) {
      const names = ['greatvibes', 'sacramento', 'parisienne'].map(
        (id) => `SpectraSignature-${id}`,
      );
      const fonts = (document as unknown as { fonts: FontFaceSet }).fonts;
      const loaded: string[] = [];
      fonts.forEach((f) => loaded.push(f.family));
      done({
        loaded,
        checks: names.map((n) => fonts.check(`30px "${n}"`)),
      });
    })) as { loaded: string[]; checks: boolean[] };
    for (const face of faces) {
      if (!registered.loaded.includes(`SpectraSignature-${face}`)) {
        throw new Error(
          `the ${face} face never registered; document.fonts holds ` +
            `${registered.loaded.join(', ') || '(nothing)'}`,
        );
      }
    }
    expect(registered.checks).toEqual([true, true, true]);
    for (const face of faces) {
      await setReactInputValue('[data-testid="signature-typed-text"]', `Ada ${face}`);
      await $(`[data-testid="signature-face-${face}"]`).click();
      expect(await $(`[data-testid="signature-face-${face}"]`).getAttribute('aria-checked')).toBe(
        'true',
      );
      await setReactInputValue('[data-testid="signature-label"]', `Typed ${face}`);
      // Save is dead until the bundled faces are registered — a typed
      // signature is only a signature in the hand the user chose. A dialog
      // error here names the broken installation rather than leaving the
      // failure as "the button did nothing".
      expect(await dialogError()).toBe('');
      await browser.waitUntil(async () => $('[data-testid="signature-save"]').isEnabled(), {
        timeout: 20_000,
        timeoutMsg: `Save never became live for ${face}: ${await dialogError()}`,
      });
      await $('[data-testid="signature-save"]').click();
      await browser.waitUntil(
        async () => (await storedAssets()).some((a) => a.name === `Typed ${face}`),
        { timeoutMsg: `the ${face} typed signature never saved` },
      );
      const saved = (await storedAssets()).find((a) => a.name === `Typed ${face}`)!;
      expect(saved.kind).toBe('typed');
      expect(saved.face).toBe(face);
      expect(saved.text).toBe(`Ada ${face}`);
      // The aspect is measured in the face that will draw it, so a face that
      // never loaded would leave a placeholder ratio behind.
      expect(saved.aspect).toBeGreaterThan(0);
    }
  });

  // ── Door 3: import ───────────────────────────────────────────────────

  it('imports a raster, and background removal is reversible until save', async () => {
    const png = join(SCRATCH, 'mark.png');
    writeFileSync(png, markPng());

    await openCaptureDialog();
    await $('[data-testid="signature-door-import"]').click();
    await waitForDisplayedSelector('[data-testid="signature-pick-image"]', { timeout: 10_000 });
    await answerImagePicker(png);
    await $('[data-testid="signature-pick-image"]').click();
    await browser.waitUntil(async () => $('[data-testid="signature-save"]').isEnabled(), {
      timeout: 20_000,
      timeoutMsg: `the imported image never became saveable: ${await dialogError()}`,
    });

    // Removal ON is the default and it TRIMS: the derived artwork is the mark
    // alone, so its aspect differs from the sheet's. Both answers are reached
    // from the same source pixels — that is what "reversible before save"
    // means, and it is why the threshold control can be moved at all.
    expect(await $('[data-testid="signature-strip-background"]').isSelected()).toBe(true);
    await expect($('[data-testid="signature-threshold"]')).toBeDisplayed();
    await $('[data-testid="signature-strip-background"]').click();
    expect(await $('[data-testid="signature-strip-background"]').isSelected()).toBe(false);
    // With removal off there is nothing to threshold, so the control goes.
    await waitForDisplayedSelector('[data-testid="signature-threshold"]', {
      reverse: true,
      timeout: 10_000,
    });
    await $('[data-testid="signature-strip-background"]').click();
    await waitForDisplayedSelector('[data-testid="signature-threshold"]', { timeout: 10_000 });

    await setReactInputValue('[data-testid="signature-label"]', 'Imported mark');
    await $('[data-testid="signature-save"]').click();
    await browser.waitUntil(
      async () => (await storedAssets()).some((a) => a.name === 'Imported mark'),
      { timeoutMsg: 'the imported signature never saved' },
    );
    const saved = (await storedAssets()).find((a) => a.name === 'Imported mark')!;
    expect(saved.kind).toBe('image');
    // PNG unconditionally: a removed background is an alpha channel and JPEG
    // has none.
    expect(saved.imageData!.startsWith('data:image/png;base64,')).toBe(true);
    expect(saved.aspect).toBeGreaterThan(0);
  });

  // ── Consumer 1: the page ─────────────────────────────────────────────

  it('a placed drawn signature survives the real commit as an /Ink annotation', async () => {
    const assets = await storedAssets();
    const drawn = assets.find((a) => a.kind === 'ink' && a.name === 'Drawn mark')!;
    // The dialog's Place arms an asset and closes; the strip's pill arms one
    // without opening anything. Both are the same arming, so this uses Place
    // for the close and then aims the pill at the asset it wants.
    await openCaptureDialog();
    await $('[data-testid="signature-place"]').click();
    await waitForDisplayedSelector('[data-testid="signature-save"]', {
      reverse: true,
      timeout: 10_000,
    });
    await armPreset(drawn.id);
    expect(await $(`[data-testid="signature-preset-${drawn.id}"]`).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await clickPage();
    const placed = await getFirstAnnotation(10_000);
    expect(placed).not.toBeNull();
    expect(placed!.kind).toBe('ink');

    await commitPendingEdits();
    const dest = join(SCRATCH, 'drawn.pdf');
    await saveActiveAs(dest);
    expect(annotationSubtypes(dest)).toContain('Ink');
  });

  it('Ctrl+Z restores the page to its unsigned state', async () => {
    // The placement went through the annotate tier, so the workspace's own
    // undo owns it — no signature-specific history.
    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(
      async () => {
        const a = await getFirstAnnotation(1_500).catch(() => null);
        return a === null;
      },
      { timeout: 20_000, timeoutMsg: 'undo did not remove the placed signature' },
    );
  });

  it('a placed typed signature carries its text and a /ToUnicode-mapped subset', async () => {
    const typed = (await storedAssets()).find((a) => a.kind === 'typed')!;
    await armPreset(typed.id);
    await clickPage(0.5, 0.6);
    const placed = await getFirstAnnotation(10_000);
    expect(placed).not.toBeNull();
    expect(placed!.kind).toBe('stamp');

    await commitPendingEdits();
    const dest = join(SCRATCH, 'typed.pdf');
    await saveActiveAs(dest);

    // The mark's own text is on the annotation, so a reader that never renders
    // the appearance still reports what was signed.
    expect(annotationContents(dest)).toContain(typed.text);

    // And the appearance's font is a real embedded subset with a /ToUnicode
    // CMap — the property that makes the drawn glyphs extractable rather than
    // an unmapped picture of letters. Read out of the written file: an
    // assertion on the renderer's intent would prove nothing about the bytes.
    const doc = await PDFDocument.load(readFileSync(dest));
    const page = doc.getPage(0);
    const annots = page.node.Annots();
    expect(annots).toBeDefined();
    let sawToUnicode = false;
    for (let i = 0; i < annots!.size(); i += 1) {
      const annot = doc.context.lookup(annots!.get(i), PDFDict);
      const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
      if (!ap) continue;
      const normal = ap.get(PDFName.of('N'));
      if (!normal) continue;
      const stream = doc.context.lookup(normal);
      if (!(stream instanceof PDFStream)) continue;
      const resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
      if (!fonts) continue;
      for (const key of fonts.keys()) {
        const font = fonts.lookup(key, PDFDict);
        if (font.get(PDFName.of('ToUnicode'))) sawToUnicode = true;
      }
    }
    expect(sawToUnicode).toBe(true);

    await pressGlobalKey('z', { ctrl: true });
  });

  // ── The gate: a signed document ──────────────────────────────────────

  it('placing on a SIGNED document rides the incremental-append tier, not a new door', async () => {
    const signed = join(SCRATCH, 'signed.pdf');
    execFileSync(
      APP_EXE,
      ['sign', SAMPLE_PDF, '-o', signed, '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD],
      { encoding: 'utf-8' },
    );
    await openByPaths([signed]);
    await invokeAppCommand('view.documentView');
    await waitForDisplayedSelector('[data-testid="document-view"]', { timeout: 15_000 });

    await armStampTool();
    await waitForDisplayedSelector('[data-testid="secondary-toolbar"]', { timeout: 10_000 });
    // The DRAWN asset by name, never "whatever the list shows first": with all
    // three doors live the newest asset is an imported raster, which lands as
    // a /Stamp, and this case's claim is about /Ink surviving onto a signed
    // document rather than about which door ran most recently.
    const drawn = (await storedAssets()).find((a) => a.kind === 'ink' && a.name === 'Drawn mark')!;
    await armPreset(drawn.id);
    await clickPage();
    const placed = await getFirstAnnotation(10_000);
    expect(placed).not.toBeNull();

    // No signature-specific gate exists, and none is wanted: the annotate
    // tier on a document with a live signature already lands as an
    // incremental revision, so the mark is added and the existing signature
    // stays valid over the bytes it signed. That is the whole content of
    // "no new door" — asserted on the WRITTEN FILE, not on a dialog.
    await commitPendingEdits();
    const dest = join(SCRATCH, 'signed-then-signed.pdf');
    await saveActiveAs(dest);

    expect(annotationSubtypes(dest)).toContain('Ink');
    const out = execFileSync(APP_EXE, ['verify-signatures', dest], { encoding: 'utf-8' });
    const verified = JSON.parse(out.slice(out.indexOf('{'))) as {
      signature_count: number;
      signatures: { valid: boolean; intact: boolean }[];
    };
    expect(verified.signature_count).toBe(1);
    expect(verified.signatures[0].valid).toBe(true);
    expect(verified.signatures[0].intact).toBe(true);
  });

  // ── The store's own housekeeping ─────────────────────────────────────

  it('deleting an armed asset disarms the preset', async () => {
    await openByPaths([SAMPLE_PDF]);
    await invokeAppCommand('view.documentView');
    await waitForDisplayedSelector('[data-testid="document-view"]', { timeout: 15_000 });
    await armStampTool();
    await waitForDisplayedSelector('[data-testid="secondary-toolbar"]', { timeout: 10_000 });

    // A drawn asset, so this case stands on its own door rather than on
    // whichever other door ran last.
    const victim = (await storedAssets()).find((a) => a.name === 'One lift')!;
    await armPreset(victim.id);
    expect(
      await $(`[data-testid="signature-preset-${victim.id}"]`).getAttribute('aria-pressed'),
    ).toBe('true');

    // Delete it through the dialog's own control, then close. The list renders
    // the store's own order, so the victim's row is at its index in the store.
    await $('[data-testid="signature-create"]').click();
    await waitForDisplayedSelector('[data-testid="signature-list"]', { timeout: 10_000 });
    const index = (await storedAssets()).findIndex((a) => a.id === victim.id);
    expect(index).toBeGreaterThanOrEqual(0);
    const deletes = await $$('[data-testid="signature-delete"]').getElements();
    await (await deletes)[index].click();
    await browser.waitUntil(
      async () => !(await storedAssets()).some((a) => a.id === victim.id),
      { timeoutMsg: 'the asset was never deleted' },
    );
    await closeCaptureDialog();

    // The pill is gone — and so is the ARMING. A preset still holding a
    // deleted asset would place a mark the user has thrown away on the next
    // page click, which is the one outcome a signature store must not have.
    expect(await $(`[data-testid="signature-preset-${victim.id}"]`).isExisting()).toBe(false);
    await clickPage(0.4, 0.5);
    const stray = await getFirstAnnotation(3_000).catch(() => null);
    expect(stray).toBeNull();
  });
});
