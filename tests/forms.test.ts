import { describe, expect, it } from 'vitest';
import { mapEngineField, readFormFields } from '../src/renderer/lib/forms';

// FC4b: the GUI form read routes through the Python engine (`read_form_fields`,
// covered by tests/test_forms.py over real bytes) and the renderer's remaining
// job is the pure engine→FormField MAPPING. These tests pin that mapping —
// type classification, value coercion, `editable` derivation, and the
// per-widget geometry shape the on-canvas overlay depends on — with no pdf-lib
// or engine dependency (the engine result is a plain object).

// A convenience for building the raw engine field shape `mapEngineField` maps.
type RawEngineField = Parameters<typeof mapEngineField>[0];
function ef(overrides: Record<string, unknown>): RawEngineField {
  return {
    name: 'f',
    type: 'text',
    value: '',
    read_only: false,
    required: false,
    widgets: [],
    ...overrides,
  } as RawEngineField;
}

describe('mapEngineField — types & values', () => {
  it('maps a text field with multiline and marks it editable', () => {
    const f = mapEngineField(ef({ name: 'notes', type: 'text', value: 'hi', multiline: true }))!;
    expect(f).toMatchObject({
      name: 'notes',
      type: 'text',
      value: 'hi',
      multiline: true,
      editable: true,
    });
  });

  it('coerces a checkbox value to a boolean', () => {
    expect(mapEngineField(ef({ type: 'checkbox', value: true }))!.value).toBe(true);
    expect(mapEngineField(ef({ type: 'checkbox', value: false }))!.value).toBe(false);
    // A non-boolean engine value never leaks through as truthy.
    expect(mapEngineField(ef({ type: 'checkbox', value: null }))!.value).toBe(false);
  });

  it('reshapes an optionlist value into a string array', () => {
    expect(mapEngineField(ef({ type: 'optionlist', value: ['EN', 'ES'] }))!.value).toEqual([
      'EN',
      'ES',
    ]);
    // The engine reports "" for an empty selection and a bare string for one.
    expect(mapEngineField(ef({ type: 'optionlist', value: '' }))!.value).toEqual([]);
    expect(mapEngineField(ef({ type: 'optionlist', value: 'FR' }))!.value).toEqual(['FR']);
  });

  it('keeps radio/dropdown selection as a string and passes options through', () => {
    const r = mapEngineField(ef({ type: 'radio', value: 'blue', options: ['red', 'blue'] }))!;
    expect(r.value).toBe('blue');
    expect(r.options).toEqual(['red', 'blue']);
  });

  it('normalizes a null value for non-fillable button/signature to an empty string', () => {
    expect(mapEngineField(ef({ type: 'button', value: null }))!.value).toBe('');
    expect(mapEngineField(ef({ type: 'signature', value: null }))!.value).toBe('');
  });
});

describe('mapEngineField — editable & signature flags', () => {
  it('marks read-only fields and button/signature as not editable', () => {
    expect(mapEngineField(ef({ type: 'text', read_only: true }))!.editable).toBe(false);
    expect(mapEngineField(ef({ type: 'button', value: null }))!.editable).toBe(false);
    expect(mapEngineField(ef({ type: 'signature', value: null }))!.editable).toBe(false);
  });

  it('carries the signature filled flag and omits it for other types', () => {
    expect(mapEngineField(ef({ type: 'signature', value: null, filled: true }))!.filled).toBe(true);
    expect(mapEngineField(ef({ type: 'signature', value: null, filled: false }))!.filled).toBe(
      false,
    );
    expect(mapEngineField(ef({ type: 'text' }))!.filled).toBeUndefined();
  });

  it('omits a field whose engine type is unclassifiable', () => {
    expect(mapEngineField(ef({ type: 'unknown' }))).toBeNull();
  });
});

describe('mapEngineField — widget geometry', () => {
  it('carries page, rect, hidden, and radio option per widget', () => {
    const f = mapEngineField(
      ef({
        type: 'radio',
        options: ['red', 'blue'],
        widgets: [
          { page: 0, rect: [50, 600, 65, 615], hidden: false, option: 'red' },
          { page: 2, rect: [50, 600, 65, 615], hidden: false, option: 'blue' },
        ],
      }),
    )!;
    expect(f.widgets).toEqual([
      { pageIndex: 0, rect: [50, 600, 65, 615], hidden: false, radioOption: 'red' },
      { pageIndex: 2, rect: [50, 600, 65, 615], hidden: false, radioOption: 'blue' },
    ]);
  });

  it('drops a widget whose page did not resolve (engine page null)', () => {
    const f = mapEngineField(
      ef({
        type: 'text',
        widgets: [
          { page: null, rect: [0, 0, 10, 10], hidden: false },
          { page: 1, rect: [0, 0, 10, 10], hidden: false },
        ],
      }),
    )!;
    expect(f.widgets).toHaveLength(1);
    expect(f.widgets[0].pageIndex).toBe(1);
  });

  it('marks a hidden widget so the overlay offers no input over it', () => {
    const f = mapEngineField(
      ef({ type: 'text', widgets: [{ page: 0, rect: [0, 0, 10, 10], hidden: true }] }),
    )!;
    expect(f.widgets[0].hidden).toBe(true);
  });

  it('leaves radioOption undefined when the engine reports no option', () => {
    const f = mapEngineField(
      ef({ type: 'radio', options: [], widgets: [{ page: 0, rect: [0, 0, 10, 10], hidden: false }] }),
    )!;
    expect(f.widgets[0].radioOption).toBeUndefined();
  });
});

describe('readFormFields — engine wiring', () => {
  it('calls the engine read op and maps the result, dropping unclassifiable fields', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const call = async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return {
        has_xfa: true,
        fields: [
          ef({ name: 'a', type: 'text', value: 'x' }),
          ef({ name: 'b', type: 'unknown' }),
        ],
      };
    };
    const { fields, hasXFA } = await readFormFields(call, '/w/copy.pdf');
    expect(calls).toEqual([{ method: 'read_form_fields', params: { file: '/w/copy.pdf' } }]);
    expect(hasXFA).toBe(true);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'a', value: 'x' });
  });

  it('tolerates an engine result with no fields', async () => {
    const call = async () => ({});
    const { fields, hasXFA } = await readFormFields(call, '/w/copy.pdf');
    expect(fields).toEqual([]);
    expect(hasXFA).toBe(false);
  });
});
