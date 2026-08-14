// Emitter: an authored format/validate/calculate choice → the stock `/JS`
// bodies, plus the `/CO` order those calculations run in.
//
// The TypeScript half of the authoring twin; `src/engine/afemit.py` is the same
// table and the same ordering rule, and the two are pinned string for string
// against `tests/fixtures/af-corpus.json`'s `emit` section.
//
// Two properties this module exists to hold:
//
//   • Byte compatibility. The bodies written here are the call shapes the
//     ecosystem writes, so every other viewer executes what this app authors.
//     The templates are literal per kind — never assembled from a computation —
//     and every emitted body is fed back through `recognize` by the corpus, so
//     a body this app writes is always a body this app runs.
//   • A declared calculation order. `/CO` is the author's order and a
//     conforming viewer runs it once. It is derived here by a topological sort
//     over the dependency graph, never by appending: a field placed before the
//     fields it reads computes a stale value in every viewer.
//
// Pure over plain values: no pdf-lib, no file paths. The writers translate what
// comes back into objects.
import { asStored, makeNumber } from './af-calc';
import { ENTRY_POINTS, recognize, sfnFields, type SfnNode } from './af-script';

export type SepStyle = 0 | 1 | 2 | 3 | 4;
export type NegStyle = 0 | 1 | 2 | 3;
export type SpecialKind = 0 | 1 | 2 | 3;
export type CalcFunction = 'SUM' | 'PRD' | 'AVG' | 'MIN' | 'MAX';

/** What the page shows for a typed value. `/Ff` carries structural flags only
 * (multiline, comb, combo…) — AcroForm text formatting is entirely `/AA`
 * driven, so there is no format bit to hunt for. */
export type FieldFormat =
  | {
      kind: 'number';
      decimals: number;
      sepStyle: SepStyle;
      negStyle: NegStyle;
      currency: string;
      currencyPrepend: boolean;
    }
  | { kind: 'percent'; decimals: number; sepStyle: SepStyle; prepend: boolean }
  | { kind: 'date'; mask: string }
  | { kind: 'time'; mask: string }
  | { kind: 'special'; psf: SpecialKind }
  | { kind: 'mask'; mask: string };

export interface FieldValidate {
  min?: number;
  max?: number;
}

export type FieldCalculate =
  | { op: CalcFunction; fields: string[] }
  | { sfn: string };

/** Format and Validate belong to the kinds that carry a typed value; Calculate
 * writes one, which only a text field can hold. */
export const FORMAT_TYPES: readonly string[] = ['text', 'dropdown'];
export const VALIDATE_TYPES: readonly string[] = ['text', 'dropdown'];
export const CALCULATE_TYPES: readonly string[] = ['text'];

export const CALC_FUNCTIONS: readonly CalcFunction[] = ['SUM', 'PRD', 'AVG', 'MIN', 'MAX'];
export const FORMAT_KINDS: readonly FieldFormat['kind'][] = [
  'number', 'percent', 'date', 'time', 'special', 'mask',
];
export const SEP_STYLES: readonly SepStyle[] = [0, 1, 2, 3, 4];
export const NEG_STYLES: readonly NegStyle[] = [0, 1, 2, 3];
export const SPECIAL_KINDS: readonly SpecialKind[] = [0, 1, 2, 3];

/** The format a DETECTED date field is authored with. Detection says only that
 * a label announces a date; the mask is a choice, and this is the one the
 * ecosystem writes by default. The reviewer can change it before creating. */
export const DETECTED_DATE_FORMAT: FieldFormat = { kind: 'date', mask: 'mm/dd/yy' };

/** Beyond this the reference's own printf spec stops producing a number. */
export const MAX_DECIMALS = 15;
const DECIMAL_RANGE: readonly number[] = Array.from({ length: MAX_DECIMALS + 1 }, (_, i) => i);

/** Why an authored action cannot become a script, as a condition rather than a
 * sentence — the caller renders it through its own catalog, because the two
 * halves of the twin speak to different audiences. */
export type EmitProblem =
  | 'formatUnknown'
  | 'decimalsRange'
  | 'sepStyleRange'
  | 'negStyleRange'
  | 'specialRange'
  | 'maskRequired'
  | 'rangeNeedsBound'
  | 'rangeNotNumber'
  | 'rangeInverted'
  | 'calcUnknown'
  | 'calcNeedsFields'
  | 'sfnEmpty'
  | 'sfnUnreadable';

