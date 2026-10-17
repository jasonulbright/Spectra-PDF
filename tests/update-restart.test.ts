import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function parse(relative: string): ts.SourceFile {
  const path = resolve(process.cwd(), relative);
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

const printer = ts.createPrinter({ removeComments: true });

function calleePath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const head = calleePath(expression.expression);
    return head === null ? null : `${head}.${expression.name.text}`;
  }
  return null;
}

function callsIn(root: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function useCallbackBody(source: ts.SourceFile, name: string): ts.ArrowFunction {
  let body: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer && ts.isCallExpression(node.initializer)
      && calleePath(node.initializer.expression) === 'useCallback') {
      const callback = node.initializer.arguments[0];
      if (callback && ts.isArrowFunction(callback)) body = callback;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(body, name).toBeDefined();
  return body!;
}

describe('Restart now', () => {
  it('asks the quit itself to relaunch and arms nothing before it', () => {
    const bar = parse('src/renderer/components/UpdateBar.tsx');
    const restart = useCallbackBody(bar, 'restart');
    expect(callsIn(restart.body).map((call) => calleePath(call.expression))).toEqual(['onRestart']);

    const bridge = readFileSync(resolve(process.cwd(), 'src/renderer/lib/tauri-bridge.ts'), 'utf8');
    expect(bridge).not.toContain('update_restart');

    const app = parse('src/renderer/App.tsx');
    const restartForUpdate = useCallbackBody(app, 'restartForUpdate');
    expect(printer.printNode(ts.EmitHint.Unspecified, restartForUpdate, app)).toBe('() => handleExit(true)');

    let onRestart: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(app) === 'onRestart' && node.initializer
        && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        onRestart = node.initializer.expression.getText(app);
      }
      ts.forEachChild(node, visit);
    };
    visit(app);
    expect(onRestart).toBe('restartForUpdate');

    const exit = useCallbackBody(app, 'handleExit');
    const quits = callsIn(exit.body).filter((call) => calleePath(call.expression) === 'app.requestQuit');
    expect(quits).toHaveLength(1);
    expect(printer.printNode(ts.EmitHint.Unspecified, quits[0], app)).toBe('app.requestQuit(relaunch === true)');
  });
});
