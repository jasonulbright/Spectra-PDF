// Guided actions (lib/guided-actions.ts): catalog integrity, validation,
// param coercion, and the localStorage round trip (stubbed — no DOM env).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  STEP_CATALOG,
  actionFileJson,
  askedParamKeys,
  buildStepParams,
  createsItsOwnSource,
  inPlaceBlocker,
  openDocumentBlocker,
  isGuidedAction,
  loadGuidedActions,
  newStep,
  parseActionFile,
  saveGuidedActions,
  unattendedBlocker,
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
    // Watermark takes text OR an image; neither set is as wrong as both.
    a.steps = [newStep('watermark')];
    expect(validateAction(a)).toMatch(/set Text \/ Image file/);
    a.steps[0].params.text = 'DRAFT';
    a.steps[0].params.image = 'logo.png';
    expect(validateAction(a)).toMatch(/set Text \/ Image file/);
    a.steps[0].params.image = '';
    expect(validateAction(a)).toBeNull();
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
    // An asked one-of param is the PRE-RUN form's problem.
    const wm = newStep('watermark');
    wm.ask = ['text'];
    const a = base();
    a.steps = [wm];
    expect(validateAction(a)).toBeNull();
    expect(validateRunValues(wm, {})).toMatch(/set Text \/ Image file/);
    expect(validateRunValues(wm, { text: 'DRAFT' })).toBeNull();
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

describe('action files (export/import)', () => {
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

  it('exports the CLI-consumable {name, steps} shape — no id, and NO password material by construction', () => {
    const wm = newStep('watermark');
    wm.params.text = 'DRAFT';
    const enc = newStep('encrypt');
    enc.params.user_password = 'hunter2'; // simulate an in-memory secret
    enc.params.owner_password = 'hunter3';
    const raw = actionFileJson({ id: 'abc', name: 'Lock', steps: [wm, enc] });
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('hunter3');
    expect(raw).not.toContain('password'); // the KEYS are stripped, not blanked
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.id).toBeUndefined();
    expect(parsed).toEqual({
      name: 'Lock',
      steps: [
        {
          op: 'watermark',
          params: {
            text: 'DRAFT',
            image: '',
            pdf_source: '',
            pdf_page: 1,
            opacity: 0.15,
            angle: 45,
            scale: 1,
            position: 'center',
          },
        },
        { op: 'encrypt', params: {} },
      ],
    });
  });

  it('round-trips through parseActionFile with a FRESH id; params and ask marks survive', () => {
    const wm = newStep('watermark');
    wm.params.text = 'X';
    wm.ask = ['opacity'];
    const hf = newStep('add_header_footer');
    hf.params.text = 'Page {page}';
    const a: GuidedAction = { id: 'orig', name: 'Share', steps: [wm, hf] };
    const back = parseActionFile(actionFileJson(a));
    expect(back.id).not.toBe('orig');
    expect(back.name).toBe('Share');
    expect(back.steps).toEqual(a.steps);
    expect(isGuidedAction(back)).toBe(true);
  });

  it('refuses malformed files BY NAME (the engine validate_steps message shape)', () => {
    const f = (v: unknown): string => JSON.stringify(v);
    expect(() => parseActionFile('{oops')).toThrow(/valid JSON/);
    expect(() => parseActionFile(f([]))).toThrow(/action file/);
    expect(() => parseActionFile(f({ name: 'x' }))).toThrow(/steps/);
    expect(() => parseActionFile(f({ name: 'x', steps: [{ op: 'rm_rf', params: {} }] }))).toThrow(
      /unknown operation 'rm_rf'/,
    );
    expect(() =>
      parseActionFile(f({ name: 'x', steps: [{ op: 'compress', params: { gs_path: 'evil.exe' } }] })),
    ).toThrow(/unknown parameter\(s\) \[gs_path\]/);
    expect(() =>
      parseActionFile(f({ name: 'x', steps: [{ op: 'compress', params: { quality: 'bogus' } }] })),
    ).toThrow(/invalid value 'bogus' for 'quality'/);
    expect(() =>
      parseActionFile(f({ name: 'x', steps: [{ op: 'watermark', params: { text: true } }] })),
    ).toThrow(/parameter 'text' must be text or a number/);
    expect(() =>
      parseActionFile(
        f({ name: 'x', steps: [{ op: 'watermark', params: { text: 'A', image: 'b.png' } }] }),
      ),
    ).toThrow(/set Text \/ Image file/);
    expect(() =>
      parseActionFile(f({ name: 'x', steps: [{ op: 'compress', params: 'zip' }] })),
    ).toThrow(/params must be an object/);
    expect(() => parseActionFile(f({ name: '', steps: [{ op: 'strip_metadata', params: {} }] }))).toThrow(
      /name/,
    );
    expect(() => parseActionFile(f({ name: 'x', steps: [] }))).toThrow(/at least one/);
    expect(() =>
      parseActionFile(
        f({
          name: 'x',
          steps: [{ op: 'encrypt', params: {} }, { op: 'strip_metadata', params: {} }],
        }),
      ),
    ).toThrow(/last step/);
    // One-of params with neither set are refused like the editor refuses them.
    expect(() =>
      parseActionFile(f({ name: 'x', steps: [{ op: 'watermark', params: {} }] })),
    ).toThrow(/set Text \/ Image file/);
  });

  it('accepts the engine placements shape for ONE placement (CLI-authored files); multi-placement refuses by name', () => {
    const single = JSON.stringify({
      name: 'x',
      steps: [
        {
          op: 'add_header_footer',
          params: { placements: [{ position: 'br', text: 'P {page}' }], font_size: 12 },
        },
      ],
    });
    const a = parseActionFile(single);
    expect(a.steps[0].params).toEqual({ position: 'br', text: 'P {page}', font_size: 12 });
    const multi = JSON.stringify({
      name: 'x',
      steps: [
        {
          op: 'add_header_footer',
          params: {
            placements: [
              { position: 'br', text: 'a' },
              { position: 'bl', text: 'b' },
            ],
          },
        },
      ],
    });
    expect(() => parseActionFile(multi)).toThrow(/one placement per step/);
    const both = JSON.stringify({
      name: 'x',
      steps: [{ op: 'add_header_footer', params: { placements: [], position: 'br', text: 'a' } }],
    });
    expect(() => parseActionFile(both)).toThrow(/not both/);
  });

  it('unattendedBlocker: ask-at-run and secret steps cannot be scheduled; plain actions can', () => {
    const plain: GuidedAction = { id: '1', name: 'Nightly', steps: [newStep('strip_metadata')] };
    expect(unattendedBlocker(plain)).toBeNull();

    const wm = newStep('watermark');
    wm.params.text = 'X';
    wm.ask = ['text'];
    expect(unattendedBlocker({ id: '2', name: 'Asks', steps: [wm] })).toMatch(
      /asks for values when it runs \(text\)/,
    );

    const locked: GuidedAction = {
      id: '3',
      name: 'Lock',
      steps: [newStep('strip_metadata'), newStep('encrypt')],
    };
    expect(unattendedBlocker(locked)).toMatch(/passwords are never stored/);
  });

  it('an imported password never reaches disk: secret values are accepted then stripped at save', () => {
    const withPw = JSON.stringify({
      name: 'Lock',
      steps: [{ op: 'encrypt', params: { user_password: 'leaked' } }],
    });
    const a = parseActionFile(withPw);
    saveGuidedActions([a]);
    expect(store.get('guided-actions')!).not.toContain('leaked');
    // …and export strips it the same way.
    expect(actionFileJson(a)).not.toContain('leaked');
  });
});

