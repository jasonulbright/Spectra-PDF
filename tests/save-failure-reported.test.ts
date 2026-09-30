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
  it('file.saveAs and saveWorkingCopy are reached only from saveOrReport', () => {
    const owners: (string | null)[] = [];
    const visit = (node: ts.Node) => {
      // Any reference, called or handed on: `saveWorkingCopy` receives
      // `file.saveAs` as its writer.
      if (ts.isPropertyAccessExpression(node) && node.getText(source) === 'file.saveAs') {
        owners.push(enclosingDeclaration(node));
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'saveWorkingCopy') {
        owners.push(enclosingDeclaration(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(owners).toEqual(['saveOrReport', 'saveOrReport']);
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
      expect(outcomeDecides(use.parent), use.getText(source)).toBe(true);
    }
  });
});

function readsBinding(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (child) => readsBinding(child, name) || undefined) ?? false;
}

// The awaited result must reach an `if` condition: directly (through `!`,
// `&&`, `||`, parentheses), through a binding a later `if` in the same block
// reads, or as an arrow's return value whose enclosing call meets the same test.
function outcomeDecides(value: ts.Node): boolean {
  let current = value;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent)
      || (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
      || (ts.isBinaryExpression(parent)
        && (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
      || ts.isAwaitExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isIfStatement(parent)) return parent.expression === current;
    if (ts.isReturnStatement(parent) && ts.isBlock(parent.parent)
      && ts.isArrowFunction(parent.parent.parent) && parent.parent.parent.body === parent.parent) {
      current = parent.parent;
      continue;
    }
    if (ts.isArrowFunction(parent) && parent.body === current) {
      if (ts.isCallExpression(parent.parent)) return outcomeDecides(parent.parent);
      // A `write` callback handed to saveListedFiles: the helper stops the run
      // on a false outcome (tests/dirty-prompt.test.ts covers the refusal).
      return ts.isPropertyAssignment(parent.parent)
        && parent.parent.name.getText() === 'write'
        && ts.isObjectLiteralExpression(parent.parent.parent)
        && ts.isCallExpression(parent.parent.parent.parent)
        && parent.parent.parent.parent.expression.getText() === 'saveListedFiles';
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) {
      const name = parent.name.text;
      const statement = parent.parent.parent;
      const block = statement.parent;
      if (!ts.isBlock(block)) return false;
      const later = block.statements.slice(block.statements.indexOf(statement as ts.Statement) + 1);
      return later.some((next) => ts.isIfStatement(next) && readsBinding(next.expression, name));
    }
    return false;
  }
}
