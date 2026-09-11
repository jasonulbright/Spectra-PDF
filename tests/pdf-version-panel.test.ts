import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const path = 'src/renderer/panels/PdfVersionPanel.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actualCallback(hook: string, env: Record<string, unknown>) {
  let expression: ts.Expression | undefined, dependencies: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === hook && !expression) {
      expression = node.arguments[0]; dependencies = node.arguments[1];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression || !ts.isArrowFunction(expression)) throw new Error(`Missing ${hook}`);
  const code = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return { run: new Function(...Object.keys(env), `${code}; return callback;`)(...Object.values(env)),
    dependencies: dependencies?.getText(source) };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tChrome = (key: string, data?: unknown) => `${key}:${JSON.stringify(data)}`;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('actual PDF version panel callbacks', () => {
  function reader() {
    const response = deferred<{ version: string }>();
    const env = { workingPath: 'working.pdf', buffer: new Uint8Array([1]), call: vi.fn(() => response.promise),
      setCurrentVersion: vi.fn(), setReadError: vi.fn(), setStatus: vi.fn(), tChrome };
    return { env, response, ...actualCallback('useEffect', env) };
  }
  it('invalidates on buffer changes and clears the old version before reading', async () => {
    const f = reader(); f.run();
    expect(f.dependencies).toContain('buffer');
    expect(f.env.setCurrentVersion).toHaveBeenCalledWith(null);
    f.response.resolve({ version: '2.0' }); await tick();
    expect(f.env.setCurrentVersion).toHaveBeenLastCalledWith('2.0');
    expect(f.env.call).toHaveBeenCalledWith('get_pdf_version', { file: 'working.pdf' });
  });
  it('cannot reinstate an old fact after the effect is invalidated', async () => {
    const f = reader(); const cleanup = f.run(); cleanup();
    f.response.resolve({ version: '1.3' }); await tick();
    expect(f.env.setCurrentVersion.mock.calls).toEqual([[null]]);
  });
  it('a failed read does not leave a stale version or replace action status', async () => {
    const f = reader(); f.run();
    f.response.reject(new Error('unreadable version')); await tick();
    expect(f.env.setCurrentVersion.mock.calls).toEqual([[null]]);
    expect(f.env.setReadError.mock.lastCall?.[0]).toContain('unreadable version');
    expect(f.env.setStatus.mock.calls).toEqual([['']]);
  });
  function writer() {
    const dialog = deferred<string | null>(), result = deferred<{ original_version: string; target_version: string }>();
    const file = { path: 'source.pdf', name: 'source.pdf', workingPath: 'work.pdf', buffer: new Uint8Array([1]) };
    const env = { activeFile: file, activeFileRef: { current: file }, busyRef: { current: false },
      version: '2.0', saveFile: vi.fn(() => dialog.promise), call: vi.fn(() => result.promise),
      setBusy: vi.fn(), setStatus: vi.fn(), tChrome, suffixedOutputName: () => 'source-version.pdf' };
    return { env, dialog, result, ...actualCallback('useCallback', env) };
  }
  it('serializes clicks before the save dialog resolves', async () => {
    const f = writer(), run = f.run(); await f.run();
    expect(f.env.saveFile).toHaveBeenCalledTimes(1);
    f.dialog.resolve(null); await run;
    expect(f.env.busyRef.current).toBe(false);
    expect(f.env.setBusy.mock.lastCall).toEqual([false]);
    expect(f.env.call).not.toHaveBeenCalled();
  });
  it('refuses a buffer replaced while the save dialog was open', async () => {
    const f = writer(), run = f.run();
    f.env.activeFileRef.current = { ...f.env.activeFile, buffer: new Uint8Array([2]) };
    f.dialog.resolve('out.pdf'); await run;
    expect(f.env.call).not.toHaveBeenCalled();
    expect(f.env.setStatus.mock.lastCall?.[0]).toContain('app.operation.unverified');
    expect(f.env.busyRef.current).toBe(false);
  });
  it('handles a save-dialog rejection and releases the guard', async () => {
    const f = writer(), run = f.run(); f.dialog.reject(new Error('dialog failed')); await run;
    expect(f.env.setStatus.mock.lastCall?.[0]).toContain('dialog failed');
    expect(f.env.busyRef.current).toBe(false);
  });
  it('calls the actual setter and reports its effective before/after versions', async () => {
    const f = writer(), run = f.run(); f.dialog.resolve('out.pdf'); await tick();
    expect(f.env.call).toHaveBeenCalledWith('set_pdf_version', { file: 'work.pdf', output: 'out.pdf', version: '2.0' });
    f.result.resolve({ original_version: '1.7', target_version: '2.0' }); await run;
    expect(f.env.setStatus.mock.lastCall?.[0]).toContain('"from":"1.7","to":"2.0"');
    expect(f.env.busyRef.current).toBe(false);
  });
  it('does not report a former document result on a newly active document', async () => {
    const f = writer(), run = f.run(); f.dialog.resolve('out.pdf'); await tick();
    f.env.activeFileRef.current = { ...f.env.activeFile, path: 'other.pdf', workingPath: 'other-work.pdf' };
    const before = f.env.setStatus.mock.calls.length;
    f.result.resolve({ original_version: '1.7', target_version: '2.0' }); await run;
    expect(f.env.setStatus.mock.calls.length).toBe(before);
  });
});
