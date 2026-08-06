import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFieldSpecs,
  candidateKind,
  type DetectedCandidate,
  type FieldCandidate,
  type ResolvedCandidate,
} from '../src/renderer/lib/form-candidates';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';

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

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'field-spec-corpus.json'), 'utf8'),
) as { cases: Case[] };

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
