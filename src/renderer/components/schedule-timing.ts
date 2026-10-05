// Task Scheduler reports "Last Result" as a decimal HRESULT. The SCHED_S_*
// values are informational, not outcomes of a run.
const SCHED_S_TASK_READY = 0x41300;
const SCHED_S_TASK_RUNNING = 0x41301;
const SCHED_S_TASK_DISABLED = 0x41302;
const SCHED_S_TASK_HAS_NOT_RUN = 0x41303;
const SCHED_S_TASK_NO_MORE_RUNS = 0x41304;

const NOT_A_FAILURE = new Set([
  0,
  SCHED_S_TASK_READY,
  SCHED_S_TASK_RUNNING,
  SCHED_S_TASK_DISABLED,
  SCHED_S_TASK_NO_MORE_RUNS,
]);

export interface LastRunView {
  /** False when the task has never run; its "Last Run Time" is then a
   * placeholder date (30 November 1999), not a run. */
  ran: boolean;
  /** The result code to show, only when the last run failed. */
  failureCode: string | null;
}

export function lastRunView(lastRun: string, lastResult: string): LastRunView {
  const raw = lastResult.trim();
  const ranText = lastRun.trim() !== '';
  if (!/^-?\d+$/.test(raw)) return { ran: ranText, failureCode: null };
  const code = Number(raw);
  if (code === SCHED_S_TASK_HAS_NOT_RUN) return { ran: false, failureCode: null };
  return { ran: ranText, failureCode: NOT_A_FAILURE.has(code) ? null : raw };
}
