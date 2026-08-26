// Where a field script's run state is published, so the FormsPanel can name
// what happened without owning a sandbox of its own.
//
// The canvas runs the scripts (it is the interactive fill surface); the panel
// reports on them. A module-level store rather than React context because both
// consumers already read the workspace by path and neither is a child of the
// other, and because it unit-tests without a DOM.
import type { ScriptRunReport } from './field-js-policy';

type Listener = () => void;

const reports = new Map<string, ScriptRunReport[]>();
const listeners = new Set<Listener>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** Replace one document's report set. Reports accumulate ACROSS dispatches for
 * one document — a script that failed on the last keystroke is still a script
 * that failed — and are keyed by (field, trigger) so a repeat is one row. */
export function publishScriptReports(path: string, incoming: readonly ScriptRunReport[]): void {
  if (incoming.length === 0) return;
  const existing = reports.get(path) ?? [];
  const merged = [...existing];
  let changed = false;
  for (const report of incoming) {
    const at = merged.findIndex((r) => r.field === report.field && r.trigger === report.trigger);
    if (at === -1) {
      merged.push(report);
      changed = true;
    } else if (merged[at].kind !== report.kind || merged[at].detail !== report.detail) {
      merged[at] = report;
      changed = true;
    }
  }
  if (!changed) return;
  reports.set(path, merged);
  announce();
}

/** Forget a document's reports — it closed, or its bytes were replaced, so
 * every verdict was taken against a document that no longer exists. */
export function clearScriptReports(path: string): void {
  if (reports.delete(path)) announce();
}

export function scriptReportsFor(path: string): readonly ScriptRunReport[] {
  return reports.get(path) ?? [];
}

export function subscribeScriptReports(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop every document's reports and every listener. */
export function resetScriptReports(): void {
  reports.clear();
  listeners.clear();
}
