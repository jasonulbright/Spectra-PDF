// The accessibility report surface.
//
// The assertions that matter are the ones a unit test cannot make:
//   · the checker's verdicts reach the panel as a categorized tree, with the
//     failing categories opened,
//   · each of the THREE address kinds lands somewhere different — a tag path
//     selects that element in the Tags panel, a page finding draws on the
//     page, and an object finding opens the panel that owns it,
//   · and the export writes a real artefact in both formats, carrying the
//     same verdicts the panel shows.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  focusTab,
  getState,
  invokeAppCommand,
  closeAllFiles,
  selectCanvasPages,
  getWorkspacePageIds,
  a11ySnapshot,
  a11yJump,
  a11yShow,
  a11yExport,
  a11yFix,
  a11yAuthoredFix,
  a11yArtifactRest,
  a11yFindingsOnPage,
  tagsSelectedPath,
} from '../support/harness.js';

const UNTAGGED_TEXT = 'This paragraph is tagged by nothing at all.';

/**
 * One page that fails PDF/UA nine element-level ways while being genuinely
 * tagged. Authored here rather than checked in, so the spec owns every failure
 * it asserts on and a reader can see why each one is a failure.
 *
 * The nine: no document language · no title · a run inside no marked content ·
 * a page carrying an annotation with no tab order · a widget outside the tree ·
 * a field with no description · a figure with no alternate text · a table with
 * no header cells · a heading level skipped from 1 to 3.
 */
async function buildFailingPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;

  // A text field, so the page carries an annotation: that is what makes the
  // missing /Tabs and the untagged widget real findings rather than moot ones.
  const form = doc.getForm();
  const field = form.createTextField('approval');
  field.addToPage(page, { x: 380, y: 80, width: 160, height: 24, font });

  // The widget already installed its own resources; the text font goes in
  // BESIDE them — replacing the dictionary would strip the field's appearance.
  const helvetica = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: 'WinAnsiEncoding',
    }),
  );
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (fonts) fonts.set(PDFName.of('F1'), helvetica);
  else resources?.set(PDFName.of('Font'), ctx.obj({ F1: helvetica }));

  const show = (mcid: number | null, role: string, body: string): string => {
    if (mcid === null) return `${body}\n`;
    return `/${role} <</MCID ${mcid}>> BDC\n${body}\nEMC\n`;
  };
  const text = (size: number, x: number, y: number, value: string): string =>
    `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${value}) Tj ET`;

  const content =
    show(0, 'H1', text(22, 72, 720, 'Quarterly report')) +
    show(1, 'H3', text(15, 72, 680, 'Regional detail')) +
    show(2, 'Figure', '0.6 0.6 0.6 rg 72 560 140 80 re f') +
    show(3, 'TD', text(11, 72, 520, 'North')) +
    show(4, 'TD', text(11, 240, 520, '1200')) +
    show(5, 'LBody', text(11, 72, 470, 'An item with no label')) +
    show(null, '', text(11, 72, 420, UNTAGGED_TEXT));
  const stream = ctx.stream(content);
  page.node.set(PDFName.of('Contents'), ctx.register(stream));
  page.node.set(PDFName.of('StructParents'), ctx.obj(0));

  // The structure tree. Every element that owns marked content names its page
  // so the walk does not have to infer it.
  const pageRef = page.ref;
  const leaf = (type: string, mcid: number) =>
    ctx.register(ctx.obj({ Type: 'StructElem', S: type, Pg: pageRef, K: mcid }));
  const h1 = leaf('H1', 0);
  const h3 = leaf('H3', 1);
  const figure = leaf('Figure', 2);
  const td1 = leaf('TD', 3);
  const td2 = leaf('TD', 4);
  const lbody = leaf('LBody', 5);
  const tr = ctx.register(ctx.obj({ Type: 'StructElem', S: 'TR', K: [td1, td2] }));
  const table = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Table', K: [tr] }));
  const li = ctx.register(ctx.obj({ Type: 'StructElem', S: 'LI', K: [lbody] }));
  const list = ctx.register(ctx.obj({ Type: 'StructElem', S: 'L', K: [li] }));
  const document = ctx.register(
    ctx.obj({ Type: 'StructElem', S: 'Document', K: [h1, h3, figure, table, list] }),
  );
  const parentTree = ctx.register(
    ctx.obj({ Nums: [0, ctx.obj([h1, h3, figure, td1, td2, lbody])] }),
  );
  const structRoot = ctx.register(
    ctx.obj({
      Type: 'StructTreeRoot',
      K: [document],
      ParentTree: parentTree,
      ParentTreeNextKey: 1,
    }),
  );
  // /P is what makes the tree navigable in both directions; a checker that
  // reports a parent role is reading it.
  const setParent = (child: PDFRef, parent: PDFRef): void => {
    const dict = ctx.lookup(child, PDFDict);
    dict.set(PDFName.of('P'), parent);
  };
  for (const ref of [h1, h3, figure, table, list]) setParent(ref, document);
  setParent(document, structRoot);
  setParent(tr, table);
  setParent(li, list);
  setParent(td1, tr);
  setParent(td2, tr);
  setParent(lbody, li);

  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  // Deliberately absent: /Lang on the catalog, a document title, /Tabs on the
  // page, /TU on the field, /Alt on the figure, any TH in the table.
  writeFileSync(path, await doc.save());
}

