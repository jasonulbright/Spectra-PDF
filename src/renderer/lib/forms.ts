// AcroForm read via the Python engine (`read_form_fields`). Since FC4b (§I.0
// S1/S6) the GUI read and fill share ONE implementation — the engine — so the
// side panel and the on-canvas overlay see exactly what the CLI does, including
// nested/typed-terminal widgets the old renderer-side pdf-lib enumeration
// skipped. The fill also routes through the engine (`fill_form_fields`,
// Unicode-capable + multi-select). This module is now just the read call plus
// the pure engine→FormField MAPPING; the field-value/geometry TYPES it exports
// are the shared contract consumed by the FormsPanel, the canvas overlay
// (form-overlay.ts), and the fill fingerprint machinery. See
// docs/architecture/08-phase2f-forms.md and 24-phase9 § FC4.
import type { EngineCall } from './engine-call';

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'button'
  | 'signature';

// text -> string; checkbox -> boolean; radio/dropdown -> selected string ('' =
// none); optionlist -> selected strings.
export type FormFieldValue = string | boolean | string[];

// One widget annotation of a field, located on a page (2n.4b — the on-canvas
// overlay's geometry source). `rect` is the raw PDF user-space /Rect
// [x0,y0,x1,y1]; the overlay projects it into display space with the same
// pdfRectToDisplay + in-memory-rotation recipe Find words use.
export interface FormWidgetPlacement {
  pageIndex: number; // 0-based index into the FILE's pages
  rect: [number, number, number, number];
  // radio only: the option (from FormField.options) THIS widget selects when
  // clicked — engine /Opt-indexed radios map their index on-state ('0') back
  // to the display string; others use the on-state name itself.
  radioOption?: string;
  // /F Hidden or NoView — the overlay must not offer an input where the
  // raster shows nothing.
  hidden: boolean;
}

export interface FormField {
  name: string;
  type: FormFieldType;
  value: FormFieldValue;
  options?: string[]; // radio / dropdown / optionlist
  readOnly: boolean;
  required: boolean;
  multiline?: boolean; // text only
  // Whether this field can be filled: a supported input kind and not read-only.
  // buttons/signatures are always false; so are read-only fields of any kind.
  editable: boolean;
  // Where this field's widgets sit (empty for a pure-data field with no page
  // presence). A widget whose page couldn't be resolved is omitted.
  widgets: FormWidgetPlacement[];
  // signature only: the field already holds a signature (/V present).
  filled?: boolean;
}

export interface FormReadResult {
  fields: FormField[];
  hasXFA: boolean;
}

const EDITABLE_TYPES = new Set<FormFieldType>([
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'optionlist',
]);

const FIELD_TYPES = new Set<FormFieldType>([
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'optionlist',
  'button',
  'signature',
]);

// The raw shapes the engine `read_form_fields` op returns over JSON-RPC.
interface EngineWidget {
  page: number | null;
  rect: [number, number, number, number] | number[];
  hidden?: boolean;
  option?: string; // radio only
}
interface EngineField {
  name: string;
  type: string;
  value: string | boolean | string[] | null;
  options?: string[];
  read_only: boolean;
  required: boolean;
  multiline?: boolean;
  filled?: boolean;
  widgets?: EngineWidget[];
}
interface EngineReadResult {
  has_xfa?: boolean;
  fields?: EngineField[];
}

// Coerce the engine `value` into the FormFieldValue the field's type expects.
// The engine already returns the right JSON kind for most types; the only
// reshaping is optionlist (the engine reports "" for an empty selection and a
// bare string for a single item — the panel/overlay want string[]) and the
// non-fillable button/signature (null -> '').
function coerceValue(type: FormFieldType, raw: EngineField['value']): FormFieldValue {
  if (type === 'checkbox') return raw === true;
  if (type === 'optionlist') {
    if (Array.isArray(raw)) return raw.map((v) => String(v));
    if (typeof raw === 'string' && raw) return [raw];
    return [];
  }
  // text / radio / dropdown / button / signature — a string ('' when null).
  if (typeof raw === 'string') return raw;
  return '';
}

// Map one engine field to a FormField, or null when its type is unclassifiable
// (engine 'unknown') — omitted, the same fate the old pdf-lib read gave a field
// it couldn't classify. `editable` is derived here (a supported kind and not
// read-only) rather than sent by the engine, keeping the classification of
// "fillable" in one place. Widgets whose page didn't resolve (engine page null)
// are dropped: there is nothing to project on the canvas.
export function mapEngineField(ef: EngineField): FormField | null {
  const type = ef.type as FormFieldType;
  if (!FIELD_TYPES.has(type)) return null;
  const readOnly = Boolean(ef.read_only);
  const widgets: FormWidgetPlacement[] = [];
  for (const w of ef.widgets ?? []) {
    if (w.page === null || w.page === undefined) continue;
    const r = w.rect;
    if (!Array.isArray(r) || r.length !== 4) continue;
    widgets.push({
      pageIndex: w.page,
      rect: [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3])],
      hidden: Boolean(w.hidden),
      ...(typeof w.option === 'string' ? { radioOption: w.option } : {}),
    });
  }
  return {
    name: ef.name,
    type,
    value: coerceValue(type, ef.value),
    ...(ef.options ? { options: ef.options } : {}),
    readOnly,
    required: Boolean(ef.required),
    ...(ef.multiline !== undefined ? { multiline: Boolean(ef.multiline) } : {}),
    editable: EDITABLE_TYPES.has(type) && !readOnly,
    widgets,
    ...(type === 'signature' ? { filled: Boolean(ef.filled) } : {}),
  };
}

// Read a file's AcroForm fields through the engine. `call` is the engine
// invoker (`useEngine`'s `call`/`callRaw`); `read_form_fields` is registered as
// an INTERNAL method, so it never runs the commit gate — a passive overlay read
// must not flush the user's pending page edits to disk. `path` is the file's
// WORKING copy, whose bytes always equal the in-memory buffer the canvas
// renders from (page-tier edits touch neither until commit), so fields read
// here stay consistent with geometry resolved from that buffer's pdf.js proxy.
export async function readFormFields(call: EngineCall, path: string): Promise<FormReadResult> {
  const res = (await call('read_form_fields', { file: path })) as unknown as EngineReadResult;
  const fields: FormField[] = [];
  for (const ef of res.fields ?? []) {
    const mapped = mapEngineField(ef);
    if (mapped) fields.push(mapped);
  }
  return { fields, hasXFA: Boolean(res.has_xfa) };
}
