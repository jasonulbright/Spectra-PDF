// N12 slice D (brief 37) — the ENGINE-MESSAGE BOUNDARY.
//
// The Python engine refuses in ENGLISH and keeps doing so: the CLI, the
// operation log, the diagnostics and the fingerprint text are all English by
// contract, and a message that changed with the UI language would fork every
// one of them from the thing they describe. Localization therefore happens
// on ONE side only — here, where the refusal crosses into the UI — by
// RECOGNIZING the English the engine sent and rendering the catalog entry
// that means the same thing.
//
// The table is `locales/engine-messages.tsv`: generated from an AST sweep of
// `src/engine/*.py` (`scripts/gen-engine-messages.py`), reviewed as a git
// diff, checked in, and gated by `tests/test_engine_messages.py`, which
// fails when the engine raises something the table doesn't carry. That gate
// is the whole reason this is safe to do by text match.
//
// Two rules the rest of the app depends on:
//
//   * NOTHING IS EVER SWALLOWED. A message with no row — a composed one, a
//     Ghostscript stderr dump, a refusal added since the last sweep — is
//     returned VERBATIM. The worst case is an English sentence in a Spanish
//     UI, never a lost or invented one.
//   * THE ENGLISH SURVIVES. `EngineError.raw` carries the exact bytes the
//     engine sent, and every English sink reads THAT: the operation log, and
//     the batch report's `reason` strings (byte-identical to the batch log,
//     pinned by `tests/batch-log.test.ts`). Only display reads `message`.
// The INITIALIZED instance (not the bare `i18next` package): this module is
// reached from pure libs whose vitest runs never mount the app, and an
// uninitialized instance has no `t`.
import i18next from '../i18n';
import tableSource from '../locales/engine-messages.tsv?raw';

export interface EngineMessageRow {
  /** Catalog id — the entry is `engine.<key>`. */
  readonly key: string;
  readonly kind: 'exact' | 'pattern';
  /** Engine modules that raise it (review/traceability; the gate pins it). */
  readonly modules: readonly string[];
  /** The English message, `{{name}}` where the engine interpolated a value. */
  readonly message: string;
}

function decodeField(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      const mapped = next === '\\' ? '\\' : next === 't' ? '\t' : next === 'n' ? '\n' : next === 'r' ? '\r' : null;
      if (mapped !== null) {
        out += mapped;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function parseTable(source: string): EngineMessageRow[] {
  const rows: EngineMessageRow[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 4) continue;
    const [key, kind, modules, message] = fields;
    if (key === 'key' && kind === 'kind') continue; // header
    if (kind !== 'exact' && kind !== 'pattern') continue;
    rows.push({
      key,
      kind,
      modules: modules ? modules.split(',') : [],
      message: decodeField(message),
    });
  }
  return rows;
}

export const ENGINE_MESSAGE_ROWS: readonly EngineMessageRow[] = parseTable(tableSource);

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;

/** How many LITERAL characters a template carries outside its placeholders —
 *  the specificity a pattern is ranked by. */
export function literalAnchorLength(message: string): number {
  return message.replace(PLACEHOLDER, '').length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledPattern {
  readonly row: EngineMessageRow;
  readonly regex: RegExp;
  readonly variables: readonly string[];
}

function compile(row: EngineMessageRow): CompiledPattern {
  const variables: string[] = [];
  let source = '';
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(row.message)) !== null) {
    source += escapeRegExp(row.message.slice(last, match.index));
    // GREEDY, deliberately. The interpolated values are overwhelmingly file
    // paths and nested error text, which routinely contain the same
    // punctuation the surrounding literal uses (`Ghostscript render failed
    // for {{file}}: {{detail}}` against `C:\a.pdf: broken` — non-greedy would
    // split at the drive colon and call the path "C"). Greedy takes the LAST
    // viable split, which is right for a trailing detail; the `$` anchor and
    // the literals still force a full-string match, and a mis-split cannot
    // lose text — the translation reassembles the same literals around the
    // same captures.
    source += '([\\s\\S]+)';
    variables.push(match[1]);
    last = match.index + match[0].length;
  }
  source += escapeRegExp(row.message.slice(last));
  return { row, regex: new RegExp(`^${source}$`), variables };
}

