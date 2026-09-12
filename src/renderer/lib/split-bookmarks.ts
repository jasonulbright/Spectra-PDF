/** A failed, truncated or malformed read is not evidence of no bookmarks. */
export function splitBookmarkCount(reply: unknown, pageCount: number): number | null {
  if (!reply || typeof reply !== 'object') return null;
  const value = reply as Record<string, unknown>;
  // useEngine has already unwrapped the successful JSON-RPC envelope.
  // get_outline returns { outline, count, truncated }, not a health-style ok.
  if ('ok' in value && value.ok !== true || value.truncated !== false || !Array.isArray(value.outline)) return null;
  let count = 0;
  for (const item of value.outline) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const page: unknown = (item as Record<string, unknown>).page;
    if (page === null) continue;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) return null;
    count++;
  }
  return count;
}
