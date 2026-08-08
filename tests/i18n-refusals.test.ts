// The RENDERER's own refusal messages.
//
// Slice D localized the ENGINE's refusals at the bridge; these are the ones
// the renderer builds itself, in leaf libs that no component test can reach
// (there is no DOM test environment). What is asserted here is the property
// that matters at the display site: the message a user reads follows the UI
// language, is composed from ONE key per message (never glued fragments),
// and keeps the file's own vocabulary — op ids, parameter names, paths —
// verbatim inside it.
import { describe, it, expect, afterAll } from 'vitest';
import i18next from '../src/renderer/i18n';
import { REFUSAL_STRINGS } from '../src/renderer/i18n-refusals';
import {
  parseActionFile,
  validateAction,
  validateRunValues,
  newStep,
  type GuidedAction,
} from '../src/renderer/lib/guided-actions';
import { FieldSpecError } from '../src/renderer/lib/form-authoring';

const inEs = async <T>(fn: () => T): Promise<T> => {
  await i18next.changeLanguage('es');
  try {
    return fn();
  } finally {
    await i18next.changeLanguage('en');
  }
};

afterAll(async () => {
  await i18next.changeLanguage('en');
});

describe('renderer refusal messages', () => {
  it('the record is flat, non-empty, and every key is namespaced', () => {
    for (const [k, v] of Object.entries(REFUSAL_STRINGS)) {
      expect(k.startsWith('refusal.'), `${k} is not namespaced`).toBe(true);
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('guided-action validation refuses in the UI language', async () => {
    const action: GuidedAction = { id: 'a', name: '', steps: [] };
    expect(validateAction(action)).toBe('The action needs a name.');
    expect(await inEs(() => validateAction(action))).toBe('La acción necesita un nombre.');

    action.name = 'Test';
    expect(validateAction(action)).toBe('Add at least one step.');

    // A one-of pair with neither set: the message names BOTH the step and the
    // params through their own catalog keys, so it cannot disagree with the
    // editor rendering the same step above it.
    action.steps = [newStep('watermark')];
    const en = validateAction(action);
    expect(en).toBe('Step 1 (Watermark): set Text / Image file — one of them, not both.');
    const es = await inEs(() => validateAction(action));
    expect(es).toContain('Paso 1');
    expect(es).toContain('Marca de agua');
    expect(es).not.toContain('Watermark');
  });

  it('the pre-run check refuses in the UI language', async () => {
    const enc = newStep('encrypt');
    expect(validateRunValues(enc, {})).toBe('Encrypt: set an open or an owner password.');
    expect(await inEs(() => validateRunValues(enc, {}))).toContain('contraseña de apertura');
  });

  it('an action FILE refusal localizes but keeps the file\'s own vocabulary', async () => {
    const bad = JSON.stringify({
      name: 'x',
      steps: [{ op: 'compress', params: { gs_path: 'C:/gs.exe' } }],
    });
    expect(() => parseActionFile(bad)).toThrow('Step 1 (compress): unknown parameter(s) [gs_path].');
    const es = await inEs(() => {
      try {
        parseActionFile(bad);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(es).toContain('Paso 1');
    // The op id and the parameter name name things INSIDE the file the user
    // is being asked to fix — translating either would name nothing.
    expect(es).toContain('(compress)');
    expect(es).toContain('gs_path');
  });

  it('parse refusals stay byte-identical in en (the e2e suite asserts them)', () => {
    expect(() => parseActionFile('{oops')).toThrow('Not a valid JSON file.');
    expect(() => parseActionFile(JSON.stringify({ name: 'x', steps: [{ op: 'explode' }] })))
      .toThrow("Step 1: unknown operation 'explode'.");
  });

  it('FieldSpecError reports every problem at once and follows a live switch', async () => {
    const err = new FieldSpecError([
      { key: 'refusal.field.nameRequired' },
      { key: 'refusal.field.rectEmpty' },
      { key: 'refusal.field.nameExists', vars: { name: 'address' } },
    ]);
    // Each problem is its own key; nothing is glued into a single catalog
    // entry, so the joined message is rebuilt per language.
    expect(err.problems).toHaveLength(3);
    expect(err.message.split('\n')).toEqual([
      'A field name is required.',
      'The field rectangle is empty.',
      'A field named "address" already exists.',
    ]);
    // The accessor, not a stored string: an error already sitting in a
    // component's state re-reads the catalog after a language change.
    const es = await inEs(() => err.message);
    expect(es).toContain('El nombre del campo es obligatorio.');
    expect(es).toContain('Ya existe un campo llamado «address».');
    expect(err.message).toContain('A field name is required.');
    expect(err).toBeInstanceOf(Error);
  });
});
