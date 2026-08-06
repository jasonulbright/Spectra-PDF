// On-canvas form-field creation. Pure over bytes like lib/forms.ts —
// pdf-lib authors the field and generates its widget appearance, the caller
// wraps it in the standard renderer-side whole-file-op shape. Signature
// fields are the one hand-rolled case: pdf-lib has no high-level create for
// /FT /Sig, so the widget dict + /AcroForm registration are built at the low
// level (an EMPTY signature field has no appearance stream by convention —
// viewers draw their own affordance; the canvas overlay shows its badge).
//
// CLI-scope boundary (deliberate, recorded so it is never mistaken for an
// overlooked gap): field creation is an
// interactive canvas AUTHORING gesture — the same class as annotations,
// redaction marks, and signature placement, none of which have CLI arms; the
// CLI's forms parity surface is the fill/read/flatten TRANSFORM (the
// `forms` subcommand), which is unchanged by this.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PdfBuffer } from '../state/types';
import type { FieldLock, LockAction } from './signatures';
// The spec problems are USER-FACING copy, so they resolve
// through the catalog. i18n is itself a data module (catalogs + i18next), so
// this file stays pure over bytes and unit-testable with no DOM.
import { tChrome, type UiKey } from '../i18n';

export type NewFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'signature';

/**
 * One choice of a radio group, dropdown or list.
 *
 * The object form carries the option's OWN rectangle. Detection produces four
 * separately drawn circles, and equal cells of one enclosing rectangle cannot
 * express that; a hand-drawn group still passes bare strings and still gets the
 * equal-cell layout.
 */
export type NewFieldOption = string | { label: string; rect?: [number, number, number, number] };

export interface NewFieldSpec {
  name: string;
  type: NewFieldType;
  pageIndex: number; // 0-based, in the file's COMMITTED page order
  rect: [number, number, number, number]; // PDF user-space points, bottom-up
  options?: NewFieldOption[]; // radio / dropdown / optionlist
  multiline?: boolean; // text only
  comb?: boolean; // text only; requires maxLength and excludes multiline
  maxLength?: number; // text only
  /** The `/Lock` seed, signature fields only: what whoever signs this field
   * later is bound by. Its names may be the document's existing fields or the
   * batch's own — a form laid out in one pass locks the fields laid out with
   * it. */
  lock?: FieldLock | null;
}

/** Wire action → the PDF name the `/Lock` dictionary carries. A table, not a
 * computation: an action this build does not know must not become a name. */
const LOCK_PDF_NAME = {
  all: 'All',
  include: 'Include',
  exclude: 'Exclude',
} as const satisfies Record<LockAction, string>;

/** Whether this action's meaning depends on the field list. */
function lockListed(action: LockAction): boolean {
  return action === 'include' || action === 'exclude';
}

const CHOICE_TYPES: ReadonlySet<NewFieldType> = new Set(['radio', 'dropdown', 'optionlist']);

interface ResolvedOption {
  label: string;
  rect?: [number, number, number, number];
}

function resolveOptions(options: readonly NewFieldOption[] | undefined): ResolvedOption[] {
  return (options ?? [])
    .map((o) => (typeof o === 'string' ? { label: o.trim() } : { label: o.label.trim(), rect: o.rect }))
    .filter((o) => o.label.length > 0);
}

/** One validation problem, held as its KEY plus its values rather than as a
 * rendered sentence — see FieldSpecError. `field` names the spec it belongs to,
 * because a batch reports every problem at once and a bare sentence would not
 * say which of forty fields it is about. */
interface FieldProblem {
  key: UiKey;
  vars?: Record<string, string | number>;
  field?: string;
}

/**
 * The refusal `addFormField` throws when a spec is invalid.
 *
 * Two properties:
 *   • the problems are reported ALL AT ONCE (the engine ops' fail-closed
 *     posture), and each is its OWN catalog key. Nothing glues several
 *     sentences into one key — a joined message would carry several
 *     unrelated grammars and be untranslatable as a unit.
 *   • `message` is an ACCESSOR (the EngineError precedent), so a refusal
 *     already sitting in a component's state follows a LIVE language switch.
 *     The join is a NEWLINE — a separator with no language of its own; the
 *     display sinks collapse it to a space exactly as the old ' '.join did.
 */
export class FieldSpecError extends Error {
  readonly problems: readonly FieldProblem[];

  constructor(problems: readonly FieldProblem[]) {
    // No argument: `Error(undefined)` defines no own `message`, leaving the
    // accessor below as the only one.
    super();
    this.problems = problems;
    this.name = 'FieldSpecError';
    Object.defineProperty(this, 'message', {
      get: () =>
        problems
          .map((p) => {
            const problem = tChrome(p.key, p.vars);
            return p.field ? tChrome('refusal.field.inField', { field: p.field, problem }) : problem;
          })
          .join('\n'),
      configurable: true,
      enumerable: false,
    });
    if (typeof this.stack === 'string') {
      const [, ...rest] = this.stack.split('\n');
      this.stack = [`FieldSpecError: ${this.message}`, ...rest].join('\n');
    }
  }
}

