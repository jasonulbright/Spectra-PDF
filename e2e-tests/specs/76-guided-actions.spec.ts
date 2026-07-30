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

// § parity-map 2 — guided actions (Action Wizard), slice 1: author a
// two-step sequence through the REAL editor, validation refuses an empty
// draft, the runner drives both steps through the gated engine pipeline over
// the open document, and the REAL CLI reads the watermark back out of the
// saved output. Library state cleared at the end (cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'openpdfstudio.exe');

let SCRATCH = '';

describe('guided actions (parity map § 2, slice 1)', () => {
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
