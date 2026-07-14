import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  consumeLastError,
} from '../support/harness.js';

const MALFORMED_PDF = resolve(__dirname, '..', 'fixtures', 'malformed.pdf');

describe('malformed PDF refusal', () => {
  it('rejects a structurally broken PDF without crashing the renderer', async () => {
    await waitForHarness();

    let threw = false;
    try {
      await openByPaths([MALFORMED_PDF]);
    } catch {
      threw = true;
    }

    const state = await getState();
    const error = await consumeLastError();

    // Either the open call threw OR the file was silently skipped — both are
    // acceptable refusals; what's NOT acceptable is the file landing in state
    // as a usable document.
    const acceptedAsValid =
      state.fileCount > 0 && state.activeFile?.path === MALFORMED_PDF;
    expect(acceptedAsValid).toBe(false);

    // At least one of the failure signals must have fired.
    expect(threw || error !== null).toBe(true);

    // App must still be responsive.
    await expect($('[data-testid="menubar"]')).toBeDisplayed();
  });
});
