// The stepped health sweep: what the renderer asks the engine, in what order,
// and what it does with a run it abandons.
//
// The token is worker-side state holding an open document, so the rule under
// test is that every exit which is not `done` ENDS the run — including a begin
// this build refused, which may still have opened the document. A sweep that
// returns without ending leaks a file handle in the worker until eviction.
//
// The begin and the step have SEPARATE contracts and this file gates both. A
// reply that violates either is `failed`, which the ledger records as
// undetermined; it is never read as a clean sweep of a document nothing
// inspected.
import { describe, it, expect } from 'vitest';
import { isHealthMethod, runHealthSweep } from '../src/renderer/lib/doc-health-engine';
import {
  resolvePendingResponse,
  nextEngineRequestIdForTest,
} from '../src/renderer/hooks/useEngine';

const passthrough = <R,>(send: () => Promise<R>): Promise<R> => send();

/** A fake engine that answers begin/step/end and records the calls. */
function fakeHealthEngine(pages: number, perStep: Record<string, unknown>[][] = []) {
  const calls: string[] = [];
  const dispatch = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push(method);
    if (method === 'document_health_begin') {
      return {
        token: 'tok', pages, done: false, status: 'collected',
        facts: [{ kind: 'recovered', severity: 'warning', boundary: 'qpdf', code: 'xref.reconstructed', page: null, params: {} }],
      };
    }
    if (method === 'document_health_step') {
      expect(params.token).toBe('tok');
      const index = calls.filter((c) => c === 'document_health_step').length - 1;
      const facts = perStep[index] ?? [];
      return {
        token: 'tok',
        done: index >= Math.max(perStep.length - 1, 0),
        status: 'collected',
        facts,
      };
    }
    return { token: 'tok', ended: true };
  };
  return { calls, dispatch };
}

