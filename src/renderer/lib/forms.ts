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
  PDFArray,
  PDFRef,
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

// One widget annotation of a field, located on a page (2n.4b — the on-canvas
// overlay's geometry source). `rect` is the raw PDF user-space /Rect
// [x0,y0,x1,y1]; the overlay projects it into display space with the same
// pdfRectToDisplay + in-memory-rotation recipe Find words use.
export interface FormWidgetPlacement {
  pageIndex: number; // 0-based index into the FILE's pages
  rect: [number, number, number, number];
  // radio only: the option (from FormField.options) THIS widget selects when
  // clicked — pdf-lib-authored radios use /Opt-indexed on-states ('/0'),
  // others use the on-state name itself.
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
  // Whether THIS slice can fill it: a supported input kind and not read-only.
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

// Widget /F flags (1-based bit positions per the PDF spec, as masks).
const AF_HIDDEN = 1 << 1;
const AF_NOVIEW = 1 << 5;

// The widget entries (ref + dict) a field draws through: the field dict
// itself when merged (no /Kids), else its ref-valued /Kids that carry no /T
// of their own (a /T-carrying kid is a sub-FIELD — pdf-lib's own field
// enumeration doesn't descend into a typed terminal's kids, so neither do
// we; same posture as engine/forms.py's widget rule from 2l).
function widgetEntries(doc: PDFDocument, field: AnyField): { ref: PDFRef; dict: PDFDict }[] {
  const acroDict = field.acroField.dict;
  const kids = acroDict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids || kids.size() === 0) {
    return [{ ref: field.acroField.ref, dict: acroDict }];
  }
  const out: { ref: PDFRef; dict: PDFDict }[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const raw = kids.get(i);
    if (!(raw instanceof PDFRef)) continue; // a widget must be indirect to sit in /Annots
    const dict = doc.context.lookup(raw);
    if (!(dict instanceof PDFDict)) continue;
    if (dict.get(PDFName.of('T')) !== undefined) continue;
    out.push({ ref: raw, dict });
  }
  return out;
}

// The on-state name a radio widget selects (the non-/Off key of its /AP /N).
function widgetOnState(doc: PDFDocument, dict: PDFDict): string | null {
  const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
  const n = ap?.lookupMaybe(PDFName.of('N'), PDFDict);
  if (!n) return null;
  for (const [key] of n.entries()) {
    const name = key.decodeText();
    if (name !== 'Off') return name;
  }
  return null;
}

function widgetPlacements(
  doc: PDFDocument,
  field: AnyField,
  classified: Classified,
): FormWidgetPlacement[] {
  const pages = doc.getPages();
  const hasOpt = field.acroField.dict.get(PDFName.of('Opt')) !== undefined;
  const out: FormWidgetPlacement[] = [];
  for (const { ref, dict } of widgetEntries(doc, field)) {
    const page = doc.findPageForAnnotationRef(ref);
    if (!page) continue; // widget reachable from no page — nothing to place
    const pageIndex = pages.indexOf(page);
    if (pageIndex < 0) continue;
    const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!rectArr || rectArr.size() !== 4) continue;
    let nums: number[];
    try {
      nums = [0, 1, 2, 3].map((i) => (rectArr.lookup(i) as import('pdf-lib').PDFNumber).asNumber());
    } catch {
      continue;
    }
    const rect: [number, number, number, number] = [
      Math.min(nums[0], nums[2]),
      Math.min(nums[1], nums[3]),
      Math.max(nums[0], nums[2]),
      Math.max(nums[1], nums[3]),
    ];
    let flags: number;
    try {
      const f = dict.get(PDFName.of('F'));
      flags = f ? (f as import('pdf-lib').PDFNumber).asNumber() : 0;
    } catch {
      flags = 0;
    }
    let radioOption: string | undefined;
    if (classified.type === 'radio') {
      const on = widgetOnState(doc, dict);
      if (on !== null) {
        // pdf-lib-authored radios use /Opt-indexed on-states ('0', '1', …);
        // others use the option name itself (engine/forms.py's convention
        // note from 2l).
        radioOption =
          hasOpt && /^\d+$/.test(on) ? classified.options?.[Number(on)] ?? on : on;
      }
    }
    out.push({
      pageIndex,
      rect,
      ...(radioOption !== undefined ? { radioOption } : {}),
      hidden: (flags & (AF_HIDDEN | AF_NOVIEW)) !== 0,
    });
  }
  return out;
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
    let widgets: FormWidgetPlacement[];
    try {
      widgets = widgetPlacements(doc, field, c);
    } catch {
      widgets = []; // geometry probing must never sink the field list
    }
    fields.push({
      name: field.getName(),
      type: c.type,
      value: c.value,
      ...(c.options ? { options: c.options } : {}),
      readOnly,
      required: field.isRequired(),
      ...(c.multiline !== undefined ? { multiline: c.multiline } : {}),
      editable: EDITABLE_TYPES.has(c.type) && !readOnly,
      widgets,
      ...(c.type === 'signature'
        ? { filled: field.acroField.dict.get(PDFName.of('V')) !== undefined }
        : {}),
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
