// Prepare Form — automatic field detection, end to end.
//
// The assertions that matter are the ones a unit test cannot make:
//   · detection writes NOTHING (the document still has zero widgets after it
//     has found five fields),
//   · the checkbox decides — an unchecked candidate does not become a field,
//   · and ONE undo removes the whole accepted batch, which is what proves the
//     accept is a single operation rather than N.
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  focusTab,
  invokeAppCommand,
  saveActiveAs,
  closeAllFiles,
  formWidgetCount,
  pressGlobalKey,
} from '../support/harness.js';

const LABELS = ['First name:', 'Last name:', 'Email address:', 'Telephone:'] as const;

/** A ruled fill-in form: four labelled rules, plus a two-row table whose rules
 * carry no label — those must be reported and not offered. */
async function makeRuledForm(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 700;
  for (const label of LABELS) {
    page.drawText(label, { x: 72, y: y + 3, size: 11, font });
    page.drawLine({
      start: { x: 170, y },
      end: { x: 520, y },
      thickness: 0.7,
      color: rgb(0, 0, 0),
    });
    y -= 40;
  }
  for (const ty of [450, 430]) {
    page.drawLine({
      start: { x: 72, y: ty },
      end: { x: 540, y: ty },
      thickness: 0.4,
      color: rgb(0, 0, 0),
    });
  }
  writeFileSync(path, await doc.save());
}

async function fieldNames(path: string): Promise<string[]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), {
    ignoreEncryption: true,
  });
  return doc
    .getForm()
    .getFields()
    .map((f) => f.getName())
    .sort();
}

async function clickEl(selector: string): Promise<void> {
  const el = await $(selector);
  await el.waitForExist({ timeout: 20_000 });
  await browser.execute((s: string) => {
    const node = document.querySelector(s) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center' });
    node?.click();
  }, selector);
}

async function candidateRowCount(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid^="prepare-form-check-"]').length,
  );
}

async function overlayCount(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid^="field-candidate-"]').length,
  );
}

describe('Prepare Form field detection', () => {
  let tmp: string;
  let source: string;
  let output: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-f17-'));
    source = resolve(tmp, 'ruled.pdf');
    output = resolve(tmp, 'ruled-out.pdf');
    await makeRuledForm(source);
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('detects fields without writing, then creates only the checked ones as one undoable act', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');
    await focusTab({ doc: source });
    // One command seats the panel in the dock AND arms the tool's canvas mode,
    // which is what draws the provisional overlays.
    expect(await invokeAppCommand('tools.panel.prepareform')).toBe(true);
    await $('[data-testid="prepare-form-panel"]').waitForDisplayed({ timeout: 20_000 });

    await clickEl('[data-testid="prepare-form-detect"]');
    await browser.waitUntil(async () => (await candidateRowCount()) === LABELS.length, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'detection never produced one row per labelled rule',
    });

    // Found, offered, and NOTHING written: the whole safety property.
    expect(await formWidgetCount(source)).toBe(0);
    expect(await overlayCount()).toBe(LABELS.length);

    // The table rules were found and withheld, and said so.
    const unoffered = await $('[data-testid="prepare-form-unoffered"]');
    expect(await unoffered.isExisting()).toBe(true);

    // Check every candidate, then take one back.
    await clickEl('[data-testid="prepare-form-select-all"]');
    await clickEl('[data-testid="prepare-form-check-Telephone"]');

    await clickEl('[data-testid="prepare-form-create"]');
    await browser.waitUntil(async () => (await formWidgetCount(source)) === LABELS.length - 1, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'the checked candidates never became fields',
    });

    await saveActiveAs(output);
    expect(await fieldNames(output)).toEqual(['Email_address', 'First_name', 'Last_name']);

    // ONE undo removes the whole batch — the proof that the accept is a single
    // operation, not one per field.
    await pressGlobalKey('z', { ctrl: true });
    await browser.waitUntil(async () => (await formWidgetCount(source)) === 0, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'one undo did not remove the whole created batch',
    });
  });

  it('recovers the same fields from a scan of the same form', async () => {
    // The scanned page carries no painted paths and no text runs, so the arm is
    // chosen by the page's own content rather than by a switch the user sets.
    const scan = resolve(tmp, 'scan.pdf');
    const rendered = resolve(tmp, 'scan-source.pdf');
    await makeRuledForm(rendered);
    await buildScan(rendered, scan);

    await closeAllFiles();
    await openByPaths([scan]);
    await setView('canvas');
    await focusTab({ doc: scan });
    expect(await invokeAppCommand('tools.panel.prepareform')).toBe(true);
    await $('[data-testid="prepare-form-panel"]').waitForDisplayed({ timeout: 20_000 });

    await clickEl('[data-testid="prepare-form-detect"]');
    await browser.waitUntil(async () => (await candidateRowCount()) === LABELS.length, {
      timeout: 120_000,
      interval: 500,
      timeoutMsg: 'the scan arm never produced one row per labelled rule',
    });
    // The page carries no text at all, so a bound label can only have come
    // from recognition — and the names prove the labels, not just the rules.
    expect(await formWidgetCount(scan)).toBe(0);
    await clickEl('[data-testid="prepare-form-select-all"]');
    await clickEl('[data-testid="prepare-form-create"]');
    await browser.waitUntil(async () => (await formWidgetCount(scan)) === LABELS.length, {
      timeout: 60_000,
      interval: 200,
      timeoutMsg: 'the recovered candidates never became fields',
    });
    const scanOut = resolve(tmp, 'scan-out.pdf');
    await saveActiveAs(scanOut);
    expect(await fieldNames(scanOut)).toEqual([
      'Email_address',
      'First_name',
      'Last_name',
      'Telephone',
    ]);
  });
});

/** Render the form at the recognition density and re-embed it as an image.
 *
 * The vendored Ghostscript is a hard requirement rather than a skip: a scan
 * case that quietly does nothing is a case that stops testing the scan arm the
 * first time the fixture build breaks. */
async function buildScan(source: string, target: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const gs = resolve(process.cwd(), '..', 'resources', 'ghostscript', 'gswin64c.exe');
  const local = resolve(process.cwd(), 'resources', 'ghostscript', 'gswin64c.exe');
  const exe = existsSync(gs) ? gs : existsSync(local) ? local : null;
  if (!exe) throw new Error('the vendored Ghostscript is required to build the scan fixture');
  const png = resolve(tmpdir(), `spectra-e2e-f17-${Date.now()}.png`);
  execFileSync(exe, [
    '-sDEVICE=png16m',
    '-r300',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-dSAFER',
    `-sOutputFile=${png}`,
    source,
  ]);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(readFileSync(png));
  const page = doc.addPage([612, 792]);
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  writeFileSync(target, await doc.save());
  rmSync(png, { force: true });
}
