import { expect } from '@wdio/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  answerAnyFilePicker,
  gsAnswer,
  gsForceAbsent,
  gsRestore,
  invokeAppCommand,
  openByPaths,
  setActiveOp,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

// The CAPABILITY-ABSENT axis, end to end.
//
// Ghostscript is a user-supplied prerequisite: nothing in the distribution
// provides one. Every machine that can run this suite HAS one — the present
// axis needs it — so absence is arranged from inside the app, by pinning the
// renderer's one answer (`gsForceAbsent`). That is the same shape as
// `breakTabOrderPublish`: a seam on the module the shipped code already
// reads, reachable only from the harness, which exists only in a VITE_E2E
// build. PATH cannot arrange it — discovery reads the registry and the
// environment too — and uninstalling is not something a suite may do.
//
// What is under test is the GATING TABLE, not one panel: 25 surfaces gate on
// this prerequisite and nine of them are PARTIAL, so a spec that only proved
// "things are disabled" would pass over the whole point — Compare's text mode
// still works, Create PDF still builds from images, Export still offers Word
// and text. The walk samples one surface per MECHANISM (a rendered notice, a
// gated command, a disabled mode inside a working panel, a refused source
// class inside a working dialog), drives Settings ▸ Engine, then lifts the
// pin and asserts a surface lights up with no restart.

const FIXTURES = resolve(process.cwd(), 'fixtures');
const SAMPLE = join(FIXTURES, 'sample.pdf');
const SECOND = join(FIXTURES, 'bookmarked.pdf');

const PREFLIGHT_NOTICE = '[data-testid="preflight-gs"]';
const COMPARE_VISUAL = '[data-testid="compare-mode-visual"]';
const COMPARE_TEXT = '[data-testid="compare-mode-text"]';
const COMPARE_RUN = '[data-testid="compare-run"]';
const GS_STATUS = '[data-testid="prefs-gs-status"]';
const GS_PROBLEM = '[data-testid="prefs-gs-problem"]';
const GS_BROWSE = '[data-testid="prefs-gs-browse"]';

// A 1x1 PNG. Create PDF's image leg needs no interpreter, and proving that
// takes an actual image rather than another PDF.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function storedGsPath(): Promise<string> {
  return browser.execute(
    () => JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').gsPath ?? '',
  ) as Promise<string>;
}

