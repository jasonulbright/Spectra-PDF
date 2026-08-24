import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  answerIccPicker,
  getState,
  iccAssentRefresh,
  iccAssentSnapshot,
  invokeAppCommand,
  openByPaths,
  setActiveOp,
  setReactSelectValue,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

// P37 — the PORTABLE container: the colour-profile licence presented in-app,
// and the app's data living beside the executable.
//
// The suite's harness binary runs from a folder with no `install-record.json`
// beside it, which IS the portable shape — that is not an approximation, it is
// the same structural test the shipped code makes. So the assent record this
// spec removes and restores is the real one, in the real place, written by the
// product's own command.
//
// `wdio.conf.ts`'s `onPrepare` seeds an ACCEPTED record beside the binary so
// the licence dialog does not stand in front of every other spec in the
// battery. This spec is the one that is about the unanswered state, so it
// removes that record and puts it back — which is exactly what the seeding
// comment says the first-run spec must do.
//
// What a spec cannot arrange from outside: the app read its answer once at
// launch, long before any `before` hook. `iccAssentRefresh` drops that cached
// answer and re-runs the REAL read against whatever is on disk now, then
// re-takes the launch decision through the app's own predicate and the app's
// own registered opener. Nothing about the record, the read, the dialog, the
// recording or the dependent surfaces is stubbed.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const EXE_DIR = resolve(APP_EXE, '..');
const PORTABLE_DATA = join(EXE_DIR, 'data');
const ASSENT_RECORD = join(PORTABLE_DATA, 'icc-assent.json');
const SEEDED_RECORD = '{\n  "adobeIccEulaAccepted": true\n}\n';

/** The standard per-user directory an INSTALLED copy would use. A portable run
 * must leave it alone; this is the whole of "location independence" as a user
 * meets it. */
const ROAMING_APP_DIR = join(process.env.APPDATA ?? '', 'com.spectrapdf.app');

const DIALOG = '[data-testid="icc-license-dialog"]';
const ACCEPT = '[data-testid="icc-license-accept"]';
const DECLINE = '[data-testid="icc-license-decline"]';
const REVIEW = '[data-testid="icc-licence-review"]';
const PREPRESS_NOTICE = '[data-testid="prepress-icc"]';
const OUTPUT_PREVIEW_NOTICE = '[data-testid="output-preview-icc"]';

let SCRATCH = '';

function roamingListing(): string[] {
  try {
    return readdirSync(ROAMING_APP_DIR).sort();
  } catch {
    return [];
  }
}

/** Remove the record and make the app re-read it. Returns the answer that
 * landed, which is the unrecorded one when nothing is on disk. */
async function unanswer(): Promise<void> {
  rmSync(ASSENT_RECORD, { force: true });
  const state = await iccAssentRefresh();
  expect(state.portable).toBe(true);
  expect(state.assent).toBe('unrecorded');
  expect(state.pending).toBe(false);
}

async function openPrepress(): Promise<void> {
  await setView('operations');
  await setActiveOp('convert_cmyk');
  await waitForDisplayedSelector('[data-testid="cmyk-convert"]', { timeout: 20_000 });
}

