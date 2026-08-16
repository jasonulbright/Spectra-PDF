/**
 * The known-intentional WARN/ERROR rows of an e2e run.
 *
 * WebdriverIO logs a driver-level failure at WARN and again at ERROR even when
 * the spec goes on to pass, so a green suite still prints red rows. Every row
 * is either registered here — provoked on purpose, correct behaviour — or it is
 * a defect the scanner reports as UNEXPLAINED.
 *
 * An entry grants permission for one message under one spec. Registering a
 * pattern without its spec would keep suppressing the row after the spec that
 * justified it changes meaning, so `scan-run-log.ts` matches on both whenever
 * the log carries attribution, and reports an entry that matched nothing in the
 * run as STALE.
 */

export interface KnownLogRow {
  /** Stable identifier, printed in the KNOWN inventory. */
  id: string;
  /** Matched against the message half of a `<level> <component>: <message>` row. */
  match: RegExp;
  /** Basename of the spec that provokes the row. */
  spec: string;
  /** Why the row is correct behaviour rather than a defect. */
  reason: string;
}

export const KNOWN_LOG_ROWS: readonly KnownLogRow[] = [
  {
    id: 'schedule-inplace-destination',
    match: /javascript error:.*in-place run takes no destination/i,
    spec: '71-scheduled-runs.spec.ts',
    reason:
      'A negative-path case registers an in-place schedule that also names a destination. The refusal is thrown inside browser.execute, so the driver reports the product message as a javascript error; the spec asserts on that message and passes.',
  },
  {
    id: 'schedule-other-account-log-folder',
    match: /javascript error:.*needs an explicit log folder/i,
    spec: '71-scheduled-runs.spec.ts',
    reason:
      'A negative-path case registers a schedule that runs under another account with no log folder. The refusal is thrown inside browser.execute, so the driver reports the product message as a javascript error; the spec asserts on that message and passes.',
  },
  {
    id: 'schedule-name-charset',
    match: /javascript error:.*schedule name may use letters/i,
    spec: '71-scheduled-runs.spec.ts',
    reason:
      'A negative-path case registers a schedule whose name carries path separators. The refusal is thrown inside browser.execute, so the driver reports the product message as a javascript error; the spec asserts that a refusal happened and passes.',
  },
];
