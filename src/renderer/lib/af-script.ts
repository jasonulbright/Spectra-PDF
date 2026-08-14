// Recognizer: an AcroForm field `/JS` body → a typed script, or null.
//
// The TypeScript half of the twin; `src/engine/afscript.py` is the same table
// and the same grammar, and the two are pinned case for case against
// `tests/fixtures/af-corpus.json`. Python is authoritative for what lands in a
// file; this half exists so the canvas can show a live Total before the fill
// runs, and it writes no bytes.
//
// No JavaScript engine, no `eval`, no dynamic code path. A body is accepted
// only when it is exactly one of two shapes: a call to one of the 18 authored
// `AF*` entry points whose arguments are all literals, or `event.value =
// <expr>` where `<expr>` is the Simplified Field Notation arithmetic grammar.
// Anything else returns null, and the field carrying it keeps its `/JS` bytes.

/** The authored entry points — what a producer writes into `/AA` — and the
 * argument count the reference accepts. A call outside that range is not the
 * call the reference would run, so the body is not recognized. */
export const ENTRY_POINTS: Readonly<Record<string, readonly [number, number]>> = {
  AFNumber_Format: [6, 6],
  AFNumber_Keystroke: [6, 6],
  AFPercent_Format: [2, 3],
  AFPercent_Keystroke: [2, 2],
  AFDate_Format: [1, 1],
  AFDate_FormatEx: [1, 1],
  AFDate_Keystroke: [1, 1],
  AFDate_KeystrokeEx: [1, 1],
  AFTime_Format: [1, 1],
  AFTime_FormatEx: [1, 1],
  AFTime_Keystroke: [1, 1],
  AFTime_KeystrokeEx: [1, 1],
  AFSpecial_Format: [1, 1],
  AFSpecial_Keystroke: [1, 1],
  AFSpecial_KeystrokeEx: [1, 1],
  AFSimple_Calculate: [2, 2],
  AFSimple: [3, 3],
  AFRange_Validate: [4, 4],
};

export type SfnNode =
  | { num: number }
  | { field: string }
  | { op: 'neg'; v: SfnNode }
  | { op: '+' | '-' | '*' | '/'; l: SfnNode; r: SfnNode };

export type ScriptArg = string | number | boolean | null | ScriptArg[];

export type FieldScript =
  | { fn: string; args: ScriptArg[] }
  | { fn: 'SFN'; expr: SfnNode };

const STRING_OR_COMMENT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const WHITESPACE = ' \t\r\n\f\v';

/** Comments removed, string literals preserved verbatim. */
function stripComments(text: string): string {
  return text.replace(STRING_OR_COMMENT, (token) => (token[0] === '"' || token[0] === "'" ? token : ' '));
}

class Reject extends Error {}

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}

  skip(): void {
    while (this.pos < this.text.length && WHITESPACE.includes(this.text[this.pos])) this.pos += 1;
  }

  peek(): string {
    this.skip();
    return this.pos < this.text.length ? this.text[this.pos] : '';
  }

  take(literal: string): boolean {
    this.skip();
    if (this.text.startsWith(literal, this.pos)) {
      this.pos += literal.length;
      return true;
    }
    return false;
  }

  atEnd(): boolean {
    this.skip();
    return this.pos >= this.text.length;
  }

  match(pattern: RegExp): string | null {
    pattern.lastIndex = this.pos;
    const m = pattern.exec(this.text);
    return m ? m[0] : null;
  }
}

const ESCAPES: Record<string, string> = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
};

function stringLiteral(cur: Cursor): string {
  const quote = cur.peek();
  if (quote !== '"' && quote !== "'") throw new Reject();
  let i = cur.pos + 1;
  const out: string[] = [];
  const text = cur.text;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      if (i >= text.length) throw new Reject();
      const esc = text[i];
      if (esc === 'u' && i + 4 < text.length) {
        const code = Number.parseInt(text.slice(i + 1, i + 5), 16);
        if (Number.isNaN(code)) throw new Reject();
        out.push(String.fromCharCode(code));
        i += 5;
        continue;
      }
      if (esc === 'x' && i + 2 < text.length) {
        const code = Number.parseInt(text.slice(i + 1, i + 3), 16);
        if (Number.isNaN(code)) throw new Reject();
        out.push(String.fromCharCode(code));
        i += 3;
        continue;
      }
      out.push(ESCAPES[esc] ?? esc);
      i += 1;
      continue;
    }
    if (ch === quote) {
      cur.pos = i + 1;
      return out.join('');
    }
    out.push(ch);
    i += 1;
  }
  throw new Reject();
}

function literal(cur: Cursor): ScriptArg {
  const ch = cur.peek();
  if (ch === '"' || ch === "'") return stringLiteral(cur);
  if (ch === '[') {
    cur.pos += 1;
    return literalList(cur, ']');
  }
  if (ch === '-' || ch === '+') {
    cur.pos += 1;
    const value = literal(cur);
    if (typeof value !== 'number') throw new Reject();
    return ch === '-' ? -value : value;
  }
  const number = cur.match(NUMBER);
  if (number !== null) {
    cur.pos += number.length;
    return Number(number);
  }
  const word = cur.match(IDENT);
  if (word !== null) {
    cur.pos += word.length;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null' || word === 'undefined') return null;
    if (word === 'Array' || word === 'new') {
      // `new Array(a, b)` — `new` was consumed as the identifier, so the
      // constructor name follows; a bare `Array(a, b)` is the same array in
      // the reference and is accepted alike.
      if (word === 'new') {
        cur.skip();
        const ctor = cur.match(IDENT);
        if (ctor !== 'Array') throw new Reject();
        cur.pos += ctor.length;
      }
      if (!cur.take('(')) throw new Reject();
      return literalList(cur, ')');
    }
    throw new Reject();
  }
  throw new Reject();
}

