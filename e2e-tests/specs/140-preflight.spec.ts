// The print preflight surface.
//
// The assertions that matter are the ones a unit test cannot make:
//   · the 37 checks reach the panel as a categorized tree, with the failing
//     categories opened and every row carrying the rule it was measured
//     against,
//   · THE SAME DOCUMENT UNDER TWO PROFILES GIVES TWO ANSWERS — the round's
//     whole thesis in one assertion,
//   · each address kind lands somewhere different: a content finding draws on
//     the page, an object finding opens the panel that owns the thing, and a
//     page finding opens the surface that owns the edit,
//   · a profile exported and re-imported is the same rule, and it drives a
//     run,
//   · a per-row Fix and "fix what this profile can" both flip their rows on
//     the automatic re-check, land as ONE undo entry each, and undo puts the
//     verdicts back,
//   · and the export writes a real artefact in both formats, carrying every
//     check id AND its parameters.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  getState,
  invokeAppCommand,
  closeAllFiles,
  preflightSnapshot,
  preflightSelectProfile,
  preflightJump,
  preflightShow,
  preflightExport,
  preflightImportProfile,
  preflightExportProfile,
  preflightFix,
  preflightFixAll,
  preflightAuthoredFix,
  a11yFindingsOnPage,
} from '../support/harness.js';

/**
 * One page that is print-hostile in several categories at once, authored here
 * rather than checked in so the spec owns every failure it asserts on.
 *
 * The failures: RGB content (colour) · a 72 dpi photograph (images) · a
 * non-embedded font (fonts) · no trim box (pages) · a hairline stroke
 * (content) · a printing sticky note (content).
 */
async function buildFailingPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;

  // A 10x10 raster placed at 100 pt — 7 dpi, far below any press minimum.
  const pixels = new Uint8Array(10 * 10 * 3).fill(0x40);
  const image = ctx.stream(pixels, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 10,
    Height: 10,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
  });
  const imageRef = ctx.register(image);
  page.node.setXObject(PDFName.of('Im0'), imageRef);

  page.drawText('Preflight fixture', { x: 40, y: 700, size: 14, font });
  // RGB fill, a hairline rule, and the image placement — three findings in
  // three categories from one content stream.
  page.drawRectangle({ x: 40, y: 640, width: 200, height: 20, color: undefined });
  const content = ctx.stream(
    [
      '1 0 0 rg 40 600 200 20 re f',
      '0.05 w 0 0 0 RG 40 560 m 400 560 l S',
      'q 100 0 0 100 40 400 cm /Im0 Do Q',
    ].join('\n'),
  );
  page.node.addContentStream(ctx.register(content));

  // A sticky note flagged to print reaches the plate with the page.
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [500, 700, 520, 720],
    F: 4,
    Contents: 'Check this before it goes out',
  });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));

  writeFileSync(path, await doc.save());
}

