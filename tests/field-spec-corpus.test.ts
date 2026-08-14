import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { recognize } from '../src/renderer/lib/af-script';
import type { FieldCalculate, FieldFormat, FieldValidate } from '../src/renderer/lib/af-emit';
import {
  buildFieldSpecs,
  candidateKind,
  type DetectedCandidate,
  type FieldCandidate,
  type ResolvedCandidate,
} from '../src/renderer/lib/form-candidates';
import { addFormFields, FieldSpecError, type NewFieldSpec } from '../src/renderer/lib/form-authoring';
import type { FieldLock } from '../src/renderer/lib/signatures';

// The renderer half of the shared spec pin. The SAME JSON file drives
// tests/test_form_prepare.py: the canvas builds specs here and the folder and
// headless tiers build them in the engine, so the two must answer alike or a
// form prepared through one route differs from the same form prepared through
// the other.
interface CorpusSpec {
  name: string;
  type: string;
  page_index: number;
  rect: number[];
  options?: { label: string; rect: number[] }[];
  multiline?: boolean;
  comb?: boolean;
  max_length?: number;
  /** The format/validate/calculate a field carries, in the engine's key
   * spelling. */
  format?: Record<string, unknown>;
  validate?: FieldValidate;
  calculate?: FieldCalculate;
  default_value?: string;
}

/** A field-actions authoring case: build the base document, author the specs,
 * then either read the `/AA` and `/CO` back or require the named refusal. */
interface ActionCase {
  name: string;
  existing: string[];
  specs: CorpusSpec[];
  actions?: Record<string, Record<string, string>>;
  co?: string[];
  defaults?: Record<string, string>;
  refuses?: string;
}

interface Case {
  name: string;
  existing: string[];
  candidates: DetectedCandidate[];
  specs: CorpusSpec[];
}

/** A `/Lock` authoring case: build the base document, author the specs, then
 * either read the locks back or require the named refusal. */
interface LockCase {
  name: string;
  existing: string[];
  specs: (CorpusSpec & { lock?: FieldLock })[];
  locks?: Record<string, FieldLock | null>;
  refuses?: string;
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'field-spec-corpus.json'), 'utf8'),
) as { cases: Case[]; lock_cases: LockCase[]; action_cases: ActionCase[] };

/** A detected row as the canvas holds it. The geometry conversion the canvas
 * does is not exercised here: the corpus works in page space, which is what
 * both builders receive. */
function resolve(row: DetectedCandidate): ResolvedCandidate {
  const candidate: FieldCandidate = {
    id: `${row.page}:${row.index}`,
    path: 'C:\\a.pdf',
    pageId: `C:\\a.pdf#g0#p${row.page - 1}`,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    rotationAtDraw: 0,
    page: row.page,
    kind: candidateKind(row.kind),
    name: row.name,
    label: row.label,
    group: row.group,
    exportValue: row.export,
    multiline: row.multiline,
    comb: row.comb,
    format: row.format,
    evidence: row.evidence,
    warnings: row.warnings,
    checked: true,
    lock: null,
    actions: null,
  };
  return {
    candidate,
    pageIndex: row.page - 1,
    rect: row.rect,
  };
}

/** The corpus speaks the engine's key spelling; the renderer spec is the same
 * data under camelCase names. */
function asCorpusSpec(spec: NewFieldSpec): CorpusSpec {
  const out: CorpusSpec = {
    name: spec.name,
    type: spec.type,
    page_index: spec.pageIndex,
    rect: [...spec.rect],
  };
  if (spec.options) {
    out.options = spec.options.map((option) =>
      typeof option === 'string'
        ? { label: option, rect: [] }
        : { label: option.label, rect: [...(option.rect ?? [])] },
    );
  }
  if (spec.multiline) out.multiline = true;
  if (spec.comb) out.comb = true;
  if (spec.maxLength !== undefined) out.max_length = spec.maxLength;
  if (spec.format) {
    // The renderer spec is camelCase; the corpus is the engine's spelling.
    out.format = Object.fromEntries(
      Object.entries(spec.format).map(([k, v]) => [
        { sepStyle: 'sep_style', negStyle: 'neg_style', currencyPrepend: 'currency_prepend' }[k] ?? k,
        v,
      ]),
    );
  }
  if (spec.validate) out.validate = spec.validate;
  if (spec.calculate) out.calculate = spec.calculate;
  if (spec.defaultValue !== undefined) out.default_value = String(spec.defaultValue);
  return out;
}

describe('field-spec corpus', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      const specs = buildFieldSpecs(c.candidates.map(resolve), new Set(c.existing));
      expect(specs.map(asCorpusSpec)).toEqual(c.specs);
    });
  }

  it('covers every kind a spec can carry', () => {
    const kinds = new Set(corpus.cases.flatMap((c) => c.specs.map((s) => s.type)));
    expect(kinds).toEqual(new Set(['text', 'checkbox', 'radio', 'signature']));
  });
});

