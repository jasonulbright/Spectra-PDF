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
  fields?: string[];
  /** The caller's own half of `fields`; the rest is what the document's
   * calculation order recomputes as a result. */
  typed?: string[];
  kind: 'proceed' | 'warn' | 'refuse';
  reason?: string;
  locked?: string[];
  indirect?: boolean;
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'signed-edit-corpus.json'), 'utf8'),
) as { cases: Case[] };

describe('signed-edit corpus', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      const decision = signedEditDecision(c.policy, c.class, c.fields ?? null, c.typed ?? null);
      expect(decision.kind).toBe(c.kind);
      expect(decision.kind === 'proceed' ? undefined : decision.reason).toBe(c.reason);
      if (c.locked !== undefined) {
        expect(decision.kind === 'proceed' ? undefined : decision.fields).toEqual(c.locked);
      }
      if (c.indirect !== undefined) {
        const key = decision.kind === 'proceed' ? undefined : decision.bodyKey;
        expect(key === 'app.signedEdit.lockedByCalculation').toBe(c.indirect);
        expect(decision.kind === 'proceed' ? undefined : decision.typed).toEqual(
          c.indirect ? c.typed : undefined,
        );
      }
    });
  }

  it('covers every kind the decision can return', () => {
    expect(new Set(corpus.cases.map((c) => c.kind))).toEqual(
      new Set(['proceed', 'warn', 'refuse']),
    );
  });
});
