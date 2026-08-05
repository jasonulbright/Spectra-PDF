import { resolve } from 'node:path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  invokeAppCommand,
  scheduleCreate,
  scheduleList,
  scheduleRemove,
  setReactInputValue,
  setReactSelectValue,
} from '../support/harness.js';

// Schedule a saved action (run_action was built engine-side FOR this).
// A scheduled action = the Task
// Scheduler lifecycle + a FROZEN copy of the action in this app's
// machine-scoped ProgramData folder: a task must not depend on the GUI's
// localStorage (wrong profile under a service account, and it fires with the
// app closed). Real tasks are registered under \Spectra PDF\ and torn
// down in `after` with schtasks directly, so a failed assertion cannot leave
// one behind.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const TASK_NAME = 'E2E Action Schedule';
const FROZEN = resolve(
  process.env.ProgramData ?? 'C:\\ProgramData',
  'Spectra PDF',
  'scheduled-actions',
  `${TASK_NAME}.json`,
);

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

describe('scheduled guided actions', () => {
  let tmp: string;
  let src: string;
  let dest: string;
  let logs: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-sched-action-'));
    src = resolve(tmp, 'in');
    dest = resolve(tmp, 'out');
    logs = resolve(tmp, 'logs');
    mkdirSync(src, { recursive: true });
    copyFileSync(SAMPLE_PDF, resolve(src, 'doc.pdf'));

    await waitForHarness();
    // Seed the action library BEFORE the dialog mounts (it reads at mount):
    // one schedulable action, one that asks at run time (must refuse).
    await browser.execute(() => {
      localStorage.setItem(
        'guided-actions',
        JSON.stringify([
          { id: 'seed-strip', name: 'Nightly Strip', steps: [{ op: 'strip_metadata', params: {} }] },
          {
            id: 'seed-asks',
            name: 'Asks At Run',
            steps: [{ op: 'watermark', params: { text: '', opacity: 0.15, angle: 45 }, ask: ['text'] }],
          },
        ]),
      );
    });
    expect(await invokeAppCommand('tools.scheduledRuns')).toBe(true);
    await $('[data-testid="schedule-dialog"]').waitForDisplayed({ timeout: 10_000 });
  });

  after(async () => {
    forceDelete(TASK_NAME);
    try {
      rmSync(FROZEN, { force: true });
    } catch {
      /* fine */
    }
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    await browser.execute(() => localStorage.removeItem('guided-actions'));
    try {
      await $('[data-testid="schedule-close"]').click();
    } catch {
      /* dialog already closed */
    }
  });

  it('registers an action schedule Windows holds, freezing the action to a machine-scoped file', async () => {
    forceDelete(TASK_NAME);
    expect(taskExists(TASK_NAME)).toBe(false);

    const actionJson = JSON.stringify(
      { name: 'Nightly Strip', steps: [{ op: 'strip_metadata', params: {} }] },
      null,
      2,
    );
    await scheduleCreate(
      {
        name: TASK_NAME,
        source: src,
        dest,
        logDir: logs,
        frequency: 'daily',
        time: '03:00',
        runType: 'action',
      },
      actionJson,
    );

    // The OS has it — the only proof a schedule exists.
    expect(taskExists(TASK_NAME)).toBe(true);
    // The frozen copy is machine-scoped (readable by whatever account the
    // task runs as) and carries exactly the sanitized shape we handed over.
    expect(existsSync(FROZEN)).toBe(true);
    const frozen = JSON.parse(readFileSync(FROZEN, 'utf-8')) as {
      name: string;
      steps: { op: string }[];
    };
    expect(frozen.name).toBe('Nightly Strip');
    expect(frozen.steps.map((s) => s.op)).toEqual(['strip_metadata']);

    // The list reads the run-action command line back off the task itself.
    const row = (await scheduleList()).find((r) => r.name === TASK_NAME);
    expect(row).toBeTruthy();
    expect(row!.profile?.runType).toBe('action');
    expect(row!.profile?.actionFile).toBe(FROZEN);
    expect(row!.actionName).toBe('Nightly Strip');
    expect(row!.actionSteps).toEqual(['strip_metadata']);
    expect(row!.actionMissing).toBe(false);
  });

  it('the dialog shows the action row; ask-at-run actions refuse to schedule BY NAME', async () => {
    // Remount so the list refreshes (the harness create bypassed the form).
    await $('[data-testid="schedule-x"]').click();
    expect(await invokeAppCommand('tools.scheduledRuns')).toBe(true);
    await $(`[data-testid="schedule-row-${TASK_NAME}"]`).waitForDisplayed({ timeout: 10_000 });
    const info = await $(`[data-testid="schedule-action-info-${TASK_NAME}"]`);
    await info.waitForDisplayed();
    expect(await info.getText()).toContain('Nightly Strip');

    // The refusal is client-side and needs no folder pickers: pick the
    // ask-at-run action, try to save, read the named refusal.
    await $('[data-testid="schedule-new"]').click();
    await $('[data-testid="schedule-form"]').waitForDisplayed();
    await setReactInputValue('[data-testid="schedule-name"]', 'E2E Should Not Register');
    await setReactSelectValue('[data-testid="schedule-runtype"]', 'action');
    await $('[data-testid="schedule-action"]').waitForDisplayed();
    await setReactSelectValue('[data-testid="schedule-action"]', 'seed-asks');
    await $('[data-testid="schedule-save"]').click();
    const err = await $('[data-testid="schedule-form-error"]');
    await err.waitForDisplayed({ timeoutMsg: 'the ask-at-run action was not refused' });
    expect(await err.getText()).toMatch(/asks for values when it runs/);
    expect(taskExists('E2E Should Not Register')).toBe(false);
    await $('button=Cancel').click();
    await $('[data-testid="schedule-list-view"]').waitForDisplayed();
  });

  it('run-now fires the real CLI through Task Scheduler: mirror and action-run log appear', async () => {
    execFileSync('schtasks.exe', ['/Run', '/TN', `\\Spectra PDF\\${TASK_NAME}`], {
      stdio: 'pipe',
    });
    // The task invokes `spectrapdf run-action … --action <frozen>` with
    // the app CLOSED from the run's point of view — the mirror file and the
    // run log are the proof the whole marriage works headlessly.
    await browser.waitUntil(() => existsSync(resolve(dest, 'doc.pdf')), {
      timeout: 90_000,
      interval: 2_000,
      timeoutMsg: 'the scheduled action run never produced its mirror output',
    });
    await browser.waitUntil(
      () => existsSync(logs) && readdirSync(logs).some((f) => f.startsWith('action-run-')),
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: 'the scheduled action run never wrote its log',
      },
    );
    const logName = readdirSync(logs).find((f) => f.startsWith('action-run-'))!;
    const body = readFileSync(resolve(logs, logName), 'utf-8');
    expect(body).toContain('Nightly Strip');
    expect(body).toContain('1 processed');
  });

  it('deleting removes the task AND its frozen action file', async () => {
    await scheduleRemove(TASK_NAME);
    expect(taskExists(TASK_NAME)).toBe(false);
    expect(existsSync(FROZEN)).toBe(false);
    const runs = await scheduleList();
    expect(runs.find((r) => r.name === TASK_NAME)).toBeUndefined();
  });
});