// ── The /Lock half of the same pin ────────────────────────────────────────

/** The wording each corpus condition carries on THIS side. The engine states
 * the same conditions in its own English; only the condition identity crosses. */
const REFUSAL_KEY: Record<string, string> = {
  lock_not_signature: 'refusal.field.lockNotSignature',
  lock_needs_fields: 'refusal.field.lockNeedsFields',
  lock_takes_no_fields: 'refusal.field.lockTakesNoFields',
  lock_unknown_field: 'refusal.field.lockUnknownField',
  lock_self: 'refusal.field.lockSelf',
};

async function baseDocument(existing: readonly string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  existing.forEach((name, i) => {
    form.createTextField(name).addToPage(page, { x: 72, y: 700 - i * 24, width: 228, height: 14 });
  });
  return doc.save();
}

function asSpec(row: CorpusSpec & { lock?: FieldLock }): NewFieldSpec {
  return {
    name: row.name,
    type: row.type as NewFieldSpec['type'],
    pageIndex: row.page_index,
    rect: row.rect as [number, number, number, number],
    ...(row.lock ? { lock: row.lock } : {}),
  };
}

function decodeText(value: unknown): string | null {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
}

/** The `/Lock` a top-level field carries, in the corpus's own vocabulary. */
function lockOfField(doc: PDFDocument, fieldName: string): FieldLock | null {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return null;
  for (let i = 0; i < fields.size(); i++) {
    const entry = fields.get(i);
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) continue;
    if (decodeText(dict.get(PDFName.of('T'))) !== fieldName) continue;
    const lock = dict.lookupMaybe(PDFName.of('Lock'), PDFDict);
    if (!lock) return null;
    const action = lock.lookupMaybe(PDFName.of('Action'), PDFName)?.asString();
    const wire = { '/All': 'all', '/Include': 'include', '/Exclude': 'exclude' }[action ?? ''];
    if (!wire) return null;
    const listed = lock.lookupMaybe(PDFName.of('Fields'), PDFArray);
    const names: string[] = [];
    for (let j = 0; j < (listed?.size() ?? 0); j++) {
      const text = decodeText(listed!.get(j));
      if (text !== null) names.push(text);
    }
    return { action: wire as FieldLock['action'], fields: names };
  }
  return null;
}

describe('field-lock corpus', () => {
  for (const c of corpus.lock_cases) {
    it(c.name, async () => {
      const base = await baseDocument(c.existing);
      const specs = c.specs.map(asSpec);
      if (c.refuses) {
        const key = REFUSAL_KEY[c.refuses];
        expect(key).toBeDefined();
        await expect(addFormFields(base, specs)).rejects.toThrow(FieldSpecError);
        const problems = await addFormFields(base, specs).catch((e: unknown) =>
          e instanceof FieldSpecError ? e.problems.map((p) => p.key) : [],
        );
        expect(problems).toContain(key);
        return;
      }
      const written = await addFormFields(base, specs);
      const doc = await PDFDocument.load(written, { updateMetadata: false });
      for (const [field, expected] of Object.entries(c.locks ?? {})) {
        expect(lockOfField(doc, field)).toEqual(expected);
      }
    });
  }

  it('covers both outcomes and every action', () => {
    const actions = new Set(
      corpus.lock_cases.flatMap((c) => Object.values(c.locks ?? {}).map((l) => l?.action ?? null)),
    );
    expect(actions).toEqual(new Set(['all', 'include', 'exclude', null]));
    expect(new Set(corpus.lock_cases.map((c) => Boolean(c.refuses)))).toEqual(new Set([true, false]));
  });
});

// ── the /AA + /CO half of the same pin ────────────────────────────────────

/** The wording each corpus condition carries on THIS side. The engine states
 * the same conditions in its own English; only the condition identity crosses. */
const ACTION_REFUSAL_KEY: Record<string, string> = {
  calc_cycle: 'refusal.field.calcCycle',
  calc_unknown_field: 'refusal.field.calcUnknownField',
  format_kind_only: 'refusal.field.formatKindOnly',
  calculate_kind_only: 'refusal.field.calculateKindOnly',
  range_needs_bound: 'refusal.field.rangeNeedsBound',
};

/** The corpus speaks the ENGINE's key spelling for a format; the renderer spec
 * is the same data under camelCase names. */
function asFormat(raw: Record<string, unknown>): FieldFormat {
  return {
    kind: raw.kind,
    decimals: raw.decimals,
    sepStyle: raw.sep_style,
    negStyle: raw.neg_style,
    currency: raw.currency,
    currencyPrepend: raw.currency_prepend,
    prepend: raw.prepend,
    mask: raw.mask,
    psf: raw.psf,
  } as unknown as FieldFormat;
}

