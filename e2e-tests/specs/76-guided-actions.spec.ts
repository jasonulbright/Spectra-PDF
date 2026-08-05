import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

// Guided actions (Action Wizard): author a
// two-step sequence through the REAL editor, validation refuses an empty
// draft, the runner drives both steps through the gated engine pipeline over
// the open document, and the REAL CLI reads the watermark back out of the
// saved output. Library state cleared at the end (cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

let SCRATCH = '';

async function saveAs(dest: string): Promise<void> {
  const err = (await browser.executeAsync(function (d: string, done: (r: string | null) => void) {
    (window as any).__SPECTRA_TEST__
      .saveActiveAs(d)
      .then(() => done(null))
      .catch((e: unknown) => done(String(e)));
  }, dest)) as string | null;
  expect(err).toBeNull();
}

function cliText(path: string): string {
  const out = execFileSync(APP_EXE, ['extract-text', path], { encoding: 'utf-8' });
  return (JSON.parse(out) as { text?: string }).text ?? '';
}

async function storedActions(): Promise<{ id: string; name: string }[]> {
  return (await browser.execute(() =>
    JSON.parse(localStorage.getItem('guided-actions') ?? '[]'),
  )) as { id: string; name: string }[];
}

describe('guided actions', () => {
  before(async () => {
    SCRATCH = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-actions-'));
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

  it('refuses to save an empty draft with a named problem', async () => {
    await $('[data-testid="action-new"]').click();
    await $('[data-testid="action-save"]').waitForDisplayed();
    await $('[data-testid="action-save"]').click();
    const err = await $('[data-testid="action-edit-error"]');
    await err.waitForDisplayed({ timeoutMsg: 'no validation error shown' });
    expect(await err.getText()).toMatch(/name/i);
    await $('[data-testid="action-cancel"]').click();
  });

  it('authors a two-step action through the editor', async () => {
    await $('[data-testid="action-new"]').click();
    await setReactInputValue('[data-testid="action-name"]', 'Mark & Strip');

    await setReactSelectValue('[data-testid="action-add-op"]', 'watermark');
    await $('[data-testid="action-add-step"]').click();
    await $('[data-testid="action-step-0-text"]').waitForDisplayed();
    await setReactInputValue('[data-testid="action-step-0-text"]', 'DRAFT E2E');

    await setReactSelectValue('[data-testid="action-add-op"]', 'strip_metadata');
    await $('[data-testid="action-add-step"]').click();
    await $('[data-testid="action-step-1"]').waitForDisplayed();

    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed({
      timeoutMsg: 'saving did not return to the list',
    });
    const stored = (await browser.execute(() =>
      JSON.parse(localStorage.getItem('guided-actions') ?? '[]'),
    )) as { name: string; steps: unknown[] }[];
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe('Mark & Strip');
    expect(stored[0].steps.length).toBe(2);
  });

  it('runs the action over the open document, every step green', async () => {
    const runButtons = await $$('[data-testid^="action-run-"]');
    expect((await runButtons).length).toBe(1);
    await runButtons[0].click();

    await $('[data-testid="actions-run"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="run-done"]').waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'the run never completed',
    });
    expect(await $('[data-testid="run-step-0"]').getAttribute('data-status')).toBe('done');
    expect(await $('[data-testid="run-step-1"]').getAttribute('data-status')).toBe('done');
    await $('[data-testid="run-close"]').click();
  });

  it('Ask-at-run + header tokens through the pre-run form', async () => {
    // Author: watermark with its TEXT asked at run (left empty — legal,
    // because asked) + a {page} footer.
    await $('[data-testid="action-new"]').click();
    await setReactInputValue('[data-testid="action-name"]', 'Asked & Numbered');
    await setReactSelectValue('[data-testid="action-add-op"]', 'watermark');
    await $('[data-testid="action-add-step"]').click();
    await $('[data-testid="action-step-0-text-ask"]').click();
    await setReactSelectValue('[data-testid="action-add-op"]', 'add_header_footer');
    await $('[data-testid="action-add-step"]').click();
    await setReactInputValue('[data-testid="action-step-1-text"]', 'Page {page}');
    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();

    const asked = (await storedActions()).find((a) => a.name === 'Asked & Numbered');
    expect(asked).toBeDefined();
    await $(`[data-testid="action-run-${asked!.id}"]`).click();

    // The pre-run form gates the run: an empty required asked value refuses
    // by name, a filled one starts.
    await $('[data-testid="actions-prerun"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="prerun-start"]').click();
    await $('[data-testid="prerun-error"]').waitForDisplayed({
      timeoutMsg: 'the empty asked value was not refused',
    });
    await setReactInputValue('[data-testid="prerun-0-text"]', 'ASKED E2E');
    await $('[data-testid="prerun-start"]').click();
    await $('[data-testid="run-done"]').waitForDisplayed({ timeout: 30_000 });
    await $('[data-testid="run-close"]').click();

    const dest = resolve(SCRATCH, 'asked.pdf');
    await saveAs(dest);
    const text = cliText(dest);
    expect(text).toContain('ASKED E2E');
    expect(text).toContain('Page 1'); // the engine resolved the {page} token
  });

  it('The OCR step offers the full language list in the editor', async () => {
    await $('[data-testid="action-new"]').click();
    await setReactSelectValue('[data-testid="action-add-op"]', 'ocr_file');
    await $('[data-testid="action-add-step"]').click();
    const options = await $$('[data-testid="action-step-0-language"] option');
    expect((await options).length).toBeGreaterThanOrEqual(40);
    await $('[data-testid="action-cancel"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();
  });

  it('Encrypt runs as a TERMINAL step — new file locked, open doc untouched', async () => {
    await $('[data-testid="action-new"]').click();
    await setReactInputValue('[data-testid="action-name"]', 'Lock');
    await setReactSelectValue('[data-testid="action-add-op"]', 'encrypt');
    await $('[data-testid="action-add-step"]').click();
    // Passwords are never stored: the editor shows the fact, not an input.
    await expect($('[data-testid="action-step-0-user_password-secret"]')).toBeDisplayed();
    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();

    const lock = (await storedActions()).find((a) => a.name === 'Lock');
    expect(lock).toBeDefined();
    expect(JSON.stringify(await storedActions())).not.toContain('s3cret');

    // The terminal output is a native dialog — inject it via the bridge and
    // drive the REAL runner with the asked password.
    const out = resolve(SCRATCH, 'locked.pdf');
    const err = (await browser.executeAsync(
      function (
        id: string,
        vals: Record<number, Record<string, string>>,
        output: string,
        done: (r: string | null) => void,
      ) {
        (window as any).__SPECTRA_TEST__
          .guidedRunWithOutput(id, vals, output)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      lock!.id,
      // A USER (open) password — an owner-only password deliberately leaves
      // the file readable (that IS owner encryption), so only an open
      // password makes the extraction-refusal assertion meaningful.
      { 0: { user_password: 's3cret-e2e' } },
      out,
    )) as string | null;
    expect(err).toBeNull();
    await $('[data-testid="run-done"]').waitForDisplayed({ timeout: 30_000 });
    await $('[data-testid="run-close"]').click();

    // The product is really encrypted — extraction REFUSES it…
    let refused = false;
    try {
      execFileSync(APP_EXE, ['extract-text', out], { encoding: 'utf-8' });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    // …and the OPEN document stayed unencrypted.
    const plain = resolve(SCRATCH, 'still-plain.pdf');
    await saveAs(plain);
    expect(cliText(plain).length).toBeGreaterThan(0);
  });

  it('the saved output really carries the watermark (real CLI reads it back)', async () => {
    const dest = resolve(SCRATCH, 'marked.pdf');
    const err = (await browser.executeAsync(function (d: string, done: (r: string | null) => void) {
      (window as any).__SPECTRA_TEST__
        .saveActiveAs(d)
        .then(() => done(null))
        .catch((e: unknown) => done(String(e)));
    }, dest)) as string | null;
    expect(err).toBeNull();

    const out = execFileSync(APP_EXE, ['extract-text', dest], { encoding: 'utf-8' });
    const parsed = JSON.parse(out) as { text?: string };
    expect(parsed.text ?? '').toContain('DRAFT E2E');
  });
});
