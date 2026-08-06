// Trap presets: authored, assigned, emitted, and honest about `/Trapped`.
//
// A trap-presets surface without a trapping engine is theatre unless the
// presets reach something that acts on them, so the assertion that matters is
// the PostScript: the assigned range's parameters have to be inside that
// page's own setup, and the unassigned page must not carry them.
//
// The second assertion is the one the recon found: assigning a preset adds no
// trap network, so the document must not come out claiming to be trapped.
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  closeAllFiles,
  invokeAppCommand,
  saveActiveAs,
  setReactInputValue,
} from '../support/harness.js';

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

let workDir = '';

async function trapExportPostscript(dest: string): Promise<unknown> {
  return browser.executeAsync<unknown, [string]>(
    function (out, done) {
      (window as any).__SPECTRA_TEST__.trapExportPostscript(out)
        .then((r: unknown) => done(r as any))
        .catch((err: unknown) => done(('__SPECTRA_E2E_ERROR__:' + String(err)) as any));
    },
    dest,
  );
}

async function openTrapPresets(): Promise<void> {
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  await setActiveOp('trappresets');
  await $('[data-testid="trap-preset-apply"]').waitForDisplayed({ timeout: 15_000 });
}

/** The page-setup block for a 1-based page of a DSC PostScript file. */
function pageSetup(postscript: string, page: number): string {
  const marks = [...postscript.matchAll(/^%%Page:.*$/gm)];
  if (marks.length < page) return '';
  const start = marks[page - 1].index ?? 0;
  const end = page < marks.length ? (marks[page].index ?? postscript.length) : postscript.length;
  return postscript.slice(start, end);
}

describe('trap presets', () => {
  before(async () => {
    workDir = mkdtempSync(resolve(tmpdir(), 'spectra-trap-'));
    await waitForHarness();
    await closeAllFiles();
    await openByPaths([SAMPLE]);
    await openTrapPresets();
  });

  after(async () => {
    await closeAllFiles();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('offers the in-RIP vocabulary and starts every field at its own default', async () => {
    await $('[data-testid="trap-field-TrapWidth"]').waitForDisplayed({ timeout: 20_000 });
    for (const field of ['TrapWidth', 'BlackWidth', 'Enabled', 'ImageTrapPlacement',
      'SlidingTrapLimit', 'StepLimit', 'TrapColorScaling', 'ImageResolution']) {
      expect(await $(`[data-testid="trap-field-${field}"]`).isExisting()).toBe(true);
    }
    // A trapping parameter is a wire name a RIP reads, so it is shown
    // verbatim rather than translated.
    expect(await $('[data-testid="trap-field-TrapWidth"]').getText()).toContain('TrapWidth');
    await $('[data-testid="trap-preset-empty"]').waitForDisplayed({ timeout: 10_000 });
  });

  it('refuses a page range the document does not have, before writing anything', async () => {
    await setReactInputValue('[data-testid="trap-preset-first"]', '1');
    await setReactInputValue('[data-testid="trap-preset-last"]', '99');
    await $('[data-testid="trap-preset-range-problem"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="trap-preset-add"]').isEnabled()).toBe(false);
  });

  it('authors a preset and assigns it to a page range', async () => {
    await setReactInputValue('[data-testid="trap-preset-name"]', 'Press A');
    await setReactInputValue('[data-testid="trap-preset-first"]', '1');
    await setReactInputValue('[data-testid="trap-preset-last"]', '2');
    await setReactInputValue('[data-testid="trap-field-TrapWidth"] input', '2.5');
    await browser.waitUntil(
      async () => !(await $('[data-testid="trap-preset-range-problem"]').isExisting()),
      { timeout: 10_000, timeoutMsg: 'the range objection outlived the value' },
    );
    await $('[data-testid="trap-preset-add"]').click();
    await $('[data-testid="trap-assignment-0"]').waitForDisplayed({ timeout: 10_000 });
    const row = await $('[data-testid="trap-assignment-0"]').getText();
    expect(row).toContain('Press A');
    // The pages nothing covers are named rather than left implied.
    await $('[data-testid="trap-preset-uncovered"]').waitForDisplayed({ timeout: 10_000 });
  });

  it('saving the assignment declares Trapped Unknown, not True', async () => {
    await $('[data-testid="trap-preset-apply"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="trap-preset-empty"]').isExisting()),
      { timeout: 60_000, timeoutMsg: 'the assignment never landed on the document' },
    );
    const saved = resolve(workDir, 'assigned.pdf');
    await saveActiveAs(saved);
    const bytes = readFileSync(saved).toString('latin1');
    expect(bytes).toContain('/Trapped');
    expect(bytes).toContain('/Unknown');
    // Nothing here generates a trap network, so the document is never
    // entitled to say it carries one.
    expect(bytes).not.toContain('/Trapped /True');
    expect(bytes).not.toContain('/Trapped/True');
  });

  it('exporting PostScript puts the parameters in the assigned pages’ own setup', async () => {
    const postscript = resolve(workDir, 'out.ps');
    const result = await trapExportPostscript(postscript);
    expect(String(result)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect((result as { trapping_pages?: number }).trapping_pages).toBe(2);

    const text = readFileSync(postscript).toString('latin1');
    expect(text.startsWith('%!PS')).toBe(true);
    const blocks = text.match(/%%BeginFeature: \*Trapping True/g) ?? [];
    expect(blocks.length).toBe(2);

    const first = pageSetup(text, 1);
    expect(first).toContain('<< /Trapping true /TrappingType 1001 >> setpagedevice');
    expect(first).toContain('/TrapWidth 2.5');
    // `settrapparams` exists only where the Trapping ProcSet does; an
    // unguarded call would stop a press that has no in-RIP trapping at all.
    expect(first).toContain('/Trapping /ProcSet resourcestatus');
    // The DSC stays well formed: the block sits inside the page's setup.
    expect(first.indexOf('%%BeginFeature')).toBeLessThan(first.indexOf('%%EndPageSetup'));

    // Page 3 was never assigned, so it carries nothing.
    expect(pageSetup(text, 3)).not.toContain('%%BeginFeature: *Trapping True');
  });

  it('the assignment is read back off the document it was written to', async () => {
    await setActiveOp('preflight');
    await $('[data-testid="preflight-recheck"]').waitForDisplayed({ timeout: 15_000 });
    await setActiveOp('trappresets');
    await $('[data-testid="trap-assignment-0"]').waitForDisplayed({ timeout: 20_000 });
    expect(await $('[data-testid="trap-assignment-0"]').getText()).toContain('Press A');
    expect(await $('[data-testid="trap-preset-trapped"]').getValue()).toBe('Unknown');
  });

  it('removing the assignment clears it from the document', async () => {
    await $('[data-testid="trap-assignment-remove-0"]').click();
    await $('[data-testid="trap-preset-empty"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="trap-preset-apply"]').click();
    const postscript = resolve(workDir, 'plain.ps');
    await browser.waitUntil(
      async () => {
        const result = await trapExportPostscript(postscript);
        return (result as { trapping_pages?: number })?.trapping_pages === 0;
      },
      { timeout: 90_000, timeoutMsg: 'the cleared assignment still emitted trapping setup' },
    );
    const text = readFileSync(postscript).toString('latin1');
    expect(text).not.toContain('%%BeginFeature: *Trapping True');
  });
});
