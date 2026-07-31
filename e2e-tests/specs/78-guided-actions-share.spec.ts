import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// § parity-map 2 — guided actions slice 4: actions travel as FILES. Export
// writes the CLI-consumable {name, steps} shape and can never carry a
// password (secrets stripped by construction); import validates against the
// catalog BY NAME, mints a fresh id, and the imported action runs through
// the real machinery. Native dialogs are bridged with injected paths (the
// 76/77 precedent). Library state cleared at the end (cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'openpdfstudio.exe');

let SCRATCH = '';
let EXPORTED = '';
let ORIGINAL_ID = '';

function cliText(path: string): string {
  const out = execFileSync(APP_EXE, ['extract-text', path], { encoding: 'utf-8' });
  return (JSON.parse(out) as { text?: string }).text ?? '';
}

interface StoredAction {
  id: string;
  name: string;
  steps: { op: string; params: Record<string, unknown> }[];
}

async function storedActions(): Promise<StoredAction[]> {
  return (await browser.execute(() =>
    JSON.parse(localStorage.getItem('guided-actions') ?? '[]'),
  )) as StoredAction[];
}

/** Bridge the native save dialog: export `actionId` to `path`. Null = ok. */
async function exportViaBridge(actionId: string, path: string): Promise<string | null> {
  return (await browser.executeAsync(
    function (id: string, p: string, done: (r: string | null) => void) {
      (window as any).__SPECTRA_TEST__
        .guidedExportToPath(id, p)
        .then(() => done(null))
        .catch((e: unknown) => done(String(e)));
    },
    actionId,
    path,
  )) as string | null;
}

/** Bridge the native open dialog: import the file at `path`. Null = ok,
 * otherwise the named refusal. */
async function importViaBridge(path: string): Promise<string | null> {
  return (await browser.executeAsync(function (p: string, done: (r: string | null) => void) {
    (window as any).__SPECTRA_TEST__
      .guidedImportFromPath(p)
      .then(() => done(null))
      .catch((e: unknown) => done(String(e)));
  }, path)) as string | null;
}

describe('guided actions — export/import as files (slice 4)', () => {
  before(async () => {
    // Scratch lives INSIDE the app's static fs scope ($TEMP/openpdfstudio/**):
    // the bridge injects paths without a native dialog, so the runtime scope
    // extension real picks get (allow_picked_path) never runs for them.
    const scoped = resolve(tmpdir(), 'openpdfstudio');
    mkdirSync(scoped, { recursive: true });
    SCRATCH = mkdtempSync(resolve(scoped, 'e2e-actions-share-'));
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
    if (SCRATCH && existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('exports an authored action as the CLI-shape file with NO password material', async () => {
    // Author through the REAL editor: a watermark + a terminal encrypt (the
    // step whose secrets make the no-password assertion meaningful).
    await $('[data-testid="action-import"]').waitForDisplayed(); // slice-4 UI present
    await $('[data-testid="action-new"]').click();
    await setReactInputValue('[data-testid="action-name"]', 'Travel Kit');
    await setReactSelectValue('[data-testid="action-add-op"]', 'watermark');
    await $('[data-testid="action-add-step"]').click();
    await setReactInputValue('[data-testid="action-step-0-text"]', 'SHARED E2E');
    await setReactSelectValue('[data-testid="action-add-op"]', 'encrypt');
    await $('[data-testid="action-add-step"]').click();
    await expect($('[data-testid="action-step-1-user_password-secret"]')).toBeDisplayed();
    await $('[data-testid="action-save"]').click();
    await $('[data-testid="actions-list"]').waitForDisplayed();

    const action = (await storedActions()).find((a) => a.name === 'Travel Kit');
    expect(action).toBeDefined();
    ORIGINAL_ID = action!.id;
    await $(`[data-testid="action-export-${ORIGINAL_ID}"]`).waitForDisplayed();

    EXPORTED = resolve(SCRATCH, 'travel-kit.json');
    expect(await exportViaBridge(ORIGINAL_ID, EXPORTED)).toBeNull();

    const raw = readFileSync(EXPORTED, 'utf-8');
    // Secrets are stripped at the save path by construction — not even the
    // KEY names survive, so no password material of any kind is in the file.
    expect(raw).not.toContain('password');
    const parsed = JSON.parse(raw) as {
      id?: string;
      name: string;
      steps: { op: string; params: Record<string, unknown> }[];
    };
    expect(parsed.id).toBeUndefined(); // imports mint their own
    expect(parsed.name).toBe('Travel Kit');
    expect(parsed.steps.map((s) => s.op)).toEqual(['watermark', 'encrypt']);
    expect(parsed.steps[0].params.text).toBe('SHARED E2E');
    expect(parsed.steps[1].params).toEqual({});
  });

  it('a wiped library imports the file back under a FRESH id — and the action runs', async () => {
    await $(`[data-testid="action-delete-${ORIGINAL_ID}"]`).click();
    await $('[data-testid="actions-empty"]').waitForDisplayed();
    expect((await storedActions()).length).toBe(0);

    expect(await importViaBridge(EXPORTED)).toBeNull();
    await $('[data-testid="actions-list"]').waitForDisplayed({
      timeoutMsg: 'the imported action never appeared in the list',
    });
    const imported = (await storedActions()).find((a) => a.name === 'Travel Kit');
    expect(imported).toBeDefined();
    expect(imported!.id).not.toBe(ORIGINAL_ID);
    expect(imported!.steps.map((s) => s.op)).toEqual(['watermark', 'encrypt']);

    // Run it through the REAL runner: encrypt is terminal (injected output)
    // and its passwords are implicitly asked. An OWNER-ONLY password
    // deliberately leaves the file readable — which is exactly what lets the
    // watermark assertion see through the encryption it also proves.
    const out = resolve(SCRATCH, 'travelled.pdf');
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
      imported!.id,
      { 1: { owner_password: 'own-e2e' } },
      out,
    )) as string | null;
    expect(err).toBeNull();
    await $('[data-testid="run-done"]').waitForDisplayed({ timeout: 30_000 });
    await $('[data-testid="run-close"]').click();

    expect(readFileSync(out).includes('/Encrypt')).toBe(true); // really encrypted
    expect(cliText(out)).toContain('SHARED E2E'); // both imported steps ran
  });

  it('malformed files refuse BY NAME and leave the library alone', async () => {
    const badOp = resolve(SCRATCH, 'bad-op.json');
    writeFileSync(badOp, JSON.stringify({ name: 'Bad', steps: [{ op: 'explode', params: {} }] }));
    expect(await importViaBridge(badOp)).toContain("unknown operation 'explode'");

    const badParam = resolve(SCRATCH, 'bad-param.json');
    writeFileSync(
      badParam,
      JSON.stringify({ name: 'Bad2', steps: [{ op: 'compress', params: { gs_path: 'evil.exe' } }] }),
    );
    expect(await importViaBridge(badParam)).toContain('unknown parameter(s) [gs_path]');

    const notJson = resolve(SCRATCH, 'not-json.json');
    writeFileSync(notJson, '{oops');
    expect(await importViaBridge(notJson)).toContain('valid JSON');

    const stored = await storedActions();
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe('Travel Kit');
  });
});
