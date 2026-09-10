import { resolve } from 'node:path';
import { existsSync, statSync, rmSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  saveActiveAs,
  getState,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

describe('save active file to a known path', () => {
  let tmp: string;
  let dest: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-'));
    dest = resolve(tmp, 'saved-sample.pdf');
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a non-empty PDF to the chosen path', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    const state = await getState();
    expect(state.activeFile).not.toBeNull();

    await saveActiveAs(dest);

    expect(existsSync(dest)).toBe(true);
    const size = statSync(dest).size;
    expect(size).toBeGreaterThan(500);
    expect(readFileSync(dest).equals(readFileSync(state.activeFile!.workingPath))).toBe(true);
  });

  it('replaces an existing destination with exactly the current working bytes', async () => {
    writeFileSync(dest, 'previous complete contents');
    const working = (await getState()).activeFile!.workingPath;
    await saveActiveAs(dest);
    expect(readFileSync(dest).equals(readFileSync(working))).toBe(true);
  });

  it('keeps a read-only destination intact on refusal and saves after it becomes writable', async () => {
    const original = Buffer.from('protected original contents');
    writeFileSync(dest, original);
    chmodSync(dest, 0o444);
    try {
      let error = '';
      try { await saveActiveAs(dest); } catch (e) { error = String(e); }
      expect(error).toContain('saveActiveAs failed');
      expect(readFileSync(dest).equals(original)).toBe(true);
    } finally {
      chmodSync(dest, 0o666);
    }
    await saveActiveAs(dest);
    expect(readFileSync(dest).equals(readFileSync((await getState()).activeFile!.workingPath))).toBe(true);
  });
});
