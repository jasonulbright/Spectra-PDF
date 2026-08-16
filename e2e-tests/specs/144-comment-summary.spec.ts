// The comment summary end to end: a reviewed document, the Comments panel's
// sort and filter, the summary dialog, and the PDF that comes out — read back
// through the shipped binary's own text extraction, because the FILE is the
// claim. A summary that drops a comment is worse than none, so every case
// counts occurrences rather than looking for presence.
//
// Nothing here matches a localized string. The furniture is resolved from the
// catalog at run time and translated per locale; what this spec asserts on is
// authored content (bodies, author names), artwork drawn into the source
// pages, and the engine's own structured report.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  focusTab,
  setView,
  setActiveOp,
  getState,
  addAnnotation,
  commentSummaryRun,
  setReactInputValue,
  setReactSelectValue,
  closeAllFiles,
} from '../support/harness.js';
import type { CommentSummaryReport } from '../support/harness.js';

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

// Drawn into the source pages, so it can only reach the summary through the
// page image — which is what tells the two composition modes apart in the
// produced file rather than in a parameter.
const ARTWORK_ONE = 'PAGEONEARTWORK';
const ARTWORK_TWO = 'PAGETWOARTWORK';

// Authored content: emitted verbatim, never translated, so a spec may match it.
const BODY_ZULU = 'zulumark reviewer body';
const BODY_ALPHA = 'alphasquare reviewer body';
const BODY_CHARLIE = 'charliestrike reviewer body';
const BODY_DELTA = 'deltanote reviewer body';
const PENDING_NOTE = 'uncommitted canvas remark';

const AUTHOR_ZOE = 'Zoe Mbeki';
const AUTHOR_ADA = 'Ada Byron';
const AUTHOR_BRUNO = 'Bruno Reyes';

/** Ids are assigned in document order, so the fixture's own order names them. */
const ID_ZULU = 'c1';
const ID_ALPHA = 'c2';
const ID_CHARLIE = 'c3';
const ID_DELTA = 'c4';

interface AnnotSpec {
  subtype: string;
  rect: number[];
  contents?: string;
  author?: string;
  modified?: string;
  quads?: number[];
}

/**
 * A reviewed document: four markup comments across two pages, one annotation
 * type the product does not model, and a third page carrying none.
 *
 * The unmodelled annotation is deliberate — it keeps the reconciliation
 * identity from degenerating to `found == written`, which would hold for any
 * implementation that simply wrote everything it read.
 */
async function makeReviewedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;

  const attach = (page: PDFPage, specs: AnnotSpec[]): void => {
    const refs = specs.map((spec) =>
      ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: spec.subtype,
          Rect: spec.rect,
          F: 4,
          ...(spec.quads ? { QuadPoints: spec.quads } : {}),
          ...(spec.contents === undefined ? {} : { Contents: PDFString.of(spec.contents) }),
          ...(spec.author === undefined ? {} : { T: PDFString.of(spec.author) }),
          ...(spec.modified === undefined ? {} : { M: PDFString.of(spec.modified) }),
        }),
      ),
    );
    page.node.set(PDFName.of('Annots'), ctx.obj(refs));
  };

  const one = doc.addPage([612, 792]);
  one.drawText(ARTWORK_ONE, { x: 180, y: 380, size: 16, font });
  attach(one, [
    {
      subtype: 'Highlight',
      rect: [60, 700, 200, 720],
      quads: [60, 720, 200, 720, 60, 700, 200, 700],
      contents: BODY_ZULU,
      author: AUTHOR_ZOE,
      modified: "D:20260814093000+02'00'",
    },
    {
      subtype: 'Square',
      rect: [60, 600, 200, 640],
      contents: BODY_ALPHA,
      author: AUTHOR_ADA,
      modified: 'D:20260814101500Z',
    },
    {
      subtype: 'StrikeOut',
      rect: [60, 500, 200, 520],
      quads: [60, 520, 200, 520, 60, 500, 200, 500],
      contents: BODY_CHARLIE,
      author: AUTHOR_ADA,
      modified: "D:20260814110000+02'00'",
    },
  ]);

  const two = doc.addPage([612, 792]);
  two.drawText(ARTWORK_TWO, { x: 180, y: 380, size: 16, font });
  attach(two, [
    {
      subtype: 'Text',
      rect: [80, 700, 100, 720],
      contents: BODY_DELTA,
      author: AUTHOR_BRUNO,
      modified: 'D:20260814120000Z',
    },
    // Outside the shipped markup set: counted as found, never written.
    { subtype: 'Screen', rect: [300, 300, 400, 400] },
  ]);

  doc.addPage([612, 792]);

  writeFileSync(path, await doc.save());
}

