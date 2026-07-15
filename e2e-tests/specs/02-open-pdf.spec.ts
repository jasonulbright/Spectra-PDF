import { resolve, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  closeAllFiles,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Working copies land in %TEMP%/openpdfstudio/<uuid>/ — one dir per
// create_working_copy call (src-tauri/src/commands.rs), never reused.
function countWorkDirs(): number {
  const dir = join(tmpdir(), 'openpdfstudio');
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe('open valid PDF', () => {
  it('loads sample.pdf and reports page count', async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);

    const state = await getState();
    expect(state.fileCount).toBe(1);
    expect(state.activeFile).not.toBeNull();
    expect(state.activeFile!.name).toBe('sample.pdf');
    expect(state.activeFile!.pageCount).toBe(5);
    expect(state.activeFile!.dirty).toBe(false);
  });

  it('opening focuses a document tab (the board) automatically', async () => {
    const state = await getState();
    // openByPaths lands on the opened doc's tab — the § M2 tab model.
    expect(state.focusedTab).toEqual({ doc: SAMPLE_PDF });
    expect(state.view).toBe('canvas'); // legacy projection of a doc tab
    await expect($('[data-testid="tab-doc-0"]')).toBeDisplayed();
    // The toolbar exposes Save (disabled while clean) and Undo.
    await expect($('[data-testid="toolbar-save"]')).toBeDisabled();
    await expect($('[data-testid="toolbar-undo"]')).toBeDisplayed();
  });

  it('the same path twice in one batch opens it once', async () => {
    // `openpdfstudio.exe a.pdf a.pdf` really does arrive as two entries — the
    // CLI and second-instance handlers build the list straight off argv with no
    // dedupe. The already-open check can't catch it: the loop only awaits
    // BEFORE each dispatch, so the second iteration reads state React hasn't
    // flushed and sees the file as absent. Opening twice mints a second working
    // copy that nothing ever purges (and double-prompts for an encrypted file).
    //
    // The close is what makes this test MEAN anything: with the file already
    // open, both iterations take the already-open shortcut and the batch is
    // deduped by accident — the assertion passes against the unfixed code. The
    // bug only exists on the path where the file is genuinely NOT open yet.
    await closeAllFiles();
    expect((await getState()).fileCount).toBe(0);

    // `fileCount` can NEVER show this: `files` is a Map keyed by path, so a
    // double-open just overwrites the entry. The observable is the WORKING
    // COPY — `create_working_copy` mints a fresh uuid temp dir per call and
    // nothing purges them — so count those instead.
    const before = countWorkDirs();
    await openByPaths([SAMPLE_PDF, SAMPLE_PDF]);
    const state = await getState();
    expect(state.fileCount).toBe(1);
    expect(state.activeFile!.path).toBe(SAMPLE_PDF);
    expect(countWorkDirs() - before).toBe(1); // not 2
    // One tab, not two stacked on the same file.
    await expect($('[data-testid="tab-doc-0"]')).toBeDisplayed();
    await expect($('[data-testid="tab-doc-1"]')).not.toBeExisting();
  });
});
