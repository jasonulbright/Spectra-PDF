import { expect } from '@wdio/globals';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  answerNextSaveDialog,
  audiverisAnswer,
  audiverisForceAbsent,
  audiverisRestore,
  commandEnabled,
  getActiveDocPages,
  harnessLastError,
  invokeAppCommand,
  openByPaths,
  setActiveOp,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

// Recognize Music runs a user-installed Audiveris. The ABSENT axis is held by
// pinning the renderer's one answer, because the machine running the suite may
// have Audiveris installed and nothing outside the app can hide it from the
// Rust discovery. The PRESENT leg runs only where the machine's real answer is
// ready.

const FIXTURES = resolve(process.cwd(), 'fixtures');
const SAMPLE = join(FIXTURES, 'sample.pdf');

const NOTICE = '[data-testid="audiveris-required"]';
const SETUP = '[data-testid="audiveris-setup"]';
const PANEL = '[data-testid="omr-panel"]';
const RUN = '[data-testid="omr-run"]';
const PREF = '[data-testid="pref-audiveris"]';
const PREF_STATUS = '[data-testid="pref-audiveris-status"]';
const STATUS = '[data-testid="omr-panel"] [data-testid="status-bar"]';

/** One staff of five lines, a bar line at each end and four stemmed quarter
 * notes, drawn here so that no third-party score enters the repository. The
 * line spacing is 6 pt, which is 25 pixels at the recognizer's 300 dpi. */
async function drawScore(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const left = 72;
  const right = 523;
  const top = 700;
  const gap = 6;
  const ink = rgb(0, 0, 0);
  for (let i = 0; i < 5; i++) {
    const y = top - i * gap;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.8, color: ink });
  }
  const bottom = top - 4 * gap;
  for (const x of [left, right]) {
    page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 1.2, color: ink });
  }
  const notes = [bottom + gap, bottom + 1.5 * gap, bottom + 2 * gap, bottom + 2.5 * gap];
  notes.forEach((y, i) => {
    const x = left + 90 + i * 100;
    page.drawEllipse({ x, y, xScale: 3.6, yScale: 2.7, color: ink });
    page.drawLine({ start: { x: x + 3.4, y }, end: { x: x + 3.4, y: y + 3.5 * gap }, thickness: 0.9, color: ink });
  });
  writeFileSync(path, await doc.save());
}

