// Shared signature-verification types + status classifier.
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
  /** 1-based page carrying the signature's widget — absent when the
   * engine could not place it, in which case no jump is offered. */
  page?: number;
  /** The certification level THIS signature declares; null for an approval
   * signature. Certification is a second axis, orthogonal to validity. */
  certification_level?: CertificationLevel | null;
  /** Whether the changes since signing stay within the document's
   * certification. `null` whenever `policy_judged` is false. */
  policy_ok?: boolean | null;
  /** False when this build cannot decide the document's policy. A verdict that
   * cannot be made is reported unmade, never as a pass or a failure. */
  policy_judged?: boolean;
  /** Stable enum NAME of how far the document moved since signing. */
  modification_level?: string | null;
  error?: string;
}

/** Wire values, never localized and never parsed from display text. */
export type CertificationLevel = 'none' | 'form-fill' | 'annotate';

/** The document-level certification, read from the catalog's `/Perms /DocMDP`. */
export interface CertificationInfo {
  certified: boolean;
  /** Null when the recorded permission value is not one of the three levels —
   * an unknown level is reported, never guessed. */
  level: CertificationLevel | null;
  level_value: number | null;
  /** The field of the signature that wrote the certification. */
  field: string | null;
  /** Set when a certification is present but unreadable — which is reported as
   * NOT certified plus this error, never as a silent absence. */
  error: string | null;
}

