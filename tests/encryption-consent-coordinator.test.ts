// The consent coordinator's lifetime, pinned. Every case here is a shape the
// hook must handle: overlap, a stale answer, disposal
// before the refusal lands, disposal while the question is open, ownership
// moving between the answer and the retry.
//
// The engine is a deferred promise in every case, so nothing depends on
// timing: a test settles the operation exactly when it wants to.
import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_ABANDONED,
  CONSENT_BUSY,
  CONSENT_DECLINED,
  createEncryptionConsentCoordinator,
  type ConsentPromptState,
} from '../src/renderer/lib/encryption-consent-coordinator';

/** The one refusal a question may answer. Identity, not a pattern: the point
 * of the supplied predicate is that nothing else can open a question. */
const REFUSAL = { consentable: true };
const isConsentRefusal = (e: unknown): boolean => e === REFUSAL;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every already-resolved microtask drain. */
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/** A request whose attempts are handed back as deferreds in call order. */
function recorder(options?: { current?: () => boolean; subject?: unknown }) {
  const calls: boolean[] = [];
  const pending: Deferred<string>[] = [];
  return {
    calls,
    pending,
    request: {
      attempt: (dropEncryption: boolean): Promise<string> => {
        calls.push(dropEncryption);
        const d = deferred<string>();
        pending.push(d);
        return d.promise;
      },
      isCurrent: options?.current ?? ((): boolean => true),
      subject: options?.subject,
    },
  };
}

describe('createEncryptionConsentCoordinator: ordinary completion', () => {
  it('runs once without consent and returns the value, asking nothing', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    expect(r.calls).toEqual([false]);
    expect(c.prompt()).toBeNull();
    r.pending[0].resolve('ok');
    expect(await done).toBe('ok');
    expect(r.calls).toEqual([false]);
    expect(c.isBusy()).toBe(false);
  });

  it('asks on the supplied refusal and re-runs WITH consent on proceed', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ subject: { doc: 'a', op: 'grayscale' } });
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    const prompt = c.prompt();
    expect(prompt).not.toBeNull();
    expect(prompt?.subject).toEqual({ doc: 'a', op: 'grayscale' });
    expect(c.answer((prompt as ConsentPromptState).ticket, true)).toBe(true);
    await tick();
    expect(r.calls).toEqual([false, true]);
    r.pending[1].resolve('written');
    expect(await done).toBe('written');
    expect(c.prompt()).toBeNull();
  });

  it('declines on cancel and never runs the consented attempt', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    expect(c.answer((c.prompt() as ConsentPromptState).ticket, false)).toBe(true);
    expect(await done).toBe(CONSENT_DECLINED);
    expect(r.calls).toEqual([false]);
    expect(c.prompt()).toBeNull();
  });

  it('is reusable after an ordinary completion, with a fresh ticket', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const first = recorder();
    const firstDone = c.run(first.request);
    await tick();
    first.pending[0].reject(REFUSAL);
    await tick();
    const firstTicket = (c.prompt() as ConsentPromptState).ticket;
    c.answer(firstTicket, false);
    expect(await firstDone).toBe(CONSENT_DECLINED);

    const second = recorder();
    const secondDone = c.run(second.request);
    await tick();
    second.pending[0].reject(REFUSAL);
    await tick();
    const secondTicket = (c.prompt() as ConsentPromptState).ticket;
    expect(secondTicket).toBeGreaterThan(firstTicket);
    c.answer(secondTicket, true);
    await tick();
    second.pending[1].resolve('again');
    expect(await secondDone).toBe('again');
  });
});

