// The GWG Processing Steps Test Suite v1.0, through the real Layers panel,
// Output Preview and preflight.
//
// INTERNAL REGRESSION EVIDENCE ONLY. Passing here is not a Ghent Workgroup
// certification and it is not an ISO 19593-1 conformance claim; that standard
// is not held in this repository at all (the gap is recorded in
// `src/engine/processing_steps.py`, which names it).
//
// The engine-side table of documented expectations is
// `tests/processing-steps-expected.tsv`. What THIS spec proves is the half
// that only the built product can answer: the declaration the engine read
// reaches the Layers surface as a labelled step beside layers that carry
// none, the two malformations the standard's own corpus documents are shown
// as notes rather than swallowed, the exclusion switch is a VIEW control that
// actually moves the plate inventory and the ink measurement, and preflight's
// row for it is addressable to the surface that owns the edit.
//
// The corpus is gitignored and fetched (`scripts/fetch-processing-steps-suite.py`),
// so every case skips by NAME on a tree that has not fetched it — the skip
// tests for the FILES, never for a directory a workflow may have created
// empty (the `gs_axis` shape).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  setView,
  setActiveOp,
  closeAllFiles,
  invokeAppCommand,
  waitForDisplayedSelector,
  preflightSnapshot,
  preflightJump,
} from '../support/harness.js';

const PATCHES = resolve(
  __dirname,
  '..',
  '..',
  'processing-steps-corpus',
  'suite',
  'Processing Steps Test Suite V1.0',
  'Patches',
);

const patch = (id: string): string => resolve(PATCHES, `Patch ${id}.pdf`);

/** A conforming two-step patch: a Cutting die line, a Punching step, and one
 *  ordinary artwork layer beneath them. */
const CUTTING = patch('PS-001-01G');
/** The suite's unregistered-type patch: `Structural/NotAllowed`. */
const UNREGISTERED = patch('PS-013-01E');
/** The suite's type-on-an-untyped-group patch: `White/NotAllowed`. */
const UNTYPED_GROUP = patch('PS-012-02E');
/** A conforming patch whose first step is a White (varnish class) group. */
const WHITE = patch('PS-006-04G');

/** The layer the patches carry that is artwork and declares no step. Its
 *  index is the engine's /OCGs order, which the panel renders in. */
const ARTWORK_LAYER = 2;

/** The two spot colorants every patch paints ONLY inside processing-step
 *  marked content, named as the files name them; the slugs are the panel's
 *  own selector derivation. */
const STEP_INKS = [
  { slug: 'structural', name: 'Structural' },
  { slug: 'structural-punching', name: 'Structural - Punching' },
];

/** The colorant the artwork itself paints, which the exclusion never drops. */
const ARTWORK_INK = { slug: 'orange', name: 'Orange' };

/** The process plate the White group's own content paints, and so the plate
 *  whose coverage figure moves when the step content is put back. */
const ARTWORK_PROCESS_INK = 'cyan';

/** The one reason a case here is skipped, named as an axis. */
function corpusPresent(...files: string[]): boolean {
  return files.every((file) => existsSync(file));
}

async function separationsReady(): Promise<boolean> {
  return browser.execute(function () {
    const list = Array.prototype.slice.call(
      document.querySelectorAll('canvas.pageview-separation.ready'),
    ) as HTMLCanvasElement[];
    return list.filter((c) => c.width > 8 && c.height > 8).length > 0;
  });
}

async function waitForSeparations(timeout = 90_000): Promise<void> {
  await browser.waitUntil(async () => await separationsReady(), {
    timeout,
    timeoutMsg: 'the separation composite never arrived',
    interval: 300,
  });
}

async function openLayers(file: string): Promise<void> {
  await closeAllFiles();
  await openByPaths([file]);
  await setView('operations');
  await setActiveOp('layers');
  await waitForDisplayedSelector('[data-testid="layers-list"]', { timeout: 30_000 });
}

async function openOutputPreview(file: string): Promise<void> {
  await closeAllFiles();
  await openByPaths([file]);
  await setView('operations');
  await invokeAppCommand('view.documentView');
  await waitForDisplayedSelector('[data-testid="document-view"]', { timeout: 15_000 });
  await setActiveOp('outputpreview');
  await waitForDisplayedSelector('[data-testid="output-preview-arm"]', { timeout: 15_000 });
  await $('[data-testid="output-preview-arm"]').click();
  await waitForSeparations();
  await waitForDisplayedSelector('[data-testid="output-preview-ink-list"]', {
    timeout: 60_000,
  });
}

/** The heaviest-pixel figure, read as the NUMBER: the sentence around it is
 *  localized and the figure is not. */
