/**
 * Page LABELS in the navigation readout.
 *
 * A document that defines `/PageLabels` numbers its pages the way the
 * printed thing does: front matter as i, ii, iii, the body restarting at 1,
 * an appendix as A-1. The editors for that exist; what did not was
 * CONSUMING them — the page box still counted physical sheets, so on a book
 * with twelve roman pages the reader's "page 1" and ours were eleven apart,
 * and typing "iv" did nothing.
 *
 * This is the pure half (there is no DOM test environment, so the logic that
 * can be tested lives here rather than inside the component).
 */

/** Whether `labels` says anything the plain sheet count does not. */
export function hasCustomLabels(labels: readonly string[] | null | undefined): boolean {
  if (!labels || !labels.length) return false;
  return labels.some((label, i) => label !== String(i + 1));
}

/** The label to show for a 1-based page, falling back to its number. */
export function labelFor(page: number, labels: readonly string[] | null | undefined): string {
  const label = labels?.[page - 1];
  return label && label.length ? label : String(page);
}

/**
 * The 1-based page a typed entry means, or null when it means nothing.
 *
 * LABEL first, then the sheet number — the order matters on exactly the
 * documents where it is ambiguous. A book whose body restarts at "1" has a
 * label "1" on a sheet that is not sheet 1; the reader typing "1" wants the
 * page printed 1, which is what they can see. The sheet-number fallback then
 * keeps every unlabelled document, and every entry no label matches,
 * behaving exactly as it did before labels existed.
 *
 * Matching is case- and space-insensitive: "IV", "iv" and " iv " are the
 * same page to a reader, and a roman-numeral style emits lowercase while a
 * user types either.
 */
export function resolvePageEntry(
  input: string,
  labels: readonly string[] | null | undefined,
  total: number,
): number | null {
  const needle = input.trim().toLowerCase();
  if (!needle || total <= 0) return null;
  if (labels && labels.length) {
    // FIRST match wins: a label may legitimately repeat (two ranges both
    // restarting at 1), and jumping to the first is both predictable and
    // the shortest scroll from the top.
    const hit = labels.findIndex((label) => label.trim().toLowerCase() === needle);
    if (hit >= 0 && hit < total) return hit + 1;
  }
  if (!/^\d+$/.test(needle)) return null;
  const n = parseInt(needle, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, total);
}

/**
 * What the input should accept as the user types. With custom labels that is
 * anything (labels carry prefixes, letters and hyphens); without them it is
 * digits only, exactly as the box has always behaved.
 */
export function sanitizePageEntry(raw: string, custom: boolean): string {
  return custom ? raw : raw.replace(/[^0-9]/g, '');
}
