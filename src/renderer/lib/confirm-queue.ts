// Requests for the one confirm dialog of a window, shown in the order they were
// made.
//
// The dialog shows one request at a time. A request made while another is open
// waits for it: replacing the open one would leave its caller awaiting an
// answer that never comes, and most callers await it.

export interface ConfirmQueue<R extends { id: number }> {
  /** Queue a request. It shows at once when nothing else is open. */
  push(request: R): void;
  /**
   * Close the open request if it is `id`, show the next one, and return the
   * closed request so its caller can be answered. Anything else returns
   * undefined: one gesture can report its answer twice (Escape closes the
   * dialog AND reports a dismissal), and the second report must not answer
   * the request shown after it.
   */
  answer(id: number): R | undefined;
}

export function createConfirmQueue<R extends { id: number }>(
  show: (head: R | null) => void,
): ConfirmQueue<R> {
  const pending: R[] = [];
  return {
    push(request) {
      pending.push(request);
      if (pending.length === 1) show(request);
    },
    answer(id) {
      if (pending.length === 0 || pending[0].id !== id) return undefined;
      const done = pending.shift();
      show(pending[0] ?? null);
      return done;
    },
  };
}
