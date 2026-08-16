// The comment summary's renderer half — one order, one parameter assembly.
//
// The ENGINE decides which comments, in what order: `list_comments` takes the
// sort and the filter and answers with the model already ordered and narrowed.
// This module is the reader's side of that contract, and the panel goes
// through it, so the on-screen list and the produced document can never give
// two answers to "which comments, in what order".
//
// The document's furniture is resolved here and handed to the engine as an
// explicit labels argument. The engine never translates: a summary is a
// document ABOUT a document, read by a reviewer, so its headings are in the
// UI locale — while bodies, author names and subjects are authored content
// and travel verbatim. Dates split: the VALUE is the document's, the FORMAT
// is the reader's, and the OFFSET is the document's, never converted to this
// machine's zone.
import { currentLanguage, formattingLocale, tChrome, textDirection, tNumber } from '../i18n';

export type CommentSort = 'page' | 'author' | 'date' | 'type';
export type SummaryMode = 'comments_only' | 'document_and_comments';
export type SummaryPlacement = 'auto' | 'beside' | 'beneath' | 'separate';

export const COMMENT_SORTS: readonly CommentSort[] = ['page', 'author', 'date', 'type'];
export const SUMMARY_MODES: readonly SummaryMode[] = [
  'comments_only',
  'document_and_comments',
];
export const SUMMARY_PLACEMENTS: readonly SummaryPlacement[] = [
  'auto',
  'beside',
  'beneath',
  'separate',
];
export const SUMMARY_PAPERS: readonly string[] = [
  'letter',
  'legal',
  'tabloid',
  'a3',
  'a4',
  'a5',
];

/** A PDF date as the engine read it. `raw` is always present; the rest only
 * when the string parsed. `offset` is minutes east of UTC, or null when the
 * value recorded none — never silently read as UTC. */
export interface CommentDate {
  raw: string;
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  offset?: number | null;
}

export interface EngineComment {
  id: string;
  page: number;
  subtype: string;
  rect: [number, number, number, number] | null;
  contents: string;
  author: string;
  subject: string;
  created: CommentDate | null;
  modified: CommentDate | null;
  state: string;
  state_model: string;
  name: string;
  reply_to: string | null;
  reply_type: 'reply' | 'group' | null;
  children: string[];
  orphan: boolean;
  cycle: boolean;
}

export interface CommentModel {
  comments: EngineComment[];
  count: number;
  found: number;
  authors: string[];
  subtypes: string[];
  states: string[];
  by_type: Record<string, number>;
  excluded: { filtered: number; unmodelled: number };
  unreadable: { page: number; reason?: string }[];
  sort: CommentSort;
}

export interface CommentFilter {
  authors?: string[];
  subtypes?: string[];
  states?: string[];
  pages?: string;
  has_body?: boolean;
}

export interface SummaryOptions {
  mode: SummaryMode;
  placement: SummaryPlacement;
  connectors: boolean;
  gutter: number;
  paper: string;
  sort: CommentSort;
  filter: CommentFilter;
}

export const DEFAULT_SUMMARY_OPTIONS: SummaryOptions = {
  mode: 'document_and_comments',
  placement: 'auto',
  connectors: true,
  gutter: 216,
  paper: 'letter',
  sort: 'page',
  filter: {},
};

/** One row of the panel's list: an engine comment plus how deep it sits in its
 * thread. */
export interface CommentRow {
  comment: EngineComment;
  depth: number;
}

/**
 * The engine's comments as display rows, in the engine's own order.
 *
 * The engine already emits a thread's parent before its replies; this derives
 * the indent from `reply_to` rather than re-deriving the order, so a model
 * assembled from a partial answer still renders in one stable sequence and the
 * panel cannot invent an order of its own.
 */
export function orderedComments(model: CommentModel): CommentRow[] {
  const depths = new Map<string, number>();
  const rows: CommentRow[] = [];
  for (const comment of model.comments) {
    const parent = comment.reply_type === 'reply' ? comment.reply_to : null;
    const depth = parent !== null && depths.has(parent) ? (depths.get(parent) ?? 0) + 1 : 0;
    depths.set(comment.id, depth);
    rows.push({ comment, depth });
  }
  return rows;
}

/** Whether the caller narrowed anything at all — "0 comments" and "40 comments
 * you filtered away" are different answers and the panel says which it is. */
export function filterIsActive(filter: CommentFilter): boolean {
  return (
    (filter.authors?.length ?? 0) > 0 ||
    (filter.subtypes?.length ?? 0) > 0 ||
    (filter.states?.length ?? 0) > 0 ||
    (filter.pages ?? '') !== '' ||
    filter.has_body !== undefined
  );
}

/** The filter as the engine's own shape: a condition the user did not set is
 * ABSENT, never an empty list, because an empty list narrows nothing while
 * claiming to have been asked to. */
