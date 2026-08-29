// Which encryption refusal the user can answer.
//
// Compress, Grayscale and Rebuild rewrite the document in a renderer
// subprocess that reads it and writes a new one, so none of them can carry
// the source's protection through. The engine refuses rather than handing
// back an unprotected copy of a protected document — but where the document's
// passwords are empty, the operation CAN run, and whether an unprotected copy
// is acceptable is the user's answer to give. That is what the consent dialog
// asks, and `drop_encryption` is what the answer reaches.
//
// The other two encryption refusals — a certificate recipient list, a
// non-empty owner password — are not offerable: no answer supplies a password
// nobody holds. They surface as themselves.
//
// The signal is the engine-message table's ROW KEY, not the sentence. The
// displayed text is translated and the raw text is the engine's English;
// control flow reads neither, it reads the identity the bridge resolved.
import { EngineError, matchEngineMessage } from './engine-messages';

/** The row whose refusal consent can answer (`engine/pdf_save.py`). */
export const CONSENTABLE_ENCRYPTION_REFUSAL = 'pdf_save.documentSEncryptionCannot';

/** Is this failure the refusal the consent dialog exists to answer? */
export function isEncryptionConsentRefusal(err: unknown): boolean {
  if (!(err instanceof EngineError)) return false;
  return matchEngineMessage(err.raw)?.row.key === CONSENTABLE_ENCRYPTION_REFUSAL;
}