describe('createEncryptionConsentCoordinator: error propagation', () => {
  it('rethrows a failure the predicate does not recognize, asking nothing', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    const other = new Error('disk full');
    r.pending[0].reject(other);
    await expect(done).rejects.toBe(other);
    expect(c.prompt()).toBeNull();
    expect(r.calls).toEqual([false]);
    expect(c.isBusy()).toBe(false);
  });

  it('rethrows a near-miss refusal: only the exact predicate opens a question', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    const lookalike = { consentable: true };
    r.pending[0].reject(lookalike);
    await expect(done).rejects.toBe(lookalike);
    expect(c.prompt()).toBeNull();
  });

  it('propagates a failure of the CONSENTED attempt', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    c.answer((c.prompt() as ConsentPromptState).ticket, true);
    await tick();
    const boom = new Error('ghostscript exited 1');
    r.pending[1].reject(boom);
    await expect(done).rejects.toBe(boom);
    expect(c.isBusy()).toBe(false);
  });
});

describe('createEncryptionConsentCoordinator: overlap', () => {
  it('completes a second invocation as BUSY without invoking its attempt', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const first = recorder();
    const second = recorder();
    const firstDone = c.run(first.request);
    await tick();
    expect(await c.run(second.request)).toBe(CONSENT_BUSY);
    expect(second.calls).toEqual([]);
    // The first run is untouched by the overlap: its own question is still
    // the one that gets asked and answered.
    first.pending[0].reject(REFUSAL);
    await tick();
    c.answer((c.prompt() as ConsentPromptState).ticket, true);
    await tick();
    expect(first.calls).toEqual([false, true]);
    first.pending[1].resolve('first');
    expect(await firstDone).toBe('first');
  });

  it('refuses overlap while a question is open, then serves the next run', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const first = recorder();
    const second = recorder();
    const firstDone = c.run(first.request);
    await tick();
    first.pending[0].reject(REFUSAL);
    await tick();
    expect(await c.run(second.request)).toBe(CONSENT_BUSY);
    expect(second.calls).toEqual([]);
    c.answer((c.prompt() as ConsentPromptState).ticket, false);
    expect(await firstDone).toBe(CONSENT_DECLINED);
    const secondDone = c.run(second.request);
    await tick();
    expect(second.calls).toEqual([false]);
    second.pending[0].resolve('second');
    expect(await secondDone).toBe('second');
  });
});

describe('createEncryptionConsentCoordinator: ticket identity', () => {
  it('rejects an answer carrying a spent ticket, and it cannot settle the next question', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const first = recorder();
    const firstDone = c.run(first.request);
    await tick();
    first.pending[0].reject(REFUSAL);
    await tick();
    const staleTicket = (c.prompt() as ConsentPromptState).ticket;
    c.invalidate();
    expect(await firstDone).toBe(CONSENT_ABANDONED);

    const second = recorder();
    const secondDone = c.run(second.request);
    await tick();
    second.pending[0].reject(REFUSAL);
    await tick();
    const liveTicket = (c.prompt() as ConsentPromptState).ticket;
    expect(liveTicket).not.toBe(staleTicket);
    // The abandoned question's answer arrives late. It must settle nothing.
    expect(c.answer(staleTicket, true)).toBe(false);
    expect(c.prompt()?.ticket).toBe(liveTicket);
    expect(second.calls).toEqual([false]);
    expect(c.answer(liveTicket, false)).toBe(true);
    expect(await secondDone).toBe(CONSENT_DECLINED);
  });

  it('accepts one answer per ticket', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    const ticket = (c.prompt() as ConsentPromptState).ticket;
    expect(c.answer(ticket, false)).toBe(true);
    expect(c.answer(ticket, true)).toBe(false);
    expect(await done).toBe(CONSENT_DECLINED);
    expect(r.calls).toEqual([false]);
  });

  it('rejects an answer when nothing is being asked', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    expect(c.answer(1, true)).toBe(false);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    // Running, but not asking.
    expect(c.answer(1, true)).toBe(false);
    r.pending[0].resolve('ok');
    expect(await done).toBe('ok');
  });
});

