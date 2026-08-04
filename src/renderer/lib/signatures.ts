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
  /** /SubFilter as written (e.g. '/ETSI.CAdES.detached'). */
  subfilter?: string | null;
  /** True for a PAdES (ETSI.CAdES.detached) signature. */
  pades?: boolean;
  /** RFC 3161 TSA timestamp present (TSA-backed time, unlike signing_time). */
  timestamped?: boolean;
  timestamp_time?: string | null;
  timestamp_valid?: boolean;
  /** 1-based page carrying the signature's widget (F7) — absent when the
   * engine could not place it, in which case no jump is offered. */
  page?: number;
  error?: string;
}

export interface VerifyResult {
  signed: boolean;
  signature_count: number;
  signatures: SignatureEntry[];
  /** A /DSS is present (PAdES B-LT long-term-validation material). */
  ltv_info_present?: boolean;
  /** PAdES B-LTA document timestamps sealing the file. */
  document_timestamps?: number;
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

/** Badge text per status — identical wording across both panels. N12: the
 * values are CATALOG KEYS (both consumers render `tChrome(...)`), kept here
 * so the two surfaces still cannot drift on the wording — they share the
 * key, and the catalog owns the text. */
export const SIGNATURE_STATUS_LABEL = {
  invalid: 'panel.sig.statusInvalid',
  modified: 'panel.sig.statusModified',
  valid: 'panel.sig.statusValid',
} as const satisfies Record<SignatureStatus, string>;
