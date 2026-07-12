// On-canvas form-field creation (2n.4c). Pure over bytes like lib/forms.ts —
// pdf-lib authors the field and generates its widget appearance, the caller
// wraps it in the standard renderer-side whole-file-op shape. Signature
// fields are the one hand-rolled case: pdf-lib has no high-level create for
// /FT /Sig, so the widget dict + /AcroForm registration are built at the low
// level (an EMPTY signature field has no appearance stream by convention —
// viewers draw their own affordance; the canvas overlay shows its badge).
//
// CLI-scope boundary (deliberate, recorded like 2m's OCR-recognition note so
// it is never mistaken for an overlooked gap): field creation is an
// interactive canvas AUTHORING gesture — the same class as annotations,
// redaction marks, and signature placement, none of which have CLI arms; the
// CLI's forms parity surface is the fill/read/flatten TRANSFORM (2l's
// `forms` subcommand), which is unchanged by this.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import type { PdfBuffer } from '../state/types';

export type NewFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'signature';

export interface NewFieldSpec {
  name: string;
  type: NewFieldType;
  pageIndex: number; // 0-based, in the file's COMMITTED page order
  rect: [number, number, number, number]; // PDF user-space points, bottom-up
  options?: string[]; // radio / dropdown / optionlist
  multiline?: boolean; // text only
}

const CHOICE_TYPES: ReadonlySet<NewFieldType> = new Set(['radio', 'dropdown', 'optionlist']);

// Validate a spec against the document BEFORE any mutation (fail-closed,
// everything reported at once — the engine ops' posture).
function validateSpec(doc: PDFDocument, spec: NewFieldSpec): void {
  const problems: string[] = [];
  const name = spec.name.trim();
  if (!name) problems.push('A field name is required.');
  // pdf-lib rejects dots itself (hierarchy separator), but with an internal
  // message — say it plainly here.
  if (name.includes('.')) problems.push('Field names cannot contain "." (it separates parent and child names).');
  if (spec.pageIndex < 0 || spec.pageIndex >= doc.getPageCount()) {
    problems.push(`Page ${spec.pageIndex + 1} is out of range (1-${doc.getPageCount()}).`);
  }
  const [x0, y0, x1, y1] = spec.rect;
  if (!(x1 > x0) || !(y1 > y0)) problems.push('The field rectangle is empty.');
  if (CHOICE_TYPES.has(spec.type)) {
    const options = (spec.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (options.length === 0) {
      problems.push('This field type needs at least one option.');
    } else if (new Set(options).size !== options.length) {
      problems.push('Options must be unique.');
    }
  }
  if (name) {
    // Duplicate fully-qualified names would make readers treat two fields as
    // one logical field. getFields() enumerates every terminal field.
    const existing = doc.getForm().getFields();
    if (existing.some((f) => f.getName() === name)) {
      problems.push(`A field named "${name}" already exists.`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join(' '));
}

function addSignatureField(doc: PDFDocument, spec: NewFieldSpec): void {
  // getForm() ensured /AcroForm exists (validateSpec already called it).
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)!;
  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = doc.context.obj([]) as PDFArray;
    acro.set(PDFName.of('Fields'), fields);
  }
  const page = doc.getPage(spec.pageIndex);
  const widget = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [...spec.rect],
    F: 4, // print
    P: page.ref,
  }) as PDFDict;
  widget.set(PDFName.of('T'), PDFHexString.fromText(spec.name.trim()));
  const ref = doc.context.register(widget);
  fields.push(ref);
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = doc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
  // A document that can hold signatures advertises it (SigFlags bit 1) —
  // the same recompute rule the 2n.4a carry applies.
  acro.set(PDFName.of('SigFlags'), doc.context.obj(1));
}

/**
 * Author one new AcroForm field into the document. Returns the new bytes;
 * throws (with every problem at once) before any mutation on invalid input.
 * A drawn radio group lays its options out left-to-right in equal cells of
 * the placed rectangle.
 */
export async function addFormField(
  buffer: PdfBuffer | Uint8Array | ArrayBuffer,
  spec: NewFieldSpec,
): Promise<Uint8Array> {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer.slice()
      : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer.slice(0))
        : new Uint8Array(buffer as number[]);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  validateSpec(doc, spec);

  const name = spec.name.trim();
  const [x0, y0, x1, y1] = spec.rect;
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const page = doc.getPage(spec.pageIndex);
  const form = doc.getForm();
  const options = (spec.options ?? []).map((o) => o.trim()).filter(Boolean);

  switch (spec.type) {
    case 'text': {
      const field = form.createTextField(name);
      if (spec.multiline) field.enableMultiline();
      field.addToPage(page, box);
      break;
    }
    case 'checkbox': {
      form.createCheckBox(name).addToPage(page, box);
      break;
    }
    case 'radio': {
      // One drawn box, N options: equal horizontal cells, square buttons
      // centered in each cell (a radio option is a small toggle, not a
      // stretch-to-fill band).
      const group = form.createRadioGroup(name);
      const cellW = box.width / options.length;
      const side = Math.min(cellW * 0.8, box.height * 0.8);
      options.forEach((option, i) => {
        group.addOptionToPage(option, page, {
          x: box.x + i * cellW + (cellW - side) / 2,
          y: box.y + (box.height - side) / 2,
          width: side,
          height: side,
        });
      });
      break;
    }
    case 'dropdown': {
      const field = form.createDropdown(name);
      field.addOptions(options);
      field.addToPage(page, box);
      break;
    }
    case 'optionlist': {
      const field = form.createOptionList(name);
      field.setOptions(options);
      field.enableMultiselect();
      field.addToPage(page, box);
      break;
    }
    case 'signature': {
      addSignatureField(doc, spec);
      break;
    }
  }
  return doc.save();
}
