// Evaluator: recognized field scripts over a plain value map.
//
// The live-preview twin of `src/engine/afcalc.py`. Python is authoritative for
// what lands in a file; this half exists so the canvas can show a live Total
// as the user types, and it never writes bytes. The two are pinned case for
// case against `tests/fixtures/af-corpus.json` — two implementations of one
// rule drift the moment nothing compares them.
//
// Arithmetic follows the reference implementation exactly, including the parts
// that look like defects: `makeNumber` replaces the FIRST comma with a decimal
// point so "1,234" is 1.234; a non-finite value formats as empty, so division
// by zero needs no rule of its own; `AFSimple_Calculate` skips a name the
// document does not have, contributes zero for a non-numeric child, yields
// zero for an empty set, expands a parent to all its terminal children, and
// rounds to six decimals.
//
// Two behaviours are ours rather than the reference's, both because the
// reference's own is implementation-defined and so cannot be pinned across two
// implementations: a date string the mask cannot parse falls back to the
// ECMAScript Date Time String Format rather than to a host's free-form
// `Date.parse`, and keystroke scripts are evaluated at COMMIT only.
import { dependencies, recognize, type FieldScript, type ScriptArg, type SfnNode } from './af-script';

export { recognize, dependencies };
export type { FieldScript, SfnNode };

export const DATE_FORMATS = [
  'm/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy',
  'yy-mm-dd', 'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy',
  'm/d/yy h:MM tt', 'm/d/yy HH:MM',
];
export const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

/** Hard-coded English in the reference, so a `mmm-yy` mask emits `Mar-26` in
 * every viewer regardless of the reader's language. A formatted field value
 * follows the FORM's conventions, never the UI locale. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The whole i18n rule for a formatted number: a fixed five-entry table
 * selected by the form's own `sepStyle`, clamped to 0..4. */
const SEPARATORS: readonly (readonly [string, string])[] = [
  [',', '.'], ['', '.'], ['.', ','], ['', ','], ["'", '.'],
];

/** A recognized call the reference itself throws on — an unknown `cFunction`,
 * a negative percent precision. The field is reported as carrying a script
 * this app does not run; its neighbours still calculate. */
export class Unsupported extends Error {}

// ── numbers ───────────────────────────────────────────────────────────────

/** `AFMakeNumber`: trim, replace the FIRST comma with a decimal point,
 * `parseFloat`, and reject NaN or non-finite. */
export function makeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const number = Number.parseFloat(value.trim().replace(',', '.'));
  return Number.isNaN(number) || !Number.isFinite(number) ? null : number;
}

function numeric(value: ScriptArg): number {
  if (typeof value !== 'number') throw new Unsupported('numeric argument expected');
  return value;
}

function clamp(value: ScriptArg, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.floor(numeric(value))));
}

/** Shewchuk partials — the exactly-rounded sum `Math.sumPrecise` specifies and
 * `math.fsum` computes on the authoritative side. Not taken from the host: a
 * sum that depends on the runtime's feature set could not be pinned. */
function sumPrecise(values: readonly number[]): number {
  const partials: number[] = [];
  for (const x of values) {
    let i = 0;
    let value = x;
    for (const y of partials.slice()) {
      let a = value;
      let b = y;
      if (Math.abs(a) < Math.abs(b)) [a, b] = [b, a];
      const hi = a + b;
      const lo = b - (hi - a);
      if (lo !== 0) partials[i++] = lo;
      value = hi;
    }
    partials.length = i;
    partials.push(value);
  }
  let total = 0;
  for (const p of partials) total += p;
  return total;
}

/** `Math.round(1e6 * res) / 1e6`. `Math.round` is floor(x + 0.5) — a tie goes
 * toward positive infinity, not away from zero. */
function round6(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = 1e6 * value;
  if (!Number.isFinite(scaled)) return value;
  return Math.floor(scaled + 0.5) / 1e6;
}

// ── printf / printd / printx / scand ──────────────────────────────────────