// ── the create_pdf source step ────────────────────────────────────────────
//
// It is the one step that PRODUCES the document rather than transforming one,
// which is why it carries three rules the other eight do not. Every one of
// them is mirrored in `engine/guided_actions.py`, because a CLI run and a
// scheduled run never pass through this editor at all.
describe('the create_pdf source step', () => {
  const catalogDef = STEP_CATALOG.find((d) => d.op === 'create_pdf')!;

  it('is in the catalog, flagged as a source step', () => {
    expect(catalogDef).toBeTruthy();
    expect(catalogDef.sourceStep).toBe(true);
  });

  it('is NOT the picker default — that would change what "Add step" adds', () => {
    // `AddStepPicker` defaults to STEP_CATALOG[0]; making the rarest step the
    // default would be a regression for every ordinary action.
    expect(STEP_CATALOG[0].op).not.toBe('create_pdf');
  });

  it('offers exactly the parameters the engine allow-lists', () => {
    // The engine refuses an unknown parameter by name, so a key this editor
    // can produce and the engine cannot take would be an action that saves
    // and then fails at the runner.
    const engine = readFileSync(
      resolve(__dirname, '../src/engine/guided_actions.py'),
      'utf-8',
    );
    const block = engine.slice(engine.indexOf('"create_pdf": ('));
    for (const p of catalogDef.params) {
      expect(block.slice(0, 600), p.key).toContain(`"${p.key}"`);
    }
  });

  it('must be the FIRST step, and says so by name', () => {
    const ok: GuidedAction = {
      id: '1',
      name: 'Convert',
      steps: [newStep('create_pdf'), newStep('strip_metadata')],
    };
    expect(validateAction(ok)).toBe(null);
    const bad: GuidedAction = {
      id: '1',
      name: 'Convert',
      steps: [newStep('strip_metadata'), newStep('create_pdf')],
    };
    expect(validateAction(bad)).toContain('first step');
  });

  it('refuses the open-document run and the in-place run, and only for itself', () => {
    const creating: GuidedAction = {
      id: '1',
      name: 'Convert',
      steps: [newStep('create_pdf')],
    };
    const ordinary: GuidedAction = {
      id: '2',
      name: 'Clean',
      steps: [newStep('strip_metadata')],
    };
    expect(createsItsOwnSource(creating)).toBe(true);
    expect(createsItsOwnSource(ordinary)).toBe(false);
    expect(openDocumentBlocker(creating)).toContain('folder');
    expect(inPlaceBlocker(creating)).toBeTruthy();
    expect(openDocumentBlocker(ordinary)).toBe(null);
    expect(inPlaceBlocker(ordinary)).toBe(null);
    expect(createsItsOwnSource({ id: '3', name: 'Empty', steps: [] })).toBe(false);
  });

  it('an imported action file is held to the same ordering rule', () => {
    const file = JSON.stringify({
      name: 'Convert',
      steps: [{ op: 'strip_metadata', params: {} }, { op: 'create_pdf', params: {} }],
    });
    expect(() => parseActionFile(file)).toThrow(/first step/);
  });

  it('an action starting with it imports cleanly', () => {
    const file = JSON.stringify({
      name: 'Convert',
      steps: [
        { op: 'create_pdf', params: { page_size: 'a4', margin_pt: 12 } },
        { op: 'strip_metadata', params: {} },
      ],
    });
    const action = parseActionFile(file);
    expect(action.steps.map((s) => s.op)).toEqual(['create_pdf', 'strip_metadata']);
    expect(buildStepParams(action.steps[0]).page_size).toBe('a4');
  });
});

