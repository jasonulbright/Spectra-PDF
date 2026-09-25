import { tChrome } from '../i18n';

export interface RepairResult {
  issues_found?: readonly unknown[] | null;
  original_size: number;
  repaired_size: number;
  pages: number;
}

/** The Repair panel's status line. An empty `issues_found` means the rewrite
 * found nothing to reconstruct, so the line must not claim a repair. */
export function repairStatus(r: RepairResult): string {
  const issues = r.issues_found?.length ?? 0;
  const values = {
    from: (r.original_size / 1024).toFixed(0),
    to: (r.repaired_size / 1024).toFixed(0),
    pages: r.pages,
  };
  return issues === 0
    ? tChrome('panel.repair.noDamage', values)
    : tChrome('panel.repair.repaired', { ...values, issues });
}
