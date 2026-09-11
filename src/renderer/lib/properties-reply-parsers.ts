// Strict readers for the two editable Properties getters.
//
// The tolerant parsers these stand beside (`parseAdvanced`, `parseInitialView`)
// exist to keep an out-of-range value out of a <select>: every unreadable
// field becomes its default. That is right for the workbench's own use of a
// document's initial view, where a field nobody can read means the reader's
// own setting stands — and it is wrong for a dialog, where the same defaults
// are shown as FACTS and installed as the baseline a save is computed
// against. `tagged: false` from a reply that never contained `tagged` is not
// a fact about a document; it is a fact about this parser.
//
// So these readers require the whole reply and refuse anything else. A refusal
// is a result the caller reports as unknown; it is never a value. They do not
// replace the tolerant pair — App.tsx's `applyInitialView` still wants
// tolerance, because there a missing field costs a preference, not a claim.
//
// Pure: no React, no DOM, no I/O, no clock, no user-facing prose. The error
// carries a field path and a machine reason; localization is the caller's.
//
// WHAT "COMPLETE" MEANS. Required is every field the engine's getter always
// sends AND that the production type carries. `get_advanced_properties` also
// sends `file`, `header_version` and `catalog_version`; none is in
// `AdvancedProperties`, none is displayed or edited today, so all three are
// ignored here. If an integration surfaces the header/catalog declarations,
// they move into the required set in the same change.
//
// KNOWN-ABSENT IS NOT MALFORMED. The engine states absence explicitly, and
// each spelling is accepted as the fact it is: `search_index: null` (no index
// recorded), `catalog_version: null`, `base_url: ''` (no base URI), a zero-row
// `page_sizes` (a zero-page document), `open_page: null` (no opening
// destination), `trapped: 'unknown'`, `'default'` for a layout/mode/zoom the
// document does not state. What is refused is a field that is absent from the
// REPLY, carries the wrong type, or carries a value the engine cannot produce.

import {
  TRAPPED_VALUES,
  type AdvancedProperties,
  type PageSizeGroup,
  type TrappedValue,
} from './doc-advanced';
import {
  PAGE_LAYOUT_VALUES,
  PAGE_MODE_VALUES,
  VIEWER_ONLY_OPTIONS,
  ZOOM_VALUES,
  type InitialView,
  type PageLayoutValue,
  type PageModeValue,
  type ReadingDirection,
  type ViewerOnlyOption,
  type ZoomValue,
} from './initial-view';

export type ReplyErrorReason =
  /** The reply, or a nested value that must be a dictionary, is not one. */
  | 'not-an-object'
  /** The key is absent from the reply. Distinct from a present null. */
  | 'missing'
  | 'wrong-type'
  /** A string outside the vocabulary the engine writes. */
  | 'unknown-value'
  | 'not-finite'
  | 'not-integer'
  | 'out-of-range'
  /** A string that carries a value must not carry an empty one. */
  | 'empty'
  /** Two rows describe the same page size, which one reply cannot. */
  | 'duplicate'
  /** Fields that the engine derives from one another disagree. */
  | 'inconsistent';

/** A refusal to read a reply. `message` is a machine identifier, not prose:
 * the caller supplies the sentence a user reads. */
export class PropertiesReplyError extends Error {
  readonly path: string;
  readonly reason: ReplyErrorReason;
  constructor(path: string, reason: ReplyErrorReason) {
    super(`${path}:${reason}`);
    this.name = 'PropertiesReplyError';
    this.path = path;
    this.reason = reason;
  }
}

/** The version strings `engine/pdf_version.version_facts` can produce: ISO
 * 32000-1 covers 1.0–1.7 and ISO 32000-2 covers 2.0, and its reader refuses
 * everything else, so anything else here did not come from that reader. A
 * later ISO revision grows both sides in one change. */
const ENGINE_VERSIONS: readonly string[] = [
  '1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0',
];

const DIRECTIONS: readonly ReadingDirection[] = ['L2R', 'R2L'];

function fail(path: string, reason: ReplyErrorReason, _reply: unknown): never {
  throw new PropertiesReplyError(path, reason);
}

/** A reader bound to one reply, so every refusal names its own field. */
class ReplyReader {
  private readonly root: Record<string, unknown>;

