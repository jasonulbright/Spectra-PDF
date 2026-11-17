// A button that shows only a symbol (x, arrows, an icon) tells a sighted user
// nothing until the pointer rests on it. Each such button needs a tooltip
// (`title`); the title also serves as its spoken name. A button that has a
// spoken name (`aria-label`) but no tooltip is a gap too, unless its visible
// content already names it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../src/renderer');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'locales' ? [] : sourceFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const SYMBOL_ONLY = /^[^\sA-Za-z0-9<{]{1,3}$/u;
const HAS_TITLE = /\btitle=/;
const HAS_NAME = /\baria-label=/;

interface ButtonTag {
  attrs: string;
  first: string;
  index: number;
}

/**
 * Every `<button ...>` opening tag with its attribute text and the first few
 * characters after it. A `>` inside `{...}` (an arrow function) or inside a
 * quoted string does not end the tag, so the scan tracks both. A plain scan
 * replaces a regular expression here: nested braces made the expression
 * back-track without limit.
 */
export function buttonTags(text: string): ButtonTag[] {
  const found: ButtonTag[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('<button', from);
    if (at < 0) return found;
    from = at + 7;
    if (!/[\s>]/.test(text[at + 7] ?? '')) continue;
    let depth = 0;
    let quote = '';
    let i = at + 7;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || (ch === '`' && depth > 0)) {
        quote = ch;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      } else if (ch === '>' && depth === 0) {
        break;
      }
    }
    if (i >= text.length) return found;
    const after = text.slice(i + 1).replace(/^\s+/, '');
    let first = '';
    if (after.startsWith('<svg')) first = '<svg';
    else if (after.startsWith('<Icon')) first = '<Icon';
    else {
      const stop = after.search(/[<{]/);
      first = after.slice(0, stop < 0 ? 4 : Math.min(stop, 4)).trim();
    }
    found.push({ attrs: text.slice(at + 7, i), first, index: at });
    from = i + 1;
  }
}

// Buttons whose visible content names them, so a tooltip would repeat it.
const NAMED_BY_CONTENT = new Set<string>([
  // The signature style picker shows each font's name in its own face.
  'components/SignatureCaptureDialog.tsx',
]);

describe('icon-only buttons carry a tooltip', () => {
  const symbolOnly: string[] = [];
  const spokenOnly: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    for (const tag of buttonTags(text)) {
      const line = text.slice(0, tag.index).split('\n').length;
      const hasTitle = HAS_TITLE.test(tag.attrs);
      const hasName = HAS_NAME.test(tag.attrs);
      const iconOnly = tag.first === '<svg' || tag.first === '<Icon' || SYMBOL_ONLY.test(tag.first);
      if (iconOnly && !hasTitle) symbolOnly.push(`${rel}:${line}`);
      if (hasName && !hasTitle && !NAMED_BY_CONTENT.has(rel)) spokenOnly.push(`${rel}:${line}`);
    }
  }

  it('every symbol-only button has a tooltip', () => {
    expect(symbolOnly).toEqual([]);
  });

  it('every button with a spoken name also has a tooltip', () => {
    expect(spokenOnly).toEqual([]);
  });
});

describe('the button scanner', () => {
  it('does not end a tag at an arrow function', () => {
    const tags = buttonTags(
      "<button onClick={() => setError(null)} aria-label={tChrome('x')}>\u00d7</button>",
    );
    expect(tags).toHaveLength(1);
    expect(tags[0].attrs).toContain('aria-label');
    expect(tags[0].first).toBe('\u00d7');
  });

  it('sees a symbol-only button with no title', () => {
    const [tag] = buttonTags('<button onClick={() => go()} className="a">\u2715</button>');
    expect(HAS_TITLE.test(tag.attrs)).toBe(false);
    expect(SYMBOL_ONLY.test(tag.first)).toBe(true);
  });

  it('ignores a tag that never closes, with deep braces, without stalling', () => {
    expect(buttonTags('<button x={' + '{'.repeat(5000))).toEqual([]);
  });
});
