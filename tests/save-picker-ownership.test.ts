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
type Holder = { owner: string; sameWindow: boolean };
type Reporter = (path: string, holder: Holder) => Promise<void>;
function pickerWith(invoke: ReturnType<typeof vi.fn>, reporter: Reporter | null) {
  const object = declaration('dialog').initializer;
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('missing dialog object');
  const property = object.properties.find(p => p.name?.getText(source) === 'saveFile');
  if (!property || !ts.isPropertyAssignment(property)) throw new Error('missing saveFile');
  const js = ts.transpileModule(`let ${declaration('saveDialogInflight').getText(source)};
    let heldOutputReporter = reporter;
    const save = ${property.initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('invoke', 'reporter', `${js}; return save;`)(invoke, reporter) as
    (options?: { defaultPath?: string; ownPath?: string }) => Promise<string | null>;
}
/** The dialog answers through `dialog`; every picked path is held by nobody. */
function picker(dialog: ReturnType<typeof vi.fn>) {
  const invoke = vi.fn((command: string, args: unknown) =>
    command === 'output_holder' ? Promise.resolve(null) : (dialog as unknown as (c: string, a: unknown) => Promise<string | null>)(command, args));
  return pickerWith(invoke, null);
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

describe('an output picker never answers with an open document', () => {
  function native(answers: (string | null)[], held: Record<string, Holder>) {
    const asked: unknown[] = [];
    const invoke = vi.fn(async (command: string, args: { path?: string; ownPath?: string | null }) => {
      if (command === 'save_file_dialog') return answers.shift() ?? null;
      if (command === 'output_holder') {
        asked.push(args);
        const holder = held[args.path ?? ''];
        return holder && args.ownPath !== args.path ? holder : null;
      }
      throw new Error(`unexpected ${command}`);
    });
    return { invoke, asked };
  }
  it('CONTROL: a path no document holds is returned as picked', async () => {
    const { invoke, asked } = native(['C:/out/new.pdf'], { 'C:/docs/a.pdf': { owner: 'main', sameWindow: true } });
    const report = vi.fn(async () => {});
    expect(await pickerWith(invoke, report)({ defaultPath: 'a.pdf' })).toBe('C:/out/new.pdf');
    expect(asked).toEqual([{ path: 'C:/out/new.pdf', ownPath: null }]);
    expect(report).not.toHaveBeenCalled();
  });
  for (const holder of [{ owner: 'main', sameWindow: true }, { owner: 'doc-1', sameWindow: false }]) {
    it(`ATTACK: a document open in ${holder.sameWindow ? 'this' : 'another'} window is reported and the dialog asks again`, async () => {
      const { invoke } = native(['C:/docs/a.pdf', 'C:/out/new.pdf'], { 'C:/docs/a.pdf': holder });
      const report = vi.fn(async () => {});
      expect(await pickerWith(invoke, report)()).toBe('C:/out/new.pdf');
      expect(report).toHaveBeenCalledExactlyOnceWith('C:/docs/a.pdf', holder);
      expect(invoke.mock.calls.filter(([c]) => c === 'save_file_dialog')).toHaveLength(2);
    });
  }
  it('cancelling the second dialog answers null', async () => {
    const { invoke } = native(['C:/docs/a.pdf', null], { 'C:/docs/a.pdf': { owner: 'main', sameWindow: true } });
    expect(await pickerWith(invoke, vi.fn(async () => {}))()).toBeNull();
  });
  it('with no reporter an open document reads as a cancelled dialog', async () => {
    const { invoke } = native(['C:/docs/a.pdf'], { 'C:/docs/a.pdf': { owner: 'main', sameWindow: true } });
    expect(await pickerWith(invoke, null)()).toBeNull();
  });
  it('Save As of a document onto its own file is allowed', async () => {
    const { invoke, asked } = native(['C:/docs/a.pdf'], { 'C:/docs/a.pdf': { owner: 'main', sameWindow: true } });
    const report = vi.fn(async () => {});
    expect(await pickerWith(invoke, report)({ ownPath: 'C:/docs/a.pdf' })).toBe('C:/docs/a.pdf');
    expect(asked).toEqual([{ path: 'C:/docs/a.pdf', ownPath: 'C:/docs/a.pdf' }]);
    expect(report).not.toHaveBeenCalled();
  });
});