function cliJson<T>(args: string[]): T {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  return JSON.parse(out.slice(out.indexOf('{'))) as T;
}

interface ReviewModel {
  comments: { id: string; page: number; author: string; contents: string }[];
  count: number;
  found: number;
  excluded: { filtered: number; unmodelled: number };
}

function review(file: string, extra: string[] = []): ReviewModel {
  return cliJson<ReviewModel>(['comments-review', file, ...extra]);
}

/**
 * The produced document's text, with its line structure collapsed.
 *
 * A narrow column wraps, so a body arrives split across lines that carry no
 * meaning of their own; collapsing every run of whitespace to one space puts a
 * wrapped body back together as it was authored.
 */
function summaryText(file: string, scratch: string): string {
  const sink = resolve(scratch, 'extracted.txt');
  execFileSync(APP_EXE, ['extract-text', file, '-o', sink], { encoding: 'utf-8' });
  return readFileSync(sink, 'utf-8').replace(/\s+/g, ' ');
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

/** Distance from an entry's author line to its body, or -1 when the author
 *  never precedes the body — the entry's own header riding with its text. */
function authorLead(text: string, author: string, body: string): number {
  const body_at = text.indexOf(body);
  if (body_at < 0) return -1;
  const author_at = text.lastIndexOf(author, body_at);
  return author_at < 0 ? -1 : body_at - author_at;
}

async function commentRows(): Promise<{ id: string | null; pending: boolean }[]> {
  return (await browser.execute(function () {
    return Array.from(document.querySelectorAll('[data-testid="comment-item"]')).map((el) => ({
      id: el.getAttribute('data-comment-id'),
      pending: el.getAttribute('data-comment-pending') === 'true',
    }));
  })) as { id: string | null; pending: boolean }[];
}

/**
 * Wait for the panel to be showing exactly these rows.
 *
 * The list re-requests asynchronously on every control change, so the rows are
 * captured INSIDE the predicate and returned from it — reading them again
 * after the wait would assert on a list the wait never saw.
 */
async function waitForRows(
  expected: { id: string | null; pending: boolean }[],
  message: string,
): Promise<void> {
  let seen: { id: string | null; pending: boolean }[] = [];
  try {
    await browser.waitUntil(
      async () => {
        seen = await commentRows();
        return JSON.stringify(seen) === JSON.stringify(expected);
      },
      { timeout: 20_000, interval: 200 },
    );
  } catch {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`,
    );
  }
}

const engineRows = (ids: string[]): { id: string | null; pending: boolean }[] =>
  ids.map((id) => ({ id, pending: false }));

describe('comment summary', () => {
  let tmp: string;
  let source: string;
  let docPath: string;
  let produced = 0;

  /** A fresh destination per run — one path per artifact, never reused, so a
   *  stale file can never pass for a new one. */
  const nextOutput = (): string => resolve(tmp, `summary-${(produced += 1)}.pdf`);

  async function showComments(): Promise<void> {
    await focusTab({ doc: docPath });
    await setView('operations');
    await setActiveOp('comments');
    await $('[data-testid="comments-summary"]').waitForDisplayed({ timeout: 20_000 });
  }

  async function setSort(value: string): Promise<void> {
    await setReactSelectValue('[data-testid="comments-sort"]', value);
  }

  async function setAuthorFilter(value: string): Promise<void> {
    await setReactSelectValue('[data-testid="comments-filter-author"]', value);
  }

  async function setPageFilter(value: string): Promise<void> {
    await setReactInputValue('[data-testid="comments-filter-pages"]', value);
  }

  async function openDialog(): Promise<void> {
    await $('[data-testid="comments-summary-open"]').click();
    await $('[data-testid="comment-summary-dialog"]').waitForDisplayed({ timeout: 15_000 });
  }

  /** Open the dialog, set its controls, and write the artifact. The dialog
   *  closes itself on success and the produced file opens in the workspace,
   *  so the run is proven by both the report and the active document. */
  async function runSummary(
    controls: { mode: string; placement?: string },
  ): Promise<{ report: CommentSummaryReport; output: string }> {
    await openDialog();
    await setReactSelectValue('[data-testid="comment-summary-mode"]', controls.mode);
    if (controls.placement) {
      await setReactSelectValue('[data-testid="comment-summary-placement"]', controls.placement);
    }
    const output = nextOutput();
    const report = await commentSummaryRun(output);
    if (report === null) {
      const error = await $('[data-testid="comment-summary-error"]').getText();
      throw new Error(`the summary refused: ${error}`);
    }
    await $('[data-testid="comment-summary-dialog"]').waitForDisplayed({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: 'the dialog stayed open after a successful run',
    });
    return { report, output };
  }

  before(async function () {
    this.timeout(120_000);
    await waitForHarness();
    tmp = mkdtempSync(resolve(tmpdir(), 'comment-summary-'));
    source = resolve(tmp, 'reviewed.pdf');
    await makeReviewedPdf(source);
    await closeAllFiles();
    await openByPaths([source]);
    await browser.waitUntil(async () => (await getState()).activeFile !== null, {
      timeout: 20_000,
      timeoutMsg: 'the reviewed document never became active',
    });
    docPath = (await getState()).activeFile!.path;
  });

  after(async () => {
    await closeAllFiles();
  });

  it('the fixture is what every case below assumes', function () {
    // Read from the command line, so the spec's own premises are the shipped
    // engine's answer rather than the fixture builder's intent.
    const model = review(source);
    expect(model.found).toBe(5);
    expect(model.count).toBe(4);
    expect(model.excluded.unmodelled).toBe(1);
    expect(model.comments.map((c) => c.id)).toEqual([ID_ZULU, ID_ALPHA, ID_CHARLIE, ID_DELTA]);
  });

  it('comments-only writes every body exactly once and no page artwork', async function () {
    this.timeout(180_000);
    await showComments();
    await setSort('page');
    const { report, output } = await runSummary({ mode: 'comments_only' });

    expect(report.mode).toBe('comments_only');
    expect(report.output).toBe(output);
    expect(report.written).toBe(4);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const loaded = await PDFDocument.load(readFileSync(output));
    expect(loaded.getPageCount()).toBe(report.sheets);

    const text = summaryText(output, tmp);
    for (const body of [BODY_ZULU, BODY_ALPHA, BODY_CHARLIE, BODY_DELTA]) {
      expect(occurrences(text, body)).toBe(1);
    }
    // Each body carries its own author's line above it, close enough to be the
    // same entry rather than a coincidence elsewhere in the document.
    for (const [author, body] of [
      [AUTHOR_ZOE, BODY_ZULU],
      [AUTHOR_ADA, BODY_ALPHA],
      [AUTHOR_ADA, BODY_CHARLIE],
      [AUTHOR_BRUNO, BODY_DELTA],
    ] as const) {
      const lead = authorLead(text, author, body);
      expect(lead).toBeGreaterThan(0);
      expect(lead).toBeLessThan(300);
    }
    // No page image in this mode: the source artwork cannot have reached it.
    expect(occurrences(text, ARTWORK_ONE)).toBe(0);
    expect(occurrences(text, ARTWORK_TWO)).toBe(0);

    // The produced file opens in the workspace through the one open funnel.
    await browser.waitUntil(async () => (await getState()).activeFile?.path === output, {
      timeout: 20_000,
      timeoutMsg: 'the produced summary never became the active document',
    });
  });

  it('document-and-comments carries the page image, one badge per comment', async function () {
    this.timeout(180_000);
    await showComments();
    await setSort('page');
    const { report, output } = await runSummary({
      mode: 'document_and_comments',
      placement: 'beside',
    });

    expect(report.mode).toBe('document_and_comments');
    expect(report.placement).toBe('beside');
    expect(report.written).toBe(4);

    const text = summaryText(output, tmp);
    for (const body of [BODY_ZULU, BODY_ALPHA, BODY_CHARLIE, BODY_DELTA]) {
      expect(occurrences(text, body)).toBe(1);
    }
    // Both source pages reached the artifact as images.
    expect(occurrences(text, ARTWORK_ONE)).toBeGreaterThanOrEqual(1);
    expect(occurrences(text, ARTWORK_TWO)).toBeGreaterThanOrEqual(1);

    // One badge per placed comment, numbered without repeats, each attributed
    // to the page the engine's own model puts its comment on.
    const pageOf = new Map(review(source).comments.map((c) => [c.id, c.page]));
    expect(report.marks).toHaveLength(4);
    expect([...report.marks].map((m) => m.badge).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    for (const mark of report.marks) {
      expect(pageOf.get(mark.comment)).toBe(mark.page);
    }

    // The sheet's orientation follows the column's edge: `beside` turns the
    // entry sheets landscape while the reconciliation sheet stays portrait.
    const loaded = await PDFDocument.load(readFileSync(output));
    expect(loaded.getPageCount()).toBe(report.sheets);
    const sizes = loaded.getPages().map((p) => p.getSize());
    for (const mark of report.marks) {
      const sheet = sizes[mark.sheet - 1];
      expect(Math.round(sheet.width)).toBe(792);
      expect(Math.round(sheet.height)).toBe(612);
      // The badge sits on the image side of the gutter, on the sheet.
      expect(mark.x).toBeGreaterThan(0);
      expect(mark.x).toBeLessThan(792 - 216);
      expect(mark.y).toBeGreaterThan(0);
      expect(mark.y).toBeLessThan(612);
    }
    const last = sizes[sizes.length - 1];
    expect(Math.round(last.width)).toBe(612);
    expect(Math.round(last.height)).toBe(792);
  });

  it('the reconciliation balances, and the file agrees with the report', async function () {
    this.timeout(180_000);
    await showComments();
    await setSort('page');
    const { report } = await runSummary({ mode: 'comments_only' });

    const excluded = report.excluded;
    expect(report.found).toBe(report.written + excluded.filtered + excluded.unmodelled);
    expect(report.reconciles).toBe(true);
    // Not the degenerate identity: something really was left out and counted.
    expect(excluded.unmodelled).toBe(1);
    expect(excluded.no_position).toBe(0);
    expect(excluded.body_refused).toBe(0);
    expect(report.unreadable).toHaveLength(0);
    expect(report.no_box_pages).toHaveLength(0);

    // The same numbers the document itself is built from, read back off disk.
    const model = review(source);
    expect(report.found).toBe(model.found);
    expect(report.written).toBe(model.count);
    expect(excluded.unmodelled).toBe(model.excluded.unmodelled);

    // And the panel is showing exactly that set of comments.
    await showComments();
    await waitForRows(
      engineRows(model.comments.map((c) => c.id)),
      'the panel did not list the engine model',
    );
  });

  it('one order: the panel and the produced document sort together', async function () {
    this.timeout(180_000);
    await showComments();

    await setSort('page');
    const byPage = review(source, ['--sort', 'page']);
    await waitForRows(
      engineRows(byPage.comments.map((c) => c.id)),
      'the panel did not adopt the page order',
    );
    const pageRun = await runSummary({ mode: 'comments_only' });
    const pageText = summaryText(pageRun.output, tmp);

    await showComments();
    await setSort('author');
    const byAuthor = review(source, ['--sort', 'author']);
    expect(byAuthor.comments.map((c) => c.id)).toEqual([ID_ALPHA, ID_CHARLIE, ID_DELTA, ID_ZULU]);
    await waitForRows(
      engineRows(byAuthor.comments.map((c) => c.id)),
      'the panel did not adopt the author order',
    );
    const authorRun = await runSummary({ mode: 'comments_only' });
    const authorText = summaryText(authorRun.output, tmp);

    // The DOCUMENT reordered, not just the list: the two entries whose
    // relative order the sort flips flip in the produced file too.
    expect(pageText.indexOf(BODY_ZULU)).toBeLessThan(pageText.indexOf(BODY_ALPHA));
    expect(authorText.indexOf(BODY_ALPHA)).toBeLessThan(authorText.indexOf(BODY_ZULU));
    // Nothing was lost or duplicated by reordering.
    for (const body of [BODY_ZULU, BODY_ALPHA, BODY_CHARLIE, BODY_DELTA]) {
      expect(occurrences(authorText, body)).toBe(1);
    }

    await showComments();
    await setSort('page');
  });

  it('a filtered run drops exactly what it says and keeps the count whole', async function () {
    this.timeout(180_000);
    await showComments();
    await setSort('page');
    await setAuthorFilter(AUTHOR_ADA);

    const narrowed = review(source, ['--author', AUTHOR_ADA]);
    expect(narrowed.count).toBe(2);
    expect(narrowed.excluded.filtered).toBe(2);
    await waitForRows(
      engineRows(narrowed.comments.map((c) => c.id)),
      'the panel did not narrow to one author',
    );
    // The panel says a filter is narrowing the list rather than shrinking in
    // silence.
    await $('[data-testid="comments-filtered"]').waitForDisplayed({ timeout: 15_000 });

    const { report, output } = await runSummary({ mode: 'comments_only' });
    expect(report.written).toBe(2);
    expect(report.excluded.filtered).toBe(2);
    // The document's own total is UNCHANGED — a filtered summary never claims
    // the document had fewer comments than it has.
    expect(report.found).toBe(5);
    expect(report.reconciles).toBe(true);

    const text = summaryText(output, tmp);
    expect(occurrences(text, BODY_ALPHA)).toBe(1);
    expect(occurrences(text, BODY_CHARLIE)).toBe(1);
    expect(occurrences(text, BODY_ZULU)).toBe(0);
    expect(occurrences(text, BODY_DELTA)).toBe(0);

    // A filter that empties the list cannot reach the engine's zero-entry
    // refusal: the button that would run it is disabled.
    await showComments();
    await setAuthorFilter('');
    await setPageFilter('3');
    await browser.waitUntil(
      async () => !(await $('[data-testid="comments-summary-open"]').isEnabled()),
      { timeout: 20_000, timeoutMsg: 'an empty filter left the summary button live' },
    );

    await setPageFilter('');
    await waitForRows(
      engineRows(review(source).comments.map((c) => c.id)),
      'clearing the filter did not restore the list',
    );
  });

  it('an uncommitted canvas comment stays in the panel and out of the file', async function () {
    this.timeout(180_000);
    await focusTab({ doc: docPath });
    await setView('canvas');
    const drawn = await addAnnotation({
      kind: 'highlight',
      x: 0.3,
      y: 0.3,
      w: 0.2,
      h: 0.1,
      color: '#ffd54f',
      note: PENDING_NOTE,
    });
    expect(drawn.annotationId).toBeTruthy();

    await showComments();
    const model = review(source);
    // Listed FIRST, in document order, ahead of everything the file carries —
    // without this rule, drawing a comment would make it vanish from the panel
    // until it was committed.
    await waitForRows(
      [{ id: null, pending: true }, ...engineRows(model.comments.map((c) => c.id))],
      'the drawn comment was not listed first as pending',
    );

    // The file has never heard of it: the engine read is unchanged.
    expect(model.count).toBe(4);
    expect(model.comments.some((c) => c.contents.includes(PENDING_NOTE))).toBe(false);

    // And the filter never removes it — narrowing to an author it does not
    // have still leaves it listed, first.
    await setAuthorFilter(AUTHOR_ADA);
    await waitForRows(
      [
        { id: null, pending: true },
        ...engineRows(review(source, ['--author', AUTHOR_ADA]).comments.map((c) => c.id)),
      ],
      'the filter removed a pending comment',
    );

    await setAuthorFilter('');
  });
});
