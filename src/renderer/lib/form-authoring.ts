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
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  adjustDimsForRotation,
  componentsToColor,
  degrees,
  drawRectangle,
  reduceRotation,
  rotateInPlace,
  type PDFOperator,
  type PDFOptionList,
  type PDFWidgetAnnotation,
} from 'pdf-lib';
import type { PdfBuffer } from '../state/types';
import type { FieldLock, LockAction } from './signatures';
import {
  CALCULATE_TYPES,
  CycleError,
  EmitError,
  FORMAT_TYPES,
  VALIDATE_TYPES,
  calculateInputs,
  calculationOrder,
  emittedScripts,
  resolves,
  scriptInputs,
  type EmitProblem,
  type FieldCalculate,
  type FieldFormat,
  type FieldValidate,
} from './af-emit';
import {
  effectiveFieldWriting,
  needsChoiceAppearance,
  resolveOptions,
  writesTextRun,
  type FieldScript,
} from './form-writing';
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
  /** What the page SHOWS for the stored value — the `/AA /F` + `/K` pair, in
   * the stock call shapes every other viewer executes. */
  format?: FieldFormat;
  /** `/AA /V`: the range a typed value must fall in. */
  validate?: FieldValidate;
  /** `/AA /C`, plus an entry in `/AcroForm /CO` ordered so this field lands
   * after everything it reads. */
  calculate?: FieldCalculate;
  /** `/DV` — what a form reset restores this field to. */
  defaultValue?: string | boolean | string[];
  /** A column rather than a line. pdf-lib cannot write the CID-keyed font a
   * column needs, so this key does not change what THIS module writes — it
   * states which created fields the caller still has to bind through the
   * engine. Absent is horizontal. */
  writingMode?: 'vertical';
  /** The character collection a vertical field's font is bound to. Required
   * with `writingMode`, refused without it. */
  script?: FieldScript;
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

/** The emitter states a CONDITION; each half of the twin renders it in its own
 * vocabulary. A table, so a new condition cannot reach the user unrendered. */
const EMIT_KEY = {
  formatUnknown: 'refusal.field.formatUnknown',
  decimalsRange: 'refusal.field.formatSetting',
  sepStyleRange: 'refusal.field.formatSetting',
  negStyleRange: 'refusal.field.formatSetting',
  specialRange: 'refusal.field.formatSetting',
  maskRequired: 'refusal.field.maskRequired',
  rangeNeedsBound: 'refusal.field.rangeNeedsBound',
  rangeNotNumber: 'refusal.field.rangeNotNumber',
  rangeInverted: 'refusal.field.rangeInverted',
  calcUnknown: 'refusal.field.calcUnknown',
  calcNeedsFields: 'refusal.field.calcNeedsFields',
  sfnEmpty: 'refusal.field.sfnEmpty',
  sfnUnreadable: 'refusal.field.sfnUnreadable',
} as const satisfies Record<EmitProblem, UiKey>;

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

function decodeName(value: unknown): string | null {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
}

/** Fully-qualified name → field dictionary for every node of the `/Fields`
 * forest, INTERIOR NODES INCLUDED: `/CO` may legally reference any field that
 * carries a `/C`, and a calculation may name a parent, which contributes every
 * terminal beneath it. `getFields()` is terminal-only and cannot see either. */
function fieldForest(doc: PDFDocument): Map<string, PDFDict> {
  const out = new Map<string, PDFDict>();
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return out;
  const walk = (entry: unknown, prefix: string, depth: number): void => {
    if (depth > MAX_FIELD_DEPTH) return;
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) return;
    let t = dict.get(PDFName.of('T'));
    if (t instanceof PDFRef) t = doc.context.lookup(t);
    const own = decodeName(t);
    const name = own === null ? prefix : prefix ? `${prefix}.${own}` : own;
    if (name && !out.has(name)) out.set(name, dict);
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; i < (kids?.size() ?? 0); i++) walk(kids!.get(i), name, depth + 1);
  };
  for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '', 0);
  return out;
}

const MAX_FIELD_DEPTH = 32;

/** The document's own `/CO` order and, for each entry, the names its calculate
 * script reads. An entry whose script this app does not recognize contributes
 * no edge: nothing here can say what it reads. */
