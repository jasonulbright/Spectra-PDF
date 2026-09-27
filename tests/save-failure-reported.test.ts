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
    const uses: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const direct = ts.isIdentifier(expression) && expression.text === 'saveOrReport';
        const throughRef = ts.isPropertyAccessExpression(expression)
          && expression.name.text === 'current'
          && ts.isIdentifier(expression.expression)
          && expression.expression.text === 'saveOrReportRef';
        if (direct || throughRef) uses.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(ts.isAwaitExpression(use.parent), use.getText(source)).toBe(true);
    }
  });
});