export class EmitError extends Error {
  readonly problem: EmitProblem;
  readonly detail: string;

  constructor(problem: EmitProblem, detail = '') {
    super(`${problem}${detail ? `: ${detail}` : ''}`);
    this.name = 'EmitError';
    this.problem = problem;
    this.detail = detail;
  }
}

/** A calculation that depends on itself, with the chain that proves it. */
export class CycleError extends Error {
  readonly chain: readonly string[];

  constructor(chain: readonly string[]) {
    super(chain.join(' -> '));
    this.name = 'CycleError';
    this.chain = [...chain];
  }
}

// ── literals ──────────────────────────────────────────────────────────────

/** A JavaScript string literal in the escaping the recognizer accepts. Double
 * quotes throughout: that is what the ecosystem writes, and a name carrying an
 * apostrophe then needs no escape at all. */
export function jsString(text: string): string {
  let out = '"';
  for (const ch of String(text)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `${out}"`;
}

/** A numeric literal, through the same Number→String rule the evaluator stores
 * values by, so both halves of the twin spell 2.5 the same way. */
export function jsNumber(value: number): string {
  const number = makeNumber(value);
  if (number === null) throw new EmitError('rangeNotNumber', String(value));
  return asStored(number);
}

function intIn(value: unknown, allowed: readonly number[], problem: EmitProblem): number {
  const number = makeNumber(value);
  if (number === null || !Number.isInteger(number) || !allowed.includes(number)) {
    throw new EmitError(problem, String(value));
  }
  return number;
}

// ── format ────────────────────────────────────────────────────────────────

/** `{F, K}` for a format choice.
 *
 * The Format and Keystroke halves are written as a PAIR: a `/F` with no `/K`
 * leaves input validation off in every viewer, which is not what the author
 * chose. `mask` is the one keystroke-only kind — an arbitrary mask constrains
 * typing and has no display form. */
export function formatScripts(format: FieldFormat): { F?: string; K: string } {
  const kind = format?.kind;
  if (!FORMAT_KINDS.includes(kind)) throw new EmitError('formatUnknown', String(kind));
  if (format.kind === 'number') {
    const decimals = intIn(format.decimals, DECIMAL_RANGE, 'decimalsRange');
    const sep = intIn(format.sepStyle, SEP_STYLES, 'sepStyleRange');
    const neg = intIn(format.negStyle, NEG_STYLES, 'negStyleRange');
    const currency = jsString(format.currency ?? '');
    const prepend = format.currencyPrepend ? 'true' : 'false';
    // currStyle (the fourth argument) is legacy and ignored by the reference;
    // the ecosystem writes 0 and so do we.
    const args = `${decimals}, ${sep}, ${neg}, 0, ${currency}, ${prepend}`;
    return { F: `AFNumber_Format(${args});`, K: `AFNumber_Keystroke(${args});` };
  }
  if (format.kind === 'percent') {
    const decimals = intIn(format.decimals, DECIMAL_RANGE, 'decimalsRange');
    const sep = intIn(format.sepStyle, SEP_STYLES, 'sepStyleRange');
    // The third argument is written only when it is chosen: two arguments is
    // the shape the ecosystem writes, and the reference defaults it.
    const tail = format.prepend ? ', true' : '';
    return {
      F: `AFPercent_Format(${decimals}, ${sep}${tail});`,
      K: `AFPercent_Keystroke(${decimals}, ${sep});`,
    };
  }
  if (format.kind === 'date' || format.kind === 'time') {
    const mask = format.mask ?? '';
    if (!mask) throw new EmitError('maskRequired', format.kind);
    // The Ex forms carry the mask literally. The index form (`AFDate_Format(n)`)
    // is accepted on read and never written: it depends on a table index a
    // future reader might number differently.
    const prefix = format.kind === 'date' ? 'AFDate' : 'AFTime';
    return {
      F: `${prefix}_FormatEx(${jsString(mask)});`,
      K: `${prefix}_KeystrokeEx(${jsString(mask)});`,
    };
  }
  if (format.kind === 'special') {
    const psf = intIn(format.psf, SPECIAL_KINDS, 'specialRange');
    return { F: `AFSpecial_Format(${psf});`, K: `AFSpecial_Keystroke(${psf});` };
  }
  const mask = format.mask ?? '';
  if (!mask) throw new EmitError('maskRequired', 'mask');
  return { K: `AFSpecial_KeystrokeEx(${jsString(mask)});` };
}

// ── validate ──────────────────────────────────────────────────────────────

/** `AFRange_Validate` for a min, a max, or both.
 *
 * Neither bound REFUSES rather than emitting `(false, 0, false, 0)`: the
 * reference's final branch is unguarded, so that call rejects every value above
 * zero — a script that silently means something else. */
export function validateScript(rule: FieldValidate): string {
  const hasLow = rule?.min !== undefined && rule.min !== null;
  const hasHigh = rule?.max !== undefined && rule.max !== null;
  if (!hasLow && !hasHigh) throw new EmitError('rangeNeedsBound');
  const low = hasLow ? makeNumber(rule.min) : null;
  const high = hasHigh ? makeNumber(rule.max) : null;
  if ((hasLow && low === null) || (hasHigh && high === null)) throw new EmitError('rangeNotNumber');
  if (low !== null && high !== null && low > high) throw new EmitError('rangeInverted');
  const lowText = low !== null ? jsNumber(low) : '0';
  const highText = high !== null ? jsNumber(high) : '0';
  return `AFRange_Validate(${hasLow ? 'true' : 'false'}, ${lowText}, ${hasHigh ? 'true' : 'false'}, ${highText});`;
}

// ── calculate ─────────────────────────────────────────────────────────────

/** `AFSimple_Calculate` over a field list, or the expanded Simplified Field
 * Notation assignment. SFN has no encoding of its own in the format — a
 * producer expands it into a `/JS` body at authoring time, and so do we. */
export function calculateScript(calc: FieldCalculate): string {
  if ('sfn' in calc) {
    const text = (calc.sfn ?? '').trim();
    if (!text) throw new EmitError('sfnEmpty');
    const body = `event.value = ${text};`;
    if (recognize(body) === null) throw new EmitError('sfnUnreadable', text);
    return body;
  }
  if (!CALC_FUNCTIONS.includes(calc.op)) throw new EmitError('calcUnknown', String(calc.op));
  const fields = (calc.fields ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (fields.length === 0) throw new EmitError('calcNeedsFields');
  return `AFSimple_Calculate("${calc.op}", new Array(${fields.map(jsString).join(',')}));`;
}

/** The field names a calculation reads, in first-appearance order. */
export function calculateInputs(calc: FieldCalculate): string[] {
  if ('sfn' in calc) {
    const script = recognize(`event.value = ${(calc.sfn ?? '').trim()};`);
    if (script === null || script.fn !== 'SFN') return [];
    return sfnFields((script as { expr: SfnNode }).expr);
  }
  const out: string[] = [];
  for (const raw of calc.fields ?? []) {
    const name = String(raw).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The names an EXISTING calculate body reads, or an empty list when the body
 * is not one this app recognizes — an unrecognized script constrains no order,
 * because nothing here can say what it reads. */
export function scriptInputs(js: string): string[] {
  const script = recognize(js);
  if (script === null) return [];
  if (script.fn === 'SFN') return sfnFields((script as { expr: SfnNode }).expr);
  if (script.fn === 'AFSimple_Calculate') {
    const raw = (script as { args: unknown[] }).args[1];
    const names = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
    const out: string[] = [];
    for (const name of names) {
      const cleaned = name.trim();
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
    return out;
  }
  return [];
}

/** Whether a calculation may name this field: a field of the document (or of
 * the batch), or a parent whose terminal children are among them. */
export function resolves(name: string, known: Iterable<string>): boolean {
  const prefix = `${name}.`;
  for (const candidate of known) {
    if (candidate === name || candidate.startsWith(prefix)) return true;
  }
  return false;
}

// ── the calculation order ─────────────────────────────────────────────────

/**
 * The `/CO` a document carries after this batch is authored.
 *
 * `existingOrder` is the document's own `/CO` and is NEVER re-sorted: the author
 * declared it and it may encode intent the graph does not show. Each new entry
 * is inserted at the earliest position that satisfies its dependencies, with
 * ties broken on authoring order, so a form laid out top-to-bottom keeps its
 * natural order.
 *
 * Throws `CycleError` when a cycle passes through one of the new entries; a
 * cycle wholly inside the document's own `/CO` is the document's and is
 * evaluated one pass, not refused here.
 */
export function calculationOrder(
  existingOrder: readonly string[],
  existingInputs: ReadonlyMap<string, readonly string[]>,
  newEntries: readonly (readonly [string, readonly string[]])[],
): string[] {
  const order = existingOrder.map(String);
  const entries = newEntries.map(([name, inputs]) => [String(name), inputs.map(String)] as const);
  const batch = new Set(entries.map(([name]) => name));
  const edges = new Map<string, string[]>();
  for (const [name, inputs] of entries) edges.set(name, [...inputs]);
  for (const name of order) {
    if (!edges.has(name)) edges.set(name, [...(existingInputs.get(name) ?? [])]);
  }

  refuseCycles(edges, batch);

  // A stable topological pass over the batch alone: an entry that reads another
  // entry of the same batch must be placed after it.
  const placed: (readonly [string, readonly string[]])[] = [];
  const remaining = [...entries];
  while (remaining.length > 0) {
    const pending = new Set(remaining.map(([name]) => name));
    const index = remaining.findIndex(
      ([name, inputs]) => !inputs.some((i) => i !== name && pending.has(i)),
    );
    // Unreachable: refuseCycles has already refused every cycle that touches
    // the batch, so a stall can only mean one.
    if (index < 0) throw new CycleError(remaining.map(([name]) => name));
    placed.push(...remaining.splice(index, 1));
  }

  let cursor = 0;
  for (const [name, inputs] of placed) {
    const already = order.indexOf(name);
    if (already >= 0) order.splice(already, 1);
    let want = cursor;
    for (const dep of inputs) {
      const at = order.indexOf(dep);
      if (at >= 0) want = Math.max(want, at + 1);
    }
    order.splice(want, 0, name);
    cursor = want + 1;
  }
  return order;
}

/** Depth-first over the dependency graph; the first cycle that passes through a
 * field this batch authors refuses, naming the chain. */
function refuseCycles(edges: ReadonlyMap<string, readonly string[]>, batch: ReadonlySet<string>): void {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];

  const walk = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') {
      const chain = [...stack.slice(stack.indexOf(name)), name];
      if (chain.some((n) => batch.has(n))) throw new CycleError(chain);
      return;
    }
    state.set(name, 'open');
    stack.push(name);
    for (const dep of edges.get(name) ?? []) {
      if (edges.has(dep)) walk(dep);
    }
    stack.pop();
    state.set(name, 'done');
  };

  for (const name of edges.keys()) walk(name);
}

/** Every `/AA` body one spec carries, by trigger. `format` writes `/F` + `/K`,
 * `validate` writes `/V`, `calculate` writes `/C`. A spec carrying none returns
 * an empty record and the field gets no `/AA` at all. */
export function emittedScripts(spec: {
  format?: FieldFormat;
  validate?: FieldValidate;
  calculate?: FieldCalculate;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec.format != null) {
    const { F, K } = formatScripts(spec.format);
    if (F !== undefined) out.F = F;
    out.K = K;
  }
  if (spec.validate != null) out.V = validateScript(spec.validate);
  if (spec.calculate != null) out.C = calculateScript(spec.calculate);
  return out;
}

/** The inverse of the emitter: the `/AA` bodies a field already carries, read
 * back as the choice that would have written them.
 *
 * This is what lets an existing field be EDITED rather than only replaced — a
 * properties editor seeded from the document shows what the document says.
 * A body outside the table leaves that member absent, which is the honest
 * answer: this app did not write it and cannot restate it as a choice. Pinned
 * against the emitter by the corpus, so the two cannot drift.
 */
export function actionsFromScripts(
  scripts: { F?: string; K?: string; V?: string; C?: string },
  dateFormats: readonly string[],
  timeFormats: readonly string[],
): { format?: FieldFormat; validate?: FieldValidate; calculate?: FieldCalculate } {
  const out: { format?: FieldFormat; validate?: FieldValidate; calculate?: FieldCalculate } = {};
  const display = scripts.F !== undefined ? recognize(scripts.F) : null;
  if (display !== null && 'args' in display) {
    const a = display.args;
    if (display.fn === 'AFNumber_Format') {
      out.format = {
        kind: 'number',
        decimals: Number(a[0]),
        sepStyle: Number(a[1]) as SepStyle,
        negStyle: Number(a[2]) as NegStyle,
        currency: String(a[4] ?? ''),
        currencyPrepend: Boolean(a[5]),
      };
    } else if (display.fn === 'AFPercent_Format') {
      out.format = {
        kind: 'percent',
        decimals: Number(a[0]),
        sepStyle: Number(a[1]) as SepStyle,
        prepend: Boolean(a[2]),
      };
    } else if (display.fn === 'AFDate_FormatEx') {
      out.format = { kind: 'date', mask: String(a[0]) };
    } else if (display.fn === 'AFTime_FormatEx') {
      out.format = { kind: 'time', mask: String(a[0]) };
    } else if (display.fn === 'AFDate_Format') {
      // The index form is accepted on read and never written; resolving it
      // here is what lets a form authored elsewhere be edited here.
      const mask = dateFormats[Number(a[0])];
      if (mask !== undefined) out.format = { kind: 'date', mask };
    } else if (display.fn === 'AFTime_Format') {
      const mask = timeFormats[Number(a[0])];
      if (mask !== undefined) out.format = { kind: 'time', mask };
    } else if (display.fn === 'AFSpecial_Format') {
      out.format = { kind: 'special', psf: Number(a[0]) as SpecialKind };
    }
  }
  if (out.format === undefined && scripts.K !== undefined) {
    const typing = recognize(scripts.K);
    if (typing !== null && 'args' in typing && typing.fn === 'AFSpecial_KeystrokeEx') {
      out.format = { kind: 'mask', mask: String(typing.args[0]) };
    }
  }
  const check = scripts.V !== undefined ? recognize(scripts.V) : null;
  if (check !== null && 'args' in check && check.fn === 'AFRange_Validate') {
    const [low, lowValue, high, highValue] = check.args;
    const rule: FieldValidate = {};
    if (low) rule.min = Number(makeNumber(lowValue) ?? 0);
    if (high) rule.max = Number(makeNumber(highValue) ?? 0);
    if (low || high) out.validate = rule;
  }
  const calc = scripts.C !== undefined ? recognize(scripts.C) : null;
  if (calc !== null) {
    if (calc.fn === 'AFSimple_Calculate' && 'args' in calc) {
      const raw = calc.args[1];
      const fields = Array.isArray(raw) ? raw.map(String) : String(raw).split(/, ?/);
      out.calculate = { op: String(calc.args[0]) as CalcFunction, fields };
    } else if (calc.fn === 'SFN') {
      // The expression's own TEXT, not a re-printed tree: a producer's
      // spacing is the author's and survives an edit that leaves it alone.
      out.calculate = { sfn: (scripts.C ?? '').replace(/^\s*event\.value\s*=\s*/, '').replace(/;\s*$/, '') };
    }
  }
  return out;
}

/** A format in the ENGINE's key spelling, for a request that crosses to it.
 * The two halves author the same members; only the naming convention differs,
 * and one table is what stops a third spelling appearing. */
export function toEngineFormat(format: FieldFormat): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: format.kind };
  if (format.kind === 'number') {
    out.decimals = format.decimals;
    out.sep_style = format.sepStyle;
    out.neg_style = format.negStyle;
    out.currency = format.currency;
    out.currency_prepend = format.currencyPrepend;
  } else if (format.kind === 'percent') {
    out.decimals = format.decimals;
    out.sep_style = format.sepStyle;
    out.prepend = format.prepend;
  } else if (format.kind === 'special') {
    out.psf = format.psf;
  } else {
    out.mask = format.mask;
  }
  return out;
}

/** Whether a body this module wrote reads back as the call it was built from.
 * The corpus asserts it for every template; the writers assert it for
 * everything they emit, so a body this app writes is never one it refuses. */
export function recognizable(js: string): boolean {
  const script = recognize(js);
  if (script === null) return false;
  return script.fn === 'SFN' || script.fn in ENTRY_POINTS;
}
