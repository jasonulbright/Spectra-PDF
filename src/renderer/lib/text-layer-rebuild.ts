/**
 * Rebuilds every mounted text layer in place, as a new pdf.js proxy for the
 * same bytes does. Reached only from the harness, which exists only in a
 * `VITE_E2E` build; the revision is 0 everywhere else. Kept apart from the
 * layer component so the harness does not load pdf.js to reach it.
 */
let revision = 0;
const listeners = new Set<() => void>();

export function rebuildTextLayers(): void {
  revision++;
  for (const listener of listeners) listener();
}

export function subscribeTextLayerRebuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function textLayerRebuildRevision(): number {
  return revision;
}
