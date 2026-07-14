// Shared signature-verification types + status classifier (Phase 4 M3.3b).
// Both the Tools ▸ Signatures panel (the signing surface) and the nav-pane
// Signatures panel (the read/status surface) render the SAME verify_signatures
// result, so the shape and the valid/modified/invalid decision live here once —
// the two surfaces can't drift on what "valid" means, only on how they style
// it. A leaf types module (no React/imports) so either panel can pull it.

export interface SignatureEntry {
  field: string | null;
  signer: string | null;
  valid: boolean;
  intact: boolean;
  trusted: boolean;
  coverage: string;
  covers_whole_document: boolean;
  modified_after_signing: boolean;
  digest_algorithm: string | null;
  signing_time: string | null;
  error?: string;
}

export interface VerifyResult {
  signed: boolean;
  signature_count: number;
  signatures: SignatureEntry[];
  summary: { all_valid: boolean; any_modified_after_signing: boolean; trust_verified: boolean };
}

export type SignatureStatus = 'invalid' | 'modified' | 'valid';

/** The single valid/modified/invalid decision. A signature that isn't both
 * cryptographically valid AND byte-intact is invalid; an otherwise-valid one
 * whose document changed after signing is flagged 'modified'; else 'valid'. */
export function classifySignature(sig: SignatureEntry): SignatureStatus {
  if (!(sig.valid && sig.intact)) return 'invalid';
  if (sig.modified_after_signing) return 'modified';
  return 'valid';
}

/** Badge text per status — identical wording across both panels. */
export const SIGNATURE_STATUS_LABEL: Record<SignatureStatus, string> = {
  invalid: 'Invalid',
  modified: 'Valid — document changed after signing',
  valid: 'Cryptographically valid',
};
