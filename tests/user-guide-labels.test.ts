// The end-user guide (docs/USER-GUIDE.md) names menus, items, panels and
// buttons. Those names are the English strings the app shows, so this test
// holds the guide to them:
//
//   1. Every `**A > B**` (or deeper) path is a real menu path. Paths resolve
//      the way the app resolves them: the MENUS tree for the structure, the
//      English catalog (`locales/en/chrome.json`, generated from the tables)
//      for the labels, with the table's own English as the fallback.
//   2. Every other bold label is an English string of the app: a value of the
//      English catalog, or a message the Rust side shows as written.
//   3. Every shortcut written beside a menu path is a binding of that item's
//      command in the keymap table.
//   4. Every table-of-contents anchor matches a heading, every heading of the
//      guide's top level is in the table of contents, and every in-page link
//      resolves.
//
// A wrong path is a defect in the guide, not in this test: fix the guide.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MENUS, type MenuNode } from '../src/renderer/commands/menus';
import { COMMANDS, type CommandId } from '../src/renderer/commands/registry';
import { KEY_BINDINGS, type KeyBinding } from '../src/renderer/commands/standard-keys';

const ROOT = resolve(__dirname, '..');
const GUIDE = readFileSync(resolve(ROOT, 'docs/USER-GUIDE.md'), 'utf8');
const EN: Record<string, string> = JSON.parse(
  readFileSync(resolve(ROOT, 'src/renderer/locales/en/chrome.json'), 'utf8'),
);
const RUST_SOURCES = readdirSync(resolve(ROOT, 'src-tauri/src'))
  .filter((f) => f.endsWith('.rs'))
  .map((f) => readFileSync(resolve(ROOT, 'src-tauri/src', f), 'utf8'))
  .join('\n');

const SEPARATOR = ' > ';

/** Every menu path the English menu bar offers, mapped to its command id
 * (null for a submenu). Dynamic sections (Open Recent, Window list) hold
 * file names, not fixed labels, and are not part of the table. */
function englishMenuPaths(): Map<string, CommandId | null> {
  const out = new Map<string, CommandId | null>();
  const walk = (nodes: MenuNode[], prefix: string[]): void => {
    for (const node of nodes) {
      if (node.kind === 'submenu') {
        const label = EN[`menu.${node.id}`] ?? node.label;
        out.set([...prefix, label].join(SEPARATOR), null);
        walk(node.items, [...prefix, label]);
      } else if (node.kind === 'command') {
        const title = EN[`cmd.${node.command}`] ?? COMMANDS[node.command].title;
        out.set([...prefix, title].join(SEPARATOR), node.command);
      }
    }
  };
  for (const menu of MENUS) {
    const label = EN[`menu.${menu.id}`] ?? menu.label;
    out.set(label, null);
    walk(menu.items, [label]);
  }
  return out;
}

