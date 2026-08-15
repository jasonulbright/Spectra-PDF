import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  placeAddText,
  commitAddText,
  setReactInputValue,
  setContentEditableValue,
  openParagraphEditor,
} from '../support/harness.js';

// Add Text round-trip against the real binary: arm the Edit
// tool's Add-Text mode, place a box (harness injects the placement the band
// would have drawn — transformed-canvas-space is undrivable, the new-field
// precedent), author text through the REAL card→buildSignatureAppearance→
// engine path, and confirm the authored text lists back as an ORDINARY
// editable paragraph (the subset-embed makes it re-editable with no special
// case). Undo removes it.

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editTextRuns(
  pageId: string,
): Promise<{ index: number; text: string; editable: boolean }[]> {
  return await browser.execute<{ index: number; text: string; editable: boolean }[], [string]>(
    function (p) {
      return (window as any).__SPECTRA_TEST__.editTextRuns(p);
    },
    pageId,
  );
}

interface ListedParagraph {
  index: number;
  text: string;
  lineCount: number;
  alignment: string;
  orientation: string;
  vertical: boolean;
}

async function editParagraphs(pageId: string): Promise<ListedParagraph[]> {
  return await browser.execute<ListedParagraph[], [string]>(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p);
  }, pageId);
}

// The authored paragraph, once the post-commit re-index lists it.
async function authoredParagraph(
  needle: string,
): Promise<
  | {
      pageId: string;
      index: number;
      text: string;
      lineCount: number;
      orientation: string;
      vertical: boolean;
    }
  | null
> {
  for (const pageId of await editTextPageIds()) {
    const para = (await editParagraphs(pageId)).find((p) => p.text.includes(needle));
    if (para) {
      return {
        pageId,
        index: para.index,
        text: para.text,
        lineCount: para.lineCount,
        orientation: para.orientation,
        vertical: para.vertical,
      };
    }
  }
  return null;
}

