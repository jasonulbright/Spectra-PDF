// What a redaction left behind outside page content, as data.
//
// The engine's `redact` result carries `removed_text` (the text the marks took
// off the pages) and `residue` (every place outside page content that still
// spells it). This module turns that into the question the apply flow asks and
// the request `remove_redaction_residue` takes. It owns no UI.
//
// Every place the engine found is in the request: the user redacted this text,
// so removing it is the default the question offers. Nothing is removed until
// the user answers the question.
import { formattingLocale, tChrome } from '../i18n';

export const RESIDUE_KINDS = [
  'outline',
  'thread',
  'dest_name',
  'page_label',
  'metadata',
  'annotation',
  'field',
  'embedded_file',
  'javascript',
] as const;

export type ResidueKind = (typeof RESIDUE_KINDS)[number];

export interface ResidueEntry {
  readonly kind: ResidueKind;
  readonly where: string;
  readonly text: string;
}

export interface Residue {
  readonly terms: readonly string[];
  /** The listed rows; capped by the engine, see `truncated`. */
  readonly entries: readonly ResidueEntry[];
  /** Every occurrence per kind, including rows past the cap. */
  readonly counts: ReadonlyMap<ResidueKind, number>;
  /** Places the engine reports and never changes (field names). */
  readonly reportOnly: number;
  readonly truncated: boolean;
  /** The scan could not read every place, so finding nothing does not mean
   * nothing is there. */
  readonly incomplete: boolean;
  /** The kinds of the places the scan could not read. */
  readonly unread: readonly ResidueKind[];
  /** An unread place of a kind this list does not name. */
  readonly unreadOther: boolean;
}

const KIND_SET: ReadonlySet<string> = new Set(RESIDUE_KINDS);

/** The residue a `redact` result reports, or null when there is none to
 * offer and the scan read every place. A malformed result is treated as
 * none: the redaction itself succeeded, and a question built on unreadable
 * data would name nothing. */
export function residueOf(result: unknown): Residue | null {
  if (result === null || typeof result !== 'object') return null;
  const fields = result as Record<string, unknown>;
  const terms = Array.isArray(fields.removed_text)
    ? fields.removed_text.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  const entries = Array.isArray(fields.residue)
    ? fields.residue.flatMap((raw): ResidueEntry[] => {
      if (raw === null || typeof raw !== 'object') return [];
      const { kind, where, text } = raw as Record<string, unknown>;
      if (typeof kind !== 'string' || !KIND_SET.has(kind)) return [];
      return [{ kind: kind as ResidueKind, where: String(where ?? ''), text: String(text ?? '') }];
    })
    : [];
  const counts = new Map<ResidueKind, number>();
  const reported = fields.residue_counts;
  if (reported !== null && typeof reported === 'object') {
    for (const [kind, n] of Object.entries(reported as Record<string, unknown>)) {
      const count = Math.trunc(Number(n));
      if (KIND_SET.has(kind) && Number.isFinite(count) && count > 0) counts.set(kind as ResidueKind, count);
    }
  }
  for (const entry of entries) {
    if (!counts.has(entry.kind)) {
      counts.set(entry.kind, entries.filter((e) => e.kind === entry.kind).length);
    }
  }
  let reportOnly = 0;
  const unchanged = fields.residue_report_only;
  if (unchanged !== null && typeof unchanged === 'object') {
    for (const n of Object.values(unchanged as Record<string, unknown>)) {
      const count = Math.trunc(Number(n));
      if (Number.isFinite(count) && count > 0) reportOnly += count;
    }
  }
  // Each unread place is named `kind: where` by the engine.
  const unreadRaw = Array.isArray(fields.residue_unread)
    ? fields.residue_unread.filter((u): u is string => typeof u === 'string')
    : [];
  const unreadKinds = unreadRaw.map((u) => u.split(':')[0].trim());
  const unread = RESIDUE_KINDS.filter((kind) => unreadKinds.includes(kind));
  const unreadOther = unreadKinds.some((kind) => !KIND_SET.has(kind));
  const incomplete = unreadRaw.length > 0;
  // Only removable places are offered: a question whose answer cannot
  // clear what it lists would report a removal that did not happen. A scan
  // that could not read every place is still reported, never read as clean.
  if (!terms.length || (!counts.size && !incomplete)) return null;
  return { terms, entries, counts, reportOnly, truncated: fields.residue_truncated === true, incomplete, unread, unreadOther };
}