/** A binding's chord in the notation the menus show: Ctrl+Shift+Key. */
function chordOf(binding: KeyBinding): string {
  const named: Record<string, string> = {
    delete: 'Del',
    backspace: 'Backspace',
    tab: 'Tab',
    escape: 'Esc',
    ' ': 'Space',
  };
  const key = named[binding.key] ?? (binding.key.length === 1 || /^f\d{1,2}$/.test(binding.key)
    ? binding.key.toUpperCase()
    : binding.key);
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** The guide without fenced code blocks. */
function guideProse(): string {
  return GUIDE.replace(/^```[\s\S]*?^```/gm, '');
}

/** The guide with inline code spans taken out (a span may hold `*`). */
function withoutInlineCode(text: string): string {
  return text.replace(/`[^`\n]+`/g, '');
}

function boldSpans(text: string): string[] {
  return [...withoutInlineCode(text).matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) => m[1]);
}

/** GitHub's heading anchor: lower case, punctuation removed, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function headings(): { level: number; text: string }[] {
  return guideProse()
    .split('\n')
    .map((line) => /^(#{1,6})\s+(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ level: m[1].length, text: m[2] }));
}

const MENU_PATHS = englishMenuPaths();
const CATALOG_VALUES = new Set(Object.values(EN));

describe('user guide: menu paths', () => {
  const spans = boldSpans(guideProse());
  const paths = spans.filter((s) => s.includes('>'));

  it('the guide names at least one menu path', () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  it('writes every path with exactly one " > " between names', () => {
    for (const path of paths) {
      const names = path.split(SEPARATOR);
      expect(names.join(SEPARATOR), `malformed path: ${path}`).toBe(path);
      for (const name of names) {
        expect(name, `empty or padded name in: ${path}`).toBe(name.trim());
        expect(name.length, `empty name in: ${path}`).toBeGreaterThan(0);
        expect(name, `stray ">" in: ${path}`).not.toContain('>');
      }
    }
  });

  it('every menu path exists in the English menus', () => {
    const missing = [...new Set(paths)].filter((p) => !MENU_PATHS.has(p));
    expect(missing, `paths not in the English menus:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('user guide: labels', () => {
  it('every other bold label is an English string of the app', () => {
    const labels = boldSpans(guideProse()).filter((s) => !s.includes('>'));
    const unknown = [...new Set(labels)].filter(
      (label) => !CATALOG_VALUES.has(label) && !RUST_SOURCES.includes(label),
    );
    expect(unknown, `bold text that is not an app string:\n${unknown.join('\n')}`).toEqual([]);
  });
});

describe('user guide: shortcuts', () => {
  const SHORTCUT = /^(?:(?:Ctrl|Shift)\+)+\S+$|^F\d{1,2}$|^Shift\+F\d{1,2}$/;

  it('every shortcut beside a menu path is a binding of that item', () => {
    const wrong: string[] = [];
    for (const line of guideProse().split('\n')) {
      const linePaths = [...new Set(boldSpans(line).filter((s) => s.includes('>')))];
      if (linePaths.length !== 1) continue;
      const command = MENU_PATHS.get(linePaths[0]);
      if (!command) continue;
      const allowed = new Set(KEY_BINDINGS.filter((b) => b.command === command).map(chordOf));
      for (const code of [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])) {
        if (!SHORTCUT.test(code)) continue;
        if (!allowed.has(code)) wrong.push(`${linePaths[0]}: ${code} (allowed: ${[...allowed].join(', ') || 'none'})`);
      }
    }
    expect(wrong, `shortcuts that do not match the keymap:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('every shortcut written anywhere in the guide is in the keymap table', () => {
    const known = new Set(KEY_BINDINGS.map(chordOf));
    const unknown = [...new Set(
      [...guideProse().matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => SHORTCUT.test(c)),
    )].filter((c) => !known.has(c));
    expect(unknown, `shortcuts not in the keymap:\n${unknown.join('\n')}`).toEqual([]);
  });
});

describe('user guide: table of contents', () => {
  const all = headings();
  const slugs = new Set(all.map((h) => slug(h.text)));

  const contents = (() => {
    const lines = guideProse().split('\n');
    const start = lines.findIndex((l) => /^##\s+Contents\s*$/.test(l));
    if (start < 0) return [];
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      out.push(line);
    }
    return out;
  })();
  const entries = contents
    .map((l) => /^\s*[-*]\s+\[([^\]]+)\]\(#([^)]+)\)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ text: m[1], anchor: m[2] }));

  it('has a Contents section with entries', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every anchor in the contents matches a heading', () => {
    const missing = entries.filter((e) => !slugs.has(e.anchor)).map((e) => e.anchor);
    expect(missing, `anchors without a heading:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every contents entry has the text of the heading it points to', () => {
    const byslug = new Map(all.map((h) => [slug(h.text), h.text]));
    const wrong = entries
      .filter((e) => byslug.get(e.anchor) !== e.text)
      .map((e) => `${e.text} -> ${e.anchor}`);
    expect(wrong, `entries whose text differs from the heading:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('every top-level section is in the contents, in the same order', () => {
    const sections = all.filter((h) => h.level === 2 && h.text !== 'Contents').map((h) => slug(h.text));
    expect(entries.map((e) => e.anchor)).toEqual(sections);
  });

  it('has no two headings with the same anchor', () => {
    const seen = new Set<string>();
    const repeated: string[] = [];
    for (const h of all) {
      const s = slug(h.text);
      if (seen.has(s)) repeated.push(h.text);
      seen.add(s);
    }
    expect(repeated, `headings that share an anchor:\n${repeated.join('\n')}`).toEqual([]);
  });

  it('every in-page link in the guide resolves to a heading', () => {
    const links = [...withoutInlineCode(guideProse()).matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    const missing = [...new Set(links)].filter((a) => !slugs.has(a));
    expect(missing, `links without a heading:\n${missing.join('\n')}`).toEqual([]);
  });
});
