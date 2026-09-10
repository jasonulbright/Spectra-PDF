/** Zero individually failed pages does not prove that the page tree ended. */
export function recoveryOutcome(report: {
  page_count_known?: boolean;
  enumeration_error?: string | null;
  total_pages: number;
  recovered: number;
  lost: number;
}): 'complete' | 'partial' | 'undetermined' {
  if (report.page_count_known !== true || report.enumeration_error != null
    || !Number.isInteger(report.total_pages) || report.total_pages < 1
    || !Number.isInteger(report.recovered) || report.recovered < 1
    || !Number.isInteger(report.lost) || report.lost < 0
    || report.recovered + report.lost !== report.total_pages) return 'undetermined';
  return report.lost === 0 ? 'complete' : 'partial';
}