function existingCalculations(doc: PDFDocument): {
  order: string[];
  inputs: Map<string, string[]>;
  forest: Map<string, PDFDict>;
} {
  const forest = fieldForest(doc);
  const byDict = new Map<PDFDict, string>();
  for (const [name, dict] of forest) if (!byDict.has(dict)) byDict.set(dict, name);
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const co = acro?.lookupMaybe(PDFName.of('CO'), PDFArray);
  const order: string[] = [];
  const inputs = new Map<string, string[]>();
  for (let i = 0; i < (co?.size() ?? 0); i++) {
    const entry = co!.get(i);
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) continue;
    const name = byDict.get(dict);
    if (name === undefined) continue;
    order.push(name);
    const js = calculateSourceOf(doc, dict);
    if (js !== null) inputs.set(name, scriptInputs(js));
  }
  return { order, inputs, forest };
}

/** The raw `/AA /C` JavaScript a field carries, or null. */
function calculateSourceOf(doc: PDFDocument, dict: PDFDict): string | null {
  const aa = dict.lookupMaybe(PDFName.of('AA'), PDFDict);
  const action = aa?.lookupMaybe(PDFName.of('C'), PDFDict);
  const js = action?.get(PDFName.of('JS'));
  const resolved = js instanceof PDFRef ? doc.context.lookup(js) : js;
  return decodeName(resolved);
}

/** `[(name, [input names])]` for every spec that carries a calculation, in
 * authoring order — the batch half of the topological sort. */
function batchCalculations(specs: readonly NewFieldSpec[]): [string, string[]][] {
  const entries: [string, string[]][] = [];
  for (const spec of specs) {
    const name = spec.name.trim();
    if (!spec.calculate || !name) continue;
    try {
      entries.push([name, calculateInputs(spec.calculate)]);
    } catch {
      // The emission problem is reported on its own row; an unreadable
      // calculation contributes no ordering edge.
    }
  }
  return entries;
}

