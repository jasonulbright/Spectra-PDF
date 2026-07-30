// Guided actions (lib/guided-actions.ts): catalog integrity, validation,
// param coercion, and the localStorage round trip (stubbed — no DOM env).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STEP_CATALOG,
  askedParamKeys,
  buildStepParams,
  isGuidedAction,
  loadGuidedActions,
  newStep,
  saveGuidedActions,
  validateAction,
  validateRunValues,
  type GuidedAction,
} from '../src/renderer/lib/guided-actions';

describe('step catalog integrity', () => {
  it('every step builds from defaults; unmapped steps round-trip their keys', () => {
    for (const def of STEP_CATALOG) {
      const step = newStep(def.op);
      const params = buildStepParams(step);
      if (def.mapParams) continue; // shape asserted in its own test below
      for (const p of def.params) {
        expect(params[p.key]).toBeDefined();
        if (p.kind === 'number') expect(typeof params[p.key]).toBe('number');
        if (p.kind === 'select') {
          expect(p.options!.some((o) => o.value === params[p.key])).toBe(true);
        }
      }
    }
  });

  it('header/footer maps position+text into the engine placements shape', () => {
    const step = newStep('add_header_footer');
    step.params.position = 'br';
    step.params.text = 'Page {page} of {pages}';
    const params = buildStepParams(step) as { placements: { position: string; text: string }[]; font_size: number };
    expect(params.placements).toEqual([{ position: 'br', text: 'Page {page} of {pages}' }]);
    expect(params.font_size).toBe(10);
  });

  it('the OCR step offers the full recognition language list', () => {
    const def = STEP_CATALOG.find((d) => d.op === 'ocr_file')!;
    const lang = def.params.find((p) => p.key === 'language')!;
    expect(lang.options!.length).toBeGreaterThanOrEqual(40);
    for (const code of ['eng', 'deu', 'jpn', 'ara', 'chi_sim']) {
      expect(lang.options!.some((o) => o.value === code)).toBe(true);
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

  it('encrypt is TERMINAL-output only — never an in-place step (an encrypted working copy is unreadable)', () => {
    const enc = STEP_CATALOG.find((d) => d.op === 'encrypt')!;
    expect(enc.terminalOutput).toBe(true);
    const a = base();
    a.steps = [newStep('encrypt'), newStep('strip_metadata')];
    expect(validateAction(a)).toMatch(/last step/);
    a.steps = [newStep('strip_metadata'), newStep('encrypt')];
    expect(validateAction(a)).toBeNull(); // passwords are asked, not stored
  });

  it('secrets are implicitly asked and required-at-save is skipped for asked params', () => {
    const enc = newStep('encrypt');
    expect(askedParamKeys(enc).sort()).toEqual(['owner_password', 'user_password']);
    // A required param marked ask-at-run is the PRE-RUN form's problem.
    const wm = newStep('watermark');
    wm.ask = ['text'];
    const a = base();
    a.steps = [wm];
    expect(validateAction(a)).toBeNull();
    expect(validateRunValues(wm, {})).toMatch(/Text is required/);
    expect(validateRunValues(wm, { text: 'ASKED' })).toBeNull();
  });

  it('validateRunValues demands at least one encrypt password at run time', () => {
    const enc = newStep('encrypt');
    expect(validateRunValues(enc, {})).toMatch(/open or an owner password/);
    expect(validateRunValues(enc, { owner_password: 's3cret' })).toBeNull();
  });

  it('buildStepParams merges ask-at-run overrides BEFORE coercion clamps', () => {
    const wm = newStep('watermark');
    wm.params.text = 'stored';
    const params = buildStepParams(wm, { text: 'runtime', opacity: '9' }) as Record<string, unknown>;
    expect(params.text).toBe('runtime');
    expect(params.opacity).toBe(1); // clamped to the declared max
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

  it('NEVER persists secret values — passwords are stripped at the one write path', () => {
    const enc = newStep('encrypt');
    enc.params.user_password = 'hunter2';
    enc.params.owner_password = 'hunter3';
    saveGuidedActions([{ id: '1', name: 'Lock', steps: [enc] }]);
    const raw = store.get('guided-actions')!;
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('hunter3');
    const loaded = loadGuidedActions();
    expect(loaded[0].steps[0].params.user_password).toBeUndefined();
    // ...and they remain collectable: still implicitly asked.
    expect(askedParamKeys(loaded[0].steps[0])).toContain('user_password');
  });

  it('isGuidedAction rejects unknown ops and shapeless steps', () => {
    expect(isGuidedAction({ id: '1', name: 'n', steps: [{ op: 'compress', params: {} }] })).toBe(true);
    expect(isGuidedAction({ id: '1', name: 'n', steps: [{ op: 'nope', params: {} }] })).toBe(false);
    expect(isGuidedAction({ id: '1', name: 'n', steps: [null] })).toBe(false);
  });
});
