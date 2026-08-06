import { tChrome, tChromeCount, tNumber } from '../i18n';

/** A byte count as text, in the reader's language.
 *
 * Numbers go through Intl — the decimal separator and the digit grouping are
 * locale properties, never hand-rolled — and the unit lives inside the
 * catalog string rather than being appended to it. */
export function formatBytes(n: number | null): string {
  if (n === null) return tChrome('dialog.props.unknown');
  if (n < 1024) return tChromeCount('dialog.props.bytes', n);
  const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (n < 1024 * 1024) return tChrome('dialog.props.kilobytes', { size: tNumber(n / 1024, opts) });
  return tChrome('dialog.props.megabytes', { size: tNumber(n / (1024 * 1024), opts) });
}
