// The native copy guard (App.tsx) refuses copying while a document that denies
// copying is focused. Application text that is not document content, such as the
// user guide (marked `data-app-text`), is exempt. A selection that still holds
// PDF pages is document content wherever focus sits, so it is never exempt.
export function isAppTextCopy(target: unknown, pageIds: readonly string[]): boolean {
  if (pageIds.length > 0) return false;
  if (typeof target !== 'object' || target === null) return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === 'function' && closest.call(target, '[data-app-text]') !== null;
}
