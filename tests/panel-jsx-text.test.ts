import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// A sentence typed into JSX renders in English under every locale; UI prose
// goes through the typed catalogs. Product names are the only literal prose.
const ALLOWED = new Set(['Spectra PDF']);

function literalProse(dir: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    const path = `${dir}/${name}`;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const text = node.getText(source).trim();
        if (/[A-Za-z]{2,}\s+[A-Za-z]/.test(text) && !ALLOWED.has(text)) hits.push(`${path}: ${text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

describe('panel and dialog JSX carries no literal prose', () => {
  it.each(['src/renderer/panels', 'src/renderer/components'])('%s', (dir) => {
    expect(literalProse(dir)).toEqual([]);
  });
});
