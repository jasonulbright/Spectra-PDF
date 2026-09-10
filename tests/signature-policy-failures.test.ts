import { describe, expect, it } from 'vitest';
import { parseSignaturePolicy, signedEditDecision } from '../src/renderer/lib/signatures';
import { pageEditDecision, transplantPreserves } from '../src/renderer/lib/page-edit-gate';
import { fileIsEligible, sweepReason } from '../src/renderer/lib/folder-sweep';

const VALID = { signed: true, count: 1, certified: false, level: null, locks: [] };

describe('unreadable signature policy', () => {
  const invalid: unknown[] = [null, undefined, {}, [], false, 'unsigned',
    { ...VALID, error: 'cannot read catalog' }, { ...VALID, error: false },
    { ...VALID, signed: 'false' }, { ...VALID, count: -1 }, { ...VALID, count: 1.5 },
    { ...VALID, count: Infinity }, { ...VALID, count: 0 }, { ...VALID, certified: 'false' },
    { ...VALID, level: 'invented' }, { ...VALID, level: 'none' },
    { ...VALID, locks: null }, { ...VALID, locks: [{}] },
    { ...VALID, locks: [{ action: 'banana', fields: [] }] },
    { ...VALID, locks: [{ action: 'include', fields: [42] }] },
    { ...VALID, locks: [{ action: 'exclude', fields: [''] }] },
    { ...VALID, locks: [{ action: 'all', fields: ['name'] }] },
  ];
  for (const key of Object.keys(VALID)) {
    const missing: Record<string, unknown> = { ...VALID };
    delete missing[key];
    invalid.push(missing);
  }
  it.each(invalid.map((value, i) => [i, value] as const))('rejects malformed/error wire value %i', (_, value) => {
    const policy = parseSignaturePolicy(value);
    expect(policy.error).toBe('signature-policy-unreadable');
    for (const edit of ['form-fill', 'annotate', 'structural'] as const) {
      const decision = signedEditDecision(policy, edit);
      expect(decision).toMatchObject({ kind: 'refuse', reason: 'signature-policy-unreadable' });
      if (decision.kind === 'proceed') throw new Error('unreachable');
      const signed = { reason: sweepReason(decision.reason), count: policy.count, refused: true };
      expect(fileIsEligible({ skipReason: null, signed }, true)).toBe(false);
    }
    for (const delta of ['page-keys', 'page-structure', 'content'] as const) {
      expect(transplantPreserves(policy, delta)).toBe(false);
      expect(pageEditDecision(policy, delta).kind).toBe('refuse');
    }
  });
  it('keeps valid uncertified and certified policies distinct', () => {
    expect(signedEditDecision(parseSignaturePolicy(VALID), 'annotate').kind).toBe('proceed');
    expect(signedEditDecision(parseSignaturePolicy({ ...VALID, certified: true, level: 'none' }), 'annotate').kind).toBe('refuse');
    expect(signedEditDecision(parseSignaturePolicy({ ...VALID, signed: false, count: 0 }), 'structural').kind).toBe('proceed');
    expect(signedEditDecision(parseSignaturePolicy({ ...VALID, locks: [{ action: 'all', fields: [] }] }), 'form-fill').kind).toBe('refuse');
  });
});