export function engineFilter(filter: CommentFilter): CommentFilter {
  const out: CommentFilter = {};
  if (filter.authors?.length) out.authors = [...filter.authors];
  if (filter.subtypes?.length) out.subtypes = [...filter.subtypes];
  if (filter.states?.length) out.states = [...filter.states];
  if (filter.pages) out.pages = filter.pages;
  if (filter.has_body !== undefined) out.has_body = filter.has_body;
  return out;
}

/**
 * A comment date in the reader's locale, at the DOCUMENT's own offset.
 *
 * The wall clock is rendered exactly as recorded: the instant is built as if
 * it were UTC and formatted in the UTC zone, so the formatter reproduces the
 * recorded numbers rather than shifting them into this machine's zone. A
 * conversion would silently move a comment across a date boundary for every
 * reader who is not in the author's zone. A value with no offset says so; a
 * value that is not a date string is shown verbatim, which is what a PDF
 * processor is required to do with one.
 */
export function formatCommentDate(date: CommentDate | null): string {
  if (date === null) return tChrome('panel.comments.dateMissing');
  if (date.year === undefined) return date.raw;
  const instant = Date.UTC(
    date.year,
    (date.month ?? 1) - 1,
    date.day ?? 1,
    date.hour ?? 0,
    date.minute ?? 0,
    date.second ?? 0,
  );
  const stamp = new Intl.DateTimeFormat(formattingLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(instant));
  const offset = date.offset;
  if (offset === null || offset === undefined) {
    return tChrome('panel.comments.dateNoOffset', { date: stamp });
  }
  const sign = offset < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return tChrome('panel.comments.dateWithOffset', {
    date: stamp,
    offset: `${sign}${hours}:${minutes}`,
  });
}

/** Every distinct raw date string in the model, mapped to the reader's own
 * rendering of it. The engine writes these into the document verbatim. */
export function renderedDates(model: CommentModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const comment of model.comments) {
    for (const date of [comment.created, comment.modified]) {
      if (date && !(date.raw in out)) out[date.raw] = formatCommentDate(date);
    }
  }
  return out;
}

/** The PDF vocabulary's own name for a subtype, through the keys the Comments
 * panel already uses — never a second vocabulary for the same list. An
 * unnamed subtype shows its own identifier, which is a word, rather than
 * nothing. */
export function typeLabel(subtype: string): string {
  const key = SUBTYPE_KEY[subtype.toLowerCase()];
  return key ? tChrome(key) : subtype;
}

const SUBTYPE_KEY: Record<string, Parameters<typeof tChrome>[0]> = {
  highlight: 'panel.comments.kind.highlight',
  underline: 'panel.comments.kind.underline',
  strikeout: 'panel.comments.kind.strikeout',
  squiggly: 'panel.comments.kind.squiggly',
  freetext: 'panel.comments.kind.freetext',
  ink: 'panel.comments.kind.ink',
  stamp: 'panel.comments.kind.stamp',
  text: 'panel.comments.kind.note',
  line: 'panel.comments.kind.line',
  square: 'panel.comments.kind.square',
  circle: 'panel.comments.kind.circle',
  polygon: 'panel.comments.kind.polygon',
  polyline: 'panel.comments.kind.polyline',
  caret: 'panel.comments.kind.caret',
  fileattachment: 'panel.comments.kind.fileattachment',
  sound: 'panel.comments.kind.sound',
  redact: 'panel.comments.kind.redact',
};

/** Which subtypes the catalog names — the gate pairs this against the engine's
 * own markup set, so a subtype the engine reports and nothing names fails
 * there rather than rendering as its own identifier in the UI. */
export const SUBTYPE_KEYS: readonly string[] = Object.keys(SUBTYPE_KEY);

/** The engine's furniture keys, paired with the catalog rows that fill them.
 * The engine substitutes the values; nothing here is concatenated. */
