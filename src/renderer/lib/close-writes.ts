// The last window's close while engine writes are running.
//
// The engine workers end with the app, so the last window does not close over
// a write in flight: it stays, says what is running, and closes by itself when
// the writes finish. The user can quit anyway, which stops them, or keep the
// app open.

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
 * write that started meanwhile is asked about too.
 */
export async function closeThroughWrites(
  close: (force: boolean) => Promise<CloseOutcome>,
  waitForWrites: () => Promise<WriteWait>,
): Promise<GatedClose> {
  let force = false;
  for (;;) {
    const outcome = await close(force);
    if (outcome !== 'writing') return outcome;
    const choice = await waitForWrites();
    if (choice === 'stay') return 'stayed';
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
