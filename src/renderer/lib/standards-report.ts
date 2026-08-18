// What a standards conversion changed, as the panels read it.
//
// The engine builds the report and owns the vocabulary (`engine/
// standards_report.py`). Two vocabularies, not one: a LOSS row's kind names
// what was removed, while an UNDETERMINED row's kind names the FACT the check
// could not read — a check that did not run cannot have observed a loss, so it
// carries the fact's own name instead. Both are mirrored here because the
// labels are catalog keys derived from them, and `tests/standards-report.test
// .ts` reads the engine module as source text and fails on divergence, so a
// kind the engine gains cannot reach a panel nameless.
//
// A kind with no mirror row still renders its raw `kind` rather than an empty
// line: an unlabelled alteration must remain visible as one.
import { formattingLocale, tChrome } from '../i18n';

/** One thing the conversion changed, or one check that could not run. */
export interface AlterationRow {
  readonly kind: string;
  readonly count: number;
  readonly detail: readonly Record<string, unknown>[];
  readonly detail_truncated?: boolean;
  readonly undetermined?: boolean;
  /** Why the check could not run, in the engine's own English. */
  readonly reason?: string;
}

export interface StandardsReport {
  readonly altered: readonly AlterationRow[];
  /** Producer text no known shape matched, verbatim. */
  readonly producer_notices: readonly string[];
  readonly notices_truncated?: boolean;
}

/** Kinds a LOSS row carries. */
export const ALTERATION_KINDS: readonly string[] = [
  'pages_removed',
  'annotations_removed',
  'form_fields_removed',
  'attachments_removed',
  'document_scripts_removed',
  'optional_content_removed',
  'tagged_structure_removed',
  'outline_removed',
  'encryption_removed',
  'page_content_rasterized',
  'colorants_removed',
  'colorant_shadings_rasterized',
  'images_removed',
  'fonts_substituted',
  'producer_removed_feature',
  'conformance_abandoned',
  'embedded_file_unvalidated',
];

/** Kinds an UNDETERMINED row carries — the engine's fact names. */
export const FACT_KINDS: readonly string[] = [
  'pages',
  'annotations',
  'form_fields',
  'attachments',
  'document_scripts',
  'optional_content',
  'tagged_structure',
  'outline',
  'encryption',
  'page_marks',
  'images',
];

/** Structure parts a `tagged_structure_removed` row names. */
export const STRUCTURE_PARTS: readonly string[] = [
  'structure tree',
  'mark information',
  'document language',
];

/** Kinds of mark a page paints, as the rasterization row reports them. */
export const PAGE_MARKS: readonly string[] = ['text', 'vector', 'image'];

const LABELLED = new Set<string>([...ALTERATION_KINDS, ...FACT_KINDS]);
const PARTS = new Set<string>(STRUCTURE_PARTS);
const MARKS = new Set<string>(PAGE_MARKS);

type Key = Parameters<typeof tChrome>[0];

/** The row's name in the UI language, or its raw kind when nothing names it. */
export function rowLabel(kind: string): string {
  return LABELLED.has(kind) ? tChrome(`panel.standards.row.${kind}` as Key) : kind;
}

/**
 * Does this row's number say anything the row itself does not?
 *
 * Four facts are document-wide booleans the engine reports as a count of one
 * with nothing behind them, and a bare 1 beside an encryption-removed row
 * reads as a quantity that was never measured.
 */
export function countIsMeaningful(row: AlterationRow): boolean {
  return !(row.count === 1 && row.detail.length === 0);
}

/** One line of evidence under a row. */
export interface DetailLine {
  readonly text: string;
  /** Producer text, reproduced rather than translated. */
  readonly verbatim: boolean;
}

function partLabel(part: string): string {
  return PARTS.has(part)
    ? tChrome(`panel.standards.part.${part.replace(/ /g, '_')}` as Key)
    : part;
}

function markLabel(mark: string): string {
  return MARKS.has(mark) ? tChrome(`panel.standards.mark.${mark}` as Key) : mark;
}

/** The marks a page used to paint, in the locale's own list punctuation. */
function markList(values: unknown): string {
  const items = (Array.isArray(values) ? values : []).map((v) => markLabel(String(v)));
  try {
    return new Intl.ListFormat(formattingLocale(), { style: 'short', type: 'unit' }).format(
      items,
    );
  } catch {
    // A tag Intl cannot parse must not cost the evidence line.
    return items.join(', ');
  }
}

const has = (entry: Record<string, unknown>, key: string): boolean =>
  entry[key] !== undefined && entry[key] !== null;

/**
 * One detail entry as a readable line.
 *
 * The shapes are the engine's, discriminated by the fields present rather than
 * by the row's kind: `was` carries a structure part's old value in one row and
 * a page's mark kinds in another, so `part` and `page` are tested before it.
 */
export function detailLine(entry: Record<string, unknown>): DetailLine {
  if (has(entry, 'message')) return { text: String(entry.message), verbatim: true };
  if (has(entry, 'part')) {
    const part = partLabel(String(entry.part));
    return {
      text: has(entry, 'was')
        ? tChrome('panel.standards.detail.partWas', { part, was: String(entry.was) })
        : part,
      verbatim: false,
    };
  }
  if (has(entry, 'page')) {
    return {
      text: tChrome('panel.standards.detail.pageMarks', {
        page: String(entry.page),
        marks: markList(entry.was),
      }),
      verbatim: false,
    };
  }
  if (has(entry, 'requested') && has(entry, 'used')) {
    return {
      text: tChrome('panel.standards.detail.change', {
        from: String(entry.requested),
        to: String(entry.used),
      }),
      verbatim: false,
    };
  }
  if (has(entry, 'before') && has(entry, 'after')) {
    return {
      text: tChrome('panel.standards.detail.change', {
        from: String(entry.before),
        to: String(entry.after),
      }),
      verbatim: false,
    };
  }
  if (has(entry, 'subtype')) {
    return {
      text: tChrome('panel.standards.detail.subtypeCount', {
        subtype: String(entry.subtype),
        count: String(entry.removed ?? ''),
      }),
      verbatim: false,
    };
  }
  if (has(entry, 'name')) return { text: String(entry.name), verbatim: false };
  // An entry shape nothing recognizes still shows its values: a detail line
  // that renders empty would hide the evidence the row was written to carry.
  return { text: Object.values(entry).map((v) => String(v)).join(' '), verbatim: false };
}

/** Every evidence line under one row. */
export function detailLines(row: AlterationRow): DetailLine[] {
  return row.detail.map(detailLine);
}
