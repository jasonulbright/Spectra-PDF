// The page tier's signed-document gate — consulted BEFORE the gesture, the
// same posture every other edit surface takes.
//
// The page tier is the one edit tier whose write happens later: a rotate or a
// delete lands in memory and the file is rebuilt at commit time, where
// `transplant_incremental` either carries the delta as an appended revision
// (the signature survives) or refuses (the rebuild lands and every byte range
// breaks). So the question a gesture has to ask is not "is this document
// signed" but "will this document's signature survive THIS delta" — which is
// why the decision is delta-aware rather than a bare signed check.
//
// DOM-free by construction: there is no DOM test environment, so a rule
// inside a component is a rule with no test. The dialog belongs to the
// caller; this returns the same `SignedEditDecision` shape the whole-file
// tier already renders.
import {
  signedEditDecision,
  type SignaturePolicy,
  type SignedEditDecision,
} from './signatures';

/** What a page-tier gesture changes, in the classes the transplant computes.
 *
 * `page-keys` is /Rotate and the six page boundaries; `page-structure` is
 * insert / remove / reorder / move; `content` is drawn content drift, which
 * the transplant refuses on purpose — it is mechanically appendable and is
 * exactly the change the DocMDP transform exists to detect. */
export type PageDelta = 'page-keys' | 'page-structure' | 'content';

/** The renderer half of `engine/incremental.py`'s `_CERTIFIED_PERMITS`.
 *
 * ISO 32000-2 Table 257 (clause 12.8.2.2): /P 1 permits no change; /P 2
 * permits filling in forms, instantiating page templates and signing; /P 3
 * adds annotation creation, deletion and modification. Page-template
 * instantiation is the only page-adding change any level admits, and no
 * template machinery exists here — so no row admits `page-structure` or
 * `page-keys`, and a certified document can never keep its certification
 * across a page-tier gesture.
 *
 * Written as the table rather than as `certified → false` so a level that
 * later gains a permitted class changes one row instead of a control flow. */
const CERTIFIED_PERMITS: Record<string, readonly PageDelta[]> = {
  none: [],
  'form-fill': [],
  annotate: [],
  unknown: [],
};

/** The classes the transplant carries on a document with no certification —
 * approval signatures record who signed what, not what may follow, and every
 * append against one measures intact and policy-clean. Content drift is
 * absent deliberately: carrying it would preserve a byte range while the
 * document says something different. */
const APPROVAL_CARRIES: readonly PageDelta[] = ['page-keys', 'page-structure'];

/** Whether the commit's transplant will carry this delta as an appended
 * revision, leaving the document's signatures verifying. */
export function transplantPreserves(policy: SignaturePolicy, delta: PageDelta): boolean {
  if (policy.certified) {
    const level =
      policy.level === 'form-fill' || policy.level === 'annotate' || policy.level === 'none'
        ? policy.level
        : 'unknown';
    return CERTIFIED_PERMITS[level].includes(delta);
  }
  return APPROVAL_CARRIES.includes(delta);
}

/**
 * Whether a page-tier gesture of this delta class may proceed.
 *
 * Three outcomes, one shape: a delta the commit will preserve proceeds with
 * no dialog at all (the signature survives, so there is nothing to warn
 * about); anything else falls to the whole-file decision under the
 * `structural` class, because a delta the transplant refuses lands as a
 * rebuild — which is structurally what `structural` already names. That
 * delegation is what keeps a no-changes certification refusing here for the
 * same reason and with the same words as everywhere else.
 */
export function pageEditDecision(
  policy: SignaturePolicy,
  delta: PageDelta,
): SignedEditDecision {
  if (!policy.signed && !policy.certified) return { kind: 'proceed' };
  if (transplantPreserves(policy, delta)) return { kind: 'proceed' };
  return signedEditDecision(policy, 'structural');
}
