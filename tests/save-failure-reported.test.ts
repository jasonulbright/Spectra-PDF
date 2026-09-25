import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Save gestures run from fire-and-forget command handlers, whose rejections
// reach only the console. A write over the user's file therefore has exactly
// one call site, the helper that reports a refusal.
const path = 'src/renderer/App.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

function enclosingDeclaration(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return current.name.getText(source);
  }
  return null;
}

describe('every save over a user file reports its refusal', () => {
  it('file.saveAs is called only by saveOrReport', () => {
    const owners: (string | null)[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'file.saveAs') {
        owners.push(enclosingDeclaration(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(owners).toEqual(['saveOrReport']);
  });

  it('a refused save stops the gesture that asked for it', () => {
    const text = source.getFullText();
    const uses = text.match(/saveOrReport(?:Ref\.current)?\([^)]*\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const use of uses) {
      const at = text.indexOf(use);
      expect(text.slice(Math.max(0, at - 12), at), use).toMatch(/\(await $/);
    }
  });
});