// The renderer half of the cross-language catalog pin. The fixture is the one
// written-down declaration of the step set; `tests/test_guided_actions.py`
// pins engine/guided_actions.py::_STEPS against the same file. A step added to
// one catalog alone goes red here or there — never in front of a user as
// "unknown operation" on an action file the other half wrote.
describe('the two step catalogs are pinned against each other', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/guided-step-catalog.json'), 'utf8'),
  ) as { steps: Record<string, { params: string[] }> };

  it('offers exactly the ops the engine dispatches, in both directions', () => {
    expect([...STEP_CATALOG].map((d) => d.op).sort()).toEqual(Object.keys(fixture.steps).sort());
  });

  it('every param a step EMITS is one its engine op accepts', () => {
    // Emitted, not declared: several steps reshape their form keys through
    // `mapParams` (`levels` becomes `max_level`), so the form's own key names
    // are not what the engine is handed and pinning those would pin nothing.
    for (const def of STEP_CATALOG) {
      const allowed = new Set(fixture.steps[def.op].params);
      for (const key of Object.keys(buildStepParams(newStep(def.op)))) {
        expect(allowed.has(key), `${def.op}.${key}`).toBe(true);
      }
    }
  });

  it('the conditionally-emitted params are accepted too', () => {
    // Three steps emit a key only when its form value is non-empty, so the
    // defaults pass above cannot reach them.
    const redact = newStep('search_redact');
    redact.params.overlay_text = 'EXEMPT';
    const forms = newStep('prepare_forms');
    forms.params.kinds = 'text,checkbox';
    const header = newStep('add_header_footer');
    header.params.text = 'Page {page}';
    for (const step of [redact, forms, header]) {
      const allowed = new Set(fixture.steps[step.op].params);
      for (const key of Object.keys(buildStepParams(step))) {
        expect(allowed.has(key), `${step.op}.${key}`).toBe(true);
      }
    }
    expect(Object.keys(buildStepParams(redact))).toContain('properties');
    expect(Object.keys(buildStepParams(forms))).toContain('kinds');
  });

  it('builds the scan-enhancement step the engine already dispatched', () => {
    // The drift this pin exists for: `enhance_scan` was in the engine's table
    // and not in this one, so the wizard could not build it and an action file
    // carrying it was refused by name.
    const step = newStep('enhance_scan');
    const params = buildStepParams(step);
    expect(params.pages).toBe('all');
    expect(params.deskew).toBe(true);
    expect(params.jpeg_quality).toBe(85);
    step.params.pages = '2,4';
    step.params.orientation = 'no';
    step.params.jpeg_quality = '400';
    const narrowed = buildStepParams(step);
    expect(narrowed.pages).toEqual([2, 4]);
    expect(narrowed.orientation).toBe(false);
    expect(narrowed.jpeg_quality).toBe(100);
  });

  it('imports a CLI-authored action carrying the scan-enhancement step', () => {
    const file = JSON.stringify({
      name: 'Clean scans',
      steps: [
        { op: 'enhance_scan', params: { deskew: 'yes', despeckle: 'no' } },
        { op: 'ocr_file', params: { language: 'eng' } },
      ],
    });
    const action = parseActionFile(file);
    expect(action.steps.map((s) => s.op)).toEqual(['enhance_scan', 'ocr_file']);
    expect(buildStepParams(action.steps[0]).despeckle).toBe(false);
  });
});
