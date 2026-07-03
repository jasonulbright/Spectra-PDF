// Whether a file's rebuilt bytes carry a .pdfx manifest: multi-partition
// files always do, and .pdfx-named files keep theirs even with a single
// partition. File-anchored (the FILE name, not a partition's display name) —
// shared by the reducer's rename-dirtiness rule and the commit planner so the
// two can't disagree about which renames persist.
export function carriesManifest(fileName: string, partitionCount: number): boolean {
  return partitionCount > 1 || /\.pdfx$/i.test(fileName);
}

export function uniqueDocName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
