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

const OPEN_TAG =
  /<button\b((?:[^<>]|=>|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?)>\s*([^<{]{0,4}|<svg|<Icon)/g;
const SYMBOL_ONLY = /^[^\sA-Za-z0-9<{]{1,3}$/u;

// Buttons whose visible content names them, so a tooltip would repeat it.
const NAMED_BY_CONTENT = new Set<string>([
  // The signature style picker shows each font's name in its own face.
  'components/SignatureCaptureDialog.tsx',
]);

describe('icon-only buttons carry a tooltip', () => {
  const symbolOnly: string[] = [];
  const spokenOnly: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(OPEN_TAG)) {
      const attrs = m[1];
      const first = m[2].trim();
      const line = text.slice(0, m.index).split('\n').length;
      const hasTitle = /\btitle=/.test(attrs);
      const hasName = /\baria-label=/.test(attrs);
      const iconOnly = first === '<svg' || first === '<Icon' || SYMBOL_ONLY.test(first);
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