describe('the stepped health sweep', () => {
  it('accumulates the facts of every chunk', async () => {
    const engine = fakeHealthEngine(8, [
      [{ kind: 'skipped', severity: 'warning', boundary: 'engine', code: 'page.formUnreadable', page: 1, params: {} }],
      [{ kind: 'font', severity: 'warning', boundary: 'engine', code: 'font.notEmbedded', page: 1, params: { font: 'Helvetica' } }],
    ]);
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(true);
    expect(reply.status).toBe('collected');
    expect(reply.facts.map((f) => f.code)).toEqual([
      'xref.reconstructed',
      'page.formUnreadable',
      'font.notEmbedded',
    ]);
    // Finished runs are closed by the engine itself: no end call is owed.
    expect(engine.calls).toEqual([
      'document_health_begin',
      'document_health_step',
      'document_health_step',
    ]);
  });

  it('carries an undetermined chunk into the run status', async () => {
    const calls: string[] = [];
    const dispatch = async (method: string): Promise<unknown> => {
      calls.push(method);
      if (method === 'document_health_begin') {
        return { token: 'tok', pages: 1, done: false, status: 'collected', facts: [] };
      }
      return {
        token: 'tok', done: true, status: 'undetermined',
        facts: [{ kind: 'undetermined', severity: 'warning', boundary: 'engine', code: 'page.traversalLimit', page: 1, params: {} }],
      };
    };
    const reply = await runHealthSweep(dispatch, '/a.pdf', passthrough);
    expect(reply.status).toBe('undetermined');
  });

  it('needs no step for a document the engine could not open', async () => {
    const calls: string[] = [];
    const dispatch = async (method: string): Promise<unknown> => {
      calls.push(method);
      return {
        token: '', pages: 0, done: true, status: 'undetermined',
        facts: [{ kind: 'undetermined', severity: 'warning', boundary: 'engine', code: 'document.unreadable', page: null, params: {} }],
      };
    };
    const reply = await runHealthSweep(dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(true);
    expect(reply.status).toBe('undetermined');
    expect(calls).toEqual(['document_health_begin']);
  });

  it('ends the run when a step is abandoned mid-sweep', async () => {
    const engine = fakeHealthEngine(8, [[], [], []]);
    const abandon = <R,>(send: () => Promise<R>): Promise<R> => {
      if (engine.calls.filter((c) => c === 'document_health_step').length >= 1) {
        return Promise.reject(new Error('superseded'));
      }
      return send();
    };
    await expect(runHealthSweep(engine.dispatch, '/a.pdf', abandon)).rejects.toThrow(
      'superseded',
    );
    expect(engine.calls).toContain('document_health_end');
  });

  it('ends the run and reports NOT ok for a reply it cannot parse', async () => {
    const calls: string[] = [];
    const dispatch = async (method: string): Promise<unknown> => {
      calls.push(method);
      if (method === 'document_health_begin') {
        return { token: 'tok', pages: 1, done: false, status: 'collected', facts: [] };
      }
      if (method === 'document_health_step') return { nonsense: true };
      return { ended: true };
    };
    const reply = await runHealthSweep(dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(false);
    expect(reply.status).toBe('undetermined');
    expect(calls).toContain('document_health_end');
  });

  it('a begin this build cannot parse is undetermined, never clean', async () => {
    const reply = await runHealthSweep(async () => ({ facts: [] }), '/a.pdf', passthrough);
    expect(reply.ok).toBe(false);
    expect(reply.status).toBe('undetermined');
    expect(reply.facts).toEqual([]);
  });

  it('stops rather than looping on a reply that never says done', async () => {
    let steps = 0;
    const dispatch = async (method: string): Promise<unknown> => {
      if (method === 'document_health_begin') {
        return { token: 'tok', pages: 2, done: false, status: 'collected', facts: [] };
      }
      if (method === 'document_health_step') {
        steps += 1;
        return { token: 'tok', done: false, status: 'collected', facts: [] };
      }
      return { ended: true };
    };
    const reply = await runHealthSweep(dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(false);
    // Bounded, and generously: a page can suspend part-way and resume, so the
    // step count is a multiple of the page count rather than equal to it. The
    // property under test is that it terminates at all.
    expect(steps).toBeLessThanOrEqual(128);
  });
});

describe('the begin/step contract', () => {
  /** Records the calls and answers each method from a table. */
  function scripted(replies: Record<string, unknown | ((n: number) => unknown)>) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const dispatch = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      const reply = replies[method];
      const nth = calls.filter((c) => c.method === method).length - 1;
      return typeof reply === 'function'
        ? (reply as (n: number) => unknown)(nth)
        : reply;
    };
    return { calls, dispatch, methods: () => calls.map((c) => c.method) };
  }

  it('refuses a not-done begin that issued no token, and steps nothing', async () => {
    // Without a token there is nothing to step, so a sweep that accepted this
    // would return the begin's facts as a COMPLETE answer for a document it
    // never inspected a page of.
    const engine = scripted({
      document_health_begin: { token: '', pages: 100, done: false, status: 'collected', facts: [] },
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply).toEqual({ ok: false, status: 'undetermined', facts: [] });
    expect(engine.methods()).toEqual(['document_health_begin']);
  });

  it('refuses a not-done begin whose page count is negative', async () => {
    const engine = scripted({
      document_health_begin: { token: 'tok', pages: -8, done: false, status: 'collected', facts: [] },
      document_health_end: { ended: true },
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(false);
    expect(engine.methods()).toEqual(['document_health_begin', 'document_health_end']);
  });

  it('refuses a not-done begin whose page count is not an integer', async () => {
    const engine = scripted({
      document_health_begin: { token: 'tok', pages: 1.5, done: false, status: 'collected', facts: [] },
      document_health_end: { ended: true },
    });
    expect((await runHealthSweep(engine.dispatch, '/a.pdf', passthrough)).ok).toBe(false);
  });

  it('refuses a terminal begin that still carries a token', async () => {
    const engine = scripted({
      document_health_begin: { token: 'tok', pages: 0, done: true, status: 'collected', facts: [] },
      document_health_end: { ended: true },
    });
    expect((await runHealthSweep(engine.dispatch, '/a.pdf', passthrough)).ok).toBe(false);
  });

  it('ends the token a REJECTED begin carried', async () => {
    // The reply is not the shape this build knows, but the engine may well
    // have opened the document. The token is the only handle that closes it.
    const engine = scripted({
      document_health_begin: { token: 'open-handle', pages: 1, status: 'collected', facts: [] },
      document_health_end: { ended: true },
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply).toEqual({ ok: false, status: 'undetermined', facts: [] });
    expect(engine.methods()).toEqual(['document_health_begin', 'document_health_end']);
    expect(engine.calls[1].params).toEqual({ token: 'open-handle' });
  });

  it('asks for no end when a rejected begin carried no token', async () => {
    const engine = scripted({ document_health_begin: { facts: [] } });
    expect((await runHealthSweep(engine.dispatch, '/a.pdf', passthrough)).ok).toBe(false);
    expect(engine.methods()).toEqual(['document_health_begin']);
  });

  it('refuses a step reply naming a different run', async () => {
    // Those facts describe a document this sweep did not ask about. Folding
    // them in files one document's findings under another's ledger row.
    const engine = scripted({
      document_health_begin: { token: 'issued', pages: 2, done: false, status: 'collected', facts: [] },
      document_health_step: {
        token: 'someone-else', done: true, status: 'collected',
        facts: [{ kind: 'font', severity: 'warning', boundary: 'engine', code: 'font.notEmbedded', page: 1, params: {} }],
      },
      document_health_end: { ended: true },
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply).toEqual({ ok: false, status: 'undetermined', facts: [] });
    expect(engine.methods()).toEqual([
      'document_health_begin',
      'document_health_step',
      'document_health_end',
    ]);
  });

  it('refuses a step reply carrying no token at all', async () => {
    const engine = scripted({
      document_health_begin: { token: 'issued', pages: 1, done: false, status: 'collected', facts: [] },
      document_health_step: { done: true, status: 'collected', facts: [] },
      document_health_end: { ended: true },
    });
    expect((await runHealthSweep(engine.dispatch, '/a.pdf', passthrough)).ok).toBe(false);
  });

  it('accepts the contract-shaped exchange and every step of it', async () => {
    const engine = scripted({
      document_health_begin: { token: 'issued', pages: 2, done: false, status: 'collected', facts: [] },
      document_health_step: (n: number) => ({
        token: 'issued',
        done: n >= 2,
        status: 'collected',
        facts: [{ kind: 'skipped', severity: 'warning', boundary: 'engine', code: `s${n}`, page: null, params: {} }],
      }),
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(true);
    expect(reply.facts.map((f) => f.code)).toEqual(['s0', 's1', 's2']);
    expect(engine.methods().filter((m) => m === 'document_health_end')).toEqual([]);
  });

  it('allows many more steps than pages, because a page can suspend', async () => {
    // The step cap is not the page count: a page whose traversal ran out of
    // step budget resumes in the next step, so a two-page document can take
    // many steps and must not be cut off as an unparseable reply stream.
    let steps = 0;
    const engine = scripted({
      document_health_begin: { token: 'issued', pages: 2, done: false, status: 'collected', facts: [] },
      document_health_step: (n: number) => {
        steps = n + 1;
        return { token: 'issued', done: n >= 40, status: 'collected', facts: [] };
      },
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(true);
    expect(steps).toBe(41);
  });

  it('a zero-page document still gets its terminal step', async () => {
    const engine = scripted({
      document_health_begin: { token: 'issued', pages: 0, done: false, status: 'collected', facts: [] },
      document_health_step: { token: 'issued', done: true, status: 'collected', facts: [] },
    });
    const reply = await runHealthSweep(engine.dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(true);
    expect(engine.methods()).toEqual(['document_health_begin', 'document_health_step']);
  });
});

describe('which sidecar health work goes to', () => {
  it('names every method of the stepped protocol and the whole one', () => {
    // Structural, not by convention: a health method that reached the
    // interactive sidecar would put an unbounded traversal of a document
    // nobody asked about into the FIFO the user's operations wait in.
    expect(isHealthMethod('document_health')).toBe(true);
    expect(isHealthMethod('document_health_begin')).toBe(true);
    expect(isHealthMethod('document_health_step')).toBe(true);
    expect(isHealthMethod('document_health_end')).toBe(true);
  });

  it('names nothing else', () => {
    for (const method of ['merge', 'repair', 'check', 'read_form_fields', 'document_healthy', '']) {
      expect(isHealthMethod(method)).toBe(false);
    }
  });
});

describe('the one pending map both sidecars answer into', () => {
  it('a reply for one id resolves ONLY that id, even when the same id answers twice', () => {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (r: unknown) => void }>();
    const results: Record<number, unknown> = {};
    pending.set(1, { resolve: (v) => (results[1] = v), reject: () => undefined });
    pending.set(2, { resolve: (v) => (results[2] = v), reject: () => undefined });

    resolvePendingResponse(pending as never, { id: 1, result: { count: 1 } as never });
    expect(pending.has(1)).toBe(false);
    expect(results[2]).toBeUndefined();

    // A second reply naming the same id, now that nothing is pending under
    // it, must not resolve id 2's entry nor throw.
    expect(() =>
      resolvePendingResponse(pending as never, { id: 1, result: { count: 99 } as never }),
    ).not.toThrow();
    expect(results[2]).toBeUndefined();
  });

  it('a deadline refusal for one id rejects only that request', () => {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (r: unknown) => void }>();
    const resolved: number[] = [];
    const rejected: number[] = [];
    for (const id of [10, 11, 12]) {
      pending.set(id, { resolve: () => resolved.push(id), reject: () => rejected.push(id) });
    }
    resolvePendingResponse(pending as never, { id: 11, error: { message: 'deadline exceeded' } });
    expect(rejected).toEqual([11]);
    expect(resolved).toEqual([]);
    expect(pending.has(10)).toBe(true);
    expect(pending.has(12)).toBe(true);
  });

  it('ids are drawn from ONE module-scoped counter: a same-id collision is impossible by construction', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) {
      const id = nextEngineRequestIdForTest();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('a rejected begin or step ends its token exactly once', () => {
  it('a token found in a REJECTED begin is ended exactly once', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const dispatch = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      if (method === 'document_health_begin') {
        // `done` is missing — the reply is rejected — but the engine may
        // still have opened the document.
        return { token: 'leaked-handle', pages: 3, status: 'collected', facts: [] };
      }
      return { ended: true };
    };
    const reply = await runHealthSweep(dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(false);
    const ends = calls.filter((c) => c.method === 'document_health_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].params).toEqual({ token: 'leaked-handle' });
  });

  it('a rejected step (token mismatch) ends the token exactly once', async () => {
    const calls: string[] = [];
    const dispatch = async (method: string): Promise<unknown> => {
      calls.push(method);
      if (method === 'document_health_begin') {
        return { token: 'tok', pages: 1, done: false, status: 'collected', facts: [] };
      }
      if (method === 'document_health_step') {
        return { token: 'wrong', done: true, status: 'collected', facts: [] };
      }
      return { ended: true };
    };
    const reply = await runHealthSweep(dispatch, '/a.pdf', passthrough);
    expect(reply.ok).toBe(false);
    expect(calls.filter((m) => m === 'document_health_end')).toHaveLength(1);
  });
});
