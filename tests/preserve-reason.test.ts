// The transplant's refusal reason, on its way to the notice.
//
// The defect this closes: `preserveSignatures` returned a bare boolean, so
// "this file has no signatures" and "this file HAD signatures and the append
// refused" were the same value — and the second one silently rewrote the file.
import { describe, expect, it } from 'vitest';
import { preserveReason } from '../src/renderer/lib/preserve-reason';

describe('preserveReason', () => {
  it('says nothing when the append applied', () => {
    expect(preserveReason({ applied: true })).toBeNull();
  });

  it('says nothing for an unsigned document — the rewrite is the behaviour', () => {
    expect(preserveReason({ applied: false, reason: 'not-signed' })).toBeNull();
  });

  it('names each refusal this build knows', () => {
    expect(preserveReason({ applied: false, reason: 'encrypted' })).toEqual({
      key: 'app.preserve.encrypted',
    });
    expect(preserveReason({ applied: false, reason: 'catalog-changed' })).toEqual({
      key: 'app.preserve.catalogChanged',
    });
    expect(preserveReason({ applied: false, reason: 'no-delta' })).toEqual({
      key: 'app.preserve.noDelta',
    });
  });

  it('reads the certification level as a FIELD, never by splitting the reason', () => {
    // The engine reports `certified-<level>-forbids-<class>` and also reports
    // the level as its own key. Parsing the composed name apart would be a
    // second reading of a string the engine already answered structurally.
    for (const [level, key] of [
      ['none', 'app.preserve.certifiedNoChanges'],
      ['form-fill', 'app.preserve.certifiedFormFill'],
      ['annotate', 'app.preserve.certifiedAnnotate'],
      ['unknown', 'app.preserve.certifiedUnknown'],
    ] as const) {
      expect(
        preserveReason({
          applied: false,
          reason: `certified-${level}-forbids-page-structure`,
          certification_level: level,
        }),
      ).toEqual({ key });
    }
  });

  it('a certification level this build does not know reports as unknown', () => {
    expect(
      preserveReason({
        applied: false,
        reason: 'certified-p4-forbids-page-keys',
        certification_level: 'p4',
      }),
    ).toEqual({ key: 'app.preserve.certifiedUnknown' });
  });

  it('carries an unrecognized refusal through verbatim rather than guessing', () => {
    expect(
      preserveReason({ applied: false, reason: 'field nesting too deep to reconcile' }),
    ).toEqual({
      key: 'app.preserve.unrecognized',
      detail: 'field nesting too deep to reconcile',
    });
  });

  it('a certified refusal outranks the named-reason table', () => {
    // Both fields present: the level is the more specific fact and wins.
    expect(
      preserveReason({
        applied: false,
        reason: 'no-delta',
        certification_level: 'annotate',
      }),
    ).toEqual({ key: 'app.preserve.certifiedAnnotate' });
  });
});
