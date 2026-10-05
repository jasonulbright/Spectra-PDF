// The English a person reads uses American spelling throughout: the UI
// catalog, the engine refusal table, the engine's prose strings, the Rust
// strings and command-line help, and the public documents. "cancelled" is
// absent from the list on purpose: both spellings are American, and code
// matches the literal by value.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENGINE_MESSAGE_ROWS } from '../src/renderer/lib/engine-messages';

const ROOT = resolve(__dirname, '..');

const BRITISH = new RegExp(
  '(?<![A-Za-z])(?:' +
    [
      '\\w*colour\\w*',
      '\\w*(?:behaviour|favour|honour|neighbour|harbour|humour|flavour|labour|rumour|vapour|armour|endeavour)\\w*',
      '\\w*(?:centre|centred|centres|centring)',
      '(?:milli|centi|kilo)?(?:metre|metres|litre|litres)',
      'theatres?', 'fibres?', 'manoeuvr\\w*',
      'grey(?:s|ed|ing|ish|scale)?',
      '(?:re)?analys(?:e|ed|ing|er|ers)', 'paralys(?:e|ed|ing)', 'catalys(?:e|ed|ing)',
      'catalogue[sd]?', 'dialogues?', 'licences?', 'defence', 'offence', 'pretence',
      'practis(?:e|ed|es|ing)',
      '\\w*(?:organis|recognis|optimis|minimis|maximis|normalis|serialis|initialis|customis|' +
        'synchronis|summaris|categoris|authoris|utilis|visualis|rasteris|digitis|sanitis|finalis|' +
        'memoris|prioritis|standardis|localis|apologis|canonicalis|characteris|emphasis)' +
        '(?:e|ed|es|ing|er|ers|able|ation|ations)',
      'realis(?:e|ed|es|ing|ation)',
      '\\w*(?:travell|labell|modell|signall|levell|channell|tunnell|counsell)(?:ed|ing|er|ers)',
      'fulfil(?:s|ment)?', 'enrol(?:s|ment)?', 'instalments?', 'skilful\\w*', 'wilful\\w*',
      'cheques?', 'programmes?', 'learnt', 'spelt', 'whilst', 'amongst',
      'judgements?', 'acknowledgements?', 'ageing', 'artefacts?', 'plough\\w*', 'tyres?', 'kerbs?',
      'mould\\w*', 'speciality', 'per cent', 'aluminium', 'sceptic\\w*', 'storeys?',
    ].join('|') +
    ')(?![A-Za-z])',
  'gi',
);

/** Each entry: a text the sweep reads that keeps a British form, and why. */
const ALLOWED: readonly { file: string; text: string; reason: string }[] = [];

const allowed = (file: string, text: string): boolean =>
  ALLOWED.some((a) => a.file === file && text.includes(a.text));

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (name.includes('.local.') || name === '__pycache__') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel, suffix));
    else if (name.endsWith(suffix)) out.push(rel);
  }
  return out;
}

const stripPlaceholders = (s: string): string => s.replace(/\{\{[^}]*\}\}/g, '').replace(/\{[^{}]*\}/g, '');

/** A literal that reads as prose rather than a key or a matched value. */
const prose = (s: string): boolean => /\s/.test(s.trim()) || /^[A-Z][a-z]/.test(s);

/** Single-line string literals of a Python source, outside comments.
 *  Triple-quoted strings are docstrings or long text the refusal table
 *  already carries, and are skipped. */
function pythonLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      if (src.startsWith(c.repeat(3), i)) {
        const end = src.indexOf(c.repeat(3), i + 3);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let body = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          body += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        body += src[j++];
      }
      out.push(body);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** String literals of a Rust source outside comments, with the test module
 *  (`#[cfg(test)] mod tests`) cut off. Byte strings are data and skipped. */
