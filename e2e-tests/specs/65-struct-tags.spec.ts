import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  waitForHarness,
  openByPaths,
  setView,
  setActiveOp,
  getState,
  saveActiveAs,
  setReactInputValue,
  invokeAppCommand,
  selectCanvasPages,
  getWorkspacePageIds,
  commitPendingEdits,
} from '../support/harness.js';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// A REAL tagged PDF: marked-content BDC/EMC around each text block, a
// structure tree (Document → H1, P, Figure) referencing the MCIDs, and a
// /ParentTree — built from scratch so the panel's pdf.js text previews and
// the on-disk getStructTree verification both exercise the real wire.
// Text tokens are unique to this spec (shared-workspace search rule).
async function makeTaggedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;

  const content = [
    '/H1 <</MCID 0>> BDC',
    'BT /F1 18 Tf 40 350 Td (StructTagHeading) Tj ET',
    'EMC',
    '/P <</MCID 1>> BDC',
    'BT /F1 11 Tf 40 320 Td (StructTagBody paragraph) Tj ET',
    'EMC',
    '/Figure <</MCID 2>> BDC',
    'BT /F1 11 Tf 40 290 Td (StructTagChart placeholder) Tj ET',
    'EMC',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font.ref } }));

  const h1 = ctx.obj({ Type: 'StructElem', S: 'H1', Pg: page.ref, K: 0 });
  const h1Ref = ctx.register(h1);
  const para = ctx.obj({ Type: 'StructElem', S: 'P', Pg: page.ref, K: 1 });
  const paraRef = ctx.register(para);
  const figure = ctx.obj({ Type: 'StructElem', S: 'Figure', Pg: page.ref, K: 2 });
  const figureRef = ctx.register(figure);
  const docElem = ctx.obj({ Type: 'StructElem', S: 'Document', K: [h1Ref, paraRef, figureRef] });
  const docRef = ctx.register(docElem);
  const structRoot = ctx.obj({
    Type: 'StructTreeRoot',
    K: [docRef],
    ParentTree: ctx.obj({ Nums: [0, ctx.register(ctx.obj([h1Ref, paraRef, figureRef]))] }),
    ParentTreeNextKey: 1,
  });
  const rootRef = ctx.register(structRoot);
  docElem.set(PDFName.of('P'), rootRef);
  h1.set(PDFName.of('P'), docRef);
  para.set(PDFName.of('P'), docRef);
  figure.set(PDFName.of('P'), docRef);
  page.node.set(PDFName.of('StructParents'), ctx.obj(0));
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  writeFileSync(path, await doc.save());
}

// Untagged but CONTENT-BEARING — what autotag (P20) needs; sample.pdf is
// five blank pages, whose "nothing taggable" refusal is correct behavior.
async function makeUntaggedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const content = [
    'BT /F1 20 Tf 40 350 Td (AutotagE2EHeading) Tj ET',
    'BT /F1 11 Tf 40 320 Td (AutotagE2EBody paragraph) Tj ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font.ref } }));
  writeFileSync(path, await doc.save());
}

interface StructNode {
  role?: string;
  alt?: string;
  children?: StructNode[];
}

// Page 1's structure tree as an independent reader (pdf.js) sees it on disk.
async function readStructTree(path: string): Promise<StructNode | null> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const tree = (await (await pdf.getPage(1)).getStructTree()) as StructNode | null;
  await pdf.loadingTask.destroy();
  return tree;
}

function rolesOf(tree: StructNode | null): string[] {
  const doc = tree?.children?.[0];
  return (doc?.children ?? []).map((c) => c.role ?? '');
}

async function applyAndSave(dest: string): Promise<void> {
  await browser.waitUntil(async () => (await getState()).activeFile?.dirty === true, {
    timeout: 20_000,
    timeoutMsg: 'tag mutation never marked the file dirty',
  });
  await saveActiveAs(dest);
  expect(existsSync(dest)).toBe(true);
}