  constructor(
    value: unknown,
    private readonly scope: string,
    private readonly reply: unknown = value,
  ) {
    this.root = this.asDict(value, scope);
  }

  private asDict(value: unknown, path: string): Record<string, unknown> {
    // An array and a null are both `typeof 'object'`, and a reply that is
    // either one is not a reply.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(path, 'not-an-object', this.reply);
    }
    return value as Record<string, unknown>;
  }

  private at(key: string): string {
    return `${this.scope}.${key}`;
  }

  /** The value under `key`, refusing a key the reply does not carry. */
  private raw(key: string): unknown {
    if (!Object.prototype.hasOwnProperty.call(this.root, key)) {
      fail(this.at(key), 'missing', this.reply);
    }
    return this.root[key];
  }

  boolean(key: string): boolean {
    const value = this.raw(key);
    // A boolean and nothing else: 'true', 1 and '' are three different
    // producers' idea of a flag, and none of them is this engine's.
    if (typeof value !== 'boolean') fail(this.at(key), 'wrong-type', this.reply);
    return value;
  }

  string(key: string, options?: { allowEmpty?: boolean }): string {
    const value = this.raw(key);
    if (typeof value !== 'string') fail(this.at(key), 'wrong-type', this.reply);
    if (value === '' && options?.allowEmpty !== true) {
      fail(this.at(key), 'empty', this.reply);
    }
    return value;
  }

  /** A string the engine writes only with content, or an explicit null. */
  nullableString(key: string): string | null {
    const value = this.raw(key);
    if (value === null) return null;
    if (typeof value !== 'string') fail(this.at(key), 'wrong-type', this.reply);
    if (value === '') fail(this.at(key), 'empty', this.reply);
    return value;
  }

  enum<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.raw(key);
    if (typeof value !== 'string') fail(this.at(key), 'wrong-type', this.reply);
    if (!(allowed as readonly string[]).includes(value)) {
      fail(this.at(key), 'unknown-value', this.reply);
    }
    return value as T;
  }

  integer(key: string, min: number): number {
    return checkInteger(this.raw(key), this.at(key), min, this.reply);
  }

  nullableInteger(key: string, min: number): number | null {
    const value = this.raw(key);
    if (value === null) return null;
    return checkInteger(value, this.at(key), min, this.reply);
  }

  /** A magnification: finite and positive. NOT range-checked against the
   * panel's 1–6400, because the engine's reader is not: a document whose
   * /XYZ scale is 0.001 reads back as 0.1, and refusing it would refuse a
   * faithful reply. See the module's note on that asymmetry. */
  nullablePositive(key: string): number | null {
    const value = this.raw(key);
    if (value === null) return null;
    if (typeof value !== 'number') fail(this.at(key), 'wrong-type', this.reply);
    if (!Number.isFinite(value)) fail(this.at(key), 'not-finite', this.reply);
    if (value <= 0) fail(this.at(key), 'out-of-range', this.reply);
    return value;
  }

  /** The page-size groups. A malformed row refuses the reply: the tolerant
   * parser skips one, which silently reports a document as having fewer
   * distinct page sizes than it has. */
  pageSizes(key: string): PageSizeGroup[] {
    const value = this.raw(key);
    if (!Array.isArray(value)) fail(this.at(key), 'wrong-type', this.reply);
    const groups: PageSizeGroup[] = [];
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      const path = `${this.at(key)}[${index}]`;
      const row = this.asDict(entry, path);
      // A degenerate box (a zero extent) is a document defect the engine
      // reports faithfully, so zero passes and a negative extent — which
      // `abs()` cannot produce — does not.
      const own = (key: string) => Object.prototype.hasOwnProperty.call(row, key);
      const width = checkNumber(row.width, `${path}.width`, 0, this.reply, own('width'));
      const height = checkNumber(row.height, `${path}.height`, 0, this.reply, own('height'));
      const count = checkInteger(row.count, `${path}.count`, 1, this.reply, own('count'));
      const identity = `${width}x${height}`;
      if (seen.has(identity)) fail(path, 'duplicate', this.reply);
      seen.add(identity);
      groups.push({ width, height, count });
    });
    return groups;
  }
}

