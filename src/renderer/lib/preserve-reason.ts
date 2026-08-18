// Why a signed document's commit could NOT be appended — carried from the
// engine to the notice that has to say so.
//
// `transplant_incremental` has always answered with a reason and the renderer
// has always thrown it away: `preserveSignatures` returned a bare boolean, so
// a rotate on a signed document fell back to the full rewrite, broke every
// byte range, and told the user nothing until they reopened the signature
// panel. The reason is the whole difference between "the signature is gone"
// and "the signature is gone BECAUSE the document is certified against this".
//
// The reasons are stable engine ENUM names, not display text, and are matched
// as raw wire values — the same contract `SignedEditReason` already keeps. A
// name this build does not know is passed through verbatim rather than
// guessed at, which is the engine-message table's own posture for a message
// it cannot recognize.
//
// DOM-free: the mapping is a rule, and a rule inside a component is a rule
// with no test.

/** What `transplant_incremental` answers with. Only the fields the notice
 * reads: `applied` plus, on a ceiling refusal, the certification level the
 * engine already reports as a STRUCTURED field — so nothing here parses the
 * composed `certified-<level>-forbids-<class>` name apart. */
export interface PreserveOutcome {
  applied: boolean;
  reason?: string | null;
  certification_level?: string | null;
}

/** One file whose signature the commit could not keep. */
export interface PreserveRefusal {
  /** The document's own path — the notice names the file, not the working copy. */
  path: string;
  reason: PreserveReasonText;
}

/** The catalog keys a reason can resolve to — a literal union, so a typed
 * translator takes them without a cast. */
export type PreserveReasonKey =
  | 'app.preserve.encrypted'
  | 'app.preserve.catalogChanged'
  | 'app.preserve.noDelta'
  | 'app.preserve.acroformRemoved'
  | 'app.preserve.acroformInline'
  | 'app.preserve.certifiedNoChanges'
  | 'app.preserve.certifiedFormFill'
  | 'app.preserve.certifiedAnnotate'
  | 'app.preserve.certifiedUnknown'
  | 'app.preserve.unrecognized';

/** Either a key this build owns the wording for, or the engine's own English
 * carried through untranslated — never a sentence built from both. */
export type PreserveReasonText =
  | { key: PreserveReasonKey }
  | { key: 'app.preserve.unrecognized'; detail: string };

const NAMED: Record<string, PreserveReasonKey> = {
  encrypted: 'app.preserve.encrypted',
  'catalog-changed': 'app.preserve.catalogChanged',
  'no-delta': 'app.preserve.noDelta',
  'acroform-removed': 'app.preserve.acroformRemoved',
  'acroform-inline': 'app.preserve.acroformInline',
};

const CERTIFIED: Record<string, PreserveReasonKey> = {
  none: 'app.preserve.certifiedNoChanges',
  'form-fill': 'app.preserve.certifiedFormFill',
  annotate: 'app.preserve.certifiedAnnotate',
  unknown: 'app.preserve.certifiedUnknown',
};

/**
 * The notice text for one transplant outcome, or null when there is nothing
 * to say.
 *
 * Null in exactly two cases, and they are not the same case: the transplant
 * APPLIED (the signature survives), or the document carries no live signature
 * at all (`not-signed`) — where the rewrite is the standing behaviour and
 * announcing it would report a signature loss to a document that has none.
 */
export function preserveReason(outcome: PreserveOutcome): PreserveReasonText | null {
  if (outcome.applied) return null;
  const reason = outcome.reason ?? '';
  if (reason === 'not-signed') return null;
  const level = outcome.certification_level;
  if (level != null) {
    return { key: CERTIFIED[level] ?? CERTIFIED.unknown };
  }
  const named = NAMED[reason];
  if (named) return { key: named };
  // Free text from the transplant's own refusals (a field nesting it cannot
  // reconcile, an unresolvable page parent). English at the engine, so it
  // rides a placeholder rather than being translated in place.
  return { key: 'app.preserve.unrecognized', detail: reason };
}
