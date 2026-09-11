// The refuse → ask → re-run cycle as an owned run, rather than one resolver
// slot that the next caller overwrites.
//
// Pure: no React, no DOM, no network, no filesystem, no clock and no user
// strings. The coordinator knows three things — how to recognize the one
// refusal a question can answer, whether a run still owns what it was started
// for, and whether a given answer belongs to the question being answered.
// Everything an operation is about (its document, its parameters, its output)
// stays with the caller's `attempt` closure, so nothing here can redirect an
// operation to a different document.
//
// WHAT DISPOSAL DOES AND DOES NOT DO. Disposing or invalidating cancels the
// pending QUESTION. It does not and cannot cancel an engine operation already
// running: those bytes are being written whatever this object does, so a
// disposed run whose attempt SUCCEEDS still settles with its value, and a
// disposed run whose attempt fails for an unrelated reason still throws. What
// disposal suppresses is the prompting and the retry — an abandoned run never
// opens a question and never runs `attempt(true)`. Resolving early with a
// "nothing changed" answer would report a file as unwritten while it was
// being written.
//
// ONE ACTIVE RUN, NO QUEUE. A second run while one is active completes
// immediately as `CONSENT_BUSY`, and its attempt is never invoked. Overlap is
// refused rather than serialized: two runs started a beat apart can share an
// output path, and a queue would run the second one against a question the
// user answered about the first.

/** The user's answer was Cancel: the operation did not run and nothing changed. */
export const CONSENT_DECLINED = Symbol('encryption-consent-declined');

/** A run was already active, so this invocation did nothing at all — its
 * `attempt` was never called. Distinct from declining: nobody was asked. */
export const CONSENT_BUSY = Symbol('encryption-consent-busy');

/** The run stopped being owned — disposed, invalidated, or its own ownership
 * predicate went false — before it could start, ask or retry. No question was
 * put to the user and no consented attempt ran. Distinct from declining: an
 * answer was never collected, so this is not a decision anybody made. */
export const CONSENT_ABANDONED = Symbol('encryption-consent-abandoned');

export type ConsentOutcome =
  | typeof CONSENT_DECLINED
  | typeof CONSENT_BUSY
  | typeof CONSENT_ABANDONED;

/** The open question. `ticket` is unique for the lifetime of a coordinator and
 * is never reused, so an answer carrying a spent ticket is recognizably stale
 * rather than plausibly current. `subject` is whatever the caller handed in —
 * opaque here, and the only way a rendered question can name the document and
 * operation it is about. */
export interface ConsentPromptState {
  readonly ticket: number;
  readonly subject: unknown;
}

export interface ConsentRequest<T> {
  /** The operation. Called once without consent, and at most once more with
   * it. Both calls are the same closure, so the retry cannot target a
   * different document or output than the refusal was about. */
  readonly attempt: (dropEncryption: boolean) => Promise<T>;
  /** True while this run still owns what it was started for. Consulted three
   * times and never cached: at entry (before the operation runs at all),
   * after the refusal (before asking), and after the answer (before the
   * retry). An answer about a document the panel has moved off is not an
   * answer about the document it is now showing, and a request that is
   * already stale on arrival is not work to start.
   *
   * A predicate that THROWS is a caller defect, not an answer: the throw
   * propagates to `run`'s caller unchanged and the run is released, so one
   * broken predicate cannot wedge the coordinator busy forever. */
  readonly isCurrent: () => boolean;
  /** Carried onto the prompt state verbatim. */
  readonly subject?: unknown;
}

export interface EncryptionConsentCoordinator {
  /** Run `attempt` without consent; on the supplied refusal, ask and re-run
   * with the answer. Every other failure throws as it is. */
  readonly run: <T>(request: ConsentRequest<T>) => Promise<T | ConsentOutcome>;
  /** Answer the open question. Returns whether the answer was accepted: a
   * spent, unknown or superseded ticket settles nothing. */
  readonly answer: (ticket: number, proceed: boolean) => boolean;
  /** The open question, or null. */
  readonly prompt: () => ConsentPromptState | null;
  /** Notified on every change to the prompt state. Returns its own detach. */
  readonly subscribe: (listener: (prompt: ConsentPromptState | null) => void) => () => void;
  /** Abandon the active run's question. The coordinator stays usable: a run
   * settled this way frees it for the next one. */
  readonly invalidate: () => void;
  /** Terminal. Abandons the active run's question and refuses every later run
   * without invoking its attempt. */
  readonly dispose: () => void;
  readonly isBusy: () => boolean;
  readonly isDisposed: () => boolean;
}