describe('createEncryptionConsentCoordinator: disposal and invalidation', () => {
  it('does not ask or retry when the refusal lands after disposal', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    c.dispose();
    r.pending[0].reject(REFUSAL);
    expect(await done).toBe(CONSENT_ABANDONED);
    expect(c.prompt()).toBeNull();
    expect(r.calls).toEqual([false]);
  });

  it('still returns the value when the operation SUCCEEDS after disposal', async () => {
    // Disposal cancels the question, never the engine. Bytes that were
    // written are reported as written.
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    c.dispose();
    r.pending[0].resolve('written anyway');
    expect(await done).toBe('written anyway');
  });

  it('still throws an unrelated failure that lands after disposal', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    c.dispose();
    const boom = new Error('ghostscript exited 1');
    r.pending[0].reject(boom);
    await expect(done).rejects.toBe(boom);
  });

  it('closes an open question on disposal and abandons the run', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    const ticket = (c.prompt() as ConsentPromptState).ticket;
    c.dispose();
    expect(c.prompt()).toBeNull();
    expect(await done).toBe(CONSENT_ABANDONED);
    expect(c.answer(ticket, true)).toBe(false);
    expect(r.calls).toEqual([false]);
  });

  it('refuses every run after disposal without invoking its attempt', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    c.dispose();
    const r = recorder();
    expect(await c.run(r.request)).toBe(CONSENT_ABANDONED);
    expect(r.calls).toEqual([]);
    expect(c.isDisposed()).toBe(true);
  });

  it('invalidation abandons the open question but keeps the coordinator usable', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const first = recorder();
    const firstDone = c.run(first.request);
    await tick();
    first.pending[0].reject(REFUSAL);
    await tick();
    c.invalidate();
    expect(c.prompt()).toBeNull();
    expect(await firstDone).toBe(CONSENT_ABANDONED);
    expect(first.calls).toEqual([false]);
    expect(c.isDisposed()).toBe(false);

    const second = recorder();
    const secondDone = c.run(second.request);
    await tick();
    second.pending[0].resolve('still working');
    expect(await secondDone).toBe('still working');
  });

  it('invalidation before the refusal suppresses the question, not the operation', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    c.invalidate();
    r.pending[0].reject(REFUSAL);
    expect(await done).toBe(CONSENT_ABANDONED);
    expect(c.prompt()).toBeNull();
    expect(r.calls).toEqual([false]);
  });
});

describe('createEncryptionConsentCoordinator: ownership', () => {
  it('does not ask when ownership is already gone as the refusal lands', async () => {
    let current = true;
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: () => current });
    const done = c.run(r.request);
    await tick();
    current = false;
    r.pending[0].reject(REFUSAL);
    expect(await done).toBe(CONSENT_ABANDONED);
    expect(c.prompt()).toBeNull();
    expect(r.calls).toEqual([false]);
  });

  it('does not retry when ownership moves between the answer and the retry', async () => {
    let current = true;
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: () => current });
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    const ticket = (c.prompt() as ConsentPromptState).ticket;
    current = false;
    expect(c.answer(ticket, true)).toBe(true);
    expect(await done).toBe(CONSENT_ABANDONED);
    // Consent was given for what the run owned, and it no longer owns it.
    expect(r.calls).toEqual([false]);
  });

  it('abandons an ALREADY-STALE request without running the operation', async () => {
    // The check that matters most: a request stale on arrival must not reach
    // the engine at all. No later check can unwrite a file.
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: () => false });
    expect(await c.run(r.request)).toBe(CONSENT_ABANDONED);
    expect(r.calls).toEqual([]);
    expect(c.prompt()).toBeNull();
    expect(c.isBusy()).toBe(false);
    expect(c.isDisposed()).toBe(false);

    // And the coordinator is not wedged: the next owned request runs.
    const owned = recorder();
    const done = c.run(owned.request);
    await tick();
    expect(owned.calls).toEqual([false]);
    owned.pending[0].resolve('ok');
    expect(await done).toBe('ok');
  });

  it('consults ownership per run rather than caching it', async () => {
    let current = false;
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: () => current });
    expect(await c.run(r.request)).toBe(CONSENT_ABANDONED);
    expect(r.calls).toEqual([]);

    current = true;
    const secondDone = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    expect(c.prompt()).not.toBeNull();
    c.answer((c.prompt() as ConsentPromptState).ticket, true);
    await tick();
    expect(r.calls).toEqual([false, true]);
    r.pending[1].resolve('second');
    expect(await secondDone).toBe('second');
  });
});