// The /T of every TOP-LEVEL /AcroForm /Fields entry — including non-terminal
// hierarchy parents, which pdf-lib's getFields() (terminal-only) cannot see.
// Every field this module creates is a new top-level root, so top level is
// the only place a collision can occur; the regression gap was exactly a
// signature field (the hand-rolled path, which bypasses pdf-lib's own
// FieldAlreadyExistsError machinery) landing beside a same-named parent node
// — two same-/T siblings, which the spec forbids.
function topLevelFieldNames(doc: PDFDocument): Set<string> {
  const names = new Set<string>();
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return names;
  for (let i = 0; i < fields.size(); i++) {
    const entry = fields.get(i);
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) continue;
    // /T may itself be stored indirectly (theoretical — no real authoring
    // tool does it, review-noted); resolve one level like /Encoding gets.
    let t = dict.get(PDFName.of('T'));
    if (t instanceof PDFRef) t = doc.context.lookup(t);
    if (t instanceof PDFString || t instanceof PDFHexString) names.add(t.decodeText());
  }
  return names;
}

// Validate the whole batch against the document BEFORE any mutation
// (fail-closed, everything reported at once — the engine ops' posture). The
// name set grows as the batch is checked, so two specs that would collide with
// each other are caught here rather than half-way through the writing, where
// the document would already carry the fields created before the throw.
/** Every name a lock in this batch may choose from: the document's own fields
 * plus the batch's, since laying out a form and locking what was laid out is
 * one gesture. `getFields()` is terminal-only, so the raw top-level walk
 * contributes the hierarchy parents it cannot see. */
function lockableNames(doc: PDFDocument, specs: readonly NewFieldSpec[]): Set<string> {
  const names = topLevelFieldNames(doc);
  for (const field of doc.getForm().getFields()) names.add(field.getName());
  for (const spec of specs) {
    const name = spec.name.trim();
    if (name) names.add(name);
  }
  return names;
}

function validateSpecs(doc: PDFDocument, specs: readonly NewFieldSpec[]): void {
  const problems: FieldProblem[] = [];
  const taken = topLevelFieldNames(doc);
  // Only walked when the batch actually carries a lock: the terminal-field walk
  // is work no other rule needs.
  const lockable = specs.some((s) => s.lock) ? lockableNames(doc, specs) : new Set<string>();
  const batch = specs.length > 1;
  specs.forEach((spec, index) => {
    const name = spec.name.trim();
    const field = batch ? name || `#${index + 1}` : undefined;
    const push = (key: UiKey, vars?: Record<string, string | number>): void => {
      problems.push({ key, vars, field });
    };
    if (!name) push('refusal.field.nameRequired');
    // pdf-lib rejects dots itself (hierarchy separator), but with an internal
    // message — say it plainly here.
    if (name.includes('.')) push('refusal.field.nameDot');
    if (spec.pageIndex < 0 || spec.pageIndex >= doc.getPageCount()) {
      push('refusal.field.pageOutOfRange', {
        page: spec.pageIndex + 1,
        count: doc.getPageCount(),
      });
    }
    const [x0, y0, x1, y1] = spec.rect;
    if (!(x1 > x0) || !(y1 > y0)) push('refusal.field.rectEmpty');
    if (CHOICE_TYPES.has(spec.type)) {
      const options = resolveOptions(spec.options);
      if (options.length === 0) {
        push('refusal.field.needsOption');
      } else if (new Set(options.map((o) => o.label)).size !== options.length) {
        push('refusal.field.optionsUnique');
      }
      const placed = options.filter((o) => o.rect).length;
      if (placed > 0 && placed !== options.length) {
        push('refusal.field.optionRectsPartial');
      }
    }
    if (spec.type === 'text') {
      if (spec.comb) {
        if (!spec.maxLength || spec.maxLength <= 0) push('refusal.field.combNeedsMaxLength');
        if (spec.multiline) push('refusal.field.combNotMultiline');
      }
      if (spec.maxLength !== undefined && spec.maxLength <= 0) {
        push('refusal.field.maxLengthPositive');
      }
    }
    const lock = spec.lock ?? null;
    if (lock) {
      if (spec.type !== 'signature') {
        push('refusal.field.lockNotSignature');
      } else if (lock.action === 'all' && lock.fields.length > 0) {
        // `/All` ignores the list, so accepting one would discard the choice.
        push('refusal.field.lockTakesNoFields');
      } else if (lockListed(lock.action) && lock.fields.length === 0) {
        // An include-lock of nothing locks nothing and an exclude-lock of
        // nothing locks everything — opposite meanings for one empty list.
        push('refusal.field.lockNeedsFields');
      } else {
        for (const target of lock.fields) {
          if (target === name) {
            push('refusal.field.lockSelf', { name: target });
          } else if (!lockable.has(target)) {
            // A name the document does not carry locks nothing under `include`
            // and everything-but-a-typo under `exclude` — invisible either way.
            push('refusal.field.lockUnknownField', { name: target });
          }
        }
      }
    }
    if (name) {
      // Duplicate names would make readers treat two fields as one logical
      // field (or violate sibling /T uniqueness outright). Checked against the
      // RAW top-level /Fields — not getFields(), whose terminal-only view
      // misses non-terminal hierarchy parents (regression: the hand-rolled
      // signature path has no pdf-lib backstop and would have created a
      // same-/T sibling next to such a parent).
      if (taken.has(name)) {
        push('refusal.field.nameExists', { name });
      } else {
        taken.add(name);
      }
    }
  });
  // Ensure /AcroForm exists (getForm() lazily creates it, and strips /XFA —
  // the standing pure-AcroForm posture); addSignatureField relies on it.
  doc.getForm();
  if (problems.length > 0) throw new FieldSpecError(problems);
}

