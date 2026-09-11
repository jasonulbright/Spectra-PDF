import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCall } from '../src/renderer/lib/engine-call';

// Run the actual hook's call closure with controllable gate/lock/queue waits.
// A test of a hand-copied closure would not prove where production checks run.
const path = 'src/renderer/hooks/useEngine.ts';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'call'
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('Production engine-call closure missing');
const code = ts.transpileModule(`const call = ${callback.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

describe('engine dispatch ownership', () => {
  it.each(['entry', 'gate', 'lock', 'queue', 'read-lock', 'read-current', 'current'])('checks the actual dispatch boundary: %s', async boundary => {
    let current = boundary !== 'entry';
    const raw = vi.fn(async () => ({ output: 'copy.pdf' })), release = vi.fn();
    const gate = vi.fn(async () => { if (boundary === 'gate') current = false; });
    const env = {
      isTrackableMethod: () => !boundary.startsWith('read-'), beginInteractive: () => release,
      runCommitGate: gate,
      lockKeysFor: () => ['work.pdf'],
      withFileLock: async (_keys: string[], run: () => Promise<unknown>) => {
        if (boundary === 'lock' || boundary === 'read-lock') current = false;
        return run();
      },
      track: async (_method: string, _params: unknown, run: () => Promise<unknown>) => {
        if (boundary === 'queue') current = false;
        return run();
      }, rawCall: raw,
    };
    const call = new Function(...Object.keys(env), `${code}; return call;`)(...Object.values(env)) as EngineCall;
    const result = call('grayscale', { file: 'work.pdf' }, { assertCurrent: () => {
      if (!current) throw new Error('owner changed');
    } });
    if (boundary === 'current' || boundary === 'read-current') { await expect(result).resolves.toEqual({ output: 'copy.pdf' }); expect(raw).toHaveBeenCalledOnce(); }
    else { await expect(result).rejects.toThrow('owner changed'); expect(raw).not.toHaveBeenCalled(); }
    if (boundary.startsWith('read-')) { expect(gate).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); }
    else if (boundary !== 'entry') expect(release).toHaveBeenCalledOnce();
  });
});
