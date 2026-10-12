/**
 * Run tokens for a panel action that can start again before its previous run
 * settles. Only the run begun last is current: an earlier run that resumes
 * after an await applies nothing, so its report cannot land over a newer one
 * or over another document's.
 */
export interface LatestRun {
  /** Starts a run. The returned check holds while no later run has begun. */
  begin: () => () => boolean;
}

export function latestRun(): LatestRun {
  let latest = 0;
  return {
    begin: () => {
      const mine = ++latest;
      return () => latest === mine;
    },
  };
}