describe('Recognize Music', () => {
  let tmp: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'spectra-omr-'));
    await waitForHarness();
    await openByPaths([SAMPLE]);
    await audiverisForceAbsent();
  });

  after(async () => {
    await audiverisRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    const close = await $('[data-testid="prefs-close"]');
    if (await close.isExisting()) await close.click();
  });

  describe('without Audiveris', () => {
    it('pins the answer every surface reads', async () => {
      const answer = await audiverisAnswer();
      expect(answer.kind).toBe('not-configured');
      expect(answer.pending).toBe(false);
    });

    it('disables the command', async () => {
      expect(await invokeAppCommand('tools.panel.omr')).toBe(false);
      expect(await invokeAppCommand('tools.panel.scanenhance')).toBe(true);
    });

    it('opens the panel from the tool dock on the shared explanation', async () => {
      await setView('operations');
      await setActiveOp('scanenhance');
      await waitForDisplayedSelector('[data-testid="dock-op-omr"]', { timeout: 10_000 });
      await $('[data-testid="dock-op-omr"]').click();
      await waitForDisplayedSelector(PANEL, { timeout: 10_000 });
      await waitForDisplayedSelector(NOTICE, { timeout: 10_000 });
      expect(await $(NOTICE).getAttribute('data-audiveris-kind')).toBe('not-configured');
      expect(await $(NOTICE).getText()).toContain('This needs Audiveris, which Spectra PDF does not include.');
      expect(await $(RUN).isEnabled()).toBe(false);
    });

    it('"Set up Audiveris" reaches the Preferences section', async () => {
      await setView('operations');
      await setActiveOp('omr');
      await waitForDisplayedSelector(SETUP, { timeout: 10_000 });
      await $(SETUP).click();
      await waitForDisplayedSelector(PREF, { timeout: 10_000 });
      expect(await $('[data-testid="prefs-cat-engine"]').getAttribute('aria-pressed')).toBe('true');
      expect(await $(PREF_STATUS).getText()).toBe('Not set up');
      expect(await $(PREF_STATUS).getAttribute('data-audiveris-kind')).toBe('not-configured');
      await expect($('[data-testid="pref-audiveris-problem"]')).toBeDisplayed();
      await expect($('[data-testid="pref-audiveris-origin"]')).not.toBeExisting();
      expect(await $('[data-testid="pref-audiveris-path"]').getText()).toBe('None found');
    });

    it('discloses that Spectra PDF ships no copy, and where to get one', async () => {
      await setView('operations');
      await setActiveOp('omr');
      await waitForDisplayedSelector(SETUP, { timeout: 10_000 });
      await $(SETUP).click();
      await waitForDisplayedSelector(PREF, { timeout: 10_000 });
      expect(await $('[data-testid="pref-audiveris-license"]').getText()).toContain(
        'Audiveris is not part of Spectra PDF.',
      );
      expect(await $('[data-testid="pref-audiveris-where"]').getText()).toContain(
        'github.com/Audiveris/audiveris/releases',
      );
      expect(await $('[data-testid="pref-audiveris-used-for"]').getText()).toContain('Recognize Music');
      await expect($('[data-testid="pref-audiveris-releases"]')).toBeDisplayed();
    });
  });

  // The suite-level timeout covers the hooks as well as the tests, and it is
  // in place before the WDIO wrapper arms its own timer from the test's value
  // (`@wdio/utils` executeAsync reads it before the body runs). It exceeds the
  // longest test's sum of waits, so a timed-out wait reports its diagnostics
  // before the runner kills the test.
  describe('with Audiveris', function () {
    this.timeout(400_000);
    let source: string;
    let ready = false;

    /** What the app shows about the run, for a wait that timed out: the queue
     * lines, the panel's status and the harness's last recorded error. A lost
     * engine answer leaves the run line running; a UI that never settled
     * shows a finished line. */
    /** The queue rows as text, each cell separated, from row `from` on. */
    async function queueRows(from = 0): Promise<{ status: string; text: string }[]> {
      const rows = await browser.execute(function () {
        return Array.from(document.querySelectorAll('[data-testid="opqueue-item"]')).map((el) => ({
          status: el.getAttribute('data-status') ?? '',
          text: Array.from(el.children)
            .map((cell) => (cell.textContent ?? '').trim())
            .filter((cell) => cell !== '')
            .join(' — '),
        }));
      });
      return rows.slice(from);
    }

    async function diagnostics(): Promise<string> {
      const status = (await $(STATUS).isExisting()) ? await $(STATUS).getText() : '(no status line)';
      const queue = (await queueRows()).map((row) => `${row.status}: ${row.text}`);
      const running = await browser.execute(function () {
        return document.querySelector('[data-testid="opqueue"]')?.getAttribute('data-running') ?? '0';
      });
      const busy = await $('[data-testid="omr-stop"]').isExisting();
      return `panel busy=${busy}; status="${status}"; queue running=${running} [${queue.join(' | ')}]; `
        + `lastError=${(await harnessLastError()) ?? 'none'}`;
    }

    /** The queue row index this leg's run starts from; earlier rows belong to
     * earlier legs. */
    let firstRow = 0;
    /** The panel status before this leg's Run click; until the status changes
     * it belongs to an earlier leg. */
    let statusBeforeRun: string | null = null;

    /** The run's failure as the app shows it, or null while it has not failed:
     * the panel's error or stop status, or this leg's queue line in error. */
    async function runFailure(): Promise<string | null> {
      const status = (await $(STATUS).isExisting()) ? await $(STATUS).getText() : '';
      if (status !== statusBeforeRun) statusBeforeRun = null;
      const ours = statusBeforeRun === null;
      if (ours && (status.startsWith('Error: ') || status === 'Music recognition stopped.')) return `panel: ${status}`;
      const failed = (await queueRows(firstRow)).find((row) => row.status === 'error');
      return failed ? `queue: ${failed.text}` : null;
    }

    /** Waits for `condition`, failing at once when the run fails; a timeout or
     * a failure names the app's state. */
    async function waitFor(condition: () => Promise<boolean>, timeout: number, what: string): Promise<void> {
      let failure: string | null = null;
      try {
        await browser.waitUntil(async () => {
          if (await condition()) return true;
          failure = await runFailure();
          return failure !== null;
        }, { timeout, timeoutMsg: what });
      } catch (error) {
        throw new Error(`${what} within ${timeout} ms: ${await diagnostics()} (${String(error)})`);
      }
      if (failure !== null) throw new Error(`${what}: the run failed (${failure}); ${await diagnostics()}`);
    }

    /** Waits for `selector` to show, failing at once when the run fails. */
    function waitShown(selector: string, timeout: number, what: string): Promise<void> {
      return waitFor(async () => (await $(selector).isExisting()) && (await $(selector).isDisplayed()), timeout, what);
    }

    before(async () => {
      ready = (await audiverisRestore()).kind === 'ready';
      if (!ready) return;
      source = join(tmp, 'score.pdf');
      await drawScore(source);
      await openByPaths([source]);
    });

    // A run or a consent left by a failed leg is stopped and its stage
    // discarded, so the next leg starts on an idle panel.
    afterEach(async () => {
      if (!ready) return;
      const stop = await $('[data-testid="omr-stop"]');
      if (await stop.isExisting()) {
        try {
          await stop.click();
        } catch {
          // The run ended between the check and the click; the wait decides.
        }
        await waitFor(async () => !(await $('[data-testid="omr-stop"]').isExisting()), 60_000,
          'the stopped run did not end');
      }
      const keep = await $('[data-testid="omr-consent-cancel"]');
      if (await keep.isExisting()) await keep.click();
    });

    async function runOnce(): Promise<void> {
      await setView('operations');
      await setActiveOp('omr');
      await waitForDisplayedSelector(RUN, { timeout: 10_000 });
      expect(await $(RUN).isEnabled()).toBe(true);
      if (!(await $('[data-testid="omr-keep-project"]').isSelected())) {
        await $('[data-testid="omr-keep-project"]').click();
      }
      await answerNextSaveDialog(join(tmp, 'score.mxl'));
      firstRow = (await queueRows()).length;
      statusBeforeRun = (await $(STATUS).isExisting()) ? await $(STATUS).getText() : '';
      await $(RUN).click();
    }

    it('writes the score beside a Spectra-drawn page while the document stays editable', async function () {
      if (!ready) {
        // This machine has no usable Audiveris, so the present axis is not
        // available here; the absent axis above still ran.
        this.skip();
      }
      await runOnce();
      // The run holds no lock on the document: while it is queued, a page
      // edit is offered and lands.
      await waitFor(async () => (await $(STATUS).getText()) === 'Recognizing music…', 60_000,
        'the recognition never started running');
      const before = (await getActiveDocPages()).length;
      expect(await commandEnabled('document.insertBlankPage')).toBe(true);
      expect(await invokeAppCommand('document.insertBlankPage')).toBe(true);
      // The edit lands while the run is still running, not after it.
      await waitFor(async () => (await getActiveDocPages()).length === before + 1, 10_000,
        'the blank page did not land during the run');
      expect(await $(STATUS).getText()).toBe('Recognizing music…');
      await waitShown('[data-testid="omr-result"]', 300_000, 'no result notice');
      await expect($('[data-testid="omr-not-exact"]')).toBeDisplayed();
      expect(readdirSync(tmp).filter((name) => /\.(mxl|omr)$/i.test(name)).sort()).toEqual(['score.mxl', 'score.omr']);
    });

    it('asks once for every existing file and replaces exactly those', async function () {
      if (!ready) this.skip();
      await runOnce();
      await waitShown('[data-testid="omr-consent"]', 300_000, 'no consent for the existing files');
      const names: string[] = await $$('[data-testid="omr-consent-name"]').map((item) => item.getText());
      expect([...names].sort()).toEqual(['score.mxl', 'score.omr']);
      await $('[data-testid="omr-replace"]').click();
      await waitShown('[data-testid="omr-result"]', 60_000, 'no result notice after Replace');
      expect(readdirSync(tmp).filter((name) => /\.(mxl|omr)$/i.test(name)).sort()).toEqual(['score.mxl', 'score.omr']);
    });
  });
});