describe('structure tags + reading order (I.6)', () => {
  let tmp: string;
  // One source per test: re-opening an already-open path focuses the live
  // working copy WITH its edits (correct app behavior), so a shared source
  // would leak one test's tag edits into the next.
  let sourceA: string;
  let sourceB: string;
  let sourceC: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-tags-'));
    sourceA = resolve(tmp, 'tagged-a.pdf');
    sourceB = resolve(tmp, 'tagged-b.pdf');
    sourceC = resolve(tmp, 'tagged-c.pdf');
    await makeTaggedPdf(sourceA);
    await makeTaggedPdf(sourceB);
    await makeTaggedPdf(sourceC);
  });

  after(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('lists the tag tree with a content preview and retags a heading', async () => {
    await waitForHarness();
    await openByPaths([sourceA]);
    await setView('operations');
    await setActiveOp('tags');

    const summary = $('[data-testid="tags-summary"]');
    await summary.waitForDisplayed({ timeout: 20_000 });
    expect(await summary.getText()).toContain('4 tags');

    await $('[data-testid="tag-select-0.0"]').click();
    // The pdf.js marked-content preview is the wire proof that MCID → text
    // resolution works against the real renderer.
    const preview = $('[data-testid="tag-preview"]');
    await preview.waitForDisplayed({ timeout: 20_000 });
    expect(await preview.getText()).toContain('StructTagHeading');

    await setReactInputValue('[data-testid="tag-type-input"]', 'H2');
    await $('[data-testid="tags-apply"]').click();
    const dest = resolve(tmp, 'retagged.pdf');
    await applyAndSave(dest);
    expect(rolesOf(await readStructTree(dest))).toEqual(['H2', 'P', 'Figure']);
  });

  it('sets alt text on a figure and deletes a tag (content stays)', async () => {
    await openByPaths([sourceB]);
    await setView('operations');
    await setActiveOp('tags');
    await $('[data-testid="tag-select-0.2"]').waitForDisplayed({ timeout: 20_000 });
    await $('[data-testid="tag-select-0.2"]').click();
    await setReactInputValue('[data-testid="tag-alt-input"]', 'A bar chart of quarterly totals');
    await $('[data-testid="tags-apply"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tag-row-0.2"]').getText()).includes('alt'),
      { timeout: 20_000, timeoutMsg: 'alt badge never appeared on the figure row' },
    );

    await $('[data-testid="tag-select-0.1"]').click();
    await $('[data-testid="tags-delete"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="tags-summary"]').getText()).includes('3 tags'),
      { timeout: 20_000, timeoutMsg: 'delete never shrank the tree' },
    );

    const dest = resolve(tmp, 'alt-and-delete.pdf');
    await applyAndSave(dest);
    const tree = await readStructTree(dest);
    expect(rolesOf(tree)).toEqual(['H1', 'Figure']);
    const fig = tree?.children?.[0]?.children?.find((c) => c.role === 'Figure');
    expect(fig?.alt).toBe('A bar chart of quarterly totals');
  });

  it('reading order lists page content in tree order and reorders it', async () => {
    await openByPaths([sourceC]);
    await setView('operations');
    await setActiveOp('readingorder');

    const first = $('[data-testid="order-item-0"]');
    await first.waitForDisplayed({ timeout: 20_000 });
    expect(await first.getText()).toContain('H1');
    // The content preview is a SECOND, async pdf.js round trip: the panel
    // renders rows from the struct tree immediately and fills previews in
    // afterwards (ReadingOrderPanel's texts effect, where previews are
    // explicitly "a nicety"). So the row being displayed does NOT mean its
    // preview has landed — under full-suite load it lands later, which took
    // this leg red twice in the v2.8.3 release gate while every isolated run
    // passed. Wait for the preview rather than racing it.
    await browser.waitUntil(async () => (await first.getText()).includes('StructTagHeading'), {
      timeout: 20_000,
      timeoutMsg: 'the MCID content preview never rendered on the first row',
    });
    expect((await $$('[data-testid^="order-item-"]')).length).toBe(3);

    await $('[data-testid="order-down-0"]').click();
    await browser.waitUntil(
      async () => (await $('[data-testid="order-item-0"]').getText()).includes('P'),
      { timeout: 20_000, timeoutMsg: 'reorder never moved the heading down' },
    );
    const dest = resolve(tmp, 'reordered.pdf');
    await applyAndSave(dest);
    expect(rolesOf(await readStructTree(dest))).toEqual(['P', 'H1', 'Figure']);
  });

  it('tags survive a COMMITTED page edit (P19 struct carry)', async () => {
    // The page-tier rebuild used to drop /StructTreeRoot wholesale — one
    // committed rotation orphaned every MCID. pdf.js's getStructTree resolves
    // through the ParentTree, so this read-back proves the ENTIRE rebuilt
    // chain (tree, ParentTree renumbering, page /StructParents) is coherent,
    // not merely present.
    const carried = resolve(tmp, 'carry-src.pdf');
    await makeTaggedPdf(carried);
    await openByPaths([carried]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening the tagged file did not land on canvas',
    });
    const ids = await getWorkspacePageIds();
    await selectCanvasPages([ids[0]]);
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    await commitPendingEdits();
    const dest = resolve(tmp, 'carried.pdf');
    await saveActiveAs(dest);
    expect(rolesOf(await readStructTree(dest))).toEqual(['H1', 'P', 'Figure']);
  });

  it('an untagged document states it honestly — and autotag builds a first tree (P20)', async () => {
    // sample.pdf is five BLANK pages — the honest untagged state, and (by
    // design) autotag refuses it: nothing taggable is a named error, not an
    // invented empty tree. The P20 leg runs on a content-bearing file.
    await openByPaths([SAMPLE]);
    await setView('operations');
    await setActiveOp('tags');
    await $('[data-testid="tags-untagged"]').waitForDisplayed({ timeout: 20_000 });

    const untagged = resolve(tmp, 'untagged-content.pdf');
    await makeUntaggedPdf(untagged);
    await openByPaths([untagged]);
    await setView('operations');
    await setActiveOp('tags');
    await $('[data-testid="tags-untagged"]').waitForDisplayed({ timeout: 20_000 });

    // P20: the refusal state carries the content-analysis half. One click
    // runs the REAL engine op over the working copy (undoable), and the
    // panel refreshes into the tagged editor: Document + H1 + P.
    await $('[data-testid="tags-autotag"]').click();
    await $('[data-testid="tags-summary"]').waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'autotag never produced a tagged tree in the panel',
    });
    expect(await $('[data-testid="tags-summary"]').getText()).toContain('3 tags');
    // The tree renders collapsed to the Document root; expand it and the
    // two autotagged children (H1, P) appear.
    await $('[data-testid^="tag-toggle-"]').click();
    await browser.waitUntil(
      async () => (await $$('[data-testid^="tag-row-"]')).length === 3,
      { timeoutMsg: 'expanding the root did not reveal the autotagged children' },
    );
  });
});