describe('the Ghostscript-absent axis', () => {
  let tmp: string;
  let postscript: string;
  let image: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'spectra-gs-absent-'));
    postscript = join(tmp, 'page.ps');
    writeFileSync(
      postscript,
      '%!PS-Adobe-3.0\n/Helvetica findfont 24 scalefont setfont\n' +
        '72 700 moveto (absent axis) show\nshowpage\n',
      'ascii',
    );
    image = join(tmp, 'pixel.png');
    writeFileSync(image, Buffer.from(PNG_1x1_BASE64, 'base64'));

    await waitForHarness();
    await openByPaths([SAMPLE]);
    await gsForceAbsent();
  });

  after(async () => {
    // Leave the shared workspace on the machine's real answer, whatever it
    // is — a pinned session would silently disable every later spec.
    await gsRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pins the answer the whole renderer reads', async () => {
    const answer = await gsAnswer();
    expect(answer.available).toBe(false);
    expect(answer.pending).toBe(false);
    expect(answer.reason).toBe('not-configured');
  });

  // ── Mechanism 1: the rendered notice ───────────────────────────────────
  //
  // Sampled on a PARTIAL panel on purpose. A panel whose whole operation is
  // gated is unreachable through the chrome (mechanism 2 removes its command
  // outright), so the notices a user can actually meet are the ones on panels
  // that still open — which makes those the ones worth walking.

  it('a panel that still opens explains the disabled half by name', async () => {
    await setView('operations');
    await setActiveOp('preflight');
    await waitForDisplayedSelector(PREFLIGHT_NOTICE, { timeout: 10_000 });
    expect(await $(PREFLIGHT_NOTICE).getAttribute('data-gs-reason')).toBe('not-configured');
    // One explanation and one route to fix it — the same component on all 25.
    await expect($(`${PREFLIGHT_NOTICE} [data-testid="gs-setup"]`)).toBeDisplayed();
  });

  // ── Mechanism 2: the command registry ──────────────────────────────────

  it('removes the Ghostscript-only commands', async () => {
    // Gated all the way down: there is no half of these that runs.
    expect(await invokeAppCommand('tools.panel.compress')).toBe(false);
    expect(await invokeAppCommand('tools.panel.pdfa')).toBe(false);
    expect(await invokeAppCommand('tools.panel.grayscale')).toBe(false);
    expect(await invokeAppCommand('file.print')).toBe(false);
    expect(await invokeAppCommand('file.exportImages')).toBe(false);
    expect(await invokeAppCommand('file.exportPowerpoint')).toBe(false);
  });

  it('leaves every operation that needs no interpreter reachable', async () => {
    // The failure this guards against is a blanket gate: disabling the tool
    // chrome wholesale would cut watermarking, redaction and page work that
    // never touch Ghostscript.
    expect(await invokeAppCommand('tools.panel.watermark')).toBe(true);
    expect(await invokeAppCommand('tools.panel.preflight')).toBe(true);
    expect(await invokeAppCommand('tools.panel.flattener')).toBe(true);
  });

  // ── Mechanism 3: a disabled MODE inside a working panel ────────────────

  it('Compare keeps its text mode and gates only the visual one', async () => {
    // The mode control renders only once there is a second document to
    // compare against, so this opens a DIFFERENT file rather than the same
    // one twice — a repeat open focuses the existing tab.
    await openByPaths([SECOND]);
    await setView('operations');
    await setActiveOp('compare');

    await waitForDisplayedSelector(COMPARE_VISUAL, { timeout: 10_000 });
    expect(await $(COMPARE_VISUAL).isEnabled()).toBe(false);
    expect(await $(COMPARE_TEXT).isEnabled()).toBe(true);

    // Text mode is the panel's default and it stays RUNNABLE: the visual half
    // is the only thing withheld.
    await $(COMPARE_TEXT).click();
    await waitForDisplayedSelector('[data-testid="compare-gs"]', {
      reverse: true,
      timeout: 10_000,
    });
    expect(await $(COMPARE_RUN).isEnabled()).toBe(true);
  });

  // ── Mechanism 4: a refused SOURCE CLASS inside a working dialog ────────

  it('Create PDF builds from an image and refuses PostScript by name', async () => {
    // The dialog's own source list can only be filled by the native picker,
    // so the list is injected and the RUN is the shipped one: images, Office
    // documents and PDFs are built by other tools, and only the PostScript
    // rows ask for an interpreter.
    expect(await invokeAppCommand('file.createPdf')).toBe(true);
    await waitForDisplayedSelector('[data-testid="create-pdf-pick"]', { timeout: 10_000 });

    const built = await browser.executeAsync<string, [string, string]>(
      function (src, dest, done) {
        (window as any).__SPECTRA_TEST__
          .createPdfRun([src], dest)
          .then((r: { output: string } | null) => done(r ? r.output : 'NULL'))
          .catch((e: Error) => done(`THREW ${String(e)}`));
      },
      image,
      join(tmp, 'from-image.pdf'),
    );
    expect(built).toBe(join(tmp, 'from-image.pdf'));

    const refused = await browser.executeAsync<string, [string, string]>(
      function (src, dest, done) {
        (window as any).__SPECTRA_TEST__
          .createPdfRun([src], dest)
          .then(() => done('BUILT'))
          .catch((e: Error) => done(String(e)));
      },
      postscript,
      join(tmp, 'from-ps.pdf'),
    );
    expect(refused).not.toBe('BUILT');
    expect(refused).toContain('Ghostscript');
    await $('[data-testid="create-pdf-close"]').click();
  });

  // ── Settings ▸ Engine: the surface where the answer changes ────────────

  it('reports the engine as not set up', async () => {
    expect(await invokeAppCommand('help.licenses')).toBe(true);
    await $('[data-testid="prefs-cat-engine"]').click();
    await waitForDisplayedSelector(GS_STATUS, { timeout: 10_000 });
    expect(await $(GS_STATUS).getAttribute('data-gs-available')).toBe('no');
    await expect($(GS_PROBLEM)).toBeDisplayed();
  });

  it('a browsed path that does not answer is reported and NOT stored', async () => {
    // The defect this replaced: the old resolver wrote a path into settings
    // whether or not anything answered there, so a mistyped browse left the
    // app pointed at nothing while the panel claimed it was configured.
    const before = await storedGsPath();
    const bogus = join(tmp, 'not-a-ghostscript.exe');
    writeFileSync(bogus, 'this is not a program', 'ascii');

    // Armed BEFORE the control opens it: the pick is still started by the
    // browse handler, so the probe and the store-or-refuse decision are the
    // shipped ones.
    await answerAnyFilePicker(bogus);
    await $(GS_BROWSE).click();

    // The candidate is probed through the bridge, which spawns — a longer
    // wait than a render, and bounded by the probe's own timeout.
    await waitForDisplayedSelector(GS_PROBLEM, { timeout: 30_000 });
    expect(await $(GS_PROBLEM).getText()).not.toBe('');

    expect(await storedGsPath()).toBe(before);
    // The session's answer is untouched: a failed candidate is reported
    // beside the section, never published as the app's state.
    expect((await gsAnswer()).reason).toBe('not-configured');
  });

  it('a cancelled browse changes nothing at all', async () => {
    const before = await storedGsPath();
    await answerAnyFilePicker(null);
    await $(GS_BROWSE).click();
    expect(await storedGsPath()).toBe(before);
    await $('[data-testid="prefs-close"]').click();
  });

  // ── The claim that makes the whole posture liveable ────────────────────

  it('lights the surfaces up live when Ghostscript arrives — no restart', async function () {
    const answer = await gsRestore();
    if (!answer.available) {
      // This machine is on the absent axis for real, so there is nothing to
      // light up. Named rather than silent: a green run that skipped this is
      // not a run that proved it.
      this.skip();
      return;
    }
    // Same session, same window, nothing reloaded.
    expect(await invokeAppCommand('tools.panel.compress')).toBe(true);
    await setView('operations');
    await setActiveOp('preflight');
    await waitForDisplayedSelector(PREFLIGHT_NOTICE, { reverse: true, timeout: 10_000 });

    await setActiveOp('compare');
    await waitForDisplayedSelector(COMPARE_VISUAL, { timeout: 10_000 });
    expect(await $(COMPARE_VISUAL).isEnabled()).toBe(true);
  });
});
