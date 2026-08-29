// Which encryption refusal the consent dialog is allowed to answer.
//
// The predicate decides whether a user is offered an unprotected copy, so it
// is pinned against the ENGINE'S OWN English (the exact sentences
// `engine/pdf_save.py` raises, carried by the message table) rather than
// against a paraphrase — a reworded engine refusal must fail here, not go
// quietly unrecognized and leave the panel showing a bare refusal.
import { describe, it, expect } from 'vitest';
import { EngineError, ENGINE_MESSAGE_ROWS } from '../src/renderer/lib/engine-messages';
import {
  CONSENTABLE_ENCRYPTION_REFUSAL,
  isEncryptionConsentRefusal,
} from '../src/renderer/lib/encryption-consent';

function english(key: string): string {
  const row = ENGINE_MESSAGE_ROWS.find((r) => r.key === key);
  if (!row) throw new Error(`no engine-message row ${key}`);
  return row.message;
}

describe('isEncryptionConsentRefusal', () => {
  it('recognizes the refusal consent can answer', () => {
    const raw = english(CONSENTABLE_ENCRYPTION_REFUSAL);
    expect(isEncryptionConsentRefusal(new EngineError(raw))).toBe(true);
  });

  // No answer supplies a password nobody holds or a recipient list nobody can
  // rewrite, so these two are never offered a Proceed button.
  it.each([
    'pdf_save.documentSEncryptionCannot2',
    'pdf_save.documentSEncryptionCannot3',
  ])('does not offer consent for %s', (key) => {
    expect(isEncryptionConsentRefusal(new EngineError(english(key)))).toBe(false);
  });

  it('ignores every other engine refusal', () => {
    const other = new EngineError('Ghostscript rebuild failed: no such file');
    expect(isEncryptionConsentRefusal(other)).toBe(false);
  });

  it('ignores failures that did not come from the engine', () => {
    expect(
      isEncryptionConsentRefusal(new Error(english(CONSENTABLE_ENCRYPTION_REFUSAL))),
    ).toBe(false);
    expect(isEncryptionConsentRefusal(undefined)).toBe(false);
  });
});
