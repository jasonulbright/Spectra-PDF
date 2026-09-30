import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { shouldMinimizeToTrayOnClose } from '../src/renderer/lib/close-sequence';

const path = resolve(process.cwd(), 'src/renderer/App.tsx');
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter({ removeComments: true });
const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, source);

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

const named = (root: ts.Node, name: string) => callsIn(root).filter((call) => calleePath(call.expression) === name);

function onlyCallback(name: string): ts.ArrowFunction {
  const matches = named(source, name);
  expect(matches, name).toHaveLength(1);
  const callback = matches[0].arguments[0];
  expect(callback && ts.isArrowFunction(callback), name).toBe(true);
  return callback as ts.ArrowFunction;
}

function useCallbackBody(name: string): ts.ArrowFunction {
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

describe('tray Quit', () => {
  it('only applies the tray preference to a plain window close', () => {
    expect(shouldMinimizeToTrayOnClose(null, true)).toBe(true);
    expect(shouldMinimizeToTrayOnClose(17, true)).toBe(false);
    expect(shouldMinimizeToTrayOnClose(null, false)).toBe(false);

    const close = onlyCallback('app.onBeforeClose');
    const uses = named(close, 'shouldMinimizeToTrayOnClose');
    expect(uses).toHaveLength(1);
    expect(uses[0].arguments.map(print)).toEqual([
      'sessionId',
      "getSettings().minimizeToTray === true && platformCapability('trayResidency')",
    ]);
  });

  it('uses the same unsaved-work and acknowledged close flow as File Exit', () => {
    const tray = onlyCallback('app.onTrayAction');
    const quitBranches: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      const test = ts.isIfStatement(node) ? node.expression : undefined;
      if (test && ts.isBinaryExpression(test)
        && test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isIdentifier(test.left) && test.left.text === 'action'
        && ts.isStringLiteral(test.right) && test.right.text === 'quit') {
        quitBranches.push(node as ts.IfStatement);
      }
      ts.forEachChild(node, visit);
    };
    visit(tray);
    expect(quitBranches).toHaveLength(1);
    const quit = quitBranches[0].thenStatement;
    expect(callsIn(quit).map((call) => calleePath(call.expression))).toEqual(['handleExit']);

    const exit = useCallbackBody('handleExit');
    const order = callsIn(exit.body)
      .map((call) => calleePath(call.expression))
      .filter((name) => name === 'confirmCurrentDirtyFiles' || name === 'flushTabOrder'
        || name === 'finishCoordinatedExit');
    expect(order.slice(0, 3)).toEqual(['confirmCurrentDirtyFiles', 'flushTabOrder', 'finishCoordinatedExit']);

    const coordinated = named(exit.body, 'finishCoordinatedExit');
    expect(coordinated).toHaveLength(1);
    const steps = coordinated[0].arguments;
    expect(steps).toHaveLength(4);
    for (const step of steps) expect(ts.isArrowFunction(step), print(step)).toBe(true);
    const stepCall = (index: number) => {
      const body = (steps[index] as ts.ArrowFunction).body;
      expect(ts.isCallExpression(body), print(body)).toBe(true);
      return body as ts.CallExpression;
    };
    expect(calleePath(stepCall(0).expression)).toBe('app.requestQuit');
    const reconfirm = stepCall(1);
    expect(calleePath(reconfirm.expression)).toBe('confirmCurrentDirtyFiles');
    expect(reconfirm.arguments.map(print)[2]).toBe('alreadyAnswered');
    expect(print(stepCall(2))).toBe('app.quitCancelled(sessionId)');
    // The close runs through the write gate, which keeps the last window
    // while engine writes are running.
    const close = stepCall(3);
    expect(calleePath(close.expression)).toBe('closeGated');
    expect(print(close.arguments[0])).toBe('(force) => app.confirmClose(force)');
  });
});