function validateSpecs(doc: PDFDocument, specs: readonly NewFieldSpec[]): void {
  const problems: FieldProblem[] = [];
  const taken = topLevelFieldNames(doc);
  // Only walked when the batch actually carries a lock: the terminal-field walk
  // is work no other rule needs.
  const lockable = specs.some((s) => s.lock) ? lockableNames(doc, specs) : new Set<string>();
  // What a calculation may name: the same set a lock may name, plus the
  // document's interior nodes — a calculation naming a parent contributes
  // every terminal beneath it, which `getFields()` alone cannot see.
  const calcKnown = specs.some((s) => s.calculate)
    ? new Set([...lockableNames(doc, specs), ...fieldForest(doc).keys()])
    : new Set<string>();
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
    // The writing mode and the script it binds. Mirrors the engine's rule
    // rather than deferring to it: the engine door runs AFTER pdf-lib has
    // already written the field, so a combination refused only there would
    // leave a created field that never became a column.
    if (spec.writingMode !== undefined && !writesTextRun(spec.type)) {
      push('refusal.field.writingKindOnly');
    }
    if (effectiveFieldWriting(spec.type, spec.writingMode ?? 'horizontal') === 'vertical') {
      if (spec.script === undefined) push('refusal.field.scriptRequired');
      // A comb divides the box across the very axis a column runs down.
      if (spec.type === 'text' && spec.comb) push('refusal.field.combNotVertical');
    } else if (spec.script !== undefined && spec.writingMode === undefined) {
      // Only when no mode was asked for. A mark-drawing kind that asked for
      // one is already answered by the row above, and telling the same author
      // their field "writes horizontally" would contradict what they typed.
      push('refusal.field.scriptOnHorizontal');
    }
    // Format and Validate belong to the kinds that carry a typed value;
    // Calculate writes one, which only a text field can hold.
    if (spec.format !== undefined && !FORMAT_TYPES.includes(spec.type)) {
      push('refusal.field.formatKindOnly');
    }
    if (spec.validate !== undefined && !VALIDATE_TYPES.includes(spec.type)) {
      push('refusal.field.formatKindOnly');
    }
    if (spec.calculate !== undefined && !CALCULATE_TYPES.includes(spec.type)) {
      push('refusal.field.calculateKindOnly');
    }
    if (spec.defaultValue !== undefined && spec.type === 'signature') {
      push('refusal.field.defaultOnSignature');
    }
    try {
      emittedScripts(spec);
    } catch (err) {
      if (!(err instanceof EmitError)) throw err;
      push(EMIT_KEY[err.problem], { value: err.detail });
    }
    if (spec.calculate !== undefined) {
      let targets: string[];
      try {
        targets = calculateInputs(spec.calculate);
      } catch {
        // The emission problem is reported on its own row; an unreadable
        // calculation names nothing that could be checked.
        targets = [];
      }
      for (const target of targets) {
        // The same rule /Lock already applies to its targets: a calculation
        // naming a field nothing has reads nothing, and silently contributes a
        // zero to somebody's total.
        if (!resolves(target, calcKnown)) {
          push('refusal.field.calcUnknownField', { name: target });
        }
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
  // The batch's /CO, checked before anything is written: a cycle is a
  // calculation that can never settle, and one pass over it computes a number
  // no viewer agrees with. Reported by the chain that proves it.
  const entries = batchCalculations(specs);
  if (entries.length > 0) {
    const { order, inputs } = existingCalculations(doc);
    try {
      calculationOrder(order, inputs, entries);
    } catch (err) {
      if (!(err instanceof CycleError)) throw err;
      problems.push({
        key: 'refusal.field.calcCycle',
        vars: { chain: err.chain.join(' → ') },
        field: batch ? err.chain[0] : undefined,
      });
    }
  }
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

/** The `/DA` an engine-drawn option list carries: the standard face at auto
 * size, so the door resolves the size that fits the rows it lays out. The
 * appearance names its own fonts in its own /Resources — a /DA cannot name the
 * per-row subsets a mixed-script list embeds. */
const ENGINE_DRAWN_DA = '0 g\n/Helv 0 Tf';

/**
 * An option list appearance that draws the widget's box and nothing else.
 *
 * pdf-lib's own provider minus the text and the selection band — same
 * background, border and rotation handling, so the box an engine-drawn list
 * sits in is the box every other list sits in.
 */
function boxOnlyOptionListAppearance(
  _field: PDFOptionList,
  widget: PDFWidgetAnnotation,
): PDFOperator[] {
  const rectangle = widget.getRectangle();
  const characteristics = widget.getAppearanceCharacteristics();
  const borderWidth = widget.getBorderStyle()?.getWidth() ?? 0;
  const rotation = reduceRotation(characteristics?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  return [
    ...rotateInPlace({ ...rectangle, rotation }),
    ...drawRectangle({
      x: borderWidth / 2,
      y: borderWidth / 2,
      width: width - borderWidth,
      height: height - borderWidth,
      borderWidth,
      color: componentsToColor(characteristics?.getBackgroundColor()),
      borderColor: componentsToColor(characteristics?.getBorderColor()),
      rotate: degrees(0),
      xSkew: degrees(0),
      ySkew: degrees(0),
    }),
  ];
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

/** A `/JavaScript` action carrying this body.
 *
 * ASCII rides as a PDF string, which is what the ecosystem writes and what
 * keeps a stock call byte-identical to the same call from any other producer.
 * Anything else — a currency symbol, a mask carrying an accented literal —
 * goes as a UTF-16BE stream, the convention the engine half already uses;
 * `PDFString.of` writes one byte per code unit and would corrupt it. */
function jsAction(doc: PDFDocument, js: string): PDFRef {
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7F]*$/.test(js);
  const body = ascii
    ? PDFString.of(js)
    : doc.context.register(doc.context.stream(Uint8Array.from([0xfe, 0xff, ...utf16beBytes(js)])));
  return doc.context.register(doc.context.obj({ S: 'JavaScript', JS: body }) as PDFDict);
}

function utf16beBytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out.push((code >> 8) & 0xff, code & 0xff);
  }
  return out;
}

/** Write the spec's `/AA` scripts and `/DV` onto a field dictionary.
 *
 * Every trigger this app authors is REPLACED wholesale and every other key of
 * an existing `/AA` is left alone: a widget trigger (`/E`, `/U`) is not this
 * door's business, and a spec that no longer carries a format must not leave
 * the old format's `/F` behind. */
function applyActions(doc: PDFDocument, dict: PDFDict, spec: NewFieldSpec): void {
  const scripts = emittedScripts(spec);
  let aa = dict.lookupMaybe(PDFName.of('AA'), PDFDict);
  for (const trigger of ['F', 'K', 'V', 'C'] as const) {
    const js = scripts[trigger];
    if (js !== undefined) {
      if (!aa) {
        aa = doc.context.obj({}) as PDFDict;
        dict.set(PDFName.of('AA'), aa);
      }
      aa.set(PDFName.of(trigger), jsAction(doc, js));
    } else if (aa) {
      aa.delete(PDFName.of(trigger));
    }
  }
  if (aa && aa.keys().length === 0) dict.delete(PDFName.of('AA'));
  if (spec.defaultValue !== undefined) applyDefault(doc, dict, spec);
}

/** `/DV` — the value a form reset restores to. */
function applyDefault(doc: PDFDocument, dict: PDFDict, spec: NewFieldSpec): void {
  const value = spec.defaultValue;
  if (value === undefined || value === null) {
    dict.delete(PDFName.of('DV'));
    return;
  }
  if (spec.type === 'checkbox') {
    dict.set(PDFName.of('DV'), PDFName.of(value === true || value === 'Yes' ? 'Yes' : 'Off'));
    return;
  }
  if (spec.type === 'radio') {
    dict.set(PDFName.of('DV'), PDFName.of(String(value) || 'Off'));
    return;
  }
  if (Array.isArray(value)) {
    dict.set(
      PDFName.of('DV'),
      doc.context.obj(value.map((v) => PDFHexString.fromText(String(v)))) as PDFArray,
    );
    return;
  }
  dict.set(PDFName.of('DV'), PDFHexString.fromText(String(value)));
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
      applyActions(doc, field.acroField.dict, spec);
      break;
    }
    case 'checkbox': {
      const field = form.createCheckBox(name);
      field.addToPage(page, box);
      applyActions(doc, field.acroField.dict, spec);
      break;
    }
    case 'radio': {
      const group = form.createRadioGroup(name);
      applyActions(doc, group.acroField.dict, spec);
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
      applyActions(doc, field.acroField.dict, spec);
      break;
    }
    case 'optionlist': {
      const field = form.createOptionList(name);
      const labels = options.map((o) => o.label);
      const engineDrawn = needsChoiceAppearance(spec);
      // `addToPage` runs the default appearance provider with no way to pass
      // another, and that provider lays out every /Opt entry through the
      // standard font's WinAnsi encoder. An engine-drawn list therefore gets
      // its options AFTER the widget exists, so the provider sees an empty
      // list and draws the box alone; the door then authors the rows.
      if (!engineDrawn) field.setOptions(labels);
      field.enableMultiselect();
      field.addToPage(page, box);
      if (engineDrawn) {
        field.setOptions(labels);
        // Re-drawn through the box-only provider, which also marks the field
        // clean — `save()` re-runs the DEFAULT provider over every field it
        // still considers dirty, and that is the encoder throw again.
        field.updateAppearances(form.getDefaultFont(), boxOnlyOptionListAppearance);
        field.acroField.setDefaultAppearance(ENGINE_DRAWN_DA);
      }
      applyActions(doc, field.acroField.dict, spec);
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
  writeCalculationOrder(doc, specs);
  return doc.save();
}

/** Rewrite `/CO` for the calculations this batch just created.
 *
 * Run AFTER the fields exist, so the entries are references to real objects;
 * the order itself was already proved acyclic before anything was written. An
 * existing order is never re-sorted — the author declared it and it may encode
 * intent the graph does not show. */
function writeCalculationOrder(doc: PDFDocument, specs: readonly NewFieldSpec[]): void {
  const entries = batchCalculations(specs);
  if (entries.length === 0) return;
  const { order, inputs, forest } = existingCalculations(doc);
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) return;
  // The forest is re-walked after creation so the batch's own fields resolve.
  const live = fieldForest(doc);
  const refs: PDFRef[] = [];
  for (const name of calculationOrder(order, inputs, entries)) {
    const dict = live.get(name) ?? forest.get(name);
    if (!dict) continue;
    const ref = doc.context.getObjectRef(dict);
    if (ref) refs.push(ref);
  }
  if (refs.length > 0) acro.set(PDFName.of('CO'), doc.context.obj(refs) as PDFArray);
  else acro.delete(PDFName.of('CO'));
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
