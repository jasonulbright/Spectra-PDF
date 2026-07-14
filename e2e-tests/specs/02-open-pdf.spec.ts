import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
} from '../support/harness.js';

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

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
});