/** Every check that failed, by id. */
function failed(snapshot: { checks: { id: string; status: string }[] }): string[] {
  return snapshot.checks.filter((c) => c.status === 'fail').map((c) => c.id);
}

/** One check's row in the current report. */
async function row(id: string) {
  const snapshot = (await a11ySnapshot())!;
  const found = snapshot.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id} in the report`);
  return found;
}

/** Wait for a check to reach a verdict the fix was supposed to produce. The
 * report re-runs on the buffer change the fix causes, so this is what proves
 * the row flipped LIVE rather than after a manual re-check. */
async function waitForVerdict(id: string, wanted: string[]): Promise<string> {
  let seen = '';
  await browser.waitUntil(
    async () => {
      seen = (await row(id)).status;
      return wanted.includes(seen);
    },
    {
      timeout: 60_000,
      interval: 300,
      timeoutMsg: `${id} never reached ${wanted.join('/')}`,
    },
  );
  return seen;
}

/** The checker's inventory. It grew 33 → 56 when the uncovered PDF/UA
 *  techniques were covered — as mechanical checks or as honestly reviewable
 *  ones — so the number lives in one place and a future move is one edit. */
const CHECK_COUNT = 56;

describe('the accessibility report', () => {
  let tmp: string;
  let source: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-f24-'));
    source = resolve(tmp, 'failing.pdf');
    await buildFailingPdf(source);
    await waitForHarness();
    await openByPaths([source]);
    await setView('canvas');
    await focusTab({ doc: source });
    expect(await invokeAppCommand('tools.panel.accessibility')).toBe(true);
    await $('[data-testid="a11y-tree"]').waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(async () => (await a11ySnapshot()) !== null, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'the checker never produced a report',
    });
  });

  after(async () => {
    await closeAllFiles();
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the nine defects the document actually has', async () => {
    const snapshot = (await a11ySnapshot())!;
    expect(snapshot.checks).toHaveLength(CHECK_COUNT);
    // The whole point of the round: the six-check checker called this clean.
    expect(snapshot.summary.failed).toBeGreaterThanOrEqual(8);
    for (const id of [
      'lang',
      'title',
      'tagged_content',
      'tab_order',
      'tagged_form_fields',
      'field_descriptions',
      'figures_alt',
      'heading_nesting',
    ]) {
      expect(failed(snapshot)).toContain(id);
    }
    // The ninth is a defect the clause states as a should, so it is reported
    // as one: a table with no header cells warns rather than fails.
    expect(snapshot.checks.find((c) => c.id === 'table_headers')?.status).toBe('warn');
    // Not-applicable is a state of its own and stays out of the pass tally.
    expect(snapshot.summary.applicable).toBe(CHECK_COUNT - snapshot.summary.not_applicable);
    expect(
      snapshot.summary.passed +
        snapshot.summary.failed +
        snapshot.summary.warnings +
        snapshot.summary.needs_review,
    ).toBe(snapshot.summary.applicable);
  });

  it('opens the categories that have something to answer for', async () => {
    const snapshot = (await a11ySnapshot())!;
    const failing = new Set(
      snapshot.checks
        .filter((c) => c.status === 'fail' || c.status === 'warn')
        .map((c) => c.category),
    );
    for (const category of failing) expect(snapshot.expandedCategories).toContain(category);
    for (const category of failing) {
      await expect(
        $(`[data-testid="a11y-category-count-${category}"]`),
      ).toBeDisplayed();
    }
  });

  it('lists a verdict per check in the tree', async () => {
    const snapshot = (await a11ySnapshot())!;
    // `table_headers` is deliberately not in this list. cl. 7.5 splits its two
    // questions and does not weigh them alike: a table SHOULD carry header
    // cells, while a TH that is unreachable through Headers/IDs SHALL carry
    // Scope. This fixture's table has no TH at all, which is short of the
    // recommendation only — so the row warns, and asserting a failure here
    // would be asserting a should as a shall.
    for (const id of ['figures_alt', 'heading_nesting']) {
      const row = await $(`[data-testid="a11y-check-${id}"]`);
      await row.waitForDisplayed({ timeout: 10_000 });
      expect(await row.getAttribute('data-a11y-status')).toBe('fail');
      expect(snapshot.checks.find((c) => c.id === id)?.status).toBe('fail');
    }
    const tableRow = await $('[data-testid="a11y-check-table_headers"]');
    await tableRow.waitForDisplayed({ timeout: 10_000 });
    expect(await tableRow.getAttribute('data-a11y-status')).toBe('warn');
    expect(snapshot.checks.find((c) => c.id === 'table_headers')?.status).toBe('warn');
  });

  it('jump 1 of 3 — a tag path selects that element in the Tags panel', async () => {
    const snapshot = (await a11ySnapshot())!;
    expect(snapshot.checks.find((c) => c.id === 'figures_alt')?.addressKinds).toEqual(['struct']);

    await a11yJump('figures_alt', 0);
    await browser.waitUntil(async () => (await getState()).activeOp === 'tags', {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: 'the figure finding never opened the Tags panel',
    });
    let selected: number[] | null = null;
    await browser.waitUntil(
      async () => {
        selected = await tagsSelectedPath();
        return selected !== null;
      },
      {
        timeout: 20_000,
        interval: 200,
        timeoutMsg: 'the Tags panel never selected the element the finding named',
      },
    );
    // Document is the tree's only root; the figure is its third child.
    expect(selected).toEqual([0, 2]);

    // Back to the report for the remaining cases.
    expect(await invokeAppCommand('tools.panel.accessibility')).toBe(true);
    await browser.waitUntil(async () => (await a11ySnapshot()) !== null, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'the report never came back',
    });
  });

  it('jump 2 of 3 — a page finding draws on the page', async () => {
    const snapshot = (await a11ySnapshot())!;
    expect(snapshot.checks.find((c) => c.id === 'tagged_content')?.addressKinds).toEqual([
      'content',
    ]);

    await a11yShow('tagged_content');
    await browser.waitUntil(async () => (await a11yFindingsOnPage()).length > 0, {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: 'the untagged content never drew on the page',
    });
    const drawn = await a11yFindingsOnPage();
    expect(drawn.every((f) => f.checkId === 'tagged_content')).toBe(true);
    expect(drawn.some((f) => f.preview.includes('tagged by nothing'))).toBe(true);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll('[data-testid^="a11y-finding-"]').length,
        )) > 0,
      {
        timeout: 20_000,
        interval: 200,
        timeoutMsg: 'the finding overlay never appeared on the page',
      },
    );
    expect((await a11ySnapshot())!.shownCheck).toBe('tagged_content');
  });

  it('jump 3 of 3 — an object finding opens the panel that owns it', async () => {
    const snapshot = (await a11ySnapshot())!;
    expect(snapshot.checks.find((c) => c.id === 'field_descriptions')?.addressKinds).toEqual([
      'object',
    ]);

    await a11yJump('field_descriptions', 0);
    await browser.waitUntil(async () => (await getState()).activeOp === 'forms', {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: 'the field finding never opened the Forms panel',
    });

    expect(await invokeAppCommand('tools.panel.accessibility')).toBe(true);
    await browser.waitUntil(async () => (await a11ySnapshot()) !== null, {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: 'the report never came back',
    });
  });

  it('exports the report in both formats, with the verdicts it shows', async () => {
    const snapshot = (await a11ySnapshot())!;
    const txt = resolve(tmp, 'report.txt');
    const html = resolve(tmp, 'report.html');

    expect(await a11yExport(txt)).toBe(txt);
    expect(await a11yExport(html)).toBe(html);
    expect(existsSync(txt)).toBe(true);
    expect(existsSync(html)).toBe(true);

    const text = readFileSync(txt, 'utf8');
    const markup = readFileSync(html, 'utf8');
    // The document it is about, named up front.
    expect(text.split('\n').slice(0, 3).join('\n')).toContain('failing.pdf');
    expect(markup).toContain('failing.pdf');
    // Every check id, in both, so two readers can talk about the same row.
    for (const check of snapshot.checks) {
      expect(text).toContain(`(${check.id})`);
      expect(markup).toContain(`<code>${check.id}</code>`);
    }
    // The findings themselves, not just the verdicts.
    expect(text).toContain(UNTAGGED_TEXT);
    expect(markup).toContain('&ldquo;');
    expect(markup.startsWith('<!DOCTYPE html>')).toBe(true);
    // Self-contained: a saved report opens on a machine that is not this one.
    expect(markup).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it('re-runs on a buffer change and clears what the previous run drew', async () => {
    await a11yShow('tagged_content');
    await browser.waitUntil(async () => (await a11yFindingsOnPage()).length > 0, {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: 'the findings never drew before the edit',
    });
    // A page-tier rotation alone changes no bytes, so the report still holds
    // and the overlay re-projects. COMMITTING it is what replaces the buffer,
    // and the addresses the previous run produced were read from a tree that
    // commit replaced — so they go with it.
    await selectCanvasPages(await getWorkspacePageIds());
    expect(await invokeAppCommand('document.rotateSelectionCW')).toBe(true);
    expect((await a11yFindingsOnPage()).length).toBeGreaterThan(0);
    expect(await invokeAppCommand('document.applyPageEdits')).toBe(true);
    await browser.waitUntil(async () => (await a11yFindingsOnPage()).length === 0, {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'the stale findings stayed on the page after the document changed',
    });
    // And the report itself came back rather than being left empty.
    await browser.waitUntil(async () => (await a11ySnapshot())?.checks.length === CHECK_COUNT, {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'the checker never re-ran on the new bytes',
    });
  });

  // ── the fixes ───────────────────────────────────────────────────────────
  //
  // Each of these is the same round trip a person performs: the row FAILS,
  // the control the row offers is used, and the row reaches a verdict that is
  // no longer a failure — without a manual re-check, because applying a fix
  // is what changes the buffer the report re-runs on.

  it('offers a control on every failure it can repair, and none on the rest', async () => {
    const snapshot = (await a11ySnapshot())!;
    const offered = Object.fromEntries(snapshot.checks.map((c) => [c.id, c.fix]));
    // Automatic: the document decides the result.
    for (const id of ['tab_order', 'heading_nesting', 'table_headers', 'tagged_form_fields']) {
      expect(offered[id]).toBe('auto');
    }
    // Authored: one value a machine must not invent.
    for (const id of ['lang', 'title', 'field_descriptions', 'figures_alt', 'tagged_content']) {
      expect(offered[id]).toBe('authored');
    }
    // A check that only routes offers nothing at all.
    for (const id of ['reading_order', 'contrast', 'character_encoding']) {
      expect(offered[id]).toBeNull();
    }
  });

  it('fix 1 — the automatic button repairs a whole check at once', async () => {
    expect((await row('tab_order')).status).toBe('fail');
    expect(await a11yFix('tab_order')).toBe('');
    expect(await waitForVerdict('tab_order', ['pass'])).toBe('pass');
  });

  it('fix 2 — a heading level and a table header row are computed, not asked for', async () => {
    expect((await row('heading_nesting')).status).toBe('fail');
    expect(await a11yFix('heading_nesting')).toBe('');
    await waitForVerdict('heading_nesting', ['pass']);

    // A warning, not a failure — the missing header cells are cl. 7.5's
    // should. The repair is offered on it all the same, and the round trip
    // this case exists for is unchanged: the row is dirty, the computed fix
    // runs, the row comes back clean.
    expect((await row('table_headers')).status).toBe('warn');
    expect(await a11yFix('table_headers')).toBe('');
    await waitForVerdict('table_headers', ['pass']);
  });

  it('fix 3 — the language picker writes the tag it is given', async () => {
    expect((await row('lang')).status).toBe('fail');
    expect(await a11yAuthoredFix('lang', null, 'en-GB')).toBe('');
    await waitForVerdict('lang', ['pass']);
  });

  it('fix 4 — a malformed language tag is refused by name and writes nothing', async () => {
    const refusal = await a11yAuthoredFix('lang', null, 'en--GB');
    expect(refusal).toContain('__SPECTRA_E2E_ERROR__');
    // The document still carries the tag the previous case wrote.
    expect((await row('lang')).status).toBe('pass');
  });

  it('fix 5 — a title is authored, and shown', async () => {
    expect((await row('title')).status).toBe('fail');
    expect(await a11yAuthoredFix('title', null, 'Quarterly report')).toBe('');
    await waitForVerdict('title', ['pass']);
  });

  it('fix 6 — alt text is authored per figure', async () => {
    expect((await row('figures_alt')).status).toBe('fail');
    expect(await a11yAuthoredFix('figures_alt', 0, 'A grey placeholder chart')).toBe('');
    await waitForVerdict('figures_alt', ['pass', 'not_applicable']);
  });

  it("fix 7 — a field's description is authored, never taken from its name", async () => {
    expect((await row('field_descriptions')).status).toBe('fail');
    expect(await a11yAuthoredFix('field_descriptions', 0, 'Who approved this report')).toBe('');
    await waitForVerdict('field_descriptions', ['pass']);
  });

  it('fix 8 — an untagged widget is bound into the tree, both directions', async () => {
    expect((await row('tagged_form_fields')).status).toBe('fail');
    expect(await a11yFix('tagged_form_fields')).toBe('');
    await waitForVerdict('tagged_form_fields', ['pass']);
  });

  it('fix 9 — untagged page content is bound, one authored answer at a time', async () => {
    const before = await row('tagged_content');
    expect(before.status).toBe('fail');
    expect(before.findings).toBeGreaterThan(0);
    // The choice is the whole fix: content a reader should hear, or furniture
    // it should not. Nothing here guesses which.
    expect(await a11yAuthoredFix('tagged_content', 0, 'P')).toBe('');
    await waitForVerdict('tagged_content', ['pass', 'not_applicable']);
    // The bound run really is in the tree now: the check that used to name it
    // has nothing left to name.
    expect((await row('tagged_content')).findings).toBe(0);
  });

  it('the whole report reflects the repairs, and undo takes the last one back', async () => {
    const snapshot = (await a11ySnapshot())!;
    for (const id of [
      'lang',
      'title',
      'tab_order',
      'heading_nesting',
      'table_headers',
      'field_descriptions',
      'tagged_form_fields',
    ]) {
      expect(failed(snapshot)).not.toContain(id);
    }
    // Every fix went through the ordinary op path, so the last one is undoable
    // and the check it repaired reports the failure again.
    expect(await invokeAppCommand('edit.undo')).toBe(true);
    await waitForVerdict('tagged_content', ['fail']);
    // …and redoing it is the fix again, so the document is not left broken.
    expect(await a11yArtifactRest('tagged_content')).toBe('');
    await waitForVerdict('tagged_content', ['pass', 'not_applicable']);
  });
});
