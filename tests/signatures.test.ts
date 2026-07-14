import { describe, expect, it } from 'vitest';
import { classifySignature, SIGNATURE_STATUS_LABEL, type SignatureEntry } from '../src/renderer/lib/signatures';

// The one valid/modified/invalid decision shared by the Tools and nav-pane
// Signatures panels (Phase 4 M3.3b) — so they can't disagree on what "valid" is.

function sig(partial: Partial<SignatureEntry>): SignatureEntry {
  return {
    field: 'Sig1',
    signer: 'Test Signer',
    valid: true,
    intact: true,
    trusted: false,
    coverage: 'whole',
    covers_whole_document: true,
    modified_after_signing: false,
    digest_algorithm: 'sha256',
    signing_time: null,
    ...partial,
  };
}

describe('classifySignature', () => {
  it('valid + intact + unmodified → valid', () => {
    expect(classifySignature(sig({}))).toBe('valid');
  });

  it('modified after signing (still cryptographically valid) → modified', () => {
    expect(classifySignature(sig({ modified_after_signing: true }))).toBe('modified');
  });

  it('not cryptographically valid → invalid (regardless of modified flag)', () => {
    expect(classifySignature(sig({ valid: false }))).toBe('invalid');
    expect(classifySignature(sig({ valid: false, modified_after_signing: true }))).toBe('invalid');
  });

  it('valid signature over a broken byte range → invalid', () => {
    expect(classifySignature(sig({ intact: false }))).toBe('invalid');
  });

  it('every status has a label', () => {
    expect(SIGNATURE_STATUS_LABEL.valid).toContain('valid');
    expect(SIGNATURE_STATUS_LABEL.modified).toContain('changed after signing');
    expect(SIGNATURE_STATUS_LABEL.invalid).toBe('Invalid');
  });
});