const PRINTF = /%(,[0-4])?([+ 0#]+)?(\d+)?(\.\d+)?(.)/g;
const PLUS = 1;
const SPACE = 2;
const ZERO = 4;
const HASH = 8;

/** The reference's `util.printf`, restricted to the conversions it implements
 * (`d` `f` `s` `x`); any other conversion character is emitted verbatim, which
 * is what makes a malformed spec deterministic. */
export function printf(spec: string, ...args: (string | number)[]): string {
  let i = 0;
  return spec.replace(PRINTF, (match, decSep, flagText, widthText, precisionText, conv) => {
    if (conv !== 'd' && conv !== 'f' && conv !== 's' && conv !== 'x') {
      return `%${[decSep, flagText, widthText, precisionText, conv].filter(Boolean).join('')}`;
    }
    i += 1;
    if (i > args.length) throw new Unsupported('not enough arguments in printf');
    const arg = args[i - 1];
    if (conv === 's') return String(arg);
    let flags = 0;
    for (const flag of flagText ?? '') {
      flags |= flag === '+' ? PLUS : flag === ' ' ? SPACE : flag === '0' ? ZERO : HASH;
    }
    const width = widthText ? Number.parseInt(widthText, 10) : undefined;
    const value = Number(arg);
    let integer = Math.trunc(value);
    if (conv === 'x') {
      let hex = Math.abs(integer).toString(16).toUpperCase();
      if (width !== undefined) hex = hex.padStart(width, flags & ZERO ? '0' : ' ');
      return flags & HASH ? `0x${hex}` : hex;
    }
    const precision = precisionText ? Number.parseInt(precisionText.slice(1), 10) : undefined;
    const [thousandSep, decimalSep] = SEPARATORS[decSep ? Number(decSep.slice(1)) : 0];
    let decimals = '';
    if (conv === 'f') {
      const residue = Math.abs(value - integer);
      if (precision !== undefined && (precision < 0 || precision > 100)) {
        throw new Unsupported('precision out of range');
      }
      decimals = precision !== undefined ? residue.toFixed(precision) : String(residue);
      if (decimals.length > 2) {
        if (/^1\.0+$/.test(decimals)) {
          integer += Math.sign(value);
          decimals = decimalSep + decimals.split('.')[1];
        } else {
          decimals = decimalSep + decimals.slice(2);
        }
      } else {
        if (decimals === '1') integer += Math.sign(value);
        decimals = flags & HASH ? '.' : '';
      }
    }
    let sign = '';
    if (integer < 0) {
      sign = '-';
      integer = -integer;
    } else if (flags & PLUS) {
      sign = '+';
    } else if (flags & SPACE) {
      sign = ' ';
    }
    let body: string;
    if (thousandSep && integer >= 1000) {
      const groups: string[] = [];
      for (;;) {
        groups.push(String(integer % 1000).padStart(3, '0'));
        integer = Math.trunc(integer / 1000);
        if (integer < 1000) {
          groups.push(String(integer));
          break;
        }
      }
      body = groups.reverse().join(thousandSep);
    } else {
      body = String(integer);
    }
    let text = body + decimals;
    if (width !== undefined) text = text.padStart(width - sign.length, flags & ZERO ? '0' : ' ');
    return sign + text;
  });
}

/** A calendar instant with no time zone: JavaScript builds these with the
 * local-time constructor and reads them back with local-time getters, so the
 * zone cancels. Out-of-range parts normalize exactly as `new Date` does, done
 * arithmetically so a host's DST rules cannot enter. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  dayOfWeek: number;
}

function civil(year: number, month: number, day: number, hours: number, minutes: number, seconds: number): CivilDate {
  const total = seconds + minutes * 60 + hours * 3600;
  const extra = Math.floor(total / 86400);
  const secondOfDay = total - extra * 86400;
  const carry = Math.floor(month / 12);
  const epochDay = daysFromCivil(year + carry, month - carry * 12 + 1, 1) + (day - 1) + extra;
  const [y, m, d] = civilFromDays(epochDay);
  return {
    year: y,
    month: m - 1,
    day: d,
    hours: Math.floor(secondOfDay / 3600),
    minutes: Math.floor((secondOfDay % 3600) / 60),
    seconds: secondOfDay % 60,
    dayOfWeek: (((epochDay + 4) % 7) + 7) % 7, // 1970-01-01 was a Thursday
  };
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = floorDiv(y, 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return [year + (month <= 2 ? 1 : 0), month, day];
}

const PRINTD_TOKENS = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t|\\.)/g;

export function printd(mask: string | number, date: CivilDate): string {
  if (mask === 0) return printd('D:yyyymmddHHMMss', date);
  if (mask === 1) return printd('yyyy.mm.dd HH:MM:ss', date);
  if (mask === 2) return printd('m/d/yy h:MM:ss tt', date);
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const handlers: Record<string, (d: CivilDate) => string> = {
    mmmm: (d) => MONTHS[d.month],
    mmm: (d) => MONTHS[d.month].slice(0, 3),
    mm: (d) => pad(d.month + 1, 2),
    m: (d) => String(d.month + 1),
    dddd: (d) => DAYS[d.dayOfWeek],
    ddd: (d) => DAYS[d.dayOfWeek].slice(0, 3),
    dd: (d) => pad(d.day, 2),
    d: (d) => String(d.day),
    yyyy: (d) => pad(d.year, 4),
    yy: (d) => pad(d.year % 100, 2),
    HH: (d) => pad(d.hours, 2),
    H: (d) => String(d.hours),
    hh: (d) => pad(1 + ((d.hours + 11) % 12), 2),
    h: (d) => String(1 + ((d.hours + 11) % 12)),
    MM: (d) => pad(d.minutes, 2),
    M: (d) => String(d.minutes),
    ss: (d) => pad(d.seconds, 2),
    s: (d) => String(d.seconds),
    tt: (d) => (d.hours < 12 ? 'am' : 'pm'),
    t: (d) => (d.hours < 12 ? 'a' : 'p'),
  };
  return String(mask).replace(PRINTD_TOKENS, (token) => {
    const handler = handlers[token];
    // An escaped character reaches the reference's fallback branch, which
    // emits its CHARACTER CODE. Reproduced rather than corrected: a mask
    // carrying one renders the same string in every viewer.
    return handler ? handler(date) : String(token.charCodeAt(1));
  });
}

export function printx(mask: string, source: unknown): string {
  const text = source === null || source === undefined ? '' : String(source);
  const out: string[] = [];
  let i = 0;
  let caseMode = 0; // 0 as-is, 1 upper, 2 lower
  let escaped = false;
  const cased = (ch: string): string => (caseMode === 1 ? ch.toUpperCase() : caseMode === 2 ? ch.toLowerCase() : ch);
  const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
  const isAlpha = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  for (const command of mask) {
    if (escaped) {
      out.push(command);
      escaped = false;
      continue;
    }
    if (i >= text.length) break;
    if (command === '?') {
      out.push(cased(text[i++]));
    } else if (command === 'X') {
      while (i < text.length) {
        const ch = text[i++];
        if (isAlpha(ch) || isDigit(ch)) {
          out.push(cased(ch));
          break;
        }
      }
    } else if (command === 'A') {
      while (i < text.length) {
        const ch = text[i++];
        if (isAlpha(ch)) {
          out.push(cased(ch));
          break;
        }
      }
    } else if (command === '9') {
      while (i < text.length) {
        const ch = text[i++];
        if (isDigit(ch)) {
          out.push(ch);
          break;
        }
      }
    } else if (command === '*') {
      while (i < text.length) out.push(cased(text[i++]));
    } else if (command === '\\') {
      escaped = true;
    } else if (command === '>') {
      caseMode = 1;
    } else if (command === '<') {
      caseMode = 2;
    } else if (command === '=') {
      caseMode = 0;
    } else {
      out.push(command);
    }
  }
  return out.join('');
}

const SCAND_TOKENS = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t)/g;
const REGEX_ESCAPE = /[.*+\-?^${}()|[\]\\]/g;

interface ScandData {
  year: number; month: number; day: number;
  hours: number; minutes: number; seconds: number; am: boolean | null;
}

function scandParts(mask: string): [string, ((value: string, data: ScandData) => void)[]] {
  const handlers: Record<string, [string, (value: string, data: ScandData) => void]> = {
    mmmm: [`(${MONTHS.join('|')})`, (v, d) => { d.month = MONTHS.indexOf(v); }],
    mmm: [`(${MONTHS.map((m) => m.slice(0, 3)).join('|')})`,
      (v, d) => { d.month = MONTHS.findIndex((m) => m.slice(0, 3) === v); }],
    mm: ['(\\d{2})', (v, d) => { d.month = Number.parseInt(v, 10) - 1; }],
    m: ['(\\d{1,2})', (v, d) => { d.month = Number.parseInt(v, 10) - 1; }],
    // `dddd`/`ddd` assign the WEEKDAY index to the day of month in the
    // reference. Reproduced: a mask using them parses the same way here.
    dddd: [`(${DAYS.join('|')})`, (v, d) => { d.day = DAYS.indexOf(v); }],
    ddd: [`(${DAYS.map((x) => x.slice(0, 3)).join('|')})`,
      (v, d) => { d.day = DAYS.findIndex((x) => x.slice(0, 3) === v); }],
    dd: ['(\\d{2})', (v, d) => { d.day = Number.parseInt(v, 10); }],
    d: ['(\\d{1,2})', (v, d) => { d.day = Number.parseInt(v, 10); }],
    yyyy: ['(\\d{4})', (v, d) => { d.year = Number.parseInt(v, 10); }],
    yy: ['(\\d{2})', (v, d) => { d.year = 2000 + Number.parseInt(v, 10); }],
    HH: ['(\\d{2})', (v, d) => { d.hours = Number.parseInt(v, 10); }],
    H: ['(\\d{1,2})', (v, d) => { d.hours = Number.parseInt(v, 10); }],
    hh: ['(\\d{2})', (v, d) => { d.hours = Number.parseInt(v, 10); }],
    h: ['(\\d{1,2})', (v, d) => { d.hours = Number.parseInt(v, 10); }],
    MM: ['(\\d{2})', (v, d) => { d.minutes = Number.parseInt(v, 10); }],
    M: ['(\\d{1,2})', (v, d) => { d.minutes = Number.parseInt(v, 10); }],
    ss: ['(\\d{2})', (v, d) => { d.seconds = Number.parseInt(v, 10); }],
    s: ['(\\d{1,2})', (v, d) => { d.seconds = Number.parseInt(v, 10); }],
    tt: ['([aApP][mM])', (v, d) => { d.am = v[0] === 'a' || v[0] === 'A'; }],
    t: ['([aApP])', (v, d) => { d.am = v === 'a' || v === 'A'; }],
  };
  const actions: ((value: string, data: ScandData) => void)[] = [];
  const escaped = mask.replace(REGEX_ESCAPE, '\\$&');
  const pattern = escaped.replace(SCAND_TOKENS, (token) => {
    const [source, action] = handlers[token];
    actions.push(action);
    return source;
  });
  return [pattern, actions];
}

export function scand(mask: string | number, text: string, strict = false): CivilDate | null {
  if (mask === 0) return scand('D:yyyymmddHHMMss', text);
  if (mask === 1) return scand('yyyy.mm.dd HH:MM:ss', text);
  if (mask === 2) return scand('m/d/yy h:MM:ss tt', text);
  const [pattern, actions] = scandParts(String(mask));
  let match: RegExpExecArray | null = null;
  try {
    match = new RegExp(`^(?:${pattern})$`).exec(text);
  } catch {
    match = null;
  }
  if (match === null || match.length !== actions.length + 1) {
    return strict ? null : guessDate(String(mask), text);
  }
  const data: ScandData = { year: 2000, month: 0, day: 1, hours: 0, minutes: 0, seconds: 0, am: null };
  actions.forEach((action, i) => action(match![i + 1], data));
  if (data.am !== null) data.hours = (data.hours % 12) + (data.am ? 0 : 12);
  return civil(data.year, data.month, data.day, data.hours, data.minutes, data.seconds);
}

const GUESS_TOKENS = /(d+)|(m+)|(y+)|(H+)|(M+)|(s+)/g;

function guessDate(mask: string, text: string): CivilDate | null {
  const checks: [keyof ScandData, number, number, number][] = [];
  for (const m of mask.matchAll(GUESS_TOKENS)) {
    if (m[1]) checks.push(['day', 1, 31, 0]);
    else if (m[2]) checks.push(['month', 1, 12, -1]);
    else if (m[3]) checks.push(['year', 0, 0, 0]);
    else if (m[4]) checks.push(['hours', 0, 23, 0]);
    else if (m[5]) checks.push(['minutes', 0, 59, 0]);
    else if (m[6]) checks.push(['seconds', 0, 59, 0]);
  }
  const data = { year: 2026, month: 0, day: 1, hours: 12, minutes: 0, seconds: 0 };
  let i = 0;
  for (const m of text.matchAll(/\d+/g)) {
    if (i >= checks.length) break;
    const [key, low, high, offset] = checks[i];
    i += 1;
    const n = Number.parseInt(m[0], 10);
    if (key === 'year') {
      data.year = n < 50 ? n + 2000 : n < 100 ? n + 1900 : n;
      continue;
    }
    if (n < low || n > high) return null;
    (data as unknown as Record<string, number>)[key] = n + offset;
  }
  if (i === 0) return null;
  return civil(data.year, data.month, data.day, data.hours, data.minutes, data.seconds);
}

const ISO = /^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** The reference's `_parseDate`: the mask first, then a general parse. The
 * general parse is the ECMAScript Date Time String Format only — a host
 * `Date.parse` accepts whatever else it likes, and an implementation-defined
 * behaviour cannot be pinned across two implementations. */
export function parseDate(mask: string | number, text: string): CivilDate | null {
  const byMask = scand(mask, text, false);
  if (byMask !== null) return byMask;
  const match = ISO.exec(text.trim());
  if (match === null) return null;
  return civil(
    Number(match[1]), Number(match[2] ?? 1) - 1, Number(match[3] ?? 1),
    Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0),
  );
}

// ── The AF* entry points ──────────────────────────────────────────────────

/** Why a keystroke or validate script rejected a value — a stable kind and
 * its interpolation values, never display text. A surface renders a catalog
 * string from it; control flow never matches on a rendered message. */
export type AfProblem = { kind: 'number' | 'date' | 'mask' | 'range' | 'min' | 'max'; args: string[] };

/** The reference's event object, reduced to what a commit needs: this app
 * delivers no per-character change event, so `willCommit` is always true. */
export interface AfEvent {
  value: string | number;
  rc: boolean;
  problem: AfProblem | null;
}

type Resolve = (name: string) => string[];

function text(value: string | number): string {
  return typeof value === 'string' ? value : String(value);
}

function numberFormat(event: AfEvent, args: ScriptArg[]): void {
  const [decimals, sepStyle, negStyle, , currency, prepend] = args;
  let value = makeNumber(event.value);
  if (value === null) {
    event.value = '';
    return;
  }
  const sign = Math.sign(value);
  const parts: string[] = [];
  let hasParen = false;
  if (sign === -1 && prepend && negStyle === 0) parts.push('-');
  if ((negStyle === 2 || negStyle === 3) && sign === -1) {
    parts.push('(');
    hasParen = true;
  }
  if (prepend) parts.push(String(currency));
  parts.push('%,', String(clamp(sepStyle, 0, 4)), '.', String(numeric(decimals)), 'f');
  if (!prepend) parts.push(String(currency));
  if (hasParen) parts.push(')');
  if ((negStyle !== 0 || prepend) && sign === -1) value = -value;
  event.value = printf(parts.join(''), value);
}

function percentFormat(event: AfEvent, args: ScriptArg[]): void {
  const decimals = args[0];
  const sepStyle = args[1];
  const prepend = args.length > 2 ? args[2] : false;
  if (typeof decimals !== 'number' || typeof sepStyle !== 'number') return;
  if (decimals < 0) throw new Unsupported('invalid nDec in AFPercent_Format');
  if (decimals > 512) {
    event.value = '%';
    return;
  }
  const value = makeNumber(event.value);
  if (value === null) {
    event.value = '%';
    return;
  }
  const shown = printf(`%,${clamp(sepStyle, 0, 4)}.${Math.floor(decimals)}f`, value * 100);
  event.value = prepend ? `%${shown}` : `${shown}%`;
}

const NUMBER_COMMIT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const NUMBER_COMMIT_COMMA = /^[+-]?(?:\d+(?:,\d*)?|,\d+)$/;

function numberKeystroke(event: AfEvent, args: ScriptArg[]): void {
  const sepStyle = args[1];
  const raw = text(event.value);
  if (!raw) return;
  const trimmed = raw.trim();
  const comma = typeof sepStyle === 'number' && sepStyle > 1;
  if (!(comma ? NUMBER_COMMIT_COMMA : NUMBER_COMMIT).test(trimmed)) {
    event.rc = false;
    event.problem = { kind: 'number', args: [] };
    return;
  }
  if (comma) event.value = Number.parseFloat(trimmed.replace(',', '.'));
}

function dateFormatEx(event: AfEvent, mask: string | number): void {
  const raw = text(event.value);
  if (!raw) return;
  const date = parseDate(mask, raw);
  if (date !== null) event.value = printd(mask, date);
}

function dateKeystrokeEx(event: AfEvent, mask: string | number): void {
  const raw = text(event.value);
  if (!raw) return;
  if (parseDate(mask, raw) === null) {
    event.rc = false;
    event.problem = { kind: 'date', args: [String(mask)] };
  }
}

const SPECIAL_FORMATS: Record<number, string> = { 0: '99999', 1: '99999-9999', 3: '999-99-9999' };

function specialFormat(event: AfEvent, psf: ScriptArg): void {
  const raw = text(event.value);
  if (!raw) return;
  const index = makeNumber(psf);
  let mask: string | undefined;
  if (index === 2) {
    mask = printx('9999999999', raw).length >= 10 ? '(999) 999-9999' : '999-9999';
  } else {
    mask = index === null ? undefined : SPECIAL_FORMATS[index];
    if (mask === undefined) throw new Unsupported('invalid psf in AFSpecial_Format');
  }
  event.value = printx(mask, raw);
}

const MASK_CHECKS: Record<string, (c: string) => boolean> = {
  '9': (c) => c >= '0' && c <= '9',
  A: (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'),
  O: (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'),
  X: () => true,
};

function maskValid(value: string, mask: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const expected = i < mask.length ? mask[i] : '';
    const check = MASK_CHECKS[expected];
    if (check) {
      if (!check(value[i])) return false;
    } else if (expected !== value[i]) {
      return false;
    }
  }
  return true;
}

/** `#AFSpecial_KeystrokeEx_helper` at commit: too long, too short, or a
 * character the mask forbids all reject; an exact-length match pads. */
function maskKeystroke(event: AfEvent, mask: string, value: string | null): void {
  if (!mask) return;
  const candidate = value !== null ? value : text(event.value);
  if (!candidate) return;
  if (candidate.length !== mask.length || !maskValid(candidate, mask)) {
    event.rc = false;
    event.problem = { kind: 'mask', args: [mask] };
    return;
  }
  event.value = text(event.value) + mask.slice(candidate.length);
}

function specialKeystrokeEx(event: AfEvent, mask: string): void {
  maskKeystroke(event, mask.replace(/[^9AOX]/g, ''), null);
  if (event.rc) return;
  event.rc = true;
  event.problem = null;
  maskKeystroke(event, mask, null);
}

const SPECIAL_KEYSTROKE: Record<number, [string, string | null]> = {
  0: ['99999', null],
  1: ['99999-9999', null],
  2: ['999-9999', '(999) 999-9999'],
  3: ['999-99-9999', null],
};

function specialKeystroke(event: AfEvent, psf: ScriptArg): void {
  const index = makeNumber(psf);
  const entry = index === null ? undefined : SPECIAL_KEYSTROKE[index];
  if (entry === undefined) throw new Unsupported('invalid psf in AFSpecial_Keystroke');
  const raw = text(event.value);
  const masks = entry.filter((m): m is string => Boolean(m));
  for (const mask of masks) {
    maskKeystroke(event, mask, raw);
    if (event.rc) return;
    event.rc = true;
    event.problem = null;
  }
  const stripped = raw.replace(/[-()\s]+/g, '');
  for (const mask of masks) {
    maskKeystroke(event, mask.replace(/[-()\s]+/g, ''), stripped);
    if (event.rc) return;
    event.rc = true;
    event.problem = null;
  }
  const longForm = Boolean(entry[1]) && (stripped.match(/\d/g) ?? []).length > 7;
  specialKeystrokeEx(event, longForm ? (entry[1] as string) : entry[0]);
}

function rangeValidate(event: AfEvent, args: ScriptArg[]): void {
  const [greater, lowArg, less, highArg] = args;
  if (!text(event.value)) return;
  const value = makeNumber(event.value);
  if (value === null) return;
  let low: number | null = null;
  let high: number | null = null;
  if (greater) {
    low = makeNumber(lowArg);
    if (low === null) return;
  }
  if (less) {
    high = makeNumber(highArg);
    if (high === null) return;
  }
  if (greater && less) {
    if (value < (low as number) || value > (high as number)) {
      event.rc = false;
      event.problem = { kind: 'range', args: [String(low), String(high)] };
    }
  } else if (greater) {
    if (value < (low as number)) {
      event.rc = false;
      event.problem = { kind: 'min', args: [String(low)] };
    }
  } else {
    // The final branch is deliberately UNGUARDED, as in the reference: with
    // neither bound requested the upper argument is still compared, so
    // `AFRange_Validate(false, 0, false, 0)` rejects anything above zero. A
    // producer meaning "no bounds" writes no validate script.
    const limit = Number(highArg);
    if (!Number.isNaN(limit) && value > limit) {
      event.rc = false;
      event.problem = { kind: 'max', args: [String(limit)] };
    }
  }
}

function simple(fn: string, first: ScriptArg, second: ScriptArg): number {
  const a = makeNumber(first);
  if (a === null) throw new Unsupported('invalid nValue1 in AFSimple');
  const b = makeNumber(second);
  if (b === null) throw new Unsupported('invalid nValue2 in AFSimple');
  switch (fn) {
    case 'AVG': return (a + b) / 2;
    case 'SUM': return a + b;
    case 'PRD': return a * b;
    case 'MIN': return Math.min(a, b);
    case 'MAX': return Math.max(a, b);
    default: throw new Unsupported('invalid cFunction in AFSimple');
  }
}

function simpleCalculate(event: AfEvent, args: ScriptArg[], values: Record<string, string>, resolve: Resolve): void {
  const fn = args[0];
  const raw = args[1];
  if (fn !== 'AVG' && fn !== 'SUM' && fn !== 'PRD' && fn !== 'MIN' && fn !== 'MAX') {
    throw new Unsupported('invalid function in AFSimple_Calculate');
  }
  const names = Array.isArray(raw) ? raw.map((n) => String(n)) : String(raw).split(/, ?/);
  const numbers: number[] = [];
  for (const name of names) {
    const terminals = resolve(name);
    if (terminals.length === 0) continue; // a name the document does not have
    for (const terminal of terminals) {
      const number = makeNumber(values[terminal] ?? '');
      numbers.push(number ?? 0);
    }
  }
  if (numbers.length === 0) {
    event.value = 0;
    return;
  }
  let result: number;
  if (fn === 'AVG') result = sumPrecise(numbers) / numbers.length;
  else if (fn === 'SUM') result = sumPrecise(numbers);
  else if (fn === 'PRD') result = numbers.reduce((acc, v) => acc * v, 1);
  else if (fn === 'MIN') result = Math.min(...numbers);
  else result = Math.max(...numbers);
  event.value = round6(result);
}

function sfnValue(node: SfnNode, values: Record<string, string>, resolve: Resolve): number {
  if ('num' in node) return node.num;
  if ('field' in node) {
    // An unresolvable name contributes zero — never a skip, or `A - B` with B
    // missing would silently become A.
    let total = 0;
    for (const terminal of resolve(node.field)) total += makeNumber(values[terminal] ?? '') ?? 0;
    return total;
  }
  if (node.op === 'neg') return -sfnValue(node.v, values, resolve);
  const left = sfnValue(node.l, values, resolve);
  const right = sfnValue(node.r, values, resolve);
  switch (node.op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    default: return left / right;
  }
}

/** A script whose arguments make it unrunnable for EVERY input — the reference
 * throws before it reads the value. Reported per field like any other script
 * this app does not run, rather than surfacing as a mid-fill surprise. */
export function unrunnable(script: FieldScript): boolean {
  const args = (script as { args?: ScriptArg[] }).args ?? [];
  const ops = ['AVG', 'SUM', 'PRD', 'MIN', 'MAX'];
  switch (script.fn) {
    case 'AFPercent_Format': return typeof args[0] === 'number' && args[0] < 0;
    case 'AFSpecial_Format':
    case 'AFSpecial_Keystroke': {
      const index = makeNumber(args[0]);
      return index === null || ![0, 1, 2, 3].includes(index);
    }
    case 'AFSimple_Calculate': return !ops.includes(String(args[0]));
    case 'AFSimple':
      return !ops.includes(String(args[0])) || makeNumber(args[1]) === null || makeNumber(args[2]) === null;
    default: return false;
  }
}

/** Run one recognized script over a value. `values`/`resolve` are needed only
 * by the calculate kinds; everything else is a pure value transform. */
export function run(
  script: FieldScript,
  value: string | number,
  values: Record<string, string> = {},
  resolve: Resolve = () => [],
): AfEvent {
  const event: AfEvent = { value, rc: true, problem: null };
  const args = (script as { args?: ScriptArg[] }).args ?? [];
  const indexed = (table: string[], arg: ScriptArg): string | number =>
    (typeof arg === 'number' && arg >= 0 && arg < table.length ? table[arg] : (arg as string | number));
  switch (script.fn) {
    case 'AFNumber_Format': numberFormat(event, args); break;
    case 'AFNumber_Keystroke': numberKeystroke(event, args); break;
    case 'AFPercent_Format': percentFormat(event, args); break;
    case 'AFPercent_Keystroke': numberKeystroke(event, [args[0], args[1], 0, 0, '', true]); break;
    case 'AFDate_Format': dateFormatEx(event, indexed(DATE_FORMATS, args[0])); break;
    case 'AFTime_Format': dateFormatEx(event, indexed(TIME_FORMATS, args[0])); break;
    case 'AFDate_FormatEx':
    case 'AFTime_FormatEx': dateFormatEx(event, args[0] as string); break;
    case 'AFDate_Keystroke':
      if (typeof args[0] === 'number' && args[0] >= 0 && args[0] < DATE_FORMATS.length) {
        dateKeystrokeEx(event, DATE_FORMATS[args[0]]);
      }
      break;
    case 'AFTime_Keystroke':
      if (typeof args[0] === 'number' && args[0] >= 0 && args[0] < TIME_FORMATS.length) {
        dateKeystrokeEx(event, TIME_FORMATS[args[0]]);
      }
      break;
    case 'AFDate_KeystrokeEx':
    case 'AFTime_KeystrokeEx': dateKeystrokeEx(event, args[0] as string); break;
    case 'AFSpecial_Format': specialFormat(event, args[0]); break;
    case 'AFSpecial_Keystroke': specialKeystroke(event, args[0]); break;
    case 'AFSpecial_KeystrokeEx': specialKeystrokeEx(event, String(args[0])); break;
    case 'AFRange_Validate': rangeValidate(event, args); break;
    case 'AFSimple_Calculate': simpleCalculate(event, args, values, resolve); break;
    // The reference RETURNS the result; a bare call assigns nothing. Its only
    // observable effect is the throw on a non-numeric operand.
    case 'AFSimple': simple(String(args[0]), args[1], args[2]); break;
    case 'SFN': event.value = sfnValue((script as { expr: SfnNode }).expr, values, resolve); break;
    default: throw new Unsupported(`unknown script ${script.fn}`);
  }
  return event;
}

/** The RAW text a computed value is stored as in `/V` — never the formatted
 * display string, which would corrupt the next calculation that reads it. */
export function asStored(value: string | number): string {
  return typeof value === 'string' ? value : String(value);
}

/** The string the appearance draws. Without a format script the display IS
 * the stored value. */
export function formatDisplay(script: FieldScript | null, value: string): string {
  if (script === null) return value;
  return asStored(run(script, value).value);
}

/** `getField(name).getArray()`: a terminal resolves to itself, a parent to
 * every terminal beneath it, an unknown name to nothing. */
export function terminalResolver(terminals: readonly string[]): Resolve {
  const known = new Set(terminals);
  return (name: string): string[] => {
    if (known.has(name)) return [name];
    const prefix = `${name}.`;
    return terminals.filter((t) => t.startsWith(prefix));
  };
}

export interface FieldActions {
  F?: FieldScript | null;
  K?: FieldScript | null;
  V?: FieldScript | null;
  C?: FieldScript | null;
}

/** One pass over `/CO`, entry by entry, in the order the document declares.
 *
 * Never iterated to a fixpoint: `/CO` is the author's declared order and a
 * conforming viewer runs it once. A `/CO` in the wrong order computes a stale
 * value — the author's bug, faithfully reproduced. Returns the fields whose
 * stored value CHANGED. */
export function calculate(
  values: Readonly<Record<string, string>>,
  scripts: Readonly<Record<string, FieldActions>>,
  order: readonly string[],
  terminals: readonly string[],
): Record<string, string> {
  const resolve = terminalResolver(terminals);
  const current: Record<string, string> = { ...values };
  const changed: Record<string, string> = {};
  for (const name of order) {
    const script = scripts[name]?.C;
    if (!script) continue;
    let stored: string;
    try {
      stored = asStored(run(script, current[name] ?? '', current, resolve).value);
    } catch (e) {
      if (e instanceof Unsupported) continue;
      throw e;
    }
    if (stored !== (current[name] ?? '')) {
      current[name] = stored;
      changed[name] = stored;
    }
  }
  return changed;
}

/** Everything a fill of `typed` can change: the typed fields plus every `/CO`
 * entry whose calculation reads something already in the set.
 *
 * This is what the signed-edit decision must be asked about. Filling an
 * unlocked line item that recalculates a locked Total produces a document that
 * reports as altered, and a decision taken on the typed names alone would
 * never see it. A calculation is a pure function of its inputs, so a `/CO`
 * entry outside the set provably cannot change; one inside it may or may not,
 * and being asked about a field that turns out unchanged refuses honestly
 * rather than silently. */
export function closure(
  typed: readonly string[],
  scripts: Readonly<Record<string, FieldActions>>,
  order: readonly string[],
  terminals: readonly string[],
): string[] {
  const resolve = terminalResolver(terminals);
  const reached: string[] = [];
  for (const name of typed) if (!reached.includes(name)) reached.push(name);
  const seen = new Set(reached);
  for (const name of order) {
    const script = scripts[name]?.C;
    if (!script || seen.has(name)) continue;
    if (dependencies(script, resolve).some((dep) => seen.has(dep))) {
      reached.push(name);
      seen.add(name);
    }
  }
  return reached;
}
