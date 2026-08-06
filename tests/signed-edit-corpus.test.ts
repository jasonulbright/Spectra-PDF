import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  signedEditDecision,
  type EditClass,
  type SignaturePolicy,
} from '../src/renderer/lib/signatures';

// The renderer half of the shared signed-edit pin. The SAME JSON file drives
// tests/test_signed_edit.py: a folder sweep decides with no dialog available,
// so the engine carries the table too, and the two must answer alike.
interface Case {
  name: string;
  policy: SignaturePolicy;
  class: EditClass;
  kind: 'proceed' | 'warn' | 'refuse';
  reason?: string;
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'signed-edit-corpus.json'), 'utf8'),
) as { cases: Case[] };

describe('signed-edit corpus', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      const decision = signedEditDecision(c.policy, c.class);
      expect(decision.kind).toBe(c.kind);
      expect(decision.kind === 'proceed' ? undefined : decision.reason).toBe(c.reason);
    });
  }

  it('covers every kind the decision can return', () => {
    expect(new Set(corpus.cases.map((c) => c.kind))).toEqual(
      new Set(['proceed', 'warn', 'refuse']),
    );
  });
});
