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
} from '../support/harness.js';

// Phase 9.K2 — OpenType features (small caps + stylistic alternates) end to
// end against the real binary. The Add-Text card's Sc/Alt toggles send
// `features` through the SAME card→buildSignatureAppearance→add_text_box path
// A2 proved; because authoring always renders a bundled face, a feature
// switches to Libertinus Serif (Liberation carries none). The proof the wire
// works AND the text stays usable: the authored phrase lists back as an
// ORDINARY editable paragraph — which requires the ToUnicode to still spell
// the plain letters (searchable + re-editable), even though the drawn glyphs
// are the font's small caps / alternates. Undo removes it.

async function editTextPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphs(
  pageId: string,
): Promise<{ index: number; text: string; lineCount: number; alignment: string }[]> {
  return await browser.execute<
    { index: number; text: string; lineCount: number; alignment: string }[],
    [string]
  >(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p);
  }, pageId);
}

async function authoredParagraph(needle: string): Promise<{ pageId: string; text: string } | null> {
  for (const pageId of await editTextPageIds()) {
    const para = (await editParagraphs(pageId)).find((p) => p.text.includes(needle));
    if (para) return { pageId, text: para.text };
  }
  return null;
}

describe('OpenType features (Phase 9.K2)', () => {
  let tmp: string;
  let pdfPath: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-opentype-'));
    pdfPath = resolve(tmp, 'blank.pdf');
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writeFileSync(pdfPath, await doc.save());
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('authors SMALL CAPS text that lists back as a searchable paragraph; undo removes', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await openByPaths([pdfPath]);
    await browser.waitUntil(
      async () => ((await getState()).activeFile?.path ?? '').includes('blank.pdf'),
      { timeout: 15_000, timeoutMsg: 'fixture never became active' },
    );

    expect(await invokeAppCommand('tools.open.edit')).toBe(true);
    expect(await invokeAppCommand('tools.addtext')).toBe(true);
    await placeAddText({ x: 0.15, y: 0.08, w: 0.62, h: 0.16 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    // The Sc toggle exists on the card and drives `features: ['small_caps']`.
    await $('[data-testid="add-text-smallcaps"]').waitForDisplayed({ timeout: 10_000 });
    const phrase = 'Hamburg smallcaps roundtrip';
    await commitAddText({ text: phrase, size: 20, family: 'serif', smallCaps: true });

    // Back to select-content Edit so the reloaded buffer re-lists. The phrase
    // appearing as an ordinary paragraph proves the ToUnicode kept the plain
    // letters (searchable) despite the small-cap glyphs being drawn.
    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the small-caps authored text never listed back as a searchable paragraph',
    });

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the small-caps authored text',
    });
  });

  it('authors STYLISTIC ALTERNATES text (salt) that lists back searchable; undo removes', async function () {
    this.timeout(120_000);
    await waitForHarness();
    await invokeAppCommand('tools.addtext');
    await placeAddText({ x: 0.15, y: 0.4, w: 0.62, h: 0.16 });
    await $('[data-testid="add-text-form"]').waitForDisplayed({ timeout: 10_000 });

    // Turning Alt on reveals the alternate-index input; author at index 0.
    await $('[data-testid="add-text-alternates"]').click();
    await $('[data-testid="add-text-altindex"]').waitForDisplayed({ timeout: 10_000 });
    const phrase = 'Rays alternate glyphs';
    await commitAddText({ text: phrase, size: 18, family: 'serif', alternates: true, altIndex: 0 });

    expect(await invokeAppCommand('tools.edit')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) !== null, {
      timeout: 30_000,
      timeoutMsg: 'the alternates authored text never listed back as a searchable paragraph',
    });

    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await browser.waitUntil(async () => (await authoredParagraph(phrase)) === null, {
      timeout: 30_000,
      timeoutMsg: 'undo did not remove the alternates authored text',
    });
  });
});
