// A close while writes are running.
//
// The engine workers end with the app, so the last window does not close over
// a write in flight: it stays, says what is running, and closes by itself when
// the writes finish. The user can quit anyway, which stops them, or keep the
// app open.
//
// A document closes the same way over the writes recorded for it in this
// window: the close waits for them, then asks about unsaved changes in the
// bytes they produced, then closes. The user can close now, which drops the
// result of a write still running, or keep the document.
import { documentWritesOf, onDocumentWritesChange } from './document-writes';

/** What one close request did (Rust `commands::CloseOutcome`). */
export type CloseOutcome = 'closed' | 'aborted' | 'writing';

/** How a wait on running writes ended. */
export type WriteWait = 'drained' | 'quit' | 'stay';

/** What a gated close did in the end. */
export type GatedClose = 'closed' | 'aborted' | 'stayed';

/**
 * Close through the write gate. `close(force)` asks Rust to close this
 * window; `waitForWrites` shows the running writes and resolves when they
 * finish or the user chooses. A finished wait asks again without force, so a
 * write that started meanwhile is asked about too. `cancelled()`, when given,
 * is read after each wait and before the next close: a gesture refused
 * because the window's documents are closing returns `refused` and the
 * window is not asked to close again.
 */
export async function closeThroughWrites(
  close: (force: boolean) => Promise<CloseOutcome>,
  waitForWrites: () => Promise<WriteWait>,
): Promise<GatedClose>;
export async function closeThroughWrites(
  close: (force: boolean) => Promise<CloseOutcome>,
  waitForWrites: () => Promise<WriteWait>,
  cancelled: () => boolean,
): Promise<GatedClose | 'refused'>;
export async function closeThroughWrites(
  close: (force: boolean) => Promise<CloseOutcome>,
  waitForWrites: () => Promise<WriteWait>,
  cancelled: () => boolean = () => false,
): Promise<GatedClose | 'refused'> {
  let force = false;
  for (;;) {
    const outcome = await close(force);
    if (outcome !== 'writing') return outcome;
    const choice = await waitForWrites();
    if (choice === 'stay') return 'stayed';
    if (cancelled()) return 'refused';
    force = choice === 'quit';
  }
}

export interface WriteWaitDeps {
  /** Show the choice; resolves true for Quit Anyway, false for Cancel. */
  ask: () => Promise<boolean>;
  /** Withdraw the choice when the writes finished first. */
  withdraw: () => void;
  /** Subscribe to the count of writes in flight. */
  listen: (onCount: (count: number) => void) => Promise<() => void>;
  /** The count now, for a finish that landed before the subscription. */
  current: () => Promise<number>;
}

/**
 * Close request `id` if it is the one on screen; otherwise remove it from the
 * queue unanswered, so it never shows. Another request is never touched.
 */
export function withdrawRequest(
  queue: { answer(id: number): unknown; drop?(id: number): unknown },
  id: number,
): void {
  if (queue.answer(id) === undefined) queue.drop?.(id);
}

/** Wait for running writes or for the user's choice, whichever comes first. */
export function waitForWrites(deps: WriteWaitDeps): Promise<WriteWait> {
  return new Promise((resolve) => {
    let settled = false;
    let stop: (() => void) | undefined;
    const finish = (result: WriteWait): void => {
      if (settled) return;
      settled = true;
      stop?.();
      resolve(result);
    };
    const drained = (): void => {
      if (settled) return;
      deps.withdraw();
      finish('drained');
    };
    void deps.ask().then((quit) => finish(quit ? 'quit' : 'stay'));
    void deps.listen((count) => {
      if (count === 0) drained();
    }).then((unlisten) => {
      if (settled) unlisten();
      else stop = unlisten;
      return deps.current();
    }).then((count) => {
      if (count === 0) drained();
    }, () => {});
  });
}

/** Wait for the writes recorded for `workingPaths` or for the user's choice,
 * whichever comes first: `ask` shows the choice and resolves true for Close
 * Now, false for Cancel; `withdraw` removes it when the writes finished first. */
export function waitForDocumentWrites(
  workingPaths: readonly string[],
  ask: () => Promise<boolean>,
  withdraw: () => void,
): Promise<WriteWait> {
  return waitForWrites({
    ask,
    withdraw,
    listen: async (onCount) => onDocumentWritesChange(() => onCount(documentWritesOf(workingPaths))),
    current: async () => documentWritesOf(workingPaths),
  });
}

/** Whether a close of documents goes on: `go`, `stayed` when the user kept
 * them, `refused` when a gesture on one of them was refused during the close. */
export type CloseReadiness = 'go' | 'stayed' | 'refused';

export interface CloseSteps {
  /** Writes recorded for the documents now. */
  pending: () => number;
  /** The wait for those writes. */
  wait: () => Promise<WriteWait>;
  /** The unsaved-changes prompt; false keeps the documents. */
  confirm: () => Promise<boolean>;
}

/**
 * The steps before documents close: wait for their recorded writes when
 * there are any, then ask about unsaved changes, so the prompt sees the bytes
 * those writes produced. `cancelled()` reports a gesture refused because the
 * documents are closing; it is read after each step that awaits the user or a
 * write, and the caller closes synchronously after `go`.
 */
export async function readyToClose(cancelled: () => boolean, steps: CloseSteps): Promise<CloseReadiness> {
  if (steps.pending() > 0 && (await steps.wait()) === 'stay') return 'stayed';
  if (cancelled()) return 'refused';
  if (!(await steps.confirm())) return 'stayed';
  if (cancelled()) return 'refused';
  return 'go';
}

/**
 * Close documents that a prompt already covered, once no write recorded for
 * them is running. A write that finished during the wait changed their
 * bytes, so `steps.confirm` asks again before the next look; Close Now goes
 * on with the write still running, and Cancel keeps everything.
 * `cancelled()` reports a gesture refused because the documents are closing;
 * it is read after each wait and each prompt and before `close`, and a
 * refusal returns `refused` without closing.
 */
export async function closeOverDocumentWrites(
  cancelled: () => boolean,
  steps: CloseSteps,
  close: () => Promise<GatedClose | 'refused'>,
): Promise<GatedClose | 'refused'> {
  while (steps.pending() > 0) {
    const waited = await steps.wait();
    if (waited === 'stay') return 'stayed';
    if (cancelled()) return 'refused';
    if (waited === 'quit') break;
    if (!(await steps.confirm())) return 'stayed';
    if (cancelled()) return 'refused';
  }
  if (cancelled()) return 'refused';
  return close();
}

/**
 * The close of a window whose documents are leaving: the wait for their
 * recorded writes (`closeOverDocumentWrites`), then the engine-write gate
 * (`closeThroughWrites`), both reading the one `cancelled()` of the leave.
 * A refusal in any wait keeps the window, calls `refused` once, and returns
 * `stayed`.
 */
export async function closeLeavingDocuments(
  cancelled: () => boolean,
  steps: CloseSteps,
  close: (force: boolean) => Promise<CloseOutcome>,
  waitForWrites: () => Promise<WriteWait>,
  refused: () => void,
): Promise<GatedClose> {
  const outcome = await closeOverDocumentWrites(
    cancelled,
    steps,
    () => closeThroughWrites(close, waitForWrites, cancelled),
  );
  if (outcome !== 'refused') return outcome;
  refused();
  return 'stayed';
}
