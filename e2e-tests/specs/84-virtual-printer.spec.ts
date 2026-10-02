import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from '@wdio/globals';
import { waitForHarness, invokeAppCommand, getState, saveActiveAs, requirePlatformFeatures } from '../support/harness.js';
import { APP_BINARY } from '../support/app-data.js';

// The virtual printer: the receiver's staging folder + Ghostscript distill +
// the open funnel. A job enters in the state the receiver leaves it in after
// reading it from the queue: a `Printed <seconds>-<key>.ps` file in the private
// staging folder. Reading from a real queue needs an installed printer, which
// is admin-gated UI (asserted as affordance only); the receiver's unit tests
// cover the spooler half against a fake spooler.

const APP_EXE = APP_BINARY;

let TMP = '';
let listenerReady = false;

function cliText(path: string): string {
  const out = execFileSync(APP_EXE, ['extract-text', path], { encoding: 'utf-8' });
  return (JSON.parse(out) as { text?: string }).text ?? '';
}

describe('virtual printer', () => {
  before(async function () {
    await requirePlatformFeatures(this, 'virtualPrinter');
  });

  before(async () => {
    TMP = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-vprint-'));
    await waitForHarness();
  });

  after(async () => {
    if (TMP && existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    try {
      await $('[data-testid="prefs-close"]').click();
    } catch {
      /* not open */
    }
  });

  it('Settings names the receiver state and offers the install affordance', async () => {
    expect(await invokeAppCommand('edit.preferences')).toBe(true);
    await $('[data-testid="virtual-printer-pref"]').waitForDisplayed({ timeout: 10_000 });
    const status = await $('[data-testid="virtual-printer-status"]');
    await status.waitForDisplayed({ timeout: 15_000 });
    const text = await status.getText();
    listenerReady = text.includes('ready to receive jobs');
    // One of the two lifecycle buttons is always offered; which one depends
    // on whether this machine has the printer installed.
    const install = await $('[data-testid="virtual-printer-install"]').isExisting();
    const remove = await $('[data-testid="virtual-printer-remove"]').isExisting();
    expect(install || remove).toBe(true);
    await $('[data-testid="prefs-close"]').click();
  });

  it('a staged PostScript job opens here as a PDF', async function () {
    if (!listenerReady) {
      // Another window of this account holds the receiver — the status said
      // so by name in the previous leg.
      this.skip();
      return;
    }
    const staging = await browser.execute(async () => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string) => Promise<{ staging: string }> };
      };
      return (await w.__TAURI_INTERNALS__.invoke('virtual_printer_status')).staging;
    });
    expect(/[\\/]virtual-printer[\\/]staging$/.test(staging)).toBe(true);
    const ps =
      '%!PS\n/Helvetica findfont 24 scalefont setfont\n72 700 moveto (VPRINT E2E) show\nshowpage\n';
    // The receiver skips a `.part` name, so it never takes a half-written job.
    const staged = resolve(staging, `Printed ${Math.floor(Date.now() / 1000)}-1.ps`);
    writeFileSync(`${staged}.part`, ps);
    renameSync(`${staged}.part`, staged);

    // The distilled PDF opens through the normal funnel: the printed file
    // becomes the ACTIVE document (never keyed on view alone — earlier specs
    // may already have left a document focused).
    await browser.waitUntil(
      async () => {
        const s = await getState();
        return s.view === 'canvas' && (s.activeFile?.name ?? '').startsWith('Printed ');
      },
      {
        timeout: 60_000,
        interval: 2_000,
        timeoutMsg: 'the printed job never opened as the active document',
      },
    );
    const dest = resolve(TMP, 'printed-check.pdf');
    await saveActiveAs(dest);
    expect(cliText(dest)).toContain('VPRINT E2E');
  });
});
