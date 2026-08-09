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

// Scheduled batch runs. This spec asserts the lifecycle through the app —
// create, list, and delete — and then checks Windows
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

describe('scheduled batch runs', () => {
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
    // Every task this spec can register, whether or not its test reached the
    // delete — a failed assertion must not leave one on the machine.
    for (const name of [TASK_NAME, 'E2E Preset Run', 'E2E InPlace Run', 'E2E Contradiction']) {
      forceDelete(name);
    }
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

  // A named Batch OCR preset is EXPANDED into the task's command line at
  // scheduling time, because the task fires with the app closed and cannot
  // read the store a preset lives in. So the proof is that every setting
  // survives registration and reads back off the registered task — a setting
  // that did not would make the schedule run a quietly different job.
  it('carries a preset’s page-image settings into the task and reads them back', async () => {
    const name = 'E2E Preset Run';
    forceDelete(name);
    await scheduleCreate({
      name,
      source: src,
      dest,
      lang: 'eng+fra',
      logDir: logs,
      frequency: 'daily',
      time: '02:15',
      enhance: true,
      enhanceOrientation: false,
      mrc: true,
      mrcPreset: 'smallest',
      mrcVerifyText: true,
    });
    expect(taskExists(name)).toBe(true);

    const row = (await scheduleList()).find((r) => r.name === name);
    expect(row?.profile).toBeTruthy();
    expect(row!.profile!.lang).toBe('eng+fra');
    expect(row!.profile!.enhance).toBe(true);
    // The orientation half defaults ON, so the off case is the one that has to
    // survive — a round trip that lost it would silently turn it back on.
    expect(row!.profile!.enhanceOrientation).toBe(false);
    expect(row!.profile!.mrc).toBe(true);
    expect(row!.profile!.mrcPreset).toBe('smallest');
    expect(row!.profile!.mrcVerifyText).toBe(true);

    await scheduleRemove(name);
    expect(taskExists(name)).toBe(false);
  });

  // An in-place schedule has no destination by construction. Its own test
  // because the readback used to require one, so an in-place task would have
  // listed as unreadable.
  it('registers an in-place schedule with no destination and lists it', async () => {
    const name = 'E2E InPlace Run';
    forceDelete(name);
    const inPlaceSrc = resolve(tmp, 'inplace');
    mkdirSync(inPlaceSrc, { recursive: true });
    copyFileSync(SCANNED, resolve(inPlaceSrc, 'scan.pdf'));

    await scheduleCreate({
      name,
      source: inPlaceSrc,
      dest: '',
      inPlace: true,
      logDir: logs,
      frequency: 'daily',
      time: '04:00',
    });
    expect(taskExists(name)).toBe(true);

    const row = (await scheduleList()).find((r) => r.name === name);
    expect(row?.profile).toBeTruthy();
    expect(row!.profile!.inPlace).toBe(true);
    expect(row!.profile!.dest).toBe('');

    await scheduleRemove(name);
    expect(taskExists(name)).toBe(false);
  });

  it('refuses an in-place schedule that also names a destination', async () => {
    // In place, the processed file IS the original — a destination names a
    // mirror that is never written, so registering it would describe a run
    // that cannot happen.
    let message = '';
    try {
      await scheduleCreate({
        name: 'E2E Contradiction',
        source: src,
        dest,
        inPlace: true,
      });
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message.toLowerCase()).toContain('in-place');
    expect(taskExists('E2E Contradiction')).toBe(false);
  });

  it('refuses a run under another account with no explicit log folder', async () => {
    // A service account resolves the default log location inside its own
    // profile, so the run would write its audit trail
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