function asActionSpec(row: CorpusSpec): NewFieldSpec {
  return {
    name: row.name,
    type: row.type as NewFieldSpec['type'],
    pageIndex: row.page_index,
    rect: row.rect as [number, number, number, number],
    ...(row.options ? { options: row.options.map((o) => ({ label: o.label })) } : {}),
    ...(row.format !== undefined ? { format: asFormat(row.format) } : {}),
    ...(row.validate !== undefined ? { validate: row.validate } : {}),
    ...(row.calculate !== undefined ? { calculate: row.calculate } : {}),
    ...(row.default_value !== undefined ? { defaultValue: row.default_value } : {}),
  };
}

/** A `/JS` body, whichever container it rides in: a PDF string for an ASCII
 * body, a UTF-16BE stream for anything else. */
function decodeJs(doc: PDFDocument, value: unknown): string | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (resolved instanceof PDFString || resolved instanceof PDFHexString) {
    return resolved.decodeText();
  }
  if (resolved instanceof PDFRawStream) {
    const bytes = decodePDFRawStream(resolved).decode();
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return out;
    }
    return Buffer.from(bytes).toString('latin1');
  }
  return null;
}

/** Fully-qualified name → field dictionary, interior nodes included. */
function forestOf(doc: PDFDocument): Map<string, PDFDict> {
  const out = new Map<string, PDFDict>();
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return out;
  const walk = (entry: unknown, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) return;
    let t = dict.get(PDFName.of('T'));
    if (t instanceof PDFRef) t = doc.context.lookup(t);
    const own = decodeText(t);
    const name = own === null ? prefix : prefix ? `${prefix}.${own}` : own;
    if (name && !out.has(name)) out.set(name, dict);
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; i < (kids?.size() ?? 0); i++) walk(kids!.get(i), name, depth + 1);
  };
  for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '', 0);
  return out;
}

function actionsOf(doc: PDFDocument): {
  actions: Record<string, Record<string, string>>;
  defaults: Record<string, string>;
  co: string[];
} {
  const forest = forestOf(doc);
  const actions: Record<string, Record<string, string>> = {};
  const defaults: Record<string, string> = {};
  for (const [name, dict] of forest) {
    const aa = dict.lookupMaybe(PDFName.of('AA'), PDFDict);
    if (aa) {
      const entry: Record<string, string> = {};
      for (const trigger of ['F', 'K', 'V', 'C']) {
        const action = aa.lookupMaybe(PDFName.of(trigger), PDFDict);
        if (!action) continue;
        const js = decodeJs(doc, action.get(PDFName.of('JS')));
        if (js !== null) entry[trigger] = js;
      }
      if (Object.keys(entry).length > 0) actions[name] = entry;
    }
    let dv = dict.get(PDFName.of('DV'));
    if (dv instanceof PDFRef) dv = doc.context.lookup(dv);
    const text = decodeText(dv);
    if (text !== null) defaults[name] = text;
  }
  const byDict = new Map<PDFDict, string>();
  for (const [name, dict] of forest) if (!byDict.has(dict)) byDict.set(dict, name);
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const order = acro?.lookupMaybe(PDFName.of('CO'), PDFArray);
  const co: string[] = [];
  for (let i = 0; i < (order?.size() ?? 0); i++) {
    const entry = order!.get(i);
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    const name = dict instanceof PDFDict ? byDict.get(dict) : undefined;
    if (name !== undefined) co.push(name);
  }
  return { actions, defaults, co };
}

describe('field-actions corpus', () => {
  for (const c of corpus.action_cases) {
    it(c.name, async () => {
      const base = await baseDocument(c.existing);
      const specs = c.specs.map(asActionSpec);
      if (c.refuses) {
        const key = ACTION_REFUSAL_KEY[c.refuses];
        expect(key).toBeDefined();
        const problems = await addFormFields(base, specs).then(
          () => [] as string[],
          (e: unknown) => (e instanceof FieldSpecError ? e.problems.map((p) => p.key) : []),
        );
        expect(problems).toContain(key);
        return;
      }
      const written = await addFormFields(base, specs);
      const doc = await PDFDocument.load(written, { updateMetadata: false });
      const { actions, defaults, co } = actionsOf(doc);
      expect(actions).toEqual(c.actions);
      expect(co).toEqual(c.co);
      expect(defaults).toEqual(c.defaults ?? {});
      // Every body this app writes is a body this app runs.
      for (const entry of Object.values(actions)) {
        for (const js of Object.values(entry)) expect(recognize(js), js).not.toBeNull();
      }
    });
  }

  it('covers every trigger and both outcomes', () => {
    const triggers = new Set(
      corpus.action_cases.flatMap((c) =>
        Object.values(c.actions ?? {}).flatMap((entry) => Object.keys(entry)),
      ),
    );
    expect(triggers).toEqual(new Set(['F', 'K', 'V', 'C']));
    expect(new Set(corpus.action_cases.map((c) => Boolean(c.refuses)))).toEqual(
      new Set([true, false]),
    );
  });
});
