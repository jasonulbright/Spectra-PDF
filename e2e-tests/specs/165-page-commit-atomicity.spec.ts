import { resolve } from 'node:path';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { expect } from '@wdio/globals';
import {
  waitForHarness, openByPaths, closeAllFiles, getState, focusTab,
  setView, getWorkspacePageIds, commitPendingEdits,
} from '../support/harness.js';

// FileShare.Read permits native snapshots but denies replacement. This is a
// real Windows fault at the second destination, not a mocked bridge response.
async function lockAgainstReplacement(path: string): Promise<() => Promise<void>> {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f = [IO.File]::Open($env:PAGE_COMMIT_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); ' +
    'try { [Console]::WriteLine("LOCKED"); $null = [Console]::ReadLine() } finally { $f.Dispose() }',
  ], { windowsHide: true, env: { ...process.env, PAGE_COMMIT_LOCK_PATH: path }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`lock child ${code}: ${errors}`)));
  });
  // Observe rejection even if startup fails before the release callback exists.
  void exited.catch(() => {});
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error(`lock child never became ready: ${errors}`)), 10_000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : ready(); };
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('LOCKED')) finish();
      });
      child.once('error', error => finish(error));
      child.once('exit', () => finish(new Error(`lock child exited before release: ${errors}`)));
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  return async () => { child.stdin.end('\n'); await exited; };
}

describe('multi-file page commit failure atomicity', () => {
  let directory: string;
  let files: string[];

  before(() => {
    directory = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-commit-'));
    files = ['first.pdf', 'second.pdf'].map(name => resolve(directory, name));
    for (const path of files) copyFileSync(resolve(__dirname, '..', 'fixtures', 'sample.pdf'), path);
  });
  after(async () => {
    await closeAllFiles();
    rmSync(directory, { recursive: true, force: true });
  });

  it('restores both working files after a second-file sharing violation, then retries the whole edit', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await closeAllFiles();
    await openByPaths(files);
    await setView('canvas');
    await browser.waitUntil(async () => (await getWorkspacePageIds()).length === 10, { timeout: 15_000 });
    const ids = await getWorkspacePageIds();
    const working: string[] = [];
    for (const path of files) {
      await focusTab({ doc: path });
      await browser.waitUntil(async () => (await getState()).activeFile?.path === path);
      working.push((await getState()).activeFile!.workingPath);
    }
    const originals = working.map(path => readFileSync(path));
    const sources = files.map(path => readFileSync(path));
    const picked = files.map(path => ids.find(id => id.startsWith(path))!);
    expect(picked.every(Boolean)).toBe(true);
    await browser.execute((pageIds: string[]) => {
      (window as any).__SPECTRA_TEST__.selectCanvasPages(pageIds);
    }, picked);
    await browser.waitUntil(async () => browser.execute((pageIds: string[]) => {
      const selected = (window as any).__SPECTRA_TEST__.getSelectedCanvasPageIds();
      return pageIds.every(id => selected.includes(id));
    }, picked));
    await browser.execute(() => (window as any).__SPECTRA_TEST__.rotateSelectedCanvasPages(90));

    const release = await lockAgainstReplacement(working[1]);
    try {
      let failure = '';
      try { await commitPendingEdits(); } catch (error) { failure = String(error); }
      expect(failure).toContain('commitPendingEdits failed');
      // Failed publication must not install the first update or any undo entry.
      for (let i = 0; i < working.length; i++) {
        expect(readFileSync(working[i]).equals(originals[i])).toBe(true);
        await focusTab({ doc: files[i] });
        await browser.waitUntil(async () => (await getState()).activeFile?.path === files[i]);
        expect((await getState()).activeFile?.dirty).toBe(false);
      }
    } finally {
      await release();
    }

    // The pending rotation survives the failed commit; no second rotation is
    // issued. Its authored ids, resulting bytes and original source files agree.
    await commitPendingEdits();
    for (let i = 0; i < working.length; i++) {
      const document = await PDFDocument.load(readFileSync(working[i]));
      expect(document.getPage(0).getRotation().angle).toBe(90);
      expect(document.getPageCount()).toBe(5);
      expect(readFileSync(files[i]).equals(sources[i])).toBe(true);
      await focusTab({ doc: files[i] });
      await browser.waitUntil(async () => (await getState()).activeFile?.path === files[i]);
      expect((await getState()).activeFile?.dirty).toBe(true);
    }
    expect(await getWorkspacePageIds()).toEqual(expect.arrayContaining(picked));
  });
});