/** The `/Lock` (`/SigFieldLock`) dictionary a signature field carries. `all`
 * writes no `/Fields`: the format ignores one there. */
function lockDict(doc: PDFDocument, lock: FieldLock): PDFDict {
  const dict = doc.context.obj({
    Type: 'SigFieldLock',
    Action: LOCK_PDF_NAME[lock.action],
  }) as PDFDict;
  if (lockListed(lock.action)) {
    dict.set(
      PDFName.of('Fields'),
      doc.context.obj(lock.fields.map((name) => PDFHexString.fromText(name))) as PDFArray,
    );
  }
  return dict;
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
  if (spec.lock) {
    widget.set(PDFName.of('Lock'), doc.context.register(lockDict(doc, spec.lock)));
  }
  const ref = doc.context.register(widget);
  fields.push(ref);
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = doc.context.obj([]) as PDFArray;
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
  // A document that can hold signatures advertises it (SigFlags bit 1) —
  // the same recompute rule the carry applies.
  acro.set(PDFName.of('SigFlags'), doc.context.obj(1));
}

function toBox(rect: readonly [number, number, number, number]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const [x0, y0, x1, y1] = rect;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function createField(doc: PDFDocument, spec: NewFieldSpec): void {
  const name = spec.name.trim();
  const box = toBox(spec.rect);
  const page = doc.getPage(spec.pageIndex);
  const form = doc.getForm();
  const options = resolveOptions(spec.options);

  switch (spec.type) {
    case 'text': {
      const field = form.createTextField(name);
      if (spec.multiline) field.enableMultiline();
      // Order matters: combing requires a max length to divide the box into,
      // and pdf-lib refuses `enableCombing` while none is set.
      if (spec.maxLength) field.setMaxLength(spec.maxLength);
      if (spec.comb) field.enableCombing();
      field.addToPage(page, box);
      break;
    }
    case 'checkbox': {
      form.createCheckBox(name).addToPage(page, box);
      break;
    }
    case 'radio': {
      const group = form.createRadioGroup(name);
      const placed = options.every((o) => o.rect);
      if (placed) {
        // Each option was drawn where it is; the enclosing rectangle is only
        // the group's extent.
        for (const option of options) {
          group.addOptionToPage(option.label, page, toBox(option.rect!));
        }
        break;
      }
      // One drawn box, N options: equal horizontal cells, square buttons
      // centered in each cell (a radio option is a small toggle, not a
      // stretch-to-fill band).
      const cellW = box.width / options.length;
      const side = Math.min(cellW * 0.8, box.height * 0.8);
      options.forEach((option, i) => {
        group.addOptionToPage(option.label, page, {
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
      field.addOptions(options.map((o) => o.label));
      field.addToPage(page, box);
      break;
    }
    case 'optionlist': {
      const field = form.createOptionList(name);
      field.setOptions(options.map((o) => o.label));
      field.enableMultiselect();
      field.addToPage(page, box);
      break;
    }
    case 'signature': {
      addSignatureField(doc, spec);
      break;
    }
  }
}

/**
 * Author N new AcroForm fields into the document in ONE pass. Returns the new
 * bytes; throws (with every problem in the batch at once) before any mutation
 * on invalid input.
 *
 * One load and one save for the whole batch is what makes an accepted set of
 * detected fields a single undoable act: per-field loading would put forty
 * entries on the undo stack for one gesture, and each save would re-serialize
 * the document.
 */
export async function addFormFields(
  buffer: PdfBuffer | Uint8Array | ArrayBuffer,
  specs: readonly NewFieldSpec[],
): Promise<Uint8Array> {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer.slice()
      : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer.slice(0))
        : new Uint8Array(buffer as number[]);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  validateSpecs(doc, specs);
  for (const spec of specs) createField(doc, spec);
  return doc.save();
}

/**
 * Author one new AcroForm field. The single-field entry point IS the batch with
 * one spec, so the hand-drawn path and the accepted-candidate path cannot drift
 * apart.
 */
export async function addFormField(
  buffer: PdfBuffer | Uint8Array | ArrayBuffer,
  spec: NewFieldSpec,
): Promise<Uint8Array> {
  return addFormFields(buffer, [spec]);
}
