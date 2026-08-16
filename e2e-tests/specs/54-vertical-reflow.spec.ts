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
  openParagraphEditor,
} from '../support/harness.js';

// Vertical paragraph reflow against the built binary. The
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
  await openParagraphEditor(pageId, index);
}

/** Replace the editor's text wholesale (WebDriver key injection is
 * unreliable for CJK on Windows). The editor is a contentEditable rich
 * surface, so this goes through the harness helper, which
 * fires the same `input` event the browser does and leaves the caret at the
 * END so Enter commits rather than splitting (the mid-text branch). */
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

describe('vertical paragraph reflow', () => {
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
    // These two columns used to be SKIPPED (run boxes only); now they
    // group as one vertical paragraph of two column-lines.
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe(ORIGINAL);
    expect(paras[0].lineCount).toBe(2);
    expect(paras[0].vertical).toBe(true);

    // Editor: substitution restyles are LIVE for vertical text (
    // Noto Sans CJK carries `vert`/`vrt2` and `vmtx`, and the shaper can
    // reach them). The controls must remain enabled for capable fonts. What
    // stays unavailable
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
    // the headline — "the weight axis is real, Bold asked for is Bold
    // embedded" — reaching a USER for the first time: the control that
    // sends it used to be disabled.
    const ids = await editTextPageIds();
    const pageId = ids[0];
    const before = await editParagraphs(pageId);
    expect(before).toHaveLength(1);
    expect(before[0].vertical).toBe(true);
    await editParagraphOpen(pageId, before[0].index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    // The editor's controls answer `isEnabled` while the panel is still
    // laying out, so reading enablement and then clicking is check-then-act:
    // the click lands `element not interactable` and survives only on the
    // driver middleware's retry. The verdict is captured inside the predicate
    // that also proves the control is clickable, and the element is re-queried
    // there so a re-render cannot leave a stale handle looping.
    const BOLD = '[data-testid="edit-para-bold"]';
    let boldEnabled = false;
    await browser.waitUntil(
      async () => {
        const btn = await $(BOLD);
        boldEnabled = await btn.isEnabled().catch(() => false);
        return boldEnabled && (await btn.isClickable().catch(() => false));
      },
      {
        timeout: 10_000,
        interval: 150,
        timeoutMsg: 'the bold toggle never became an enabled, clickable control',
      },
    );
    expect(boldEnabled).toBe(true);
    await $(BOLD).click();
    await browser.waitUntil(
      async () => (await $(BOLD).getAttribute('aria-pressed')) === 'true',
      { timeout: 10_000, timeoutMsg: 'the bold toggle never engaged' },
    );
    // Re-set the SAME text through the harness helper rather than clicking
    // into the editor: it leaves the caret at the END, so Enter commits
    // instead of splitting the paragraph (the mid-text branch).
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
