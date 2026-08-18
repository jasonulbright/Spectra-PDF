// The ordering a window must keep when it is asked to close.
//
// Two facts collide here. A quit SEALS the session record and the seal takes
// whatever tab order arrived last, so a window that has an order still in
// flight must finish publishing it before it answers. And a quit is
// fail-closed: it waits a bounded time for every peer's receipt and ABORTS
// when one does not arrive, so nothing closes behind a window that never
// heard the question.
//
// Put together they give one ordering: FLUSH, then acknowledge. Only the
// sealing window used to flush, which left a reorder made in another window
// sealed over — the recorded seam. Flushing before the receipt closes it
// inside the abort bound the quit already enforces: a flush that never
// resolves withholds the receipt, the quit aborts, and nothing closes. That
// is the fail-closed outcome, not a wedge.
//
// What must NOT move ahead of the receipt is a DIALOG. The unsaved-work
// prompt can take minutes, and a receipt queued behind it reads to the quit
// as a dead renderer. The flush is bounded by the publisher's own in-flight
// work, which is why it is the one thing allowed in front.
//
// DOM-free and dependency-injected: the ordering is the invariant, and an
// invariant living inside a listener callback is an invariant with no test.

export interface CloseSequenceDeps {
  /** Finish publishing this window's tab order; false when it did not land. */
  flush: () => Promise<boolean>;
  /** Tell the waiting quit this window heard it. */
  ack: (quitId: number) => Promise<unknown>;
}

/**
 * The prologue of every close request — run before anything that can show a
 * dialog. Returns whether this window may go on and close.
 *
 * `quitId` is null when the close is a plain window ×, where there is no quit
 * waiting and nothing to acknowledge; the flush still runs, because the last
 * window closing seals the record by that route too, and the window closes
 * whatever the flush reports — refusing a × over a stale tab order would make
 * the button do nothing at all.
 *
 * A flush that reports the order did NOT land withholds the receipt instead.
 * Acknowledging over it hands the quit a receipt for an order that never
 * arrived, and the quit would then seal a record this window has already
 * superseded. Withholding costs the quit its own bounded wait and then an
 * abort: nothing closes, which is the fail-closed outcome.
 *
 * A failed acknowledgement is swallowed: the quit's own timeout is the
 * authority on an unanswered request, and a rejected invoke here would abort
 * the close flow of a window that is closing anyway.
 */
export async function sealBeforeClose(
  quitId: number | null,
  deps: CloseSequenceDeps,
): Promise<boolean> {
  const landed = await deps.flush();
  if (quitId === null) return true;
  if (!landed) return false;
  try {
    await deps.ack(quitId);
  } catch {
    /* the quit's timeout decides; a lost receipt must not stop this close */
  }
  return true;
}
