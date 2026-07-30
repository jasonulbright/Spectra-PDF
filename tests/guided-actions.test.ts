// Guided actions (lib/guided-actions.ts): catalog integrity, validation,
// param coercion, and the localStorage round trip (stubbed — no DOM env).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STEP_CATALOG,
  buildStepParams,
  isGuidedAction,
  loadGuidedActions,
  newStep,
  saveGuidedActions,
  validateAction,
  type GuidedAction,
} from '../src/renderer/lib/guided-actions';

describe('step catalog integrity', () => {
  it('every step builds from defaults and round-trips buildStepParams', () => {
    for (const def of STEP_CATALOG) {
      const step = newStep(def.op);
      const params = buildStepParams(step);
      for (const p of def.params) {
        expect(params[p.key]).toBeDefined();
        if (p.kind === 'number') expect(typeof params[p.key]).toBe('number');
        if (p.kind === 'select') {
          expect(p.options!.some((o) => o.value === params[p.key])).toBe(true);
        }
      }
    }
  });

  it('coerces and clamps numeric params from string input', () => {
    const step = newStep('watermark');
    step.params.text = 'DRAFT';
    step.params.opacity = '2.5' as unknown as number; // over max
    step.params.angle = 'garbage' as unknown as number;
    const params = buildStepParams(step);
    expect(params.opacity).toBe(1); // clamped to max
    expect(params.angle).toBe(45); // unparsable → default
  });
});

describe('validation', () => {
  const base = (): GuidedAction => ({
    id: '1',
    name: 'Publish',
    steps: [newStep('strip_metadata')],
  });

  it('accepts a plain valid action', () => {
    expect(validateAction(base())).toBeNull();
  });

  it('refuses an empty name, zero steps, and missing required params', () => {
    expect(validateAction({ ...base(), name: ' ' })).toMatch(/name/);
    expect(validateAction({ ...base(), steps: [] })).toMatch(/at least one/);
    const a = base();
    a.steps = [newStep('watermark')]; // text required, defaults empty
    expect(validateAction(a)).toMatch(/Text is required/);
  });

  it('the catalog has no encrypt step (in-place encryption would make the open working copy unreadable)', () => {
    expect(STEP_CATALOG.some((d) => (d.op as string) === 'encrypt')).toBe(false);
  });
});

describe('persistence (localStorage stub)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('round-trips saved actions and drops malformed entries', () => {
    const a: GuidedAction = {
      id: '1',
      name: 'Shrink & Mark',
      steps: [newStep('compress'), { op: 'watermark', params: { text: 'DRAFT', opacity: 0.2, angle: 45 } }],
    };
    saveGuidedActions([a]);
    expect(loadGuidedActions()).toEqual([a]);

    store.set(
      'guided-actions',
      JSON.stringify([a, { id: 'x', name: 'bad', steps: [{ op: 'rm -rf', params: {} }] }, 42]),
    );
    expect(loadGuidedActions()).toEqual([a]);
  });

  it('returns [] for corrupt JSON and non-arrays', () => {
    store.set('guided-actions', '{oops');
    expect(loadGuidedActions()).toEqual([]);
    store.set('guided-actions', '"str"');
    expect(loadGuidedActions()).toEqual([]);
  });

  it('isGuidedAction rejects unknown ops and shapeless steps', () => {
    expect(isGuidedAction({ id: '1', name: 'n', steps: [{ op: 'compress', params: {} }] })).toBe(true);
    expect(isGuidedAction({ id: '1', name: 'n', steps: [{ op: 'nope', params: {} }] })).toBe(false);
    expect(isGuidedAction({ id: '1', name: 'n', steps: [null] })).toBe(false);
  });
});
