import { basename, dirname, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  closeAllFiles,
  getState,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// M7 — the path-identity gate: file identity is the raw path STRING
// app-wide, and Windows spells one file many ways. Every spelling must
// resolve to ONE open document; before the gate, each variant opened its own
// tab with its own working copy, and File ▸ Save on the "wrong" one silently
// diverged.

describe('path identity (M7)', () => {
  let tmp: string;
  let file: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ops-e2e-canon-'));
    file = resolve(tmp, 'Case Sensitive.pdf');
    copyFileSync(SAMPLE_PDF, file);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('case, slash and mixed spellings of one file are ONE document', async () => {
    await waitForHarness();
    await closeAllFiles();

    await openByPaths([file]);
    await browser.waitUntil(async () => (await getState()).fileCount === 1);
    const canonicalInState = (await getState()).activeFile!.path;

    // The same file, three hostile spellings.
    const upper = resolve(dirname(file), basename(file).toUpperCase());
    const slashy = file.replace(/\\/g, '/');
    const lowerDrive = file[1] === ':' ? file[0].toLowerCase() + file.slice(1) : file;
    for (const variant of [upper, slashy, lowerDrive]) {
      await openByPaths([variant]);
      await browser.pause(200);
      expect((await getState()).fileCount).toBe(1);
      // Still the ONE canonical identity — not a re-keyed replacement.
      expect((await getState()).activeFile!.path).toBe(canonicalInState);
    }
  });

  it('a whole batch of spellings collapses to one open', async () => {
    await closeAllFiles();
    expect((await getState()).fileCount).toBe(0);
    const upper = resolve(dirname(file), basename(file).toUpperCase());
    const slashy = file.replace(/\\/g, '/');
    await openByPaths([file, upper, slashy]);
    await browser.pause(400);
    expect((await getState()).fileCount).toBe(1);
  });
});