describe('Print preflight', () => {
  let dir: string;
  let source: string;

  before(async () => {
    await waitForHarness();
    dir = mkdtempSync(resolve(tmpdir(), 'spectra-preflight-'));
    source = resolve(dir, 'press-job.pdf');
    await buildFailingPdf(source);
  });

  after(async () => {
    await closeAllFiles();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A jump opens a panel through a dispatch, so the op is settled-for rather
   * than read once — the state snapshot is flat, `activeOp` at its top. */
  async function expectActiveOp(op: string): Promise<void> {
    await browser.waitUntil(async () => (await getState()).activeOp === op, {
      timeout: 15000,
      timeoutMsg: `the jump never landed on ${op}`,
    });
  }

  it('reports 37 checks as a categorized tree, with the failing categories open', async () => {
    await openByPaths([source]);
    await setView('canvas');
    expect(await invokeAppCommand('tools.panel.preflight')).toBe(true);

    await browser.waitUntil(async () => (await preflightSnapshot()) !== null, {
      timeout: 30000,
      timeoutMsg: 'the preflight report never arrived',
    });
    const snapshot = (await preflightSnapshot())!;
    expect(snapshot.checks).toHaveLength(37);
    expect(new Set(snapshot.checks.map((c) => c.category)).size).toBe(7);
    expect(snapshot.summary.total).toBe(37);
    // The tally adds up, and not_applicable is excluded from the passes.
    const { passed, failed, warnings, needs_review, not_applicable, applicable } =
      snapshot.summary;
    expect(passed + failed + warnings + needs_review + not_applicable).toBe(37);
    expect(applicable).toBe(37 - not_applicable);
    expect(not_applicable).toBeGreaterThan(0);
    // The categories carrying a finding are the ones opened.
    for (const category of snapshot.expandedCategories) {
      expect(
        snapshot.checks.some(
          (c) => c.category === category && (c.status === 'fail' || c.status === 'warn'),
        ),
      ).toBe(true);
    }
  });

  it('carries the rule each row was measured against', async () => {
    const snapshot = (await preflightSnapshot())!;
    const contone = snapshot.checks.find((c) => c.id === 'image_min_dpi_contone')!;
    expect(contone.params.min_dpi).toBe(300);
    const tac = snapshot.checks.find((c) => c.id === 'ink_coverage_max')!;
    expect(tac.params.max_tac_pct).toBe(300);
    // Every row states its rule, not only the ones that failed.
    for (const check of snapshot.checks) {
      expect(typeof check.params).toBe('object');
    }
  });

  it('names the document’s failures', async () => {
    const snapshot = (await preflightSnapshot())!;
    const by = Object.fromEntries(snapshot.checks.map((c) => [c.id, c]));
    expect(by.colour_family.status).toBe('fail');
    expect(by.fonts_embedded.status).toBe('fail');
    expect(by.image_min_dpi_contone.status).toBe('fail');
    expect(by.trim_box.status).toBe('warn');
    expect(by.hairlines_absent.status).toBe('warn');
    expect(by.printing_annotations.status).toBe('warn');
  });

  it('gives the SAME document two answers under two profiles', async () => {
    // This is the round's whole thesis: a verdict is meaningless without the
    // rule it was measured against.
    const sheetfed = (await preflightSnapshot())!;
    await preflightSelectProfile('office_print');
    await browser.waitUntil(
      async () => (await preflightSnapshot())?.profile === 'office_print',
      { timeout: 30000, timeoutMsg: 'the office profile never took' },
    );
    const office = (await preflightSnapshot())!;

    const before = Object.fromEntries(sheetfed.checks.map((c) => [c.id, c.status]));
    const after = Object.fromEntries(office.checks.map((c) => [c.id, c.status]));
    // RGB fails a press profile and is fine on an office one.
    expect(before.colour_family).toBe('fail');
    expect(after.colour_family).toBe('not_applicable');
    // 72 dpi fails 300 and only warns against 150.
    expect(before.image_min_dpi_contone).toBe('fail');
    expect(after.image_min_dpi_contone).toBe('warn');
    // And the check that both profiles run agrees, because the DOCUMENT
    // decides clean or dirty and only the profile decides what dirty means.
    expect(before.fonts_embedded).toBe(after.fonts_embedded);

    await preflightSelectProfile('sheetfed_offset');
    await browser.waitUntil(
      async () => (await preflightSnapshot())?.profile === 'sheetfed_offset',
      { timeout: 30000, timeoutMsg: 'the sheetfed profile never came back' },
    );
  });

  it('offers the nine shipped profiles', async () => {
    const snapshot = (await preflightSnapshot())!;
    expect(snapshot.profiles).toEqual(
      expect.arrayContaining([
        'sheetfed_offset',
        'web_offset_heatset',
        'newsprint',
        'digital_printing',
        'large_format',
        'pdfx_1a',
        'pdfx_3',
        'pdfx_4',
        'office_print',
      ]),
    );
  });

  it('draws a content finding on the page and takes it off again', async () => {
    await preflightShow('hairlines_absent');
    await browser.waitUntil(async () => (await a11yFindingsOnPage()).length > 0, {
      timeout: 15000,
      timeoutMsg: 'the hairline never reached the page',
    });
    const drawn = await a11yFindingsOnPage();
    expect(drawn[0].checkId).toBe('hairlines_absent');
    await preflightShow('hairlines_absent');
    expect(await a11yFindingsOnPage()).toHaveLength(0);
  });

  it('lands each address kind somewhere different', async () => {
    // content: the finding is drawn and focused on the page, and the panel
    // stays where it is.
    await preflightJump('hairlines_absent', 0);
    expect((await preflightSnapshot())!.shownCheck).toBe('hairlines_absent');
    await expectActiveOp('preflight');

    // object: the annotation's own panel.
    await invokeAppCommand('tools.panel.preflight');
    await preflightJump('printing_annotations', 0);
    await expectActiveOp('comments');

    // page: the surface that owns the edit — a different one again.
    await invokeAppCommand('tools.panel.preflight');
    await browser.waitUntil(async () => (await preflightSnapshot()) !== null, {
      timeout: 30000,
      timeoutMsg: 'the preflight report never came back',
    });
    await preflightJump('trim_box', 0);
    await expectActiveOp('pagebox');
  });

  /** The report re-runs on the buffer the fix changed, so a row's verdict is
   * settled-for rather than read once. */
  async function expectStatus(checkId: string, status: string): Promise<void> {
    await browser.waitUntil(
      async () => {
        const snapshot = await preflightSnapshot();
        return snapshot?.checks.find((c) => c.id === checkId)?.status === status;
      },
      { timeout: 30000, timeoutMsg: `${checkId} never reached ${status}` },
    );
  }

  describe('the fixup pass', () => {
    before(async () => {
      // A profile that carries doors for exactly what this document failed —
      // a fix is offered only where the PROFILE carries the door, so the
      // rule under test has to name them.
      const target = resolve(dir, 'fixing-rule.json');
      expect(await preflightExportProfile(target)).not.toContain('__SPECTRA_E2E_ERROR__');
      const doc = JSON.parse(readFileSync(target, 'utf8'));
      doc.profile.id = 'fixing_rule';
      doc.profile.name = 'Fixing rule';
      doc.profile.checks = {
        ...doc.profile.checks,
        ink_coverage_max: { enabled: false },
        title_present: { severity: 'fail', require_title: true },
      };
      doc.profile.fixups = [
        { id: 'remove_annotations', params: { printing_only: true } },
        { id: 'set_trim_box', params: { from_box: 'crop' } },
        { id: 'set_document_title', params: {} },
      ];
      writeFileSync(target, JSON.stringify(doc, null, 2));
      expect(await preflightImportProfile(target)).toBe('fixing_rule');
      await browser.waitUntil(
        async () => (await preflightSnapshot())?.profile === 'fixing_rule',
        { timeout: 30000, timeoutMsg: 'the fixing rule never ran' },
      );
    });

    it('offers a fix only where the profile carries the door', async () => {
      const snapshot = (await preflightSnapshot())!;
      const by = Object.fromEntries(snapshot.checks.map((c) => [c.id, c]));
      expect(by.trim_box.fix).toBe('auto');
      expect(by.printing_annotations.fix).toBe('auto');
      // An authored value nobody typed is never invented, so the title row
      // gets a field rather than a button.
      expect(by.title_present.fix).toBe('authored');
      // The profile carries no colour conversion, so the failing colour row
      // offers nothing rather than a button whose only outcome is a refusal.
      expect(by.colour_family.status).toBe('fail');
      expect(by.colour_family.fix).toBeNull();
      expect(snapshot.fixable).toEqual(
        expect.arrayContaining(['trim_box', 'printing_annotations']),
      );
      expect(snapshot.fixable).not.toContain('title_present');
    });

    it('repairs one row, and the row flips on the automatic re-check', async () => {
      // The box checks are a WARN on the general profiles: a great many
      // printable documents carry no trim box because their producer never
      // wrote one, and a fix is offered against a warn too.
      await expectStatus('trim_box', 'warn');
      expect(await preflightFix('trim_box')).toBe(true);
      await expectStatus('trim_box', 'pass');
    });

    it('puts the verdict back on ONE undo', async () => {
      // One invocation is one undo entry, which is the honest answer rather
      // than the convenient one: the fixups inside a pass condition each
      // other, so undoing one stage while the next stood would leave a
      // document the canonical order never produces.
      expect(await invokeAppCommand('edit.undo')).toBe(true);
      await expectStatus('trim_box', 'warn');
    });

    it('writes an authored value and clears its own row', async () => {
      await expectStatus('title_present', 'fail');
      expect(await preflightAuthoredFix('title_present', null, 'Spring catalogue'))
        .toBe(true);
      await expectStatus('title_present', 'pass');
    });

    it('fixes what the profile can, as one act', async () => {
      const before = (await preflightSnapshot())!;
      expect(before.fixable.length).toBeGreaterThan(0);
      expect(await preflightFixAll()).toBe(true);
      for (const checkId of before.fixable) await expectStatus(checkId, 'pass');
      // What the profile does NOT carry is untouched: a pass this document did
      // not earn is the wrongness the round exists to end.
      const after = (await preflightSnapshot())!;
      expect(after.checks.find((c) => c.id === 'colour_family')!.status).toBe('fail');
    });

    it('leaves the document readable, and comes back to the shipped rule', async () => {
      expect((await getState()).view).toBe('canvas');
      await preflightSelectProfile('sheetfed_offset');
      await browser.waitUntil(
        async () => (await preflightSnapshot())?.profile === 'sheetfed_offset',
        { timeout: 30000, timeoutMsg: 'the sheetfed profile never came back' },
      );
    });
  });

  it('exports both formats, carrying every check id AND its parameters', async () => {
    await invokeAppCommand('tools.panel.preflight');
    await browser.waitUntil(async () => (await preflightSnapshot()) !== null, {
      timeout: 30000,
      timeoutMsg: 'the preflight report never came back',
    });
    const snapshot = (await preflightSnapshot())!;

    const txt = resolve(dir, 'report.txt');
    const html = resolve(dir, 'report.html');
    expect(await preflightExport(txt)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(await preflightExport(html)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(existsSync(txt)).toBe(true);
    expect(existsSync(html)).toBe(true);

    const text = readFileSync(txt, 'utf8');
    const page = readFileSync(html, 'utf8');
    for (const check of snapshot.checks) {
      expect(text).toContain(check.id);
      expect(page).toContain(check.id);
    }
    // The rule travels with the verdict, in both formats.
    expect(text).toContain('300 dpi');
    expect(page).toContain('300 dpi');
    expect(page).toContain('<!DOCTYPE html>');
  });

  it('round-trips a profile through a file, and the file drives a run', async () => {
    const target = resolve(dir, 'house-rule.json');
    expect(await preflightExportProfile(target)).not.toContain('__SPECTRA_E2E_ERROR__');
    expect(existsSync(target)).toBe(true);

    // A shipped id cannot be replaced, so the exported rule is renamed before
    // it comes back — which is exactly what a shop does with its customers'.
    const doc = JSON.parse(readFileSync(target, 'utf8'));
    doc.profile.id = 'house_rule';
    doc.profile.name = 'House rule';
    doc.profile.checks = {
      ...doc.profile.checks,
      image_min_dpi_contone: { severity: 'warn', min_dpi: 50 },
    };
    writeFileSync(target, JSON.stringify(doc, null, 2));

    const imported = await preflightImportProfile(target);
    expect(imported).toBe('house_rule');
    await browser.waitUntil(
      async () => (await preflightSnapshot())?.profile === 'house_rule',
      { timeout: 30000, timeoutMsg: 'the imported profile never ran' },
    );
    const snapshot = (await preflightSnapshot())!;
    const contone = snapshot.checks.find((c) => c.id === 'image_min_dpi_contone')!;
    // 7 dpi is still below 50, but the imported rule says WARN, not fail.
    expect(contone.params.min_dpi).toBe(50);
    expect(contone.status).toBe('warn');
    expect(snapshot.profiles).toContain('house_rule');
  });
});
