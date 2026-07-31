import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, invokeAppCommand } from '../support/harness.js';

// Watched folders (O7): drop a PDF into the intake and the saved action runs
// over it with nobody at the keyboard — processed copy in Out, original
// filed to Done, intake left empty (the idempotence property). This drives
// the REAL machinery end to end: the in-app polling watcher, the spawned
// CLI runner, and the engine — no mocks. The watcher polls every 5s and
// needs a stable size across two ticks, so the assertions wait generously.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

let TMP = '';
let IN = '';
let OUT = '';
let DONE = '';

async function watcherCreate(folder: Record<string, unknown>): Promise<string | null> {
  return (await browser.executeAsync(function (f: Record<string, unknown>, done: (r: string | null) => void) {
    (window as any).__SPECTRA_TEST__
      .watcherCreate(f)
      .then(() => done(null))
      .catch((e: unknown) => done(String(e)));
  }, folder)) as string | null;
}

async function watcherList(): Promise<{ id: string; name: string }[]> {
  return (await browser.executeAsync(function (done: (r: unknown) => void) {
    (window as any).__SPECTRA_TEST__.watcherList().then(done);
  })) as { id: string; name: string }[];
}

async function watcherRemove(id: string): Promise<void> {
  await browser.executeAsync(function (i: string, done: (r: unknown) => void) {
    (window as any).__SPECTRA_TEST__.watcherRemove(i).then(done);
  }, id);
}

describe('watched folders (O7)', () => {
  before(async () => {
    TMP = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-watch-'));
    IN = resolve(TMP, 'in');
    OUT = resolve(TMP, 'out');
    DONE = resolve(TMP, 'done');
    for (const d of [IN, OUT, DONE]) mkdirSync(d, { recursive: true });
    await waitForHarness();
    expect(await invokeAppCommand('tools.watchedFolders')).toBe(true);
    await $('[data-testid="watchers-dialog"]').waitForDisplayed({ timeout: 10_000 });
  });

  after(async () => {
    try {
      await watcherRemove('e2e-w1');
    } catch {
      /* already gone */
    }
    try {
      await $('[data-testid="watchers-close"]').click();
    } catch {
      /* dialog already closed */
    }
    if (TMP && existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it('a dropped PDF is processed, mirrored, and filed — with nobody at the keyboard', async () => {
    const err = await watcherCreate({
      id: 'e2e-w1',
      name: 'E2E Watch',
      source: IN,
      dest: OUT,
      processedRoot: DONE,
      action: { name: 'Strip', steps: [{ op: 'strip_metadata', params: {} }] },
      logDir: '',
      enabled: true,
    });
    expect(err).toBeNull();
    const listed = await watcherList();
    expect(listed.some((w) => w.id === 'e2e-w1')).toBe(true);

    copyFileSync(SAMPLE_PDF, resolve(IN, 'drop.pdf'));
    await browser.waitUntil(
      () =>
        existsSync(resolve(OUT, 'drop.pdf')) &&
        existsSync(resolve(DONE, 'drop.pdf')) &&
        !existsSync(resolve(IN, 'drop.pdf')),
      {
        timeout: 60_000,
        interval: 2_000,
        timeoutMsg:
          'the watcher never processed the dropped PDF (Out copy + Done original + empty intake)',
      },
    );
  });

  it('refuses an entry whose folders would loop, BY NAME', async () => {
    const err = await watcherCreate({
      id: 'e2e-bad',
      name: 'Bad',
      source: IN,
      dest: resolve(IN, 'nested'),
      processedRoot: DONE,
      action: { name: 'Strip', steps: [{ op: 'strip_metadata', params: {} }] },
      logDir: '',
      enabled: true,
    });
    expect(err).toContain('outside the watched folder');
  });

  it('deleting the watcher removes it from the config', async () => {
    await watcherRemove('e2e-w1');
    const listed = await watcherList();
    expect(listed.some((w) => w.id === 'e2e-w1')).toBe(false);
  });
});
