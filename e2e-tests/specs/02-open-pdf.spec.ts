import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  setView,
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

  it('switches into canvas view and exposes Save / Save As / Undo', async () => {
    await setView('canvas');
    await expect($('[data-testid="open-pdf-btn"]')).toBeDisplayed();
    await expect($('[data-testid="save-as-btn"]')).toBeDisplayed();
    await expect($('[data-testid="undo-btn"]')).toBeDisplayed();
    await expect($('[data-testid="save-btn"]')).toBeDisabled();
  });
});