function literalList(cur: Cursor, closer: string): ScriptArg[] {
  const out: ScriptArg[] = [];
  if (cur.take(closer)) return out;
  for (;;) {
    out.push(literal(cur));
    if (cur.take(',')) {
      if (cur.take(closer)) return out; // trailing comma
      continue;
    }
    if (cur.take(closer)) return out;
    throw new Reject();
  }
}

// ── Simplified Field Notation ─────────────────────────────────────────────
//
//   expr    := term (('+' | '-') term)*
//   term    := factor (('*' | '/') factor)*
//   factor  := NUMBER | FIELDNAME | '(' expr ')' | '-' factor
//
// FIELDNAME is a fully-qualified name: dotted identifier parts, or the quoted
// form a producer writes when a name carries spaces or operators.

function sfnExpr(cur: Cursor): SfnNode {
  let node = sfnTerm(cur);
  for (;;) {
    const ch = cur.peek();
    if (ch !== '+' && ch !== '-') return node;
    cur.pos += 1;
    node = { op: ch, l: node, r: sfnTerm(cur) };
  }
}

function sfnTerm(cur: Cursor): SfnNode {
  let node = sfnFactor(cur);
  for (;;) {
    const ch = cur.peek();
    if (ch !== '*' && ch !== '/') return node;
    cur.pos += 1;
    node = { op: ch, l: node, r: sfnFactor(cur) };
  }
}

function sfnFactor(cur: Cursor): SfnNode {
  const ch = cur.peek();
  if (ch === '-') {
    cur.pos += 1;
    return { op: 'neg', v: sfnFactor(cur) };
  }
  if (ch === '+') {
    cur.pos += 1;
    return sfnFactor(cur);
  }
  if (ch === '(') {
    cur.pos += 1;
    const node = sfnExpr(cur);
    if (!cur.take(')')) throw new Reject();
    return node;
  }
  if (ch === '"' || ch === "'") return { field: stringLiteral(cur) };
  const number = cur.match(NUMBER);
  if (number !== null) {
    cur.pos += number.length;
    return { num: Number(number) };
  }
  const word = cur.match(IDENT);
  if (word !== null) {
    const start = cur.pos;
    cur.pos += word.length;
    while (cur.pos < cur.text.length && cur.text[cur.pos] === '.') {
      cur.pos += 1;
      const part = cur.match(IDENT) ?? cur.match(NUMBER);
      if (part === null) throw new Reject();
      cur.pos += part.length;
    }
    return { field: cur.text.slice(start, cur.pos) };
  }
  throw new Reject();
}

/** Every field name the expression reads, in first-appearance order. */
export function sfnFields(node: SfnNode): string[] {
  const out: string[] = [];
  const walk = (n: SfnNode): void => {
    if ('field' in n) {
      if (!out.includes(n.field)) out.push(n.field);
    } else if ('num' in n) {
      return;
    } else if (n.op === 'neg') {
      walk(n.v);
    } else {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(node);
  return out;
}

/** The typed script for a `/JS` body, or null when it is not one of the
 * accepted shapes. Never throws on arbitrary input. */
export function recognize(js: unknown): FieldScript | null {
  if (typeof js !== 'string') return null;
  const cur = new Cursor(stripComments(js));
  try {
    if (cur.take('event.value')) {
      if (!cur.take('=')) return null;
      if (cur.peek() === '=') return null; // `==` is a comparison, not an assignment
      const expr = sfnExpr(cur);
      cur.take(';');
      if (!cur.atEnd()) return null;
      return { fn: 'SFN', expr };
    }
    cur.skip();
    const name = cur.match(IDENT);
    if (name === null) return null;
    const arity = ENTRY_POINTS[name];
    if (!arity) return null;
    cur.pos += name.length;
    if (!cur.take('(')) return null;
    const args = literalList(cur, ')');
    cur.take(';');
    if (!cur.atEnd()) return null;
    if (args.length < arity[0] || args.length > arity[1]) return null;
    return { fn: name, args };
  } catch (e) {
    if (e instanceof Reject || e instanceof RangeError) return null;
    throw e;
  }
}

/** The terminal field names a CALCULATE script reads. `resolve` expands one
 * authored name to the terminal fields it covers — a parent contributes every
 * child, which is what the reference's `getArray()` does. */
export function dependencies(script: FieldScript, resolve: (name: string) => string[]): string[] {
  let names: string[];
  if (script.fn === 'SFN') {
    names = sfnFields((script as { expr: SfnNode }).expr);
  } else if (script.fn === 'AFSimple_Calculate') {
    const raw = (script as { args: ScriptArg[] }).args[1];
    names = Array.isArray(raw) ? raw.map((n) => String(n)) : String(raw).split(/, ?/);
  } else {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    for (const terminal of resolve(String(name))) {
      if (!out.includes(terminal)) out.push(terminal);
    }
  }
  return out;
}
