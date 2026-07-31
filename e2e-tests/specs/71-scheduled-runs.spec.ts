import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  invokeAppCommand,
  scheduleCreate,
  scheduleList,
  scheduleRemove,
} from '../support/harness.js';

// Phase 12, issue #1 request 5 — scheduled batch runs.
//
// The owner's ruling: scheduling is a GUI feature, not a documentation page,
// "so the user never has to touch task scheduler". So this spec asserts the
// LIFECYCLE through the app — create, list, delete — and then checks Windows
// itself, because the only thing that proves a schedule exists is Task
// Scheduler having it.
//
// These tests register REAL scheduled tasks under \Spectra PDF\. Every one
// is torn down in `after`, and the teardown runs schtasks directly so a failed
// assertion mid-test still cannot leave a task behind on the machine.

const SCANNED = resolve(__dirname, '..', 'fixtures', 'scanned.pdf');
const TASK_NAME = 'E2E Probe Run';

function taskExists(name: string): boolean {
  try {
    execFileSync('schtasks.exe', ['/Query', '/TN', `\\Spectra PDF\\${name}`], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function forceDelete(name: string): void {
  try {
    execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', `\\Spectra PDF\\${name}`], {
      stdio: 'pipe',
    });
  } catch {
    /* already gone */
  }
}

describe('scheduled batch runs (Phase 12 request 5)', () => {
  let tmp: string;
  let src: string;
  let dest: string;
  let logs: string;

  before(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-schedule-'));
    src = resolve(tmp, 'in');
    dest = resolve(tmp, 'out');
    logs = resolve(tmp, 'logs');
    mkdirSync(src, { recursive: true });
    copyFileSync(SCANNED, resolve(src, 'scan.pdf'));
  });

  after(() => {
    forceDelete(TASK_NAME);
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('opens from the Tools menu with no document open', async () => {
    await waitForHarness();
    // Same no-document shape as Batch OCR: it manages folder trees, so nothing
    // about it depends on what is open.
    expect(await invokeAppCommand('tools.scheduledRuns')).toBe(true);
    await $('[data-testid="schedule-dialog"]').waitForDisplayed({ timeout: 10_000 });
    await expect($('[data-testid="schedule-list-view"]')).toBeDisplayed();
  });

  it('creates a schedule that Windows Task Scheduler actually holds', async () => {
    forceDelete(TASK_NAME); // a previous failed run must not make this pass
    expect(taskExists(TASK_NAME)).toBe(false);

    await scheduleCreate({
      name: TASK_NAME,
      source: src,
      dest,
      lang: 'eng',
      logDir: logs,
      frequency: 'daily',
      time: '09:30',
    });

    // The assertion that matters: not that our UI says so, but that the OS has
    // it. A schedule the app believes in and Windows does not would never fire.
    expect(taskExists(TASK_NAME)).toBe(true);
  });

  it('lists it back, reading the settings off the task that will actually run', async () => {
    const runs = await scheduleList();
    const row = runs.find((r) => r.name === TASK_NAME);
    expect(row).toBeTruthy();
    expect(row!.nextRun).toContain('9:30');
    // There is no separate profile store: this comes from the command line
    // registered with Windows, so what is displayed is what will run.
    expect(row!.profile).toBeTruthy();
    expect(row!.profile!.source).toBe(src);
    expect(row!.profile!.dest).toBe(dest);
  });

  it('refuses a run under another account with no explicit log folder', async () => {
    // The owner's requirement: a service account resolves the default log
    // location inside ITS OWN profile, so the run would write its audit trail
    // where the person who set it up cannot find it. Refuse at registration
    // rather than register a task whose output nobody will ever see.
    let message = '';
    try {
      await scheduleCreate({
        name: 'E2E Should Not Exist',
        source: src,
        dest,
        account: 'CONTOSO\\svc_ocr$',
        logDir: '',
      });
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message.toLowerCase()).toContain('log folder');
    expect(taskExists('E2E Should Not Exist')).toBe(false);
  });

  it('refuses a name that could address a task outside our own folder', async () => {
    // The delete path is scoped to \Spectra PDF\; a name carrying a
    // separator is how that scoping would be escaped.
    let message = '';
    try {
      await scheduleCreate({ name: '..\\..\\Microsoft\\Windows\\Evil', source: src, dest });
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBeTruthy();
  });

  it('deletes it, and Windows no longer has it', async () => {
    await scheduleRemove(TASK_NAME);
    expect(taskExists(TASK_NAME)).toBe(false);
    const runs = await scheduleList();
    expect(runs.find((r) => r.name === TASK_NAME)).toBeUndefined();
    await $('[data-testid="schedule-close"]').click();
  });
});
