import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from 'pdf-lib';
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
) as { cases: Case[]; lock_cases: LockCase[] };

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