describe('add text', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-addtext-'));
    pdfPath = resolve(tmp, 'blank.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]); // one blank Letter page — nothing to edit yet
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('authors a new text object that lists back as an editable paragraph, then undo removes it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('blank.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    // Open Edit, then arm its Add-Text sub-mode (proves the mode/command wiring).
    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    expect(await invokeAppCommand('tools.addtext')).toBe(true);

    // Place the box (retries until the workspace indexer produced a page), then
    // the card appears and we author through the real commit path.
    await placeAddText({ x: 0.15, y: 0.08, w: 0.62, h: 0.16 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'Hello authored end to end world';
    await commitAddText({ text: phrase, size: 18, color: [0.85, 0.1, 0.1], family: 'serif' });

    // Back to select-content Edit mode so the paragraph indexer re-lists the
    // reloaded buffer — the authored run must appear as an ordinary paragraph.
    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the authored text never appeared as an editable paragraph',
    });

    // Undo drops the authored text back off the page.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the authored text',
    });
  });

  it('authors ROTATED text (90°) that lists as a run box AND as a paragraph; undo removes', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    await placeAddText({ x: 0.7, y: 0.2, w: 0.12, h: 0.4 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'Sideways label';
    // Rotate rides the same authored-op path; the engine wraps
    // the block in one rotation frame.
    //
    // INVERSION (the spec-42 / test_rotated_text_never_groups
    // precedent — the capability this pinned is deliberately replaced).
    // This case used to require the phrase on the RUN-BOX layer with NO
    // paragraph carrying it. Neither half survives the orientation model, and the probe
    // (`probe-rot90.local.ts`) shows why: admission now runs in the
    // member's OWN transposed frame, so a quarter-turned run is an
    // ordinary axis-aligned member there and GROUPS. Once it groups the
    // run-box layer is empty — and it is empty for the 0° control too,
    // so "on the run layer" was never the authoring proof it read as,
    // and the old undo check (an always-empty runs list) was vacuous.
    // The honest pin is the paragraph layer, including the ORIENTATION,
    // which is the whole point. Off-quarter angles still refuse
    // — that boundary is retained and the 37° case below is its pin.
    await commitAddText({ text: phrase, size: 14, rotate: 90 });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph('Sideways')) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the rotated authored text never listed as a paragraph',
    });
    // A quarter turn is carried as an orientation, not as a horizontal
    // paragraph that happens to sit sideways.
    expect((await authoredParagraph('Sideways'))?.orientation).toBe('rotated-ccw');

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph('Sideways')) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the rotated authored text',
    });
  });

  it('authors FREE-ANGLE text: a 37° block lists as a run box; undo removes', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    await placeAddText({ x: 0.2, y: 0.55, w: 0.4, h: 0.2 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'Angled banner';
    // Any finite angle rides the same authored-op wire; the engine
    // emits one cos/sin frame about the box center. Rotated text stays on
    // the run surface (the standing boundary — same proof as the 90° case).
    await commitAddText({ text: phrase, size: 14, rotate: 37 });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        for (const id of await editTextPageIds()) {
          const runs = await editTextRuns(id);
          if (runs.some((r) => r.text.includes('Angled'))) {
            const para = await authoredParagraph('Angled');
            return para === null;
          }
        }
        return false;
      },
      { timeout: 30_000, timeoutMsg: 'the free-angle authored run never listed' },
    );

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(
      async () => {
        for (const id of await editTextPageIds()) {
          if ((await editTextRuns(id)).some((r) => r.text.includes('Angled'))) return false;
        }
        return true;
      },
      { timeout: 30_000, timeoutMsg: 'undo did not remove the free-angle text' },
    );
  });

  it('authors BOLD text via the style toggle params; undo removes', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    await placeAddText({ x: 0.15, y: 0.55, w: 0.5, h: 0.12 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'Bold authored words';
    // The styled Liberation face embeds engine-side (BaseFont pytest-pinned);
    // the e2e proof is the wire: params through, listed back, undoable.
    await commitAddText({ text: phrase, size: 14, bold: true });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph('Bold authored')) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the bold authored text never listed back',
    });
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph('Bold authored')) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the bold authored text',
    });
  });

  it('shows the live overflow notice for text exceeding the box, non-blocking', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    // A short box: three sentences at size 14 cannot fit its height.
    await placeAddText({ x: 0.15, y: 0.75, w: 0.3, h: 0.04 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });
    // The measure effect keys off atText — drive the textarea via the
    // React-aware setter (a bare setValue can miss the controlled input's
    // onChange, so atText would stay empty and the effect never runs).
    await setReactInputValue(
      '[data-testid="add-text-input"]',
      'A long piece of text that will certainly wrap across many lines and exceed the drawn box height entirely',
    );
    // The debounced measure (engine round-trip) flips the notice on.
    await $('[data-testid="add-text-overflow"]').waitForDisplayed({ timeout: 15_000 });
    // Non-blocking: the create button stays enabled.
    expect(await $('[data-testid="add-text-create"]').isEnabled()).toBe(true);
    // Close without authoring (Escape cancels the card).
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => !(await $('[data-testid="add-text-form"]').isDisplayed().catch(() => false)),
      { timeout: 10_000, timeoutMsg: 'the card never closed' },
    );
  });

  it('wraps a long line inside a narrow box (multi-line author)', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    // A narrow box forces the greedy wrapper to break across lines.
    await placeAddText({ x: 0.12, y: 0.4, w: 0.24, h: 0.3 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = 'one two three four five six seven eight nine ten eleven twelve';
    await commitAddText({ text: phrase, size: 14 });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(
      async () => {
        const para = await authoredParagraph('one two three');
        return para !== null && para.lineCount > 1;
      },
      { timeout: 30_000, timeoutMsg: 'the wrapped multi-line authored text never appeared' },
    );

    expect(await invokeAppCommand('edit.undo')).toBe(true);
  });

  // Vertical AUTHORING. The embed side (Identity-V, /W2) and the edit side
  // (the orientation model, vertical reflow) both worked before creation
  // did, so a user could restyle and reflow a column and never make one.
  // These two cases are the wire for the half that was missing.
  it('authors a VERTICAL column through the card and reflows it', async function () {
    this.timeout(180_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    // Tall and narrow: under a vertical mode the box's HEIGHT is how far a
    // column runs and its WIDTH is how many columns fit.
    await placeAddText({ x: 0.72, y: 0.5, w: 0.14, h: 0.4 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    // CJK reaches the card through the React-aware setter — WebDriver key
    // injection is unreliable for these scripts on Windows (spec 54).
    const phrase = '日本語の縦書きです。これは段落。';
    await setReactInputValue('[data-testid="add-text-input"]', phrase);
    await $('[data-testid="add-text-writing-mode"]').selectByAttribute('value', 'vertical');

    // The card reports the direction the ENGINE's own evidence chose — the
    // renderer never classifies the script itself, which is what keeps one
    // implementation of that decision.
    await $('[data-testid="add-text-columns"]').waitForDisplayed({ timeout: 20_000 });

    // Rotation and the OpenType features go away with the mode: no
    // orientation admits a turned column, and a vertical embed carries no
    // feature request at all.
    expect(await $('[data-testid="add-text-rotate"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="add-text-smallcaps"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="add-text-family"]').isEnabled()).toBe(false);

    await $('[data-testid="add-text-create"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="add-text-form"]').isDisplayed().catch(() => false)),
      { timeout: 30_000, timeoutMsg: 'the card never closed after authoring the column' },
    );

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph('日本語')) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the authored column never listed as a paragraph',
    });
    const column = await authoredParagraph('日本語');
    // Authored as a column, listed as a column: the orientation the creation
    // wrote is the one the re-listing reads.
    expect(column?.orientation).toBe('vertical-rl');
    expect(column?.vertical).toBe(true);

    // …and it reflows through the shipped vertical machinery, which is the
    // whole point of authoring into the same model rather than beside it.
    // The retype REARRANGES the authored characters rather than introducing
    // new ones: an authored box embeds a subset of exactly what it drew, so
    // a character it never contained is a font CONVERT (the editor's own
    // explicit offer) and not the reflow this is about.
    const retyped = '段落は日本語です。';
    await openParagraphEditor(column!.pageId, column!.index);
    await $('[data-testid="edit-para-input"]').waitForDisplayed({ timeout: 10_000 });
    await setContentEditableValue('[data-testid="edit-para-input"]', retyped);
    await browser.keys(['Enter']);
    await browser.waitUntil(async () => (await authoredParagraph(retyped)) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the retyped column never re-listed',
    });
    expect((await authoredParagraph(retyped))?.orientation).toBe('vertical-rl');

    // Undo peels the reflow, then the authoring.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(retyped)) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not take back the reflow',
    });
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph('日本語')) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the authored column',
    });
  });

  it('authors a column carrying a tate-chu-yoko year, read back inside it', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    await placeAddText({ x: 0.5, y: 0.5, w: 0.12, h: 0.4 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    const phrase = '平成2026年の記録';
    // The block is one atomic unit of one column em, drawn upright and
    // condensed across the column — the same shape the reflow's absorption
    // reads back, which is what this asserts by listing ONE paragraph
    // carrying the year in reading position.
    await commitAddText({
      text: phrase,
      size: 14,
      writingMode: 'vertical',
      spans: [{ start: 2, end: 6, tcy: true }],
    });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the authored tate-chu-yoko column never listed',
    });
    const para = await authoredParagraph(phrase);
    expect(para?.text).toBe(phrase);
    expect(para?.orientation).toBe('vertical-rl');

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the authored tate-chu-yoko column',
    });
  });
});
