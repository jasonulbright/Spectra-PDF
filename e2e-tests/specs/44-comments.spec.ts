import { resolve } from 'node:path';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { waitForHarness, openByPaths, setView, setActiveOp } from '../support/harness.js';

// A native Highlight annotation — the canvas doesn't import it inline, so it
// only surfaces through the document-level Comments overview.
async function makeCommentedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [10, 10, 100, 30],
    QuadPoints: [10, 30, 100, 30, 10, 10, 100, 10],
    Contents: PDFString.of('a native highlight'),
  });
  const ref = ctx.register(annot);
  page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  writeFileSync(path, await doc.save());
}

describe('comments overview (I.2/I.6)', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-cmt-'));
    source = resolve(tmp, 'commented.pdf');
    await makeCommentedPdf(source);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists a native comment and deletes it through the engine', async () => {
    await waitForHarness();
    await openByPaths([source]);
    await setView('operations');
    await setActiveOp('comments');

    // The overview shows the native highlight.
    await $('[data-testid="comments-summary"]').waitForDisplayed({ timeout: 20_000 });
    expect(await $('[data-testid="comments-summary"]').getText()).toContain('1 comment');
    expect(await $('[data-testid="comment-item"]').getText()).toContain('Highlight');

    // Delete all → confirm → the panel shows the empty state.
    await $('[data-testid="comments-delete-all"]').click();
    await $('[data-testid="comments-delete-confirm"]').click();
    await $('[data-testid="comments-empty"]').waitForDisplayed({
      timeout: 20_000,
      timeoutMsg: 'comments were not deleted',
    });
  });
});