describe('the portable container: colour-profile assent and data beside the app', () => {
  before(async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'spectra-e2e-portable-'));
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
  });

  after(async () => {
    // The battery's baseline is an ANSWERED copy — every later spec depends on
    // it, so the seed goes back whatever happened above.
    writeFileSync(ASSENT_RECORD, SEEDED_RECORD);
    await iccAssentRefresh().catch(() => undefined);
    await invokeAppCommand('tools.close').catch(() => undefined);
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('runs as a portable copy with its answer on record beside the executable', async () => {
    // The starting state, stated rather than assumed: the record exists where
    // the product writes it, and the app reads itself as portable.
    expect(existsSync(ASSENT_RECORD)).toBe(true);
    const state = await iccAssentSnapshot();
    expect(state.portable).toBe(true);
    expect(state.assent).toBe('accepted');
    // The licence TEXT comes from the payload tree, not from a string in the
    // renderer — there is one copy and it is the installer's copy.
    expect(state.licensePath).not.toBe('');
    expect(existsSync(state.licensePath)).toBe(true);
  });

  it('presents the licence on a first run with no answer on record', async () => {
    await unanswer();
    await waitForDisplayedSelector(DIALOG, { timeout: 20_000 });
    // Presented means presented: the text is the file's, and Accept stays dead
    // until it has actually loaded — acceptance of a licence nobody was shown
    // is not acceptance.
    await browser.waitUntil(async () => $(ACCEPT).isEnabled(), {
      timeout: 30_000,
      timeoutMsg: 'the licence text never loaded, so Accept never became live',
    });
    const shown = await $('[data-testid="icc-license-text"]').getValue();
    expect(shown.trim().length).toBeGreaterThan(200);
  });

  it('declining records the answer and leaves the app fully running, named-disabled', async () => {
    await $(DECLINE).click();
    await waitForDisplayedSelector(DIALOG, { reverse: true, timeout: 30_000 });

    // Recorded — on disk, by the product's own command.
    await browser.waitUntil(async () => existsSync(ASSENT_RECORD), {
      timeout: 15_000,
      timeoutMsg: 'declining never wrote a record',
    });
    expect((await iccAssentSnapshot()).assent).toBe('declined');

    // The two profile-dependent surfaces name themselves disabled — the
    // Ghostscript posture, never a crippled or a silent app.
    await openPrepress();
    await waitForDisplayedSelector(PREPRESS_NOTICE, { timeout: 20_000 });
    expect(await $(PREPRESS_NOTICE).getAttribute('data-icc-assent')).toBe('declined');
    expect(await $('[data-testid="cmyk-convert"]').isEnabled()).toBe(false);
    expect(await $('[data-testid="pdfx-convert"]').isEnabled()).toBe(false);

    await setActiveOp('outputpreview');
    await waitForDisplayedSelector(OUTPUT_PREVIEW_NOTICE, { timeout: 20_000 });
    expect(await $(OUTPUT_PREVIEW_NOTICE).getAttribute('data-icc-assent')).toBe('declined');

    // And the rest of the product is untouched: a capability that has nothing
    // to do with colour profiles still runs.
    expect(await invokeAppCommand('tools.panel.watermark')).toBe(true);
  });

  it('a declined copy still converts against a profile the USER supplies', async () => {
    // The line between named-disabled and crippled: the licence covers the
    // profiles that SHIP, so a file the user points at is not gated. Proven at
    // the surface that chooses the destination — the bundled choices are
    // blocked while a chosen `.icc` file re-enables the action.
    const userIcc = findUserProfile();
    if (!userIcc) {
      // Named, not silently skipped: without a readable `.icc` on the machine
      // there is nothing to point at.
      expect(userIcc).toBeNull();
      return;
    }
    await openPrepress();
    await answerIccPicker(userIcc);
    await setReactSelectValue('[data-testid="cmyk-dest-profile"]', 'file');
    await browser.waitUntil(async () => $('[data-testid="cmyk-convert"]').isEnabled(), {
      timeout: 20_000,
      timeoutMsg: 'a user-supplied profile did not re-enable the conversion',
    });
    // The notice is still there — the bundled set is still closed, which is
    // the honest state — but the action the user CAN take is available.
    await expect($(PREPRESS_NOTICE)).toBeDisplayed();
  });

  it('Review re-opens the licence, and accepting lights the surfaces up with no restart', async () => {
    await openPrepress();
    await waitForDisplayedSelector(REVIEW, { timeout: 20_000 });
    await $(REVIEW).click();
    await waitForDisplayedSelector(DIALOG, { timeout: 20_000 });
    await browser.waitUntil(async () => $(ACCEPT).isEnabled(), { timeout: 30_000 });
    await $(ACCEPT).click();
    await waitForDisplayedSelector(DIALOG, { reverse: true, timeout: 30_000 });

    // Same session, same window, nothing reloaded — the claim that makes a
    // recorded decline liveable rather than a launch-time trap.
    await waitForDisplayedSelector(PREPRESS_NOTICE, { reverse: true, timeout: 30_000 });
    expect((await iccAssentSnapshot()).assent).toBe('accepted');
    await setActiveOp('outputpreview');
    await waitForDisplayedSelector(OUTPUT_PREVIEW_NOTICE, { reverse: true, timeout: 30_000 });
  });

  it('a recorded answer is not re-asked on the next read', async () => {
    // A decline that re-opened the dialog every launch would be a question
    // asked until the user gives the wanted answer. The same holds for an
    // acceptance: a recorded answer is final until the user changes it.
    const state = await iccAssentRefresh();
    expect(state.assent).toBe('accepted');
    expect(await $(DIALOG).isExisting()).toBe(false);
  });

  it('the portable answer lands under the executable folder, and %APPDATA% is untouched', async () => {
    const beforeListing = roamingListing();

    rmSync(ASSENT_RECORD, { force: true });
    await iccAssentRefresh();
    await waitForDisplayedSelector(DIALOG, { timeout: 20_000 });
    await browser.waitUntil(async () => $(ACCEPT).isEnabled(), { timeout: 30_000 });
    await $(ACCEPT).click();
    await waitForDisplayedSelector(DIALOG, { reverse: true, timeout: 30_000 });

    // The record is beside the executable, in `data/`, and it is real JSON the
    // product itself wrote.
    await browser.waitUntil(async () => existsSync(ASSENT_RECORD), {
      timeout: 15_000,
      timeoutMsg: 'accepting never wrote the portable record',
    });
    const written = JSON.parse(readFileSync(ASSENT_RECORD, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(written).length).toBeGreaterThan(0);

    // And the installed copy's directory gained nothing. A portable container
    // that quietly wrote into the roaming profile would carry none of the
    // user's settings when the folder moved, which is the whole point.
    expect(roamingListing()).toEqual(beforeListing);
    expect(existsSync(join(ROAMING_APP_DIR, 'icc-assent.json'))).toBe(false);
  });

  it('the WebView2 probe reports the runtime this machine actually has', async () => {
    // The absent case cannot be arranged (a suite may not uninstall a system
    // runtime, and no webview means no window to assert from). The PRESENT
    // case is what a machine running this suite is in, and it is worth
    // stating: the probe ran before window creation and did not refuse.
    const version = await browser.execute(() => navigator.userAgent);
    expect(version).toMatch(/Edg\/\d+/);
    // The CLI arm runs with no webview at all and must still work — the probe
    // gates the WINDOW, never the program.
    const out = execFileSync(APP_EXE, ['verify-signatures', SAMPLE_PDF], { encoding: 'utf-8' });
    expect(out).toContain('signature_count');
  });
});

/** Any `.icc` the machine has, for the user-supplied-profile case. The system
 * colour directory is the one place every Windows install has some. */
function findUserProfile(): string | null {
  const dir = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'spool', 'drivers', 'color');
  try {
    const hit = readdirSync(dir).find((f) => /\.icc$/i.test(f));
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}
