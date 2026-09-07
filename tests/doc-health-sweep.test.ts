// The stepped health sweep: what the renderer asks the engine, in what order,
// and what it does with a run it abandons.
//
// The token is engine-side state holding an open document, so the rule under
// test is that every exit which is not `done` ENDS the run. A sweep that
// returns without ending leaks a file handle in the engine until eviction.
import { describe, it, expect } from 'vitest';
import { runHealthSweep } from '../src/renderer/lib/doc-health-engine';

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
    expect(steps).toBeLessThanOrEqual(11);
  });
});