const LABEL_KEYS: readonly (readonly [string, Parameters<typeof tChrome>[0]])[] = [
  ['title', 'panel.comments.doc.title'],
  ['document', 'panel.comments.doc.document'],
  ['pageHeading', 'panel.comments.doc.pageHeading'],
  ['pageContinued', 'panel.comments.doc.pageContinued'],
  ['entryHeader', 'panel.comments.doc.entryHeader'],
  ['entryMeta', 'panel.comments.doc.entryMeta'],
  ['replyHeader', 'panel.comments.doc.replyHeader'],
  ['replyMeta', 'panel.comments.doc.replyMeta'],
  ['continued', 'panel.comments.doc.continued'],
  ['subject', 'panel.comments.doc.subject'],
  ['state', 'panel.comments.doc.state'],
  ['stateNoModel', 'panel.comments.doc.stateNoModel'],
  ['groupMember', 'panel.comments.doc.groupMember'],
  ['replyOrphan', 'panel.comments.doc.replyOrphan'],
  ['replyCycle', 'panel.comments.doc.replyCycle'],
  ['noPosition', 'panel.comments.doc.noPosition'],
  ['noBody', 'panel.comments.doc.noBody'],
  ['unknownAuthor', 'panel.comments.doc.unknownAuthor'],
  ['bodyRefused', 'panel.comments.doc.bodyRefused'],
  ['dateMissing', 'panel.comments.dateMissing'],
  ['dateNoOffset', 'panel.comments.dateNoOffset'],
  ['reconcileHeading', 'panel.comments.doc.reconcileHeading'],
  ['reconcileFound', 'panel.comments.doc.reconcileFound'],
  ['reconcileWritten', 'panel.comments.doc.reconcileWritten'],
  ['reconcileFiltered', 'panel.comments.doc.reconcileFiltered'],
  ['reconcileUnmodelled', 'panel.comments.doc.reconcileUnmodelled'],
  ['reconcileNoPosition', 'panel.comments.doc.reconcileNoPosition'],
  ['reconcileBodyRefused', 'panel.comments.doc.reconcileBodyRefused'],
  ['reconcileUnreadable', 'panel.comments.doc.reconcileUnreadable'],
  ['reconcileNoBox', 'panel.comments.doc.reconcileNoBox'],
  ['reconcileBalanced', 'panel.comments.doc.reconcileBalanced'],
  ['sortedBy', 'panel.comments.doc.sortedBy'],
  ['sortPage', 'panel.comments.sort.page'],
  ['sortAuthor', 'panel.comments.sort.author'],
  ['sortDate', 'panel.comments.sort.date'],
  ['sortType', 'panel.comments.sort.type'],
];

/** The document's own furniture, resolved from the catalog. */
export function summaryLabels(subtypes: readonly string[]): Record<string, unknown> {
  const labels: Record<string, unknown> = {};
  for (const [name, key] of LABEL_KEYS) labels[name] = tChrome(key);
  const types: Record<string, string> = {};
  for (const subtype of subtypes) types[subtype] = typeLabel(subtype);
  labels.types = types;
  return labels;
}

/** The reader's own numerals, as the ten digits the engine substitutes with.
 * A locale whose numbers are not Western would otherwise get its own headings
 * with Western digits inside them. */
export function localeDigits(): string {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => tNumber(n)).join('');
}

/** The summary's own file name, date-first so one folder sorts
 * chronologically — the accessibility report's naming shape. */
export function summaryFileName(documentName: string, runAt: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date =
    `${runAt.getFullYear()}${pad(runAt.getMonth() + 1)}${pad(runAt.getDate())}` +
    `-${pad(runAt.getHours())}${pad(runAt.getMinutes())}`;
  const base = documentName.replace(/\.[Pp][Dd][Ff]$/, '').replace(/[\\/:*?"<>|]/g, '_');
  return `${base}-comments-${date}.pdf`;
}

/** Everything `summarize_comments` is called with, assembled in one place so
 * the dialog cannot send a parameter the engine does not model. */
export function summaryParams(
  workingPath: string,
  output: string,
  options: SummaryOptions,
  model: CommentModel,
  documentName: string,
  fontPath: string,
): Record<string, unknown> {
  const language = currentLanguage();
  return {
    file: workingPath,
    output,
    mode: options.mode,
    placement: options.placement,
    connectors: options.connectors,
    gutter: options.gutter,
    paper: options.paper,
    sort: options.sort,
    filter: engineFilter(options.filter),
    labels: summaryLabels(model.subtypes),
    dates: renderedDates(model),
    digits: localeDigits(),
    lang: language,
    direction: textDirection(language),
    font_path: fontPath,
    document_name: documentName,
  };
}

/** What `summarize_comments` reports back. */
export interface SummaryResult {
  output: string;
  sheets: number;
  found: number;
  written: number;
  excluded: {
    filtered: number;
    unmodelled: number;
    no_position: number;
    body_refused: number;
  };
  unreadable: { page: number }[];
  no_box_pages: number[];
  reconciles: boolean;
  marks: { badge: number; page: number; comment: string; sheet: number }[];
}

/**
 * A file comment matched to the workspace annotation that can act on it.
 *
 * The match is the IMPORT FINGERPRINT — subtype plus the raw PDF-space rect
 * the annotation was read with. That rect is the one the engine reports, and
 * it is deliberately not the display-normalized one the canvas keeps, so a
 * page the user has rotated in the page tier still matches. A comment with no
 * match is listed without its action buttons rather than dropped.
 */
export interface MatchableRow {
  annotationId: string;
  subtype: string;
  rect: readonly [number, number, number, number];
}

export function matchWorkspaceRow(
  comment: EngineComment,
  rows: readonly MatchableRow[],
  used: Set<string>,
): MatchableRow | null {
  if (comment.rect === null) return null;
  for (const row of rows) {
    if (used.has(row.annotationId)) continue;
    if (row.subtype.toLowerCase() !== comment.subtype.toLowerCase()) continue;
    const near = row.rect.every(
      (value, index) => Math.abs(value - (comment.rect as number[])[index]) < 0.01,
    );
    if (near) {
      used.add(row.annotationId);
      return row;
    }
  }
  return null;
}
