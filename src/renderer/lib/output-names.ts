/**
 * The name a "write the result to a new file" save dialog opens on.
 *
 * A bare `compressed.pdf` loses the only thing the reader needed the name to
 * carry — which document it came from — and lands every such result in one
 * folder under one name, so the second run of any operation proposes
 * overwriting the first run's output on a different document. The suggestion
 * is a DEFAULT: the dialog is still a dialog, and nothing here forces a name.
 *
 * Repeating an operation deliberately repeats the suffix
 * (`report_compressed_compressed.pdf`). Collapsing it would propose a name the
 * previous run already wrote, which turns a suggestion into an overwrite
 * prompt on the user's own earlier output.
 */

/** Everything before the LAST dot, or the whole name when it has no extension.
 * A leading dot is part of the name, not an empty base. */
export function fileBaseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * `report.pdf` + `compressed` → `report_compressed.pdf`.
 *
 * With no source name (no document, or a name that is nothing but an
 * extension) the suffix stands alone, which is the behaviour every one of
 * these dialogs had before.
 */
export function suffixedOutputName(
  sourceName: string | null | undefined,
  suffix: string,
  ext = 'pdf',
): string {
  const base = fileBaseName((sourceName ?? '').trim());
  return base ? `${base}_${suffix}.${ext}` : `${suffix}.${ext}`;
}