/** The label each kind is listed under. */
const KIND_LABELS: Record<ResidueKind, Parameters<typeof tChrome>[0]> = {
  outline: 'panel.sanitize.category.bookmarks',
  thread: 'canvas.redact.residue.thread',
  dest_name: 'panel.optimize.audit.category.named_destinations',
  page_label: 'canvas.redact.residue.pageLabel',
  metadata: 'panel.sanitize.category.metadata',
  annotation: 'panel.sanitize.category.comments',
  field: 'panel.sanitize.category.form_fields',
  embedded_file: 'panel.sanitize.category.embedded_files',
  javascript: 'panel.sanitize.category.javascript',
};

/** (label key, count) per kind found, in `RESIDUE_KINDS` order. */
export function residueGroups(residue: Residue): { label: Parameters<typeof tChrome>[0]; count: number }[] {
  return RESIDUE_KINDS.filter((kind) => residue.counts.has(kind))
    .map((kind) => ({ label: KIND_LABELS[kind], count: residue.counts.get(kind)! }));
}

/** Whether the residue offers places to remove, rather than only reporting
 * an incomplete scan. */
export function residueRemovable(residue: Residue): boolean {
  return residue.counts.size > 0;
}

function unreadNote(residue: Residue, lng?: string): string {
  const labels = residue.unread.map((kind) => tChrome(KIND_LABELS[kind], undefined, lng));
  if (residue.unreadOther || labels.length === 0) labels.push(tChrome('canvas.redact.residue.unreadOther', undefined, lng));
  const places = new Intl.ListFormat(formattingLocale(lng), { style: 'long', type: 'conjunction' }).format(labels);
  return tChrome('canvas.redact.residue.unread', { places }, lng);
}

/** The question's body: every place with its count, in the language's own
 * list pattern, then what removal does that the user cannot see: field
 * names stay, scripts go whole, renamed destinations stop answering links
 * from outside the file, and a capped list still removes every occurrence. */
export function residueMessage(residue: Residue, lng?: string): string {
  if (!residueRemovable(residue)) return unreadNote(residue, lng);
  const items = residueGroups(residue).map(({ label, count }) =>
    tChrome('canvas.redact.residue.item', { kind: tChrome(label, undefined, lng), count }, lng));
  const places = new Intl.ListFormat(formattingLocale(lng), { style: 'long', type: 'conjunction' }).format(items);
  const parts = [tChrome('canvas.redact.residue.message', { places }, lng)];
  if (residue.counts.has('field') || residue.reportOnly > 0) parts.push(tChrome('canvas.redact.residue.fieldNote', undefined, lng));
  if (residue.counts.has('javascript')) parts.push(tChrome('canvas.redact.residue.scriptNote', undefined, lng));
  if (residue.counts.has('dest_name')) parts.push(tChrome('canvas.redact.residue.destNote', undefined, lng));
  if (residue.truncated) parts.push(tChrome('canvas.redact.residue.truncated', undefined, lng));
  if (residue.incomplete) parts.push(unreadNote(residue, lng));
  return parts.join('\n\n');
}

/** The `remove_redaction_residue` parameters: every kind the engine counted,
 * so a row past the report cap is removed with its kind. */
export function residueRequest(residue: Residue): { terms: string[]; kinds: ResidueKind[] } {
  return { terms: [...residue.terms], kinds: RESIDUE_KINDS.filter((kind) => residue.counts.has(kind)) };
}
