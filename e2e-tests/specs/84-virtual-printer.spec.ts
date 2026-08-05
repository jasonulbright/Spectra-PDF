import { createConnection } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from '@wdio/globals';
import { waitForHarness, invokeAppCommand, getState, saveActiveAs } from '../support/harness.js';

// The virtual printer: the loopback RAW listener + Ghostscript distill
// + the open funnel, driven exactly the way the Windows spooler drives it —
// a TCP stream of PostScript at 127.0.0.1:9100. No printer install needed
// for this path (that half is admin-gated UI, asserted as affordance only),
// so the whole conversion chain is exercised for real.

const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');

let TMP = '';
let listenerReady = false;

function cliText(path: string): string {
  const out = execFileSync(APP_EXE, ['extract-text', path], { encoding: 'utf-8' });
  return (JSON.parse(out) as { text?: string }).text ?? '';
}

describe('virtual printer', () => {
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

  it('a raw PostScript job streamed at the port opens here as a PDF', async function () {
    if (!listenerReady) {
      // Port 9100 is held by something else on this machine — the listener
      // said so by name in the previous leg; the conversion chain cannot be
      // exercised through a foreign socket.
      this.skip();
      return;
    }
    const ps =
      '%!PS\n/Helvetica findfont 24 scalefont setfont\n72 700 moveto (VPRINT E2E) show\nshowpage\n';
    await new Promise<void>((resolvePromise, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port: 9100 }, () => {
        sock.end(ps, () => resolvePromise());
      });
      sock.on('error', reject);
    });

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
