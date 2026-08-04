import { resolve } from 'node:path';
import { copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setContentEditableValue,
} from '../support/harness.js';

// Phase 9.B4b — vertical paragraph reflow against the built binary. The
// committed fixture (fixtures/vertical-text.pdf, generated with pikepdf —
// pdf-lib cannot author Identity-V) carries two top-aligned columns at
// pitch 14: under the engine's transposition they group as ONE paragraph
// ("あいうあい", 2 columns ≙ 2 lines). The reflow math is pytest-pinned
// with hand-computed positions; this proves the wire: listing → editor
// (substitution controls gated off) → retype → re-listed columns → undo.
// Waits are generation-keyed (README §Adding-a-spec 4).

const ORIGINAL = 'あいうあい';
const RETYPED = 'いいいいい';

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphs(
  pageId: string,
): Promise<{ index: number; text: string; lineCount: number; vertical: boolean }[]> {
  return await browser.execute<
    { index: number; text: string; lineCount: number; vertical: boolean }[],
    [string]
  >(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p);
  }, pageId);
}

async function editParagraphOpen(pageId: string, index: number): Promise<void> {
  await browser.execute<void, [string, number]>(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editParagraphOpen(p, i);
    },
    pageId,
    index,
  );
}

/** Replace the editor's text wholesale (WebDriver key injection is
 * unreliable for CJK on Windows). The editor is a contentEditable rich
 * surface (9.A5-tails-b), so this goes through the harness helper, which
 * fires the same `input` event the browser does and leaves the caret at the
 * END so Enter commits rather than splitting (the A4 mid-text branch). */
async function setEditorValue(text: string): Promise<void> {
  await setContentEditableValue('[data-testid="edit-para-input"]', text);
}

async function waitForReindexedParas(
  preOpId: string,
  test: (paras: { index: number; text: string; lineCount: number }[]) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const ids = await editTextPageIds();
      if (ids.length === 0 || ids[0] === preOpId) return false;
      return test(await editParagraphs(ids[0]));
    },
    { timeout: 30_000, timeoutMsg },
  );
}

describe('vertical paragraph reflow (Phase 9.B4b)', () => {
  let tmp: string;
  let pdfPath: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-vertical-'));
    pdfPath = resolve(tmp, 'vertical-text.pdf');
    copyFileSync(resolve(__dirname, '../fixtures/vertical-text.pdf'), pdfPath);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists the columns as one paragraph, gates substitution, reflows a retype, undoes', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('vertical-text.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const ids = await editTextPageIds();
        if (ids.length === 0) return false;
        return (await editParagraphs(ids[0])).length > 0;
      },
      { timeout: 30_000, timeoutMsg: 'paragraphs never loaded' },
    );
    const pageId = (await editTextPageIds())[0];
    const paras = await editParagraphs(pageId);
    // Before B4b these two columns were SKIPPED (run boxes only); now they
    // group as one vertical paragraph of two column-lines.
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe(ORIGINAL);
    expect(paras[0].lineCount).toBe(2);
    expect(paras[0].vertical).toBe(true);

    // Editor: substitution restyles are LIVE for vertical text (9.T4 —
    // Noto Sans CJK carries `vert`/`vrt2` and `vmtx`, and the shaper can
    // reach them). This assertion is the INVERSION of the shipped one:
    // through 2026-08-04 the three controls were disabled with a reason
    // ("the bundled faces are horizontal") that T4 had already made false,
    // and this spec pinned that stale gate green. What stays unavailable
    // is stated as the absence it is — the three BUNDLED families (all
    // horizontal; a column resolves the CJK face whichever is picked) and
    // the OpenType feature toggles (a vertical embed carries no feature
    // request at all).
    await editParagraphOpen(pageId, paras[0].index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="edit-para-family"]').isEnabled()).toBe(true);
    expect(await $('[data-testid="edit-para-bold"]').isEnabled()).toBe(true);
    expect(await $('[data-testid="edit-para-italic"]').isEnabled()).toBe(true);
    expect(
      await $('[data-testid="edit-para-family"] option[value="sans"]').isEnabled(),
    ).toBe(false);
    expect(await $('[data-testid="edit-para-smallcaps"]').isEnabled()).toBe(false);

    // Retype: 5 chars refill the columns top-down at the measured pitch
    // (3 + 2 — the pytest hand-math case). Enter commits.
    await setEditorValue(RETYPED);
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (now) =>
        now.length === 1 && now[0].text === RETYPED && now[0].lineCount === 2,
      'the vertical retype never reflowed back',
    );

    const preUndoId = (await editTextPageIds())[0];
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForReindexedParas(
      preUndoId,
      (now) => now.length === 1 && now[0].text === ORIGINAL,
      'undo did not restore the original vertical text',
    );
  });

  it('commits a bold restyle on the column and re-lists it vertical', async function () {
    this.timeout(180_000);
    // T4's headline — "the weight axis is real, Bold asked for is Bold
    // embedded" — reaching a USER for the first time: the control that
    // sends it was disabled until brief 39 slice A.
    const ids = await editTextPageIds();
    const pageId = ids[0];
    const before = await editParagraphs(pageId);
    expect(before).toHaveLength(1);
    expect(before[0].vertical).toBe(true);
    await editParagraphOpen(pageId, before[0].index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    const boldBtn = await $('[data-testid="edit-para-bold"]');
    expect(await boldBtn.isEnabled()).toBe(true);
    await boldBtn.click();
    await browser.waitUntil(
      async () => (await boldBtn.getAttribute('aria-pressed')) === 'true',
      { timeout: 10_000, timeoutMsg: 'the bold toggle never engaged' },
    );
    // Re-set the SAME text through the harness helper rather than clicking
    // into the editor: it leaves the caret at the END, so Enter commits
    // instead of splitting the paragraph (the A4 mid-text branch).
    await setEditorValue(ORIGINAL);
    await browser.keys(['Enter']);
    await waitForReindexedParas(
      pageId,
      (now) => now.length === 1 && now[0].text === before[0].text,
      'the vertical bold restyle never committed',
    );
    const after = await editParagraphs((await editTextPageIds())[0]);
    // Still a column, still the same text — a restyle, not a rewrite.
    expect(after[0].vertical).toBe(true);
    expect(after[0].text).toBe(before[0].text);
  });
});
