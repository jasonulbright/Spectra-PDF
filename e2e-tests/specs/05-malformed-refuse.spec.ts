import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, setView } from '../support/harness.js';

const MALFORMED_PDF = resolve(__dirname, '..', 'fixtures', 'malformed.pdf');
const TRUNCATED_PDF = resolve(__dirname, '..', 'fixtures', 'truncated.pdf');

describe('a document that cannot open, and one that cannot draw', () => {
  it('refuses a structurally broken PDF and SAYS SO, naming the file the user chose', async () => {
    await waitForHarness();

    await openByPaths([MALFORMED_PDF]);

    const state = await getState();
    // Not acceptable then, not acceptable now: the file landing in state as a
    // usable document.
    expect(state.fileCount > 0 && state.activeFile?.path === MALFORMED_PDF).toBe(false);

    // What IS new: the refusal is visible. Silence is the right default for a
    // document that renders; it is the wrong default for one that never
    // appears.
    const message = $('[data-testid="confirm-message"]');
    await message.waitForDisplayed({ timeout: 15_000 });
    const text = await message.getText();
    expect(text).toContain('malformed.pdf');
    // The engine raises against the temp working copy. That path must never
    // reach the user — it names a file they never chose.
    expect(text.toLowerCase()).not.toContain('temp');
    expect(text.toLowerCase()).not.toContain('appdata');

    // A refusal is a NOTICE — one OK button, no choice to make — so it
    // dismisses by `notice-ok`, not by the two-button dialog's affirm.
    await $('[data-testid="notice-ok"]').click();
    await expect($('[data-testid="menubar"]')).toBeDisplayed();
  });

  it('says in the canvas when the engine opened a document the renderer cannot draw', async () => {
    await waitForHarness();

    // qpdf reconstructs this file's xref and reports its page count; pdf.js
    // refuses the same bytes. The tab is therefore healthy over a canvas that
    // will never show anything — which the canvas now says, in place.
    await openByPaths([TRUNCATED_PDF]);
    await setView('canvas');

    const state = await getState();
    expect(state.activeFile?.path).toBe(TRUNCATED_PDF);

    const banner = $('[data-testid="canvas-unrenderable"]');
    await banner.waitForDisplayed({ timeout: 20_000 });
    expect(await banner.getText()).toContain('truncated.pdf');

    // The document stays OPEN: everything the engine can still serve keeps
    // working, and only the drawing is impossible.
    expect((await getState()).fileCount).toBeGreaterThan(0);
  });
});
