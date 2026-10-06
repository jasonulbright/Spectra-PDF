import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { EngineCall } from '../../src/renderer/lib/engine-call';

// The production `callLocked` and `call` closures of `useEngine`, compiled
// with their free names bound to `env`. A test of a hand-copied closure would
// not prove where production takes its locks or runs its checks.
const path = 'src/renderer/hooks/useEngine.ts';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function closure(name: string): string {
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
        && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error(`Production engine closure missing: ${name}`);
  return ts.transpileModule(`const ${name} = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const lockedCode = closure('callLocked');
const callCode = closure('call');

function build(code: string, name: string, env: Record<string, unknown>): EngineCall {
  return new Function(...Object.keys(env), `${code}; return ${name};`)(...Object.values(env)) as EngineCall;
}

export function engineClosures(env: Record<string, unknown>): { call: EngineCall; callLocked: EngineCall } {
  const callLocked = build(lockedCode, 'callLocked', env);
  const call = build(callCode, 'call', { ...env, callLocked });
  return { call, callLocked };
}
