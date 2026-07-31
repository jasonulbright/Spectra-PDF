import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, getState, invokeAppCommand } from '../support/harness.js';

// File ▸ Send To ▸ Email (owner-ruled in scope 2026-07-31). The STAGING half
// is fully machine-independent and is proven end-to-end: a copy of the
// working file lands in the send-to scratch under the document's REAL name,
// byte-identical to the working state, and a second send never overwrites a
// copy an open compose window might still be reading. The MAPI LAUNCH half
// is machine-dependent (it opens a real compose window when a mail client is
// registered), so the full command path — menu command → commit gate →
// stage → registry check → visible refusal — is exercised ONLY on boxes
// with NO registered client, where it deterministically refuses.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

let SCRATCH = '';
const STAGED: string[] = [];

function hasDefaultMailClient(): boolean {
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = execFileSync('reg.exe', ['query', `${hive}\\SOFTWARE\\Clients\\Mail`, '/ve'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      // The default value line shows REG_SZ + the client name when set; an
      // UNSET default still prints REG_SZ followed by "(value not set)".
      const m = out.match(/REG_SZ\s+(.+)/);
      if (m && m[1].trim() && !/\(value not set\)/i.test(m[1])) return true;
    } catch {
      /* hive/key missing — no client there */
    }
  }
  return false;
}

async function stage(): Promise<string> {
  return (await browser.executeAsync(function (done: (r: string) => void) {
    (window as any).__SPECTRA_TEST__
      .sendToEmailStage()
      .then((p: string) => done(p))
      .catch((e: unknown) => done(`ERROR:${String(e)}`));
  })) as string;
}

describe('File ▸ Send To ▸ Email (slice: send-to)', () => {
  before(async () => {
    SCRATCH = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-sendto-'));
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
  });

  after(async () => {
    // Exact names only (the glob-delete ban): the two staged copies this spec
    // recorded, plus the refusal leg's third copy if that leg ran.
    const targets = [...STAGED];
    if (STAGED.length > 0) targets.push(resolve(dirname(STAGED[0]), 'sample (3).pdf'));
    for (const p of targets) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* held open — the app's own age sweep will get it */
      }
    }
    if (SCRATCH && existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('stages a byte-identical copy under the document\'s real name', async () => {
    const staged = await stage();
    expect(staged.startsWith('ERROR:')).toBe(false);
    STAGED.push(staged);
    expect(existsSync(staged)).toBe(true);
    expect(basename(staged)).toBe('sample.pdf');
    expect(dirname(staged).replace(/\\/g, '/')).toContain('spectrapdf/send-to');

    // Byte-identical to the CURRENT working state (same source the harness
    // save writes).
    const savedCopy = resolve(SCRATCH, 'working-state.pdf');
    await browser.executeAsync(function (d: string, done: (r: string | null) => void) {
      (window as any).__SPECTRA_TEST__
        .saveActiveAs(d)
        .then(() => done(null))
        .catch((e: unknown) => done(String(e)));
    }, savedCopy);
    expect(readFileSync(staged).equals(readFileSync(savedCopy))).toBe(true);
  });

  it('a second send stages a NEW copy — never overwrites one a compose window may hold', async () => {
    const second = await stage();
    expect(second.startsWith('ERROR:')).toBe(false);
    STAGED.push(second);
    expect(basename(second)).toBe('sample (2).pdf');
    expect(readFileSync(second).equals(readFileSync(STAGED[0]))).toBe(true);
  });

  it('with no mail client registered, the real command refuses VISIBLY (machine-gated leg)', async function () {
    if (hasDefaultMailClient()) {
      // A registered client would open a real compose window — the refusal
      // path does not exist on this box. The staging halves above still ran.
      this.skip();
      return;
    }
    expect(await invokeAppCommand('file.sendToEmail')).toBe(true);
    const msg = await $('[data-testid="confirm-message"]');
    await msg.waitForDisplayed({ timeout: 15_000, timeoutMsg: 'no visible refusal appeared' });
    expect(await msg.getText()).toContain('No desktop email app');
    await $('[data-testid="notice-ok"]').click();
  });
});