/** A pending question's settlement. `null` means abandoned — nobody answered. */
type Settle = (proceed: boolean | null) => void;

interface ActiveRun {
  /** Set when the run stops being owned. Read after every await, because the
   * engine call it is waiting on cannot be recalled. */
  abandoned: boolean;
  /** The open question's ticket, or null when nothing is being asked. */
  ticket: number | null;
  settle: Settle | null;
}

/**
 * @param isConsentRefusal The EXACT predicate for the one refusal a question
 *   can answer. Nothing else may open a question: every other failure is
 *   rethrown untouched, including the refusals consent cannot answer.
 */
export function createEncryptionConsentCoordinator(
  isConsentRefusal: (error: unknown) => boolean,
): EncryptionConsentCoordinator {
  let disposed = false;
  let active: ActiveRun | null = null;
  let promptState: ConsentPromptState | null = null;
  // Monotonic and never reused, so no two questions in one coordinator's life
  // share an identity and a stale answer can never name a live question.
  let nextTicket = 1;
  const listeners = new Set<(prompt: ConsentPromptState | null) => void>();

  const publish = (next: ConsentPromptState | null): void => {
    if (promptState === null && next === null) return;
    promptState = next;
    for (const listener of [...listeners]) listener(next);
  };

  /** Take the question off a run, and settle it with `proceed` when it is
   * still pending. Closing the question is what disposal can do; the
   * operation underneath it is not this object's to stop. */
  const closeQuestion = (run: ActiveRun, proceed: boolean | null): void => {
    const settle = run.settle;
    run.ticket = null;
    run.settle = null;
    try { publish(null); }
    finally { if (settle !== null) settle(proceed); }
  };

  const abandon = (run: ActiveRun | null): void => {
    if (run === null) return;
    run.abandoned = true;
    if (run.settle !== null) closeQuestion(run, null);
  };

  const ask = (run: ActiveRun, subject: unknown): Promise<boolean | null> =>
    new Promise<boolean | null>((resolve) => {
      const ticket = nextTicket++;
      run.ticket = ticket;
      run.settle = resolve;
      publish({ ticket, subject });
    });

  const run = async <T,>(request: ConsentRequest<T>): Promise<T | ConsentOutcome> => {
    if (disposed) return CONSENT_ABANDONED;
    if (active !== null) return CONSENT_BUSY;
    const self: ActiveRun = { abandoned: false, ticket: null, settle: null };
    active = self;
    try {
      // BEFORE the operation, not only before the question. A request that is
      // already stale when it arrives is not work to start: running it would
      // write a file for a document the caller has moved off, and no later
      // check can unwrite it. Nothing has been invoked yet at this point, so
      // this is the one place cancellation is free.
      if (!request.isCurrent()) return CONSENT_ABANDONED;
      try {
        // The first attempt always runs WITHOUT consent: the engine is the
        // authority on whether this document needs the question asked.
        return await request.attempt(false);
      } catch (e: unknown) {
        if (!isConsentRefusal(e)) throw e;
        // The refusal can arrive after the run stopped being owned. A
        // question raised now would be a question about nothing, and its
        // answer would authorize work nobody asked for.
        if (self.abandoned || disposed || !request.isCurrent()) return CONSENT_ABANDONED;
        const proceed = await ask(self, request.subject);
        if (proceed === null) return CONSENT_ABANDONED;
        if (!proceed) return CONSENT_DECLINED;
        // Asked again after the answer: consent was given for what this run
        // owned, and ownership can have moved while the question was open.
        if (self.abandoned || disposed || !request.isCurrent()) return CONSENT_ABANDONED;
        return await request.attempt(true);
      }
    } finally {
      // The run is over however it ended, so the next one is free to start.
      // A question cannot still be pending here — the branch that opens one
      // awaits it — but it is cleared rather than assumed away.
      try { if (self.ticket !== null) closeQuestion(self, null); }
      finally { if (active === self) active = null; }
    }
  };

  return {
    run,
    answer: (ticket: number, proceed: boolean): boolean => {
      const current = active;
      if (current === null || current.settle === null || current.ticket !== ticket) return false;
      closeQuestion(current, proceed);
      return true;
    },
    prompt: () => promptState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    invalidate: () => { abandon(active); },
    dispose: () => {
      disposed = true;
      abandon(active);
      listeners.clear();
    },
    isBusy: () => active !== null,
    isDisposed: () => disposed,
  };
}