describe('createEncryptionConsentCoordinator: a throwing ownership predicate', () => {
  /** A predicate that throws is a caller defect. It must propagate and it
   * must not leave the coordinator busy — one broken predicate wedging every
   * later run is worse than the defect it reports. */
  const broken = (): boolean => { throw new Error('ownership predicate threw'); };

  it('propagates at entry and releases the run, without touching the engine', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: broken });
    await expect(c.run(r.request)).rejects.toThrow('ownership predicate threw');
    expect(r.calls).toEqual([]);
    expect(c.isBusy()).toBe(false);
    expect(c.prompt()).toBeNull();

    const owned = recorder();
    const done = c.run(owned.request);
    await tick();
    owned.pending[0].resolve('ok');
    expect(await done).toBe('ok');
  });

  it('propagates when it throws as the refusal lands, opening no question', async () => {
    let current = (): boolean => true;
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: () => current() });
    const done = c.run(r.request);
    await tick();
    current = broken;
    r.pending[0].reject(REFUSAL);
    await expect(done).rejects.toThrow('ownership predicate threw');
    expect(c.prompt()).toBeNull();
    expect(c.isBusy()).toBe(false);
    expect(r.calls).toEqual([false]);
  });

  it('propagates when it throws before the retry, and runs no consented attempt', async () => {
    let current = (): boolean => true;
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const r = recorder({ current: () => current() });
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    current = broken;
    expect(c.answer((c.prompt() as ConsentPromptState).ticket, true)).toBe(true);
    await expect(done).rejects.toThrow('ownership predicate threw');
    expect(r.calls).toEqual([false]);
    expect(c.isBusy()).toBe(false);
    expect(c.prompt()).toBeNull();
  });
});

describe('createEncryptionConsentCoordinator: prompt notification', () => {
  it('notifies the open question and its close, and detaches on request', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const seen: (ConsentPromptState | null)[] = [];
    const detach = c.subscribe((p) => seen.push(p));
    const r = recorder({ subject: 'compress' });
    const done = c.run(r.request);
    await tick();
    expect(seen).toEqual([]);
    r.pending[0].reject(REFUSAL);
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.subject).toBe('compress');
    c.answer((seen[0] as ConsentPromptState).ticket, false);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeNull();
    expect(await done).toBe(CONSENT_DECLINED);

    detach();
    const next = recorder();
    const nextDone = c.run(next.request);
    await tick();
    next.pending[0].reject(REFUSAL);
    await tick();
    expect(seen).toHaveLength(2);
    c.answer((c.prompt() as ConsentPromptState).ticket, false);
    expect(await nextDone).toBe(CONSENT_DECLINED);
  });

  it('notifies the close before disposal drops its listeners', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const listener = vi.fn();
    c.subscribe(listener);
    const r = recorder();
    const done = c.run(r.request);
    await tick();
    r.pending[0].reject(REFUSAL);
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    c.dispose();
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await done).toBe(CONSENT_ABANDONED);
  });

  it('keeps every ticket in a coordinator distinct', async () => {
    const c = createEncryptionConsentCoordinator(isConsentRefusal);
    const tickets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = recorder();
      const done = c.run(r.request);
      await tick();
      r.pending[0].reject(REFUSAL);
      await tick();
      const ticket = (c.prompt() as ConsentPromptState).ticket;
      tickets.push(ticket);
      c.answer(ticket, false);
      expect(await done).toBe(CONSENT_DECLINED);
    }
    expect(new Set(tickets).size).toBe(3);
    expect([...tickets].sort((a, b) => a - b)).toEqual(tickets);
  });
});
