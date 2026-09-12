import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const path = 'src/renderer/lib/tauri-bridge.ts';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  let found: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      if (found) throw new Error(`duplicate production declaration ${name}`);
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`missing production declaration ${name}`);
  return found;
}
function picker(invoke: ReturnType<typeof vi.fn>) {
  const object = declaration('dialog').initializer;
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('missing dialog object');
  const property = object.properties.find(p => p.name?.getText(source) === 'saveFile');
  if (!property || !ts.isPropertyAssignment(property)) throw new Error('missing saveFile');
  const js = ts.transpileModule(`let ${declaration('saveDialogInflight').getText(source)};
    const save = ${property.initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('invoke', `${js}; return save;`)(invoke) as
    (options?: { defaultPath?: string }) => Promise<string | null>;
}
function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe('one output picker answer belongs to one write intent', () => {
  for (const secondDefault of ['A.pdf', 'B.pdf', undefined]) {
    it(`does not share an outstanding answer with ${String(secondDefault)}`, async () => {
      const answer = deferred(); const invoke = vi.fn(() => answer.promise); const save = picker(invoke);
      const first = save({ defaultPath: 'A.pdf' });
      expect(await save({ defaultPath: secondDefault })).toBeNull();
      expect(invoke).toHaveBeenCalledExactlyOnceWith('save_file_dialog', { defaultPath: 'A.pdf' });
      answer.resolve('chosen-A.pdf'); expect(await first).toBe('chosen-A.pdf');
      invoke.mockResolvedValueOnce('chosen-B.pdf');
      expect(await save({ defaultPath: 'B.pdf' })).toBe('chosen-B.pdf');
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  }
  it('cancellation releases the picker without authorizing an overlapping write', async () => {
    const answer = deferred(); const invoke = vi.fn(() => answer.promise); const save = picker(invoke);
    const first = save(); expect(await save()).toBeNull(); answer.resolve(null);
    expect(await first).toBeNull(); invoke.mockResolvedValueOnce('next.pdf');
    expect(await save()).toBe('next.pdf');
  });
  it('native rejection reaches its owner and does not wedge the next picker', async () => {
    const answer = deferred(); const invoke = vi.fn(() => answer.promise); const save = picker(invoke);
    const first = save(); const rejection = expect(first).rejects.toThrow('native failure');
    expect(await save()).toBeNull(); answer.reject(new Error('native failure')); await rejection;
    invoke.mockResolvedValueOnce('retry.pdf'); expect(await save()).toBe('retry.pdf');
  });
});
