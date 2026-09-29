import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.includes('.local.') ? [path] : [];
  });
}

// Keys picked by a list length where the phrase is a list of names, not a
// count noun, so no locale inflects it.
const notPlural = new Set(['lib/guided-actions.ts:refusal.action.needsGhostscriptOne']);

const equality = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

const isOne = (node: ts.Expression) => {
  const inner = unwrap(node);
  return ts.isNumericLiteral(inner) && Number(inner.text) === 1;
};

function keyText(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isTemplateExpression(inner)) return inner.getText();
  return null;
}

function translator(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return /^t([A-Z]\w*)?$/.test(name);
}

function countPickedKeys(root: string): string[] {
  const found: string[] = [];
  for (const path of sources(root)) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isConditionalExpression(node)) {
        const test = unwrap(node.condition);
        let argument: ts.Node = node;
        while (ts.isParenthesizedExpression(argument.parent)) argument = argument.parent;
        if (ts.isBinaryExpression(test) && equality.has(test.operatorToken.kind)
          && (isOne(test.left) || isOne(test.right))
          && ts.isCallExpression(argument.parent) && translator(argument.parent)) {
          const at = relative(root, path).split(sep).join('/');
          const sites = [keyText(node.whenTrue), keyText(node.whenFalse)]
            .filter((key) => key !== null)
            .map((key) => `${at}:${key}`);
          if (!sites.some((site) => notPlural.has(site))) found.push(...sites);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

// A form picked by `count === 1` gives Polish or Russian `_other` where the
// catalog holds `_few` or `_many`, and Arabic never reaches `_zero` or `_two`.
describe('plural forms', () => {
  it('are chosen by the locale, never by comparing the count with 1', () => {
    expect(countPickedKeys(resolve(__dirname, '../src/renderer'))).toEqual([]);
  });
});