function checkNumber(
  value: unknown,
  path: string,
  min: number,
  reply: unknown,
  present = true,
): number {
  if (!present) fail(path, 'missing', reply);
  if (typeof value !== 'number') fail(path, 'wrong-type', reply);
  if (!Number.isFinite(value)) fail(path, 'not-finite', reply);
  if (value < min) fail(path, 'out-of-range', reply);
  return value;
}

function checkInteger(
  value: unknown,
  path: string,
  min: number,
  reply: unknown,
  present = true,
): number {
  const number = checkNumber(value, path, min, reply, present);
  if (!Number.isSafeInteger(number)) fail(path, 'not-integer', reply);
  return number;
}

/**
 * `get_advanced_properties`' reply, or a `PropertiesReplyError`.
 *
 * Required: version, linearized, tagged, pages, page_sizes, bytes, trapped,
 * base_url, has_open_action, search_index. Ignored: file, header_version,
 * catalog_version, and anything a later engine adds.
 */
export function parseAdvancedReply(value: unknown): AdvancedProperties {
  const reader = new ReplyReader(value, 'advanced');
  const result = {
    version: reader.enum('version', ENGINE_VERSIONS),
    linearized: reader.boolean('linearized'),
    tagged: reader.boolean('tagged'),
    pages: reader.integer('pages', 0),
    page_sizes: reader.pageSizes('page_sizes'),
    bytes: reader.integer('bytes', 0),
    trapped: reader.enum<TrappedValue>('trapped', TRAPPED_VALUES),
    // '' is the engine's spelling for a document with no /URI /Base.
    base_url: reader.string('base_url', { allowEmpty: true }),
    has_open_action: reader.boolean('has_open_action'),
    search_index: reader.nullableString('search_index'),
  };
  if (result.page_sizes.reduce((sum, row) => sum + row.count, 0) !== result.pages) {
    fail('advanced.page_sizes', 'inconsistent', value);
  }
  return result;
}

/**
 * `get_initial_view`' reply, or a `PropertiesReplyError`.
 *
 * Required: page_layout, page_mode, open_page, zoom, zoom_percent, the six
 * window options, direction, open_action_replaceable, pages. Ignored: file,
 * and anything a later engine adds.
 */
export function parseInitialViewReply(value: unknown): InitialView {
  const reader = new ReplyReader(value, 'initialView');
  const pages = reader.integer('pages', 0);
  const openPage = reader.nullableInteger('open_page', 1);
  const zoom = reader.enum<ZoomValue>('zoom', ZOOM_VALUES);
  const zoomPercent = reader.nullablePositive('zoom_percent');
  // The engine derives the opening page from a real page index, so a page
  // beyond the document's own count cannot be a faithful reply.
  if (openPage !== null && openPage > pages) {
    fail('initialView.open_page', 'out-of-range', value);
  }
  // `_read_zoom` returns a percentage from exactly one branch, and that branch
  // is the only one that returns 'percent'. The two fields therefore agree in
  // both directions or the reply is not this engine's.
  if ((zoom === 'percent') !== (zoomPercent !== null)) {
    fail('initialView.zoom_percent', 'inconsistent', value);
  }
  if (openPage === null && zoom !== 'default') {
    fail('initialView.open_page', 'inconsistent', value);
  }
  // Read FROM the option list rather than by hand, so a seventh window option
  // becomes required here by adding it there — a hand-written sixth of seven
  // would be a field nobody reads and nobody misses.
  const windowOptions = Object.fromEntries(
    VIEWER_ONLY_OPTIONS.map((option) => [option, reader.boolean(option)]),
  ) as Record<ViewerOnlyOption, boolean>;
  return {
    page_layout: reader.enum<PageLayoutValue>('page_layout', PAGE_LAYOUT_VALUES),
    page_mode: reader.enum<PageModeValue>('page_mode', PAGE_MODE_VALUES),
    open_page: openPage,
    zoom,
    zoom_percent: zoomPercent,
    ...windowOptions,
    direction: reader.enum<ReadingDirection>('direction', DIRECTIONS),
    open_action_replaceable: reader.boolean('open_action_replaceable'),
    pages,
  };
}