export interface VerifyResult {
  signed: boolean;
  signature_count: number;
  signatures: SignatureEntry[];
  /** A /DSS is present (PAdES B-LT long-term-validation material). */
  ltv_info_present?: boolean;
  /** PAdES B-LTA document timestamps sealing the file. */
  document_timestamps?: number;
  certification?: CertificationInfo;
  summary: {
    all_valid: boolean;
    any_modified_after_signing: boolean;
    trust_verified: boolean;
    certified?: boolean;
    any_policy_violation?: boolean;
  };
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

/** Badge text per status — identical wording across both panels. The
 * values are CATALOG KEYS (both consumers render `tChrome(...)`), kept here
 * so the two surfaces still cannot drift on the wording — they share the
 * key, and the catalog owns the text. */
export const SIGNATURE_STATUS_LABEL = {
  invalid: 'panel.sig.statusInvalid',
  modified: 'panel.sig.statusModified',
  valid: 'panel.sig.statusValid',
} as const satisfies Record<SignatureStatus, string>;

// Certification is a SECOND axis, orthogonal to validity: a certification
// signature can be valid, modified or invalid exactly like an approval one,
// and a policy violation is a third thing again. Collapsing them into one enum
// is the mistake these two functions exist to prevent, which is why
// `classifySignature` above is untouched by either.

export type SignatureKind = 'approval' | 'certification';
export type PolicyVerdict = 'within-policy' | 'violates-policy' | 'unjudged';

/** Whether this signature is the document's author (certification) signature. */
export function signatureKind(sig: SignatureEntry): SignatureKind {
  return sig.certification_level == null ? 'approval' : 'certification';
}

/** The policy verdict. An unmade verdict outranks the pass/fail question: a
 * signature whose policy was not judged is neither within nor in violation. */
export function policyVerdict(sig: SignatureEntry): PolicyVerdict {
  if (sig.policy_judged !== true) return 'unjudged';
  return sig.policy_ok === false ? 'violates-policy' : 'within-policy';
}

export const SIGNATURE_KIND_LABEL = {
  approval: 'panel.sig.kindApproval',
  certification: 'panel.sig.kindCertification',
} as const satisfies Record<SignatureKind, string>;

export const POLICY_VERDICT_LABEL = {
  'within-policy': 'panel.sig.policyWithin',
  'violates-policy': 'panel.sig.policyViolated',
  unjudged: 'panel.sig.policyUnjudged',
} as const satisfies Record<PolicyVerdict, string>;

/** Plain-language wording for each level — the format's own meaning, not its
 * wire value, which is never shown. */
export const CERTIFICATION_LEVEL_LABEL = {
  none: 'panel.sig.levelNone',
  'form-fill': 'panel.sig.levelFormFill',
  annotate: 'panel.sig.levelAnnotate',
} as const satisfies Record<CertificationLevel, string>;

/** The engine reports how far the document moved as a stable enum NAME; the
 * library's own spelling never reaches a user. */
export const MODIFICATION_LEVEL_LABEL = {
  NONE: 'panel.sig.changesNone',
  LTA_UPDATES: 'panel.sig.changesLtv',
  FORM_FILLING: 'panel.sig.changesFormFilling',
  ANNOTATIONS: 'panel.sig.changesAnnotations',
  OTHER: 'panel.sig.changesOther',
} as const satisfies Record<string, string>;

export type ModificationLevelKey = (typeof MODIFICATION_LEVEL_LABEL)[keyof typeof MODIFICATION_LEVEL_LABEL];

/** The catalog key for a reported modification level, or null when the engine
 * reported none (difference analysis unavailable) or a name this build does
 * not know — which is shown as nothing rather than as a guess. */
export function modificationLevelLabel(
  name: string | null | undefined,
): ModificationLevelKey | null {
  if (!name) return null;
  return (
    (MODIFICATION_LEVEL_LABEL as Record<string, ModificationLevelKey | undefined>)[name] ?? null
  );
}

// ── authoring a certification ─────────────────────────────────────────────

/** The certification half of a sign request. Orthogonal to the signer source,
 * the placement and the PAdES profile, so it travels beside them rather than
 * inside any of them — both sign surfaces carry the same pair. */
export interface CertifyOptions {
  certify: boolean;
  level: CertificationLevel;
}

export const DEFAULT_CERTIFY: CertifyOptions = { certify: false, level: 'form-fill' };

export const CERTIFY_LEVELS: readonly CertificationLevel[] = ['none', 'form-fill', 'annotate'];

/** Engine params for a certification request. The level is sent only WITH the
 * certify flag: a level alone would write a policy entry onto an approval
 * signature that most readers disregard, which the engine refuses. */
export function certifyParams(options: CertifyOptions): Record<string, unknown> {
  return options.certify ? { certify: true, certify_level: options.level } : {};
}

// ── what a document's own signatures permit ────────────────────────────────
//
// The decision lives here rather than in the handler that shows the dialog:
// there is no DOM test environment, so a rule inside a component is a rule
// with no test.

/** The cheap structural read the edit tier consults before every edit. */
export interface SignaturePolicy {
  signed: boolean;
  count: number;
  certified: boolean;
  /** Null both when uncertified and when the recorded permission value is not
   * one of the three levels; `certified` distinguishes those. */
  level: CertificationLevel | null;
}

/** What an edit DOES, in the terms a certification is written in. */
export type EditClass = 'form-fill' | 'annotate' | 'structural';

/** The catalog keys this decision can name — a literal union, so a consumer's
 * typed translator accepts them without a cast. */
export type SignedEditKey =
  | 'app.signedEdit.title'
  | 'app.signedEdit.body'
  | 'app.signedEdit.certifiedTitle'
  | 'app.signedEdit.certifiedRefused'
  | 'app.signedEdit.certifiedWarnFormFill'
  | 'app.signedEdit.certifiedWarnAnnotate'
  | 'app.signedEdit.certifiedWarnUnknown';

export type SignedEditDecision =
  | { kind: 'proceed' }
  | { kind: 'refuse' | 'warn'; titleKey: SignedEditKey; bodyKey: SignedEditKey };

// A structural edit is never in this table: page removal, reordering, content
// edits and flattening all fall outside the incremental-append tier, so they
// coalesce the file and break every byte range whatever any policy permits.
// That is a property of the edit, not of the certification.
const PERMITTED_CLASSES: Record<string, readonly EditClass[]> = {
  // No certification in force: the incremental tier preserves both classes
  // losslessly, so neither breaks a signature.
  uncertified: ['form-fill', 'annotate'],
  'form-fill': ['form-fill'],
  annotate: ['form-fill', 'annotate'],
  // A level this build does not recognize permits nothing it can name.
  unknown: [],
};

const CERTIFIED_WARNING = {
  'form-fill': 'app.signedEdit.certifiedWarnFormFill',
  annotate: 'app.signedEdit.certifiedWarnAnnotate',
  unknown: 'app.signedEdit.certifiedWarnUnknown',
} as const satisfies Record<string, SignedEditKey>;

/** Whether an edit of this class may proceed against this document's policy.
 *
 * A no-changes certification REFUSES rather than warns: the author's policy
 * forbids every change, the signing machinery itself will not counter-sign
 * such a file, and every edit produces a document that reports as illegally
 * modified — so a confirm here would offer a choice whose only outcome is a
 * broken file. */
export function signedEditDecision(
  policy: SignaturePolicy,
  editClass: EditClass,
): SignedEditDecision {
  if (!policy.signed && !policy.certified) return { kind: 'proceed' };
  if (policy.certified && policy.level === 'none') {
    return {
      kind: 'refuse',
      titleKey: 'app.signedEdit.certifiedTitle',
      bodyKey: 'app.signedEdit.certifiedRefused',
    };
  }
  if (!policy.certified) {
    if (PERMITTED_CLASSES.uncertified.includes(editClass)) return { kind: 'proceed' };
    return {
      kind: 'warn',
      titleKey: 'app.signedEdit.title',
      bodyKey: 'app.signedEdit.body',
    };
  }
  const key: keyof typeof CERTIFIED_WARNING =
    policy.level === 'form-fill' || policy.level === 'annotate' ? policy.level : 'unknown';
  if (PERMITTED_CLASSES[key].includes(editClass)) return { kind: 'proceed' };
  return {
    kind: 'warn',
    titleKey: 'app.signedEdit.certifiedTitle',
    bodyKey: CERTIFIED_WARNING[key],
  };
}
