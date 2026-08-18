// The page tier's delta-aware signed-document gate.
//
// Every cell of the table: three delta classes × six signature situations. The
// point of the table (and of the whole feature) is that a page-tier gesture on
// a signed document is NOT one answer — a rotate on an approval-signed file
// keeps its signature and must raise nothing, while the same rotate on a
// certified one costs it and must warn. Both used to be silent.
import { describe, expect, it } from 'vitest';
import {
  pageEditDecision,
  transplantPreserves,
  type PageDelta,
} from '../src/renderer/lib/page-edit-gate';
import type { SignaturePolicy } from '../src/renderer/lib/signatures';

const UNSIGNED: SignaturePolicy = { signed: false, count: 0, certified: false, level: null };
const APPROVAL: SignaturePolicy = { signed: true, count: 1, certified: false, level: null };
const CERT_NONE: SignaturePolicy = { signed: true, count: 1, certified: true, level: 'none' };
const CERT_FILL: SignaturePolicy = { signed: true, count: 1, certified: true, level: 'form-fill' };
const CERT_ANNOT: SignaturePolicy = { signed: true, count: 1, certified: true, level: 'annotate' };
// A recorded permission value this build does not recognize: `certified` true
// with no level. Reported, never guessed at.
const CERT_UNKNOWN: SignaturePolicy = { signed: true, count: 1, certified: true, level: null };

const DELTAS: PageDelta[] = ['page-keys', 'page-structure', 'content'];

interface Cell {
  kind: 'proceed' | 'warn' | 'refuse';
  reason?: string;
}

const TABLE: { name: string; policy: SignaturePolicy; cells: Record<PageDelta, Cell> }[] = [
  {
    name: 'unsigned and uncertified',
    policy: UNSIGNED,
    cells: {
      'page-keys': { kind: 'proceed' },
      'page-structure': { kind: 'proceed' },
      content: { kind: 'proceed' },
    },
  },
  {
    // The whole reason the gate is delta-aware: the append carries both page
    // classes here, so the signature survives and no dialog is owed.
    name: 'approval signatures, no certification',
    policy: APPROVAL,
    cells: {
      'page-keys': { kind: 'proceed' },
      'page-structure': { kind: 'proceed' },
      content: { kind: 'warn', reason: 'signed' },
    },
  },
  {
    name: 'certified, no changes permitted',
    policy: CERT_NONE,
    cells: {
      'page-keys': { kind: 'refuse', reason: 'certified-no-changes' },
      'page-structure': { kind: 'refuse', reason: 'certified-no-changes' },
      content: { kind: 'refuse', reason: 'certified-no-changes' },
    },
  },
  {
    name: 'certified, form filling permitted',
    policy: CERT_FILL,
    cells: {
      'page-keys': { kind: 'warn', reason: 'certified-form-fill' },
      'page-structure': { kind: 'warn', reason: 'certified-form-fill' },
      content: { kind: 'warn', reason: 'certified-form-fill' },
    },
  },
  {
    name: 'certified, commenting permitted',
    policy: CERT_ANNOT,
    cells: {
      'page-keys': { kind: 'warn', reason: 'certified-annotate' },
      'page-structure': { kind: 'warn', reason: 'certified-annotate' },
      content: { kind: 'warn', reason: 'certified-annotate' },
    },
  },
  {
    name: 'certified at a level this build does not recognize',
    policy: CERT_UNKNOWN,
    cells: {
      'page-keys': { kind: 'warn', reason: 'certified-unknown' },
      'page-structure': { kind: 'warn', reason: 'certified-unknown' },
      content: { kind: 'warn', reason: 'certified-unknown' },
    },
  },
];

describe('pageEditDecision — the page-tier decision table', () => {
  for (const row of TABLE) {
    for (const delta of DELTAS) {
      const cell = row.cells[delta];
      it(`${row.name} × ${delta} → ${cell.kind}${cell.reason ? ` (${cell.reason})` : ''}`, () => {
        const decision = pageEditDecision(row.policy, delta);
        expect(decision.kind).toBe(cell.kind);
        expect(decision.kind === 'proceed' ? undefined : decision.reason).toBe(cell.reason);
      });
    }
  }

  it('covers every kind the decision can return', () => {
    const kinds = new Set(TABLE.flatMap((r) => DELTAS.map((d) => r.cells[d].kind)));
    expect(kinds).toEqual(new Set(['proceed', 'warn', 'refuse']));
  });

  it('a warn carries a title and a body key, never a bare reason', () => {
    const decision = pageEditDecision(APPROVAL, 'content');
    expect(decision.kind).toBe('warn');
    if (decision.kind === 'proceed') throw new Error('unreachable');
    expect(decision.titleKey).toBe('app.signedEdit.title');
    expect(decision.bodyKey).toBe('app.signedEdit.body');
  });

  it('the no-changes refusal points at the copy, not at a retry', () => {
    const decision = pageEditDecision(CERT_NONE, 'page-keys');
    if (decision.kind === 'proceed') throw new Error('unreachable');
    expect(decision.titleKey).toBe('app.signedEdit.certifiedTitle');
    expect(decision.bodyKey).toBe('app.signedEdit.certifiedRefused');
  });
});

describe('transplantPreserves — what the commit will actually carry', () => {
  it('carries both page classes on an approval-signed document', () => {
    expect(transplantPreserves(APPROVAL, 'page-keys')).toBe(true);
    expect(transplantPreserves(APPROVAL, 'page-structure')).toBe(true);
  });

  it('refuses content drift even where it is mechanically appendable', () => {
    // Measured appendable, and refused on purpose: carrying it would preserve
    // a byte range while the document says something different.
    expect(transplantPreserves(UNSIGNED, 'content')).toBe(false);
    expect(transplantPreserves(APPROVAL, 'content')).toBe(false);
  });

  it('carries nothing under any certification — Table 257 admits no page row', () => {
    for (const policy of [CERT_NONE, CERT_FILL, CERT_ANNOT, CERT_UNKNOWN]) {
      for (const delta of DELTAS) {
        expect(transplantPreserves(policy, delta)).toBe(false);
      }
    }
  });
});