function rustLiterals(src: string): string[] {
  const cut = src.search(/^#\[cfg\(test\)\]\r?\n(?:pub(?:\(crate\))? )?mod \w+ \{/m);
  const code = cut < 0 ? src : src.slice(0, cut);
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        if (code.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (code.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'") {
      if (code[i + 1] === '\\') {
        const end = code.indexOf("'", i + 2);
        i = end < 0 ? code.length : end + 1;
      } else if (code[i + 2] === "'") i += 3;
      else i++;
      continue;
    }
    const raw = /^(b?)r(#*)"/.exec(code.slice(i, i + 40));
    if (raw && !/\w/.test(code[i - 1] ?? '')) {
      const close = '"' + raw[2];
      const start = i + raw[0].length;
      const end = code.indexOf(close, start);
      if (!raw[1]) out.push(code.slice(start, end));
      i = end < 0 ? code.length : end + close.length;
      continue;
    }
    if (c === '"') {
      const bytes = code[i - 1] === 'b' && !/\w/.test(code[i - 2] ?? '');
      let j = i + 1;
      let body = '';
      while (j < code.length && code[j] !== '"') {
        if (code[j] === '\\') {
          body += code.slice(j, j + 2);
          j += 2;
          continue;
        }
        body += code[j++];
      }
      if (!bytes) out.push(body.replace(/\\\r?\n\s*/g, ''));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** `///` lines inside the clap derive items: they are the `--help` text. */
function clapHelp(src: string): string[] {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[derive\([^)]*\b(?:Parser|Subcommand|Args|ValueEnum)\b/.test(lines[i])) continue;
    let j = i + 1;
    for (; j < lines.length && lines[j] !== '}'; j++) {
      const m = /^\s*\/\/\/(.*)$/.exec(lines[j]);
      if (m) out.push(m[1]);
    }
    i = j;
  }
  return out;
}

type Hit = { file: string; word: string; text: string };

function hits(file: string, texts: readonly string[]): Hit[] {
  const found: Hit[] = [];
  for (const text of texts) {
    if (allowed(file, text)) continue;
    for (const m of stripPlaceholders(text).matchAll(BRITISH)) {
      found.push({ file, word: m[0], text: text.slice(0, 120) });
    }
  }
  return found;
}

describe('American spelling in English a person reads', () => {
  it('holds in the generated English catalog', () => {
    const en: Record<string, string> = JSON.parse(read('src/renderer/locales/en/chrome.json'));
    expect(hits('src/renderer/locales/en/chrome.json', Object.values(en))).toEqual([]);
  });

  it('holds in the engine refusal table', () => {
    expect(
      hits(
        'src/renderer/locales/engine-messages.tsv',
        ENGINE_MESSAGE_ROWS.map((r) => r.message),
      ),
    ).toEqual([]);
  });

  it('holds in the engine prose strings', () => {
    const found = walk('src/engine', '.py').flatMap((file) =>
      hits(file, pythonLiterals(read(file)).filter(prose)),
    );
    expect(found).toEqual([]);
  });

  it('holds in the native strings and the command-line help', () => {
    const files = [...walk('src-tauri/src', '.rs'), ...walk('src-tauri/shell-menu/src', '.rs')].filter(
      (f) => !/_tests?\.rs$/.test(f) && !f.includes('/tests/'),
    );
    const found = files.flatMap((file) => {
      const src = read(file);
      return hits(file, [...rustLiterals(src).filter(prose), ...clapHelp(src)]);
    });
    expect(found).toEqual([]);
  });

  it('holds in the installer and package text', () => {
    const files = [
      'src-tauri/tauri.conf.json',
      'src-tauri/tauri.linux.conf.json',
      'src-tauri/nsis-hooks.nsh',
      'src-tauri/linux/spectrapdf.desktop',
      'src-tauri/linux/com.spectrapdf.app.appdata.xml',
    ];
    const found = files.flatMap((file) =>
      hits(
        file,
        read(file)
          .split(/\r?\n/)
          .filter((line) => !/^\s*[;#]/.test(line)),
      ),
    );
    expect(found).toEqual([]);
  });

  it('holds in the public documents', () => {
    const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/TESTER-GUIDE-SCANNING.md'];
    expect(files.flatMap((file) => hits(file, read(file).split(/\r?\n/)))).toEqual([]);
  });

  it('flags a British form in every family the sweep covers', () => {
    const samples = [
      'Colour', 'recoloured', 'behaviour', 'centred', 'millimetres', 'grey', 'greyscale', 'analyse',
      'catalogue', 'dialogue', 'licence', 'recognised', 'optimisation', 'serialise', 'labelled',
      'travelling', 'judgement', 'acknowledgement', 'programme', 'whilst', 'artefact',
    ];
    for (const s of samples) expect(hits('sample', [s]).map((h) => h.word)).toEqual([s]);
    const american = [
      'Color', 'recolored', 'behavior', 'centered', 'millimeters', 'gray', 'grayscale', 'analyze',
      'analyses', 'catalog', 'dialog', 'license', 'recognized', 'optimization', 'serialize',
      'labeled', 'traveling', 'judgment', 'acknowledgment', 'program', 'artifact', 'canceled',
      'cancelled', 'advise', 'exercise', 'emphasis', 'parameter', 'diameter',
    ];
    expect(hits('sample', american)).toEqual([]);
  });
});
