// AcroForm read/fill via pdf-lib. Pure over bytes (no React, no Tauri) so
// it unit-tests directly. This is the renderer's first whole-file op that
// does NOT call the Python engine: pdf-lib's PDFForm regenerates field
// widget appearance streams on fill (pikepdf has no appearance-generation
// API), which is why the roadmap assigns forms to pdf-lib. The panel wraps
// these in the standard snapshot -> transform -> write -> reload -> UPDATE_FILE
// whole-file-op shape. See docs/architecture/08-phase2f-forms.md.
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFButton,
  PDFSignature,
} from 'pdf-lib';
import type { PdfBuffer } from '../state/types';

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

export interface FormField {
  name: string;
  type: FormFieldType;
  value: FormFieldValue;
  options?: string[]; // radio / dropdown / optionlist
  readOnly: boolean;
  required: boolean;
  multiline?: boolean; // text only
  // Whether THIS slice can fill it: a supported input kind and not read-only.
  // buttons/signatures are always false; so are read-only fields of any kind.
  editable: boolean;
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

// Copy before handing to pdf-lib. pdf-lib (unlike pdf.js's worker) doesn't
// transfer/detach, but state buffers are shared and the copy is cheap for
// form-sized PDFs — defensive against the shared-buffer invariant.
function toLoadable(buffer: PdfBuffer | Uint8Array | ArrayBuffer): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer.slice();
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer.slice(0));
  return new Uint8Array(buffer as number[]);
}

type AnyField =
  | PDFTextField
  | PDFCheckBox
  | PDFRadioGroup
  | PDFDropdown
  | PDFOptionList
  | PDFButton
  | PDFSignature;

interface Classified {
  type: FormFieldType;
  value: FormFieldValue;
  options?: string[];
  multiline?: boolean;
}

function classify(field: AnyField): Classified | null {
  try {
    if (field instanceof PDFTextField) {
      // getText() throws on rich-text (XFA) fields — treat as empty.
      let text = '';
      try {
        text = field.getText() ?? '';
      } catch {
        text = '';
      }
      return { type: 'text', value: text, multiline: field.isMultiline() };
    }
    if (field instanceof PDFCheckBox) return { type: 'checkbox', value: field.isChecked() };
    if (field instanceof PDFRadioGroup) {
      return { type: 'radio', value: field.getSelected() ?? '', options: field.getOptions() };
    }
    if (field instanceof PDFDropdown) {
      return { type: 'dropdown', value: field.getSelected()[0] ?? '', options: field.getOptions() };
    }
    if (field instanceof PDFOptionList) {
      return { type: 'optionlist', value: field.getSelected(), options: field.getOptions() };
    }
    if (field instanceof PDFButton) return { type: 'button', value: '' };
    if (field instanceof PDFSignature) return { type: 'signature', value: '' };
  } catch {
    return null; // any pdf-lib probing failure — omit rather than surface a broken field
  }
  return null;
}

// pdf-lib's PDFDocument.getForm() proactively DELETES any /XFA (it warns
// "does not support reading or writing XFA"), so form.hasXFA() is always
// false after that call. Detect it off the raw AcroForm dict first — this is
// the read-side signal the panel warns on. (On the fill side, that same
// auto-delete means our saved output is always a pure-AcroForm PDF: an XFA
// dynamic form is reduced to its AcroForm fallback. Documented, not a bug.)
function detectXFA(doc: PDFDocument): boolean {
  try {
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    return !!acro && acro.has(PDFName.of('XFA'));
  } catch {
    return false;
  }
}

export async function readFormFields(
  buffer: PdfBuffer | Uint8Array | ArrayBuffer,
): Promise<FormReadResult> {
  const doc = await PDFDocument.load(toLoadable(buffer), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const hasXFA = detectXFA(doc); // BEFORE getForm(), which strips XFA
  const form = doc.getForm(); // lazily creates an empty AcroForm for non-forms; getFields() is then []
  const fields: FormField[] = [];
  for (const field of form.getFields() as AnyField[]) {
    const c = classify(field);
    if (!c) continue;
    const readOnly = field.isReadOnly();
    fields.push({
      name: field.getName(),
      type: c.type,
      value: c.value,
      ...(c.options ? { options: c.options } : {}),
      readOnly,
      required: field.isRequired(),
      ...(c.multiline !== undefined ? { multiline: c.multiline } : {}),
      editable: EDITABLE_TYPES.has(c.type) && !readOnly,
    });
  }
  return { fields, hasXFA };
}

// Apply one desired value to a field via its typed setter. Values are
// constrained to a field's own options by the panel's controls; we still
// guard here so an out-of-range option is skipped rather than thrown
// (pdf-lib's select() throws on an unknown option).
function applyEdit(field: AnyField, value: FormFieldValue): void {
  if (field instanceof PDFTextField) {
    field.setText(typeof value === 'string' ? value : String(value ?? ''));
    return;
  }
  if (field instanceof PDFCheckBox) {
    if (value) field.check();
    else field.uncheck();
    return;
  }
  if (field instanceof PDFRadioGroup) {
    const sel = typeof value === 'string' ? value : '';
    if (!sel) field.clear();
    else if (field.getOptions().includes(sel)) field.select(sel);
    return;
  }
  if (field instanceof PDFDropdown) {
    const sel = Array.isArray(value) ? value[0] ?? '' : typeof value === 'string' ? value : '';
    if (!sel) field.clear();
    else if (field.getOptions().includes(sel)) field.select(sel);
    return;
  }
  if (field instanceof PDFOptionList) {
    const arr = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const valid = arr.filter((o) => field.getOptions().includes(o));
    if (!valid.length) field.clear();
    else field.select(valid);
    return;
  }
  // button / signature — no fillable value in this slice.
}

export interface FillOptions {
  flatten?: boolean;
}

export async function fillFormFields(
  buffer: PdfBuffer | Uint8Array | ArrayBuffer,
  values: Record<string, FormFieldValue>,
  options: FillOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(toLoadable(buffer), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const form = doc.getForm();
  for (const field of form.getFields() as AnyField[]) {
    const name = field.getName();
    if (!(name in values)) continue;
    if (field.isReadOnly()) continue; // never fill a read-only field
    try {
      applyEdit(field, values[name]);
    } catch (err) {
      throw new Error(
        `Field "${name}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  // Appearance regeneration is where exotic forms/values fail (WinAnsi-only
  // default font; unparseable /DR fonts). flatten() also regenerates before
  // baking, so both branches funnel through the same guard, and the working
  // copy is never overwritten with a half-updated file (the caller only
  // writes on success).
  try {
    if (options.flatten) form.flatten();
    else form.updateFieldAppearances();
  } catch (err) {
    throw new Error(
      'Could not regenerate form field appearances — a value may contain characters ' +
        'outside the Latin-1 set, or the form uses a font that cannot be rendered. ' +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  // Appearances already handled above; don't let save() redo them.
  return doc.save({ updateFieldAppearances: false });
}
