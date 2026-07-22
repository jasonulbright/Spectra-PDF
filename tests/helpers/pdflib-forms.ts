// Test-only pdf-lib AcroForm read/fill over bytes.
//
// Production routes the form read AND fill through the Python engine (FC4b —
// see src/renderer/lib/forms.ts). But several renderer-side tests operate on
// PDF bytes in Node, where the Python sidecar is unavailable, and need to
// enumerate/fill form fields to verify byte-level behaviour that is NOT the
// engine's job: AcroForm carry across structural page ops (acroform-carry),
// on-canvas field authoring (form-authoring), and the overlay's
// fingerprint/rename-family resolution (form-overlay). This helper preserves
// the old pure-over-bytes pdf-lib reader/filler for exactly those fixtures. It
// is scaffolding, never shipped, and produces the same `FormField` shape the
// production engine mapping does, so the tests stay contract-accurate.
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
import type {
  FormField,
  FormFieldType,
  FormFieldValue,
  FormReadResult,
  FormWidgetPlacement,
} from '../../src/renderer/lib/forms';

const EDITABLE_TYPES = new Set<FormFieldType>([
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'optionlist',
]);

function toLoadable(buffer: Uint8Array | ArrayBuffer): Uint8Array {
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
    return null;
  }
  return null;
}

const AF_HIDDEN = 1 << 1;
const AF_NOVIEW = 1 << 5;

function widgetEntries(doc: PDFDocument, field: AnyField): { ref: PDFRef; dict: PDFDict }[] {
  const acroDict = field.acroField.dict;
  const kids = acroDict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids || kids.size() === 0) {
    return [{ ref: field.acroField.ref, dict: acroDict }];
  }
  const out: { ref: PDFRef; dict: PDFDict }[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const raw = kids.get(i);
    if (!(raw instanceof PDFRef)) continue;
    const dict = doc.context.lookup(raw);
    if (!(dict instanceof PDFDict)) continue;
    if (dict.get(PDFName.of('T')) !== undefined) continue;
    out.push({ ref: raw, dict });
  }
  return out;
}

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
    if (!page) continue;
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
        const mapped = hasOpt && /^\d+$/.test(on) ? classified.options?.[Number(on)] : on;
        radioOption =
          mapped !== undefined && (classified.options ?? []).includes(mapped) ? mapped : undefined;
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

function detectXFA(doc: PDFDocument): boolean {
  try {
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    return !!acro && acro.has(PDFName.of('XFA'));
  } catch {
    return false;
  }
}

export async function readFormFields(
  buffer: Uint8Array | ArrayBuffer,
): Promise<FormReadResult> {
  const doc = await PDFDocument.load(toLoadable(buffer), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const hasXFA = detectXFA(doc);
  const form = doc.getForm();
  const fields: FormField[] = [];
  for (const field of form.getFields() as AnyField[]) {
    const c = classify(field);
    if (!c) continue;
    const readOnly = field.isReadOnly();
    let widgets: FormWidgetPlacement[];
    try {
      widgets = widgetPlacements(doc, field, c);
    } catch {
      widgets = [];
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
}

export interface FillOptions {
  flatten?: boolean;
}

export async function fillFormFields(
  buffer: Uint8Array | ArrayBuffer,
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
    if (field.isReadOnly()) continue;
    try {
      applyEdit(field, values[name]);
    } catch (err) {
      throw new Error(`Field "${name}": ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
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
  return doc.save({ updateFieldAppearances: false });
}