async function maxTac(): Promise<number> {
  let reported = 0;
  await browser.waitUntil(
    async () => {
      const text = await $('[data-testid="output-preview-maxtac"]').getText();
      const match = /([\d.]+)\s*%/.exec(text);
      if (!match) return false;
      reported = Number(match[1]);
      return reported > 0;
    },
    { timeout: 60_000, timeoutMsg: 'the heaviest-pixel figure never appeared' },
  );
  return reported;
}

/** One plate's coverage figure, read as the NUMBER for the same reason. */
async function coverage(slug: string): Promise<number> {
  let reported = 0;
  await browser.waitUntil(
    async () => {
      const text = await $(`[data-testid="output-preview-coverage-${slug}"]`).getText();
      const match = /([\d.]+)\s*%/.exec(text);
      if (!match) return false;
      reported = Number(match[1]);
      return reported > 0;
    },
    { timeout: 60_000, timeoutMsg: `no coverage figure for ${slug}` },
  );
  return reported;
}

async function inkListed(slug: string): Promise<boolean> {
  return browser.execute(
    (id: string) => document.querySelector(`[data-testid="output-preview-ink-${id}"]`) !== null,
    slug,
  );
}

describe('processing steps', function () {
  // The suite timeout is set HERE, never per case: wdio reads the runnable's
  // timeout BEFORE the test body runs, so a `this.timeout()` written inside a
  // case is captured too late to raise anything. One separation render of a
  // patch outlives the 60 s default.
  this.timeout(300_000);

  before(async () => {
    await waitForHarness();
  });

  after(async () => {
    await closeAllFiles();
  });

  it('labels a declared step on the Layers panel and leaves artwork unlabelled', async function () {
    if (!corpusPresent(CUTTING)) {
      // Processing-steps-corpus axis: the suite is not fetched on this machine.
      this.skip();
      return;
    }
    await openLayers(CUTTING);
    const step = await $('[data-testid="layer-step-0"]');
    await step.waitForDisplayed({ timeout: 30_000 });
    // The group and the type are DOCUMENT CONTENT and are shown verbatim;
    // only the sentence around them is translated.
    expect(await step.getText()).toContain('Structural / Cutting');
    // The layer that carries artwork declares nothing, and the panel says
    // nothing about it — a step line on every row would make the label
    // meaningless.
    await waitForDisplayedSelector(`[data-testid="layer-${ARTWORK_LAYER}"]`, { timeout: 30_000 });
    expect(await $(`[data-testid="layer-step-${ARTWORK_LAYER}"]`).isExisting()).toBe(false);
  });

  it('notes the declarations the engine could not take at face value', async function () {
    if (!corpusPresent(UNREGISTERED, UNTYPED_GROUP)) {
      this.skip();
      return;
    }
    // A name outside the second-hand vocabulary is a QUESTION, not a verdict:
    // the note has to appear and it has to stay a question.
    await openLayers(UNREGISTERED);
    const unregistered = await $('[data-testid="layer-step-0"]');
    await unregistered.waitForDisplayed({ timeout: 30_000 });
    const unregisteredText = await unregistered.getText();
    expect(unregisteredText).toContain('Structural / NotAllowed');
    expect(unregisteredText).toContain('—');

    // A type written on a group that defines none is structurally wrong and
    // needs no vocabulary to see, so it carries its own separate note.
    await openLayers(UNTYPED_GROUP);
    const untyped = await $('[data-testid="layer-step-0"]');
    await untyped.waitForDisplayed({ timeout: 30_000 });
    const untypedText = await untyped.getText();
    expect(untypedText).toContain('White / NotAllowed');
    expect(untypedText).toContain('—');
    // The two malformations are told apart, not merged into one wording.
    expect(untypedText.replace('White / NotAllowed', '')).not.toBe(
      unregisteredText.replace('Structural / NotAllowed', ''),
    );
  });

  it('excludes the step colorants by default and gains their plates when asked', async function () {
    if (!corpusPresent(CUTTING)) {
      this.skip();
      return;
    }
    await openOutputPreview(CUTTING);

    // The switch is a VIEW control and it starts OFF: a die line that reached
    // the plate list by default would be a plate the press does not run.
    const toggle = await $('[data-testid="output-preview-processing-steps"]');
    await toggle.waitForDisplayed({ timeout: 30_000 });
    expect(await toggle.isSelected()).toBe(false);

    // What was excluded is NAMED. Silence would leave an operator hunting a
    // spot the panel decided not to show.
    const note = await $('[data-testid="output-preview-processing-step-inks"]');
    await note.waitForDisplayed({ timeout: 60_000 });
    const noteText = await note.getText();
    for (const ink of STEP_INKS) {
      expect(noteText).toContain(ink.name);
    }

    // The colorant the artwork paints is never dropped, whatever a layer
    // declares.
    await waitForDisplayedSelector(`[data-testid="output-preview-ink-${ARTWORK_INK.slug}"]`, {
      timeout: 60_000,
    });
    for (const ink of STEP_INKS) {
      expect(await inkListed(ink.slug)).toBe(false);
    }

    // The switch reaches the raster cache key, so the LIST ITSELF has to
    // change: a preview that re-used the keyed inventory would keep showing
    // the old plates while looking healthy.
    await toggle.click();
    for (const ink of STEP_INKS) {
      await waitForDisplayedSelector(`[data-testid="output-preview-ink-${ink.slug}"]`, {
        timeout: 90_000,
      });
    }
    await waitForSeparations();
    // With nothing excluded there is nothing left to name.
    expect(
      await $('[data-testid="output-preview-processing-step-inks"]').isExisting(),
    ).toBe(false);

    await toggle.click();
    await browser.waitUntil(async () => !(await inkListed(STEP_INKS[0].slug)), {
      timeout: 90_000,
      timeoutMsg: 'the excluded plate outlived the switch',
    });
  });

  it('keeps the varnish out of the ink measurement until it is asked for', async function () {
    if (!corpusPresent(WHITE)) {
      this.skip();
      return;
    }
    // The White group is the varnish class: counting it in the ink figures is
    // the silent-wrongness case, because a job passes or fails its coverage
    // limit on these numbers.
    //
    // The figure read is per-ink COVERAGE, not max total ink. Max TAC is a
    // maximum over pixels, and on this patch the artwork's heaviest pixel
    // already sits above anything the step content reaches — so a correct
    // exclusion moves it not at all. Coverage is the measurement that is
    // sensitive to the step content by construction: it is measured over the
    // staged copy, so ink the exclusion took off the page leaves it.
    await openOutputPreview(WHITE);
    await $('[data-testid="output-preview-alarm"]').click();
    await waitForDisplayedSelector('[data-testid="output-preview-maxtac"]', { timeout: 60_000 });
    const excludedTac = await maxTac();
    const excluded = await coverage(ARTWORK_PROCESS_INK);
    for (const ink of STEP_INKS) {
      expect(await inkListed(ink.slug)).toBe(false);
    }

    await $('[data-testid="output-preview-processing-steps"]').click();
    for (const ink of STEP_INKS) {
      await waitForDisplayedSelector(`[data-testid="output-preview-ink-${ink.slug}"]`, {
        timeout: 90_000,
      });
    }
    // The figure is settled-for rather than read once: the stats block
    // re-publishes on the re-render, and a read that landed between the plate
    // list moving and the measurement moving would be the OLD number.
    let included = 0;
    await browser.waitUntil(
      async () => {
        included = await coverage(ARTWORK_PROCESS_INK);
        return included > excluded;
      },
      {
        timeout: 120_000,
        timeoutMsg: 'ink coverage did not rise when the processing steps were included',
      },
    );
    expect(included).toBeGreaterThan(excluded);
    // Whatever the step content does to the maximum, excluding it can never
    // report MORE ink than including it.
    expect(await maxTac()).toBeGreaterThanOrEqual(excludedTac);
  });

  it('reports the declaration in preflight, addressed to the layers surface', async function () {
    if (!corpusPresent(UNTYPED_GROUP)) {
      this.skip();
      return;
    }
    await closeAllFiles();
    await openByPaths([UNTYPED_GROUP]);
    await setView('canvas');
    expect(await invokeAppCommand('tools.panel.preflight')).toBe(true);
    await browser.waitUntil(async () => (await preflightSnapshot()) !== null, {
      timeout: 60_000,
      timeoutMsg: 'the preflight report never arrived',
    });

    const snapshot = (await preflightSnapshot())!;
    const row = snapshot.checks.find((c) => c.id === 'processing_steps');
    expect(row).toBeDefined();
    expect(row!.category).toBe('content');
    // The type-on-an-untyped-group declaration is structurally wrong, and the
    // check says so off the file alone.
    expect(row!.status).toBe('fail');
    expect(row!.findings).toBeGreaterThan(0);
    expect(row!.addressKinds).toContain('object');

    // An object address lands on the surface that owns the edit — the Layers
    // panel — not on the page.
    await preflightJump('processing_steps', 0);
    await browser.waitUntil(async () => (await getState()).activeOp === 'layers', {
      timeout: 15_000,
      timeoutMsg: 'the jump never landed on the layers panel',
    });
  });
});
