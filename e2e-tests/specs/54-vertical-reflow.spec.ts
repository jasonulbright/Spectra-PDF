import { resolve } from 'node:path';
import { copyFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
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

/** Replace the editor's value wholesale via the native setter (WebDriver
 * key injection is unreliable for CJK on Windows; this is the standard
 * controlled-input path — React 18 hears the bubbled `input`). Caret lands
 * collapsed at the END so Enter commits rather than splitting (the A4
 * mid-text branch). */
async function setEditorValue(text: string): Promise<void> {
  await browser.execute<void, [string]>(function (t) {
    const ta = document.querySelector(
      '[data-testid="edit-para-input"]',
    ) as HTMLTextAreaElement | null;
    if (!ta) throw new Error('paragraph editor not open');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(ta, t);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(t.length, t.length);
  }, text);
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

    // Editor: substitution restyles are gated off for vertical (the
    // engine refuses — the bundled Liberation faces are horizontal).
    await editParagraphOpen(pageId, paras[0].index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="edit-para-family"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="edit-para-bold"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="edit-para-italic"]').isEnabled()).toBe(false);

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
});
