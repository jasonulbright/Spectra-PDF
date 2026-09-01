// What the engine's fill actually reported, read rather than discarded.
//
// `fill_form_fields` validates every named field before it mutates anything and
// refuses atomically — an absent field, an unreadable XFA datasets packet, a
// field with no XFA node all raise, and no file is written. What it returns on
// the success path is therefore a REPORT, and the report is the only thing that
// can say the write covered what was asked for. Announcing success without
// reading it means a fill that wrote fewer fields than were named — or that
// answered with a shape this app cannot read at all — is presented to the user
// as done.
//
// There is no DOM test environment, so the decision lives here and the panels
// only render it (the selectors precedent).

/** A named outcome, so a caller renders a localized string rather than this
 * module inventing English. */
export type FillRefusal =
  /** Fewer fields written than the fill named. */
  | { kind: 'incomplete'; requested: number; filled: number }
  /** No report this app can read: not an object, or no `filled` count in it.
   * Covers a missing result and one whose shape this build does not know. */
  | { kind: 'unverified' };

export type FillOutcome =
  | { kind: 'ok'; filled: number }
  | { kind: 'refused'; refusal: FillRefusal };

/**
 * Classify one `fill_form_fields` response against the edits it was given.
 *
 * `requested` is the number of fields the caller named. A flatten with no
 * edits legitimately writes none, which is why the count comes from the caller
 * rather than from a non-zero assumption here.
 */
export function classifyFillResult(result: unknown, requested: number): FillOutcome {
  if (result === null || typeof result !== 'object') return { kind: 'refused', refusal: { kind: 'unverified' } };
  const report = result as { filled?: unknown; output?: unknown };
  if (typeof report.filled !== 'number' || !Number.isFinite(report.filled)) {
    return { kind: 'refused', refusal: { kind: 'unverified' } };
  }
  if (typeof report.output !== 'string' || report.output === '') {
    // The engine names the file it wrote. No name is no evidence a file was
    // written, whatever the counts say.
    return { kind: 'refused', refusal: { kind: 'unverified' } };
  }
  const filled = report.filled;
  if (filled < requested) {
    return { kind: 'refused', refusal: { kind: 'incomplete', requested, filled } };
  }
  return { kind: 'ok', filled };
}
