import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createEncryptionConsentCoordinator, CONSENT_ABANDONED, CONSENT_BUSY } from '../src/renderer/lib/encryption-consent-coordinator';

const path = 'src/renderer/hooks/useEncryptionConsent.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'useEncryptionConsent');
if (!declaration) throw new Error('Production consent hook missing');
const code = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
const refusal = new Error('consent required');
type Hook = {
  runWithConsent: (attempt: (drop: boolean) => Promise<string>, owner: { isCurrent: () => boolean; subject: string }) => Promise<unknown>;
  consentDialog: { props: { open: boolean; onResult: (yes: boolean) => void } };
};
type Effect = { run: () => (() => void) | void; deps: unknown[]; cleanup?: () => void };
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

// Minimal hook scheduling, not a copy of the consent implementation. The real
// hook body supplies the coordinator creation, effect cleanup and ticket-bound
// dialog callback; tests drive renders and the StrictMode setup replay.
function mount() {
  const slots: unknown[] = [], effects: Effect[] = [];
  let cursor = 0, pending: (() => void)[] = [], activeFile: object = {}, dirtyPaths: string[] = [];
  const React = {
    useRef: (initial: unknown) => { const i = cursor++; return slots[i] ??= { current: initial }; },
    useReducer: () => { cursor++; return [0, () => {}]; },
    useCallback: (fn: unknown) => { cursor++; return fn; },
    createElement: (_component: unknown, props: unknown) => ({ props }),
    useEffect: (run: Effect['run'], deps: unknown[]) => {
      const i = cursor++, old = effects[i];
      if (!old || deps.length !== old.deps.length || deps.some((d, n) => d !== old.deps[n])) {
        pending.push(() => {
          old?.cleanup?.(); const cleanup = run();
          effects[i] = { run, deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
  };
  const env = { React, EncryptionConsentDialog: {}, useActiveFile: () => ({ activeFile }),
    useAppState: () => ({ pageDirtyPaths: dirtyPaths }), createEncryptionConsentCoordinator,
    isEncryptionConsentRefusal: (e: unknown) => e === refusal, CONSENT_ABANDONED };
  const invoke = new Function(...Object.keys(env), `${code}; return useEncryptionConsent;`)(...Object.values(env)) as () => Hook;
  const render = () => { cursor = 0; const hook = invoke(); const flush = pending; pending = []; flush.forEach(f => f()); return hook; };
  render();
  return { render,
    changeFile: () => { activeFile = {}; }, dirty: () => { dirtyPaths = ['A']; },
    unmount: () => effects.forEach(e => e?.cleanup?.()),
    replay: () => { effects.forEach(e => e?.cleanup?.()); effects.forEach(e => { if (e) { const c = e.run(); e.cleanup = typeof c === 'function' ? c : undefined; } }); },
  };
}

describe('production consent hook lifecycle', () => {
  it('runs the faithful refusal, question and exact retry', async () => {
    const app = mount(), calls: boolean[] = [];
    const run = app.render().runWithConsent(async drop => { calls.push(drop); if (!drop) throw refusal; return 'written'; },
      { isCurrent: () => true, subject: 'A.pdf → copy.pdf' });
    await tick(); const question = app.render().consentDialog.props;
    expect(question.open).toBe(true); question.onResult(true);
    await expect(run).resolves.toBe('written'); expect(calls).toEqual([false, true]); app.unmount();
  });
  it('settles overlap and unmount instead of orphaning either promise', async () => {
    const app = mount(), hook = app.render(), owner = { isCurrent: () => true, subject: 'A' };
    const first = hook.runWithConsent(async () => { throw refusal; }, owner);
    const second = hook.runWithConsent(async () => 'must not run', owner);
    await expect(second).resolves.toBe(CONSENT_BUSY); await tick(); app.unmount();
    await expect(first).resolves.toBe(CONSENT_ABANDONED);
  });
  it.each(['file', 'dirty'] as const)('closes an obsolete question on %s ownership changes', async kind => {
    const app = mount(); let current = true, retries = 0;
    const task = app.render().runWithConsent(async drop => { if (!drop) throw refusal; retries++; return 'bad'; },
      { isCurrent: () => current, subject: 'A' });
    await tick(); const oldAnswer = app.render().consentDialog.props.onResult;
    current = false; if (kind === 'file') app.changeFile(); else app.dirty(); app.render();
    await expect(task).resolves.toBe(CONSENT_ABANDONED); oldAnswer(true);
    expect(retries).toBe(0); expect(app.render().consentDialog.props.open).toBe(false); app.unmount();
  });
  it('a StrictMode replacement cannot accept the old instance ticket', async () => {
    const app = mount(), owner = { isCurrent: () => true, subject: 'A' };
    const first = app.render().runWithConsent(async () => { throw refusal; }, owner);
    await tick(); const stale = app.render().consentDialog.props.onResult;
    app.replay(); await expect(first).resolves.toBe(CONSENT_ABANDONED);
    let retries = 0;
    const second = app.render().runWithConsent(async drop => { if (!drop) throw refusal; retries++; return 'ok'; }, owner);
    await tick(); stale(true); await tick(); expect(retries).toBe(0);
    app.render().consentDialog.props.onResult(true); await expect(second).resolves.toBe('ok'); app.unmount();
  });
});
