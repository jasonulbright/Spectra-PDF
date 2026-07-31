import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

// § parity-map 2 — guided actions slice 3: FOLDER mode. The run happens
// ENGINE-side (one RPC, the batch-OCR mirror shape): a source tree of PDFs
// mirrors into a destination with the steps applied, originals untouched,
// one run log written. The CLI's `run-action` arm shares the same engine op
// with an action-JSON file — verified here too.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'openpdfstudio.exe');

let SCRATCH = '';
let SRC = '';
let DEST = '';

function cliText(path: string): string {
  const out = execFileSync(APP_EXE, ['extract-text', path], { encoding: 'utf-8' });
  return (JSON.parse(out) as { text?: string }).text ?? '';
}

describe('guided actions — folder mode (slice 3)', () => {
  before(async () => {
    SCRATCH = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-actions-folder-'));
    SRC = resolve(SCRATCH, 'src');
    DEST = resolve(SCRATCH, 'dest');
    mkdirSync(resolve(SRC, 'sub'), { recursive: true });
    copyFileSync(SAMPLE_PDF, resolve(SRC, 'a.pdf'));
    copyFileSync(SAMPLE_PDF, resolve(SRC, 'sub', 'b.pdf'));

    await waitForHarness();
    await browser.execute(() => localStorage.removeItem('guided-actions'));
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    expect(await invokeAppCommand('tools.open.actions')).toBe(true);
    await $('[data-testid="action-new"]').waitForDisplayed({ timeout: 10_000 });
  });

  after(async () => {
    await browser.execute(() => localStorage.removeItem('guided-actions'));
    await invokeAppCommand('tools.close');
  });

  it('authors the action and runs it over a folder through the real machinery', async () => {
    await $('[data-testid="action-new"]').click();
    await setReactInputValue('[data-testid="action-name"]', 'Folder Mark');
    await setReactSelectValue('[data-testid="action-add-op"]', 'watermark');
    await $('[data-testid="action-add-step"]').click();
    await setReactInputValue('[data-testid="action-step-0-text"]', 'TREE E2E');
    await setReactSelectValue('[data-testid="action-add-op"]', 'strip_metadata');
    await $('[data-testid="action-add-step"]').click();
    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();

    const stored = (await browser.execute(() =>
      JSON.parse(localStorage.getItem('guided-actions') ?? '[]'),
    )) as { id: string; name: string }[];
    const action = stored.find((a) => a.name === 'Folder Mark');
    expect(action).toBeDefined();

    // The folder pickers are native — inject the paths, run the REAL flow.
    const err = (await browser.executeAsync(
      function (id: string, src: string, dst: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .guidedRunFolder(id, {}, src, dst)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      action!.id,
      SRC,
      DEST,
    )) as string | null;
    expect(err).toBeNull();

    await $('[data-testid="folderrun-summary"]').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the folder run never reported',
    });
    expect(await $('[data-testid="folderrun-summary"]').getText()).toBe(
      '2 processed · 0 failed · 2 total',
    );

    // The run log is real and carries the action-run prefix.
    await expect($('[data-testid="folderrun-log"]')).toBeDisplayed();
    const logLine = await $('[data-testid="folderrun-log"]').getText();
    const logPath = logLine.replace(/^Log:\s*/, '');
    expect(existsSync(logPath)).toBe(true);
    expect(basename(logPath).startsWith('action-run-')).toBe(true);

    await $('[data-testid="folderrun-close"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();
  });

  it('the mirror carries the steps; the originals are untouched', () => {
    expect(cliText(resolve(DEST, 'a.pdf'))).toContain('TREE E2E');
    expect(cliText(resolve(DEST, 'sub', 'b.pdf'))).toContain('TREE E2E');
    expect(cliText(resolve(SRC, 'a.pdf'))).not.toContain('TREE E2E');
  });

  it('the CLI run-action arm shares the engine op via an action JSON file', () => {
    const src2 = resolve(SCRATCH, 'src2');
    const dest2 = resolve(SCRATCH, 'dest2');
    mkdirSync(src2, { recursive: true });
    copyFileSync(SAMPLE_PDF, resolve(src2, 'c.pdf'));
    const actionFile = resolve(SCRATCH, 'action.json');
    writeFileSync(
      actionFile,
      JSON.stringify({
        name: 'CLI Mark',
        steps: [
          { op: 'watermark', params: { text: 'CLI TREE', opacity: 0.2, angle: 45 } },
          { op: 'strip_metadata', params: {} },
        ],
      }),
    );
    const out = execFileSync(
      APP_EXE,
      ['run-action', src2, '--dest', dest2, '--action', actionFile],
      { encoding: 'utf-8' },
    );
    // Progress lines precede a PRETTY-PRINTED JSON report — parse from the
    // first line that opens the object.
    const lines = out.trim().split(/\r?\n/);
    const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
    expect(start).toBeGreaterThanOrEqual(0);
    const report = JSON.parse(lines.slice(start).join('\n')) as { ok: number; failed: number };
    expect(report.ok).toBe(1);
    expect(report.failed).toBe(0);
    expect(cliText(resolve(dest2, 'c.pdf'))).toContain('CLI TREE');
  });

  it('O7 in-place mode: --in-place REPLACES the originals, no mirror, no litter', () => {
    const src3 = resolve(SCRATCH, 'src3');
    mkdirSync(src3, { recursive: true });
    copyFileSync(SAMPLE_PDF, resolve(src3, 'd.pdf'));
    const actionFile = resolve(SCRATCH, 'action-inplace.json');
    writeFileSync(
      actionFile,
      JSON.stringify({
        name: 'CLI In Place',
        steps: [{ op: 'watermark', params: { text: 'INPLACE E2E', opacity: 0.2, angle: 45 } }],
      }),
    );
    const out = execFileSync(
      APP_EXE,
      ['run-action', src3, '--in-place', '--action', actionFile],
      { encoding: 'utf-8' },
    );
    const lines = out.trim().split(/\r?\n/);
    const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
    const report = JSON.parse(lines.slice(start).join('\n')) as {
      ok: number;
      failed: number;
      in_place: boolean;
    };
    expect(report.ok).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.in_place).toBe(true);
    // The ORIGINAL carries the watermark now; no staging litter remains.
    expect(cliText(resolve(src3, 'd.pdf'))).toContain('INPLACE E2E');
    expect(readdirSync(src3).filter((f) => f.endsWith('.inplace.tmp'))).toEqual([]);
  });
});
