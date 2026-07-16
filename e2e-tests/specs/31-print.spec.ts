import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  setReactInputValue,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const BINARY = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'openpdfstudio.exe');

// M-P (§ 3.4): File ▸ Print… (Ctrl+P) — printer picker, range, copies,
// fit/actual — plus the CLI arm. Nothing here SPOOLS a job (the only printers
// on a dev box either print real paper or raise interactive dialogs); the
// engine→Ghostscript→mswinpr2 path is proven through the CLI against a
// printer name that cannot exist, which executes every line of ours and
// fails only at the driver-open Ghostscript makes.

/** The dialog's printer <option> labels. */
async function printerOptions(): Promise<string[]> {
  const opts = await $$('[data-testid="print-printer"] option');
  const out: string[] = [];
  for (const o of opts) out.push(await o.getText());
  return out;
}

describe('print (M-P)', () => {
  it('Ctrl+P is inert with no document to print', async () => {
    await waitForHarness();
    await closeAllFiles();
    await browser.keys(['Control', 'p']);
    await expect($('[data-testid="print-dialog"]')).not.toBeExisting();
  });

  it('Ctrl+P opens the dialog with the REAL system printers, matching the CLI', async () => {
    await openByPaths([SAMPLE_PDF]);
    await browser.keys(['Control', 'p']);
    await $('[data-testid="print-dialog"]').waitForDisplayed({
      timeoutMsg: 'Ctrl+P did not open the Print dialog',
    });

    // GUI/CLI parity in one assertion: the picker renders what winspool
    // enumerates, and the CLI `printers` subcommand shares that exact
    // implementation — so the dialog's list must equal the CLI's JSON.
    // Deliberately HARD-fails (no skip) on a printerless box: Windows ships
    // "Microsoft Print to PDF" on by default, so zero printers means the
    // suite's machine can't exercise enumeration at all — that should be
    // loud, not a silently thinner run.
    const cli = JSON.parse(
      execFileSync(BINARY, ['printers'], { encoding: 'utf8' }),
    ) as { printers: string[]; default: string | null };
    expect(cli.printers.length).toBeGreaterThan(0);

    await browser.waitUntil(
      async () => (await printerOptions()).length === cli.printers.length,
      { timeoutMsg: 'printer list never populated' },
    );
    expect(await printerOptions()).toEqual(cli.printers);

    // The default printer is preselected (or the first, when none is set).
    const selected = await $('[data-testid="print-printer"]').getValue();
    expect(selected).toBe(cli.default ?? cli.printers[0]);

    // Complete controls, real page count.
    const allLabel = await $('[data-testid="print-range-all"]').parentElement();
    expect(await allLabel.getText()).toContain('5 pages');
    await expect($('[data-testid="print-copies"]')).toBeDisplayed();
    await expect($('[data-testid="print-fit-fit"]')).toBeSelected();
    await expect($('[data-testid="print-submit"]')).toBeEnabled();
  });

  it('refuses a range beyond the document, and garbage, BEFORE the job', async () => {
    await $('[data-testid="print-range-custom"]').click();
    // Empty custom range: not an error, but nothing to print either.
    await expect($('[data-testid="print-submit"]')).toBeDisabled();

    await setReactInputValue('[data-testid="print-range-input"]', '7');
    const err = $('[data-testid="print-range-error"]');
    await err.waitForDisplayed({ timeoutMsg: 'no range error for page 7 of 5' });
    expect(await err.getText()).toContain('beyond the document (5 pages)');
    await expect($('[data-testid="print-submit"]')).toBeDisabled();

    await setReactInputValue('[data-testid="print-range-input"]', 'abc');
    await err.waitForDisplayed();
    await expect($('[data-testid="print-submit"]')).toBeDisabled();

    await setReactInputValue('[data-testid="print-range-input"]', '2-4');
    await err.waitForDisplayed({
      reverse: true,
      timeoutMsg: 'valid range 2-4 still flagged',
    });
    await expect($('[data-testid="print-submit"]')).toBeEnabled();
  });

  it('refuses out-of-bounds copies', async () => {
    await setReactInputValue('[data-testid="print-copies"]', '0');
    await $('[data-testid="print-copies-error"]').waitForDisplayed({
      timeoutMsg: 'no copies error for 0',
    });
    await expect($('[data-testid="print-submit"]')).toBeDisabled();

    await setReactInputValue('[data-testid="print-copies"]', '2');
    await $('[data-testid="print-copies-error"]').waitForDisplayed({ reverse: true });
    await expect($('[data-testid="print-submit"]')).toBeEnabled();

    await $('[data-testid="print-cancel"]').click();
    await $('[data-testid="print-dialog"]').waitForDisplayed({
      reverse: true,
      timeoutMsg: 'Cancel did not close the Print dialog',
    });
  });

  it('File ▸ Print… opens it from the real menu, labeled Ctrl+P', async () => {
    await $('[data-testid="menu-file"]').click();
    const item = $('[data-testid="menuitem-file-print"]');
    await item.waitForDisplayed({ timeoutMsg: 'no Print… item in the File menu' });
    // The displayed shortcut comes from the keymap table (drift-impossible).
    expect(await item.getText()).toContain('Ctrl+P');
    await item.click();
    await $('[data-testid="print-dialog"]').waitForDisplayed({
      timeoutMsg: 'File ▸ Print… did not open the dialog',
    });
    await $('[data-testid="print-cancel"]').click();
    await $('[data-testid="print-dialog"]').waitForDisplayed({ reverse: true });
  });

  it('CLI print refuses an unknown printer FAST (winspool check, no gs)', async () => {
    // CLI → engine `print` registration → real winspool existence check.
    // This must refuse in seconds: gs's mswinpr2, handed a name it can't
    // open, raises its own INVISIBLE printer dialog and hangs to the 600s
    // timeout — the first cut of this very test proved that live. The
    // duration assertion is what discriminates the pre-check from the hang.
    const started = Date.now();
    let status = 0;
    let stderr = '';
    try {
      execFileSync(BINARY, [
        'print', SAMPLE_PDF, '--printer', 'OPS E2E No Such Printer',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? -1;
      stderr = String(err.stderr ?? '');
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unknown printer: 'OPS E2E No Such Printer'");
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('CLI print validates the range against the document (engine parity)', async () => {
    // A REAL printer name (the existence check runs before the range parse),
    // a range the 5-page fixture cannot satisfy — the strict parse refuses
    // BEFORE gs ever spawns, so nothing can reach a spooler.
    const cli = JSON.parse(
      execFileSync(BINARY, ['printers'], { encoding: 'utf8' }),
    ) as { printers: string[] };
    expect(cli.printers.length).toBeGreaterThan(0);

    let status = 0;
    let stderr = '';
    try {
      execFileSync(BINARY, [
        'print', SAMPLE_PDF, '--printer', cli.printers[0], '--pages', '9',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? -1;
      stderr = String(err.stderr ?? '');
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain('beyond the document');
    expect(stderr).not.toContain('Ghostscript');
  });
});
