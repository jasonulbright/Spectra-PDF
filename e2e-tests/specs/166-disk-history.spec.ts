import { resolve } from 'node:path';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, closeAllFiles, getState, setView,
  getWorkspacePageIds, commitPendingEdits, invokeAppCommand } from '../support/harness.js';

type History = { undo: string[]; redo: string[]; buffer: number[] };
const history = () => browser.execute(() => (window as any).__SPECTRA_TEST__.getHistoryState()) as Promise<History>;

describe('disk history publication', () => {
  let directory: string;
  let source: string;
  let working: string;
  before(() => {
    directory = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-history-'));
    source = resolve(directory, 'history.pdf');
    copyFileSync(resolve(__dirname, '..', 'fixtures', 'sample.pdf'), source);
  });
  after(async () => {
    await closeAllFiles();
    rmSync(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([source]);
    await setView('canvas');
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 5);
    working = (await getState()).activeFile!.workingPath;
    for (let turn = 1; turn <= 2; turn++) {
      const [first] = await getWorkspacePageIds();
      await browser.execute((id: string) => {
        const h = (window as any).__SPECTRA_TEST__;
        h.selectCanvasPages([id]);
      }, first);
      await browser.waitUntil(async () => browser.execute((id: string) =>
        (window as any).__SPECTRA_TEST__.getSelectedCanvasPageIds().includes(id), first));
      await browser.execute(() => (window as any).__SPECTRA_TEST__.rotateSelectedCanvasPages(90));
      // The command's signed-edit decision is async. Wait for that ONE
      // gesture to reach the page tier; an empty commit is a harmless no-op.
      // Never reissue the rotation while waiting for its history entry.
      await browser.waitUntil(async () => {
        await commitPendingEdits();
        return (await history()).undo.length === turn;
      }, { timeoutMsg: `rotation ${turn} never reached disk history` });
    }
  });

  it('two undo and two redo keypresses in one event keep every revision and matching display bytes', async () => {
    const latest = readFileSync(working);
    const start = await history();
    const earliest = readFileSync(start.undo[0]);
    const accepted = await browser.execute(() => {
      const h = (window as any).__SPECTRA_TEST__;
      return [h.invokeCommand('edit.undo'), h.invokeCommand('edit.undo')];
    });
    expect(accepted).toEqual([true, true]);
    try {
      await browser.waitUntil(async () => (await history()).undo.length === 0);
    } catch (error) {
      const h = await history();
      const banner = await $('[data-testid="commit-error-bar"]');
      throw new Error(`${String(error)}; undo=${h.undo.length} redo=${h.redo.length}; ${await banner.isExisting() ? await banner.getText() : 'no error banner'}`);
    }
    expect(readFileSync(working).equals(earliest)).toBe(true);
    expect(Buffer.from((await history()).buffer).equals(earliest)).toBe(true);
    expect((await history()).redo).toHaveLength(2);
    await browser.execute(() => {
      const h = (window as any).__SPECTRA_TEST__;
      h.invokeCommand('edit.redo'); h.invokeCommand('edit.redo');
    });
    await browser.waitUntil(async () => (await history()).undo.length === 2);
    expect(readFileSync(working).equals(latest)).toBe(true);
    expect(Buffer.from((await history()).buffer).equals(latest)).toBe(true);
    expect((await history()).redo).toEqual([]);
  });

  it('a corrupt history PDF refuses without changing disk or history, then Retry restores it', async () => {
    const before = await history();
    const disk = readFileSync(working);
    const target = before.undo.at(-1)!;
    const retained = readFileSync(target);
    writeFileSync(target, 'not a PDF');
    try {
      await invokeAppCommand('edit.undo');
      await browser.waitUntil(async () => (await $('[data-testid="commit-error-bar"]').getText()).includes('Undo/redo failed'));
      expect(await history()).toEqual(before);
      expect(readFileSync(working).equals(disk)).toBe(true);
    } finally {
      writeFileSync(target, retained);
    }
    await $('[data-testid="commit-error-bar"] button').click();
    await browser.waitUntil(async () => (await history()).undo.length === 1);
    expect(readFileSync(working).equals(retained)).toBe(true);
    expect(Buffer.from((await history()).buffer).equals(retained)).toBe(true);
  });

  it('a native replacement refusal keeps the current revision and retries without losing undo', async () => {
    const before = await history();
    const disk = readFileSync(working);
    const target = readFileSync(before.undo.at(-1)!);
    chmodSync(working, 0o444);
    try {
      await invokeAppCommand('edit.undo');
      await browser.waitUntil(async () => (await $('[data-testid="commit-error-bar"]').getText()).includes('Undo/redo failed'));
      expect(await history()).toEqual(before);
      expect(readFileSync(working).equals(disk)).toBe(true);
    } finally {
      chmodSync(working, 0o666);
    }
    await $('[data-testid="commit-error-bar"] button').click();
    await browser.waitUntil(async () => (await history()).undo.length === 1);
    expect(readFileSync(working).equals(target)).toBe(true);
    expect(Buffer.from((await history()).buffer).equals(target)).toBe(true);
  });
});