const EXACT: ReadonlyMap<string, EngineMessageRow> = new Map(
  ENGINE_MESSAGE_ROWS.filter((r) => r.kind === 'exact').map((r) => [r.message, r]),
);

// Most-specific-first: two templates can both match one message (`Ghostscript
// failed: X` also satisfies the generic `{{what}} failed: {{detail}}`), and
// the one carrying more literal text is the one that was written for it.
const PATTERNS: readonly CompiledPattern[] = ENGINE_MESSAGE_ROWS
  .filter((r) => r.kind === 'pattern')
  .map(compile)
  .sort((a, b) => literalAnchorLength(b.row.message) - literalAnchorLength(a.row.message));

/** The row this engine message came from, with its captured values — or null
 *  when the message is not one the engine is known to raise. */
export function matchEngineMessage(
  raw: string,
): { row: EngineMessageRow; values: Record<string, string> } | null {
  const exact = EXACT.get(raw);
  if (exact) return { row: exact, values: {} };
  for (const pattern of PATTERNS) {
    const found = pattern.regex.exec(raw);
    if (!found) continue;
    const values: Record<string, string> = {};
    pattern.variables.forEach((name, i) => {
      values[name] = found[i + 1];
    });
    return { row: pattern.row, values };
  }
  return null;
}

/**
 * An engine refusal in the UI language.
 *
 * The captured values are inserted VERBATIM — a file path, a font name, a
 * page number and, where the engine composed one refusal into another, that
 * inner English sentence. Translating a captured fragment would mean
 * translating text this boundary cannot identify, which is exactly what the
 * passthrough rule forbids.
 */
export function localizeEngineMessage(raw: string): string {
  const hit = matchEngineMessage(raw);
  if (!hit) return raw;
  return i18next.t(`engine.${hit.row.key}`, {
    defaultValue: hit.row.message,
    ...hit.values,
  });
}

/**
 * The engine's own English, whatever the UI language.
 *
 * Every English sink calls this instead of reading `.message`: the operation
 * log (a diagnostic sink), and the batch report's `reason` strings, which are
 * written byte-identically into the batch log and pinned by tests. A
 * non-engine error has no English/display split, so its message is both.
 */
export function rawEngineMessage(err: unknown): string {
  if (err instanceof EngineError) return err.raw;
  return err instanceof Error ? err.message : String(err);
}

/**
 * A refusal that came back from the engine over JSON-RPC.
 *
 * `raw` is the exact English the engine sent. `message` is an ACCESSOR, not a
 * stored string, so it renders in whatever language the UI is in when it is
 * read — an error already sitting in a panel's state follows a live language
 * switch instead of freezing in the language it arrived in. Everything that
 * displays an error (`e instanceof Error ? e.message : String(e)`, ~118
 * sites) therefore localizes with no change at the call site; everything that
 * needs the English asks `rawEngineMessage`.
 */
export class EngineError extends Error {
  readonly raw: string;

  constructor(raw: string) {
    // No argument: `Error(undefined)` defines no own `message`, leaving the
    // accessor below as the only one. Passing `raw` here would install an own
    // data property that shadows it.
    super();
    this.raw = raw;
    this.name = 'EngineError';
    Object.defineProperty(this, 'message', {
      get: () => localizeEngineMessage(raw),
      configurable: true,
      enumerable: false,
    });
    // The captured stack header is empty without a constructor message; put
    // the English back so console and crash output still name the refusal.
    if (typeof this.stack === 'string') {
      const [, ...rest] = this.stack.split('\n');
      this.stack = [`EngineError: ${raw}`, ...rest].join('\n');
    }
  }
}
