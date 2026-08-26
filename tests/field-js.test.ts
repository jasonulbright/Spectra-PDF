import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DECLARATIVE_TRIGGERS,
  JS_TRIGGERS,
  fieldScriptsEnabled,
  isDeclarative,
  needsSandbox,
  refusedCapabilities,
  scriptInventory,
  scriptSuppression,
} from '../src/renderer/lib/field-js-policy';
import {
  buildSeed,
  describeChange,
  createFieldScriptSession,
} from '../src/renderer/lib/field-js-host';
import type {
  FieldScriptWorkerLike,
  SandboxMessage,
  WorkerRequest,
  WorkerResponse,
} from '../src/renderer/lib/field-js-protocol';
import {
  clearScriptReports,
  publishScriptReports,
  resetScriptReports,
  scriptReportsFor,
  subscribeScriptReports,
} from '../src/renderer/lib/field-js-reports';
import type { FormField, FormFieldActions } from '../src/renderer/lib/forms';

function field(name: string, actions?: FormFieldActions, over: Partial<FormField> = {}): FormField {
  return {
    name,
    type: 'text',
    value: '',
    readOnly: false,
    required: false,
    editable: true,
    widgets: [{ pageIndex: 0, rect: [0, 0, 10, 10], hidden: false }],
    ...(actions ? { actions } : {}),
    ...over,
  };
}

// ── routing: declarative bodies never reach the sandbox ────────────────────

describe('declarative vs custom routing', () => {
  it('recognizes a stock AF* body as declarative', () => {
    expect(isDeclarative('AFNumber_Format(2, 0, 0, 0, "", true);')).toBe(true);
  });

  it('treats a body that merely CALLS an AF* helper inside larger code as custom', () => {
    expect(isDeclarative('event.value = FormatMoneyField(event, 2, true)')).toBe(false);
    expect(isDeclarative('if (x) { AFSimple_Calculate("SUM", ["a"]); } else { event.value = 1 }')).toBe(
      false,
    );
  });

  it('partitions a document into declarative and custom, and the custom half is the sandbox input', () => {
    const inventory = scriptInventory([
      field('total', { C: 'AFSimple_Calculate("SUM", ["a", "b"]);', F: 'AFNumber_Format(2, 0, 0, 0, "", true);' }),
      field('name', { K: 'event.change = event.change.toUpperCase()' }),
    ]);
    expect(inventory.entries).toHaveLength(3);
    expect(inventory.custom.map((e) => `${e.field}:${e.trigger}`)).toEqual(['name:K']);
  });

  it('carries the focus pair, which the declarative evaluator never sees', () => {
    const inventory = scriptInventory([
      field('box', { Fo: 'event.target.strokeColor = ["G", 0.8]', Bl: 'OnBlur()' }),
    ]);
    expect(inventory.custom.map((e) => e.trigger)).toEqual(['Fo', 'Bl']);
    // The off-state report is the four value triggers and stays that way.
    expect([...DECLARATIVE_TRIGGERS]).toEqual(['K', 'V', 'C', 'F']);
    expect([...JS_TRIGGERS]).toEqual(['K', 'F', 'V', 'C', 'Fo', 'Bl']);
  });

  it('ignores an empty body', () => {
    expect(scriptInventory([field('a', { K: '   ' })]).entries).toHaveLength(0);
  });

  it('builds no sandbox for a document whose scripts are all declarative', () => {
    const inventory = scriptInventory([field('t', { C: 'AFSimple_Calculate("SUM", ["a"]);' })]);
    expect(needsSandbox(inventory, 0)).toBe(false);
    expect(needsSandbox(inventory, 1)).toBe(true);
  });
});

// ── refused capabilities ───────────────────────────────────────────────────

describe('refused capabilities', () => {
  it('names each refused call once, in source order', () => {
    expect(
      refusedCapabilities('this.submitForm("x"); app.launchURL("y"); this.submitForm("z")'),
    ).toEqual(['submitForm', 'launchURL']);
  });

  it('reports nothing for the ordinary form-logic body', () => {
    expect(refusedCapabilities('event.value = this.getField("a").value * 0.005')).toEqual([]);
  });

  it('does not fire on a longer name that merely ends in a refused one', () => {
    expect(refusedCapabilities('myPrint(); doExecMenuItem()')).toEqual([]);
  });

  it('surfaces the refusal through the inventory', () => {
    const inventory = scriptInventory([field('go', { C: 'this.mailDoc()' })]);
    expect(inventory.custom[0].refused).toEqual(['mailDoc']);
  });
});

// ── preference and policy ──────────────────────────────────────────────────

describe('preference and policy', () => {
  it('runs only when the preference is on and the policy is absent', () => {
    expect(fieldScriptsEnabled(false, false)).toBe(false);
    expect(fieldScriptsEnabled(true, false)).toBe(true);
    expect(fieldScriptsEnabled(false, true)).toBe(false);
  });

  it('lets the policy outrank the preference, and says which decided', () => {
    expect(fieldScriptsEnabled(true, true)).toBe(false);
    expect(scriptSuppression(true, true)).toBe('policy');
    expect(scriptSuppression(false, false)).toBe('preference');
    expect(scriptSuppression(true, false)).toBeNull();
  });

  it('says nothing about the policy until the machine key has been read', () => {
    // Fail-closed for EXECUTION — nothing runs before the read lands...
    expect(fieldScriptsEnabled(true, null)).toBe(false);
    // ...but the wording is neither "policy" nor "preference": claiming an
    // administrator lockout on a machine with no policy key is a lie every
    // user would see on every open of Preferences.
    expect(scriptSuppression(true, null)).toBe('unknown');
    expect(scriptSuppression(false, null)).toBe('unknown');
  });
});

// ── the seed ───────────────────────────────────────────────────────────────

describe('buildSeed', () => {
  const base = {
    calculationOrder: [],
    documentScripts: [],
    numPages: 3,
    filename: 'f.pdf',
    language: 'en-US',
  };

  it('seeds only the custom bodies — a declarative one would run twice', () => {
    const seed = buildSeed({
      ...base,
      fields: [field('t', { C: 'AFSimple_Calculate("SUM", ["a"]);', K: 'event.rc = true' })],
    });
    expect(Object.keys(seed.objects.t[0].actions)).toEqual(['Keystroke']);
  });

  it('drops a /CO entry naming a field this read does not carry', () => {
    const seed = buildSeed({
      ...base,
      calculationOrder: ['a', 'ghost'],
      fields: [field('a', { C: 'event.value = 1' })],
    });
    expect(seed.calculationOrder).toEqual(['a']);
  });

  it('puts the document-level declarations under the Open document action', () => {
    const seed = buildSeed({
      ...base,
      documentScripts: ['function helper() { return 1 }', '   '],
      fields: [],
    });
    expect(seed.docInfo.actions.Open).toEqual(['function helper() { return 1 }']);
  });

  it('carries a checkbox as an export value the object model understands', () => {
    const seed = buildSeed({
      ...base,
      fields: [field('cb', { C: 'event.value = 1' }, { type: 'checkbox', value: true })],
    });
    expect(seed.objects.cb[0].value).toBe('Yes');
    expect(seed.objects.cb[0].type).toBe('checkbox');
  });

  it('seeds the document’s OWN checkbox on-state, not the Yes convention', () => {
    const seed = buildSeed({
      ...base,
      fields: [
        field('cb', { C: 'event.value = 1' }, {
          type: 'checkbox',
          value: true,
          exportValue: '1',
        }),
        field('off', undefined, { type: 'checkbox', value: false, exportValue: '1' }),
      ],
    });
    // `getField("cb").value == "1"` is what the document's own script compares
    // against; synthesizing `Yes` makes that false on a form that stores `/1`.
    expect(seed.objects.cb[0].value).toBe('1');
    expect(seed.objects.cb[0].exportValues).toEqual(['Off', '1']);
    expect(seed.objects.off[0].value).toBe('Off');
  });

  it('seeds the document’s real page count', () => {
    const seed = buildSeed({ ...base, numPages: 17, fields: [] });
    expect(seed.docInfo.numPages).toBe(17);
  });
});

// ── the keystroke event's change, reconstructed ────────────────────────────

describe('describeChange', () => {
  it('describes an insertion at the caret', () => {
    expect(describeChange('ab', 'abc')).toEqual({ change: 'c', selStart: 2, selEnd: 2 });
  });

  it('describes an insertion in the middle', () => {
    expect(describeChange('ac', 'abc')).toEqual({ change: 'b', selStart: 1, selEnd: 1 });
  });

  it('describes a deletion as an empty change over the removed range', () => {
    expect(describeChange('abc', 'ac')).toEqual({ change: '', selStart: 1, selEnd: 2 });
  });

  it('describes a replacement of a selection', () => {
    expect(describeChange('abcd', 'aXd')).toEqual({ change: 'X', selStart: 1, selEnd: 3 });
  });

  it('describes no edit at all', () => {
    expect(describeChange('abc', 'abc')).toEqual({ change: '', selStart: 3, selEnd: 3 });
  });
});

// ── the session, over a fake worker ────────────────────────────────────────

/** A worker that answers each dispatch with a scripted message list, and — as
 * the real one does — answers `init` with the load's verdict first. `load`
 * controls that verdict; `'defer'` withholds it so a test can prove the host
 * waits rather than posting into a sandbox that does not exist yet. */
function fakeWorker(
  reply: (event: WorkerRequest) => SandboxMessage[] | 'hang',
  load: 'ok' | 'defer' | { error: string } = 'ok',
): {
  worker: FieldScriptWorkerLike;
  terminated: () => number;
  requests: WorkerRequest[];
  ready: (verdict?: WorkerResponse & { type: 'ready' }) => void;
} {
  let terminated = 0;
  const requests: WorkerRequest[] = [];
  const announce = (verdict: WorkerResponse & { type: 'ready' }): void => {
    queueMicrotask(() => worker.onmessage?.({ data: verdict }));
  };
  const worker: FieldScriptWorkerLike = {
    onmessage: null,
    postMessage(message) {
      requests.push(message);
      if (message.type === 'init') {
        if (load === 'ok') announce({ type: 'ready', ok: true });
        else if (load !== 'defer') announce({ type: 'ready', ok: false, error: load.error });
        return;
      }
      if (message.type !== 'dispatch') return;
      const answer = reply(message);
      if (answer === 'hang') return;
      queueMicrotask(() => {
        const response: WorkerResponse = { type: 'done', id: message.id, messages: answer };
        worker.onmessage?.({ data: response });
      });
    },
    terminate() {
      terminated += 1;
    },
  };
  return {
    worker,
    terminated: () => terminated,
    requests,
    ready: (verdict = { type: 'ready', ok: true }) => announce(verdict),
  };
}

const SEED = buildSeed({
  fields: [field('a', { C: 'event.value = 1' })],
  calculationOrder: [],
  documentScripts: [],
  numPages: 1,
  filename: 'f.pdf',
  language: 'en-US',
});

describe('field script session', () => {
  it('seeds the worker on the first dispatch and returns the values it produced', async () => {
    const fake = fakeWorker(() => [
      { kind: 'value', id: 'total', value: '42', formattedValue: '$42.00' },
    ]);
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
    });
    const result = await session.commit('a', '7');
    expect(fake.requests[0]).toMatchObject({ type: 'init', wasmUrl: 'about:blank' });
    expect(result.values.get('total')).toBe('42');
    expect(result.formatted.get('total')).toBe('$42.00');
    expect(result.timedOut).toBe(false);
    session.dispose();
  });

  it('maps each gesture to the object model event the document expects', async () => {
    const fake = fakeWorker(() => []);
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
    });
    await session.keystroke('a', 'ab', 'c', 2, 2);
    await session.commit('a', 'abc');
    await session.focus('a', 'abc');
    await session.blur('a', 'abc');
    await session.open();
    const events = fake.requests
      .filter((r): r is Extract<WorkerRequest, { type: 'dispatch' }> => r.type === 'dispatch')
      .map((r) => `${r.event.name}:${r.event.id}:${r.event.willCommit ?? ''}`);
    expect(events).toEqual([
      'Keystroke:a:false',
      'Keystroke:a:true',
      'Focus:a:',
      'Blur:a:',
      'Open:doc:',
    ]);
    session.dispose();
  });

  it('collects an alert instead of reaching a platform dialog', async () => {
    const fake = fakeWorker(() => [{ kind: 'alert', text: 'Enter a valid Taxpayer ID.' }]);
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
    });
    const result = await session.commit('a', 'x');
    expect(result.alerts).toEqual(['Enter a valid Taxpayer ID.']);
    session.dispose();
  });

  it('attributes an engine error to the field and trigger it names', async () => {
    const fake = fakeWorker(() => [
      {
        kind: 'error',
        text: 'Error when executing "Calculate" for field "total"\nTypeError: x is not a function',
      },
    ]);
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
    });
    const result = await session.commit('a', 'x');
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ field: 'total', trigger: 'C', kind: 'error' });
    session.dispose();
  });

  it('reports a refused capability per field without stopping the run', async () => {
    const fake = fakeWorker(() => [{ kind: 'value', id: 'a', value: '1' }]);
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
      bodies: [{ field: 'a', trigger: 'C', js: 'this.submitForm("u"); event.value = 1' }],
    });
    const result = await session.commit('a', 'x');
    // The value still landed — refusal is a report, never a gate.
    expect(result.values.get('a')).toBe('1');
    expect(result.reports).toEqual([
      { field: 'a', trigger: 'C', kind: 'refused', detail: 'submitForm' },
    ]);
    session.dispose();
  });

  it('kills a worker that never answers, names the script, and rebuilds for the next dispatch', async () => {
    vi.useFakeTimers();
    let built = 0;
    let answer: 'hang' | SandboxMessage[] = 'hang';
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      timeoutMs: 50,
      makeWorker: () => {
        built += 1;
        const w = fakeWorker(() => answer);
        workers.push(w);
        return w.worker;
      },
    });
    const pending = session.commit('a', 'x');
    await vi.advanceTimersByTimeAsync(60);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.reports[0]).toMatchObject({ field: 'a', trigger: 'K', kind: 'timeout' });
    expect(workers[0].terminated()).toBe(1);

    // The next gesture gets a fresh worker, re-seeded from the document.
    answer = [{ kind: 'value', id: 'a', value: '9' }];
    const after = session.commit('a', 'y');
    await vi.advanceTimersByTimeAsync(1);
    expect((await after).values.get('a')).toBe('9');
    expect(built).toBe(2);
    expect(workers[1].requests[0]).toMatchObject({ type: 'init' });
    session.dispose();
    vi.useRealTimers();
  });

  it('holds the first dispatch until the interpreter has loaded', async () => {
    const fake = fakeWorker(() => [{ kind: 'value', id: 'a', value: 'seeded' }], 'defer');
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
    });
    // The document `Open` pass is always the first dispatch on a fresh worker,
    // and it is what evaluates the document-level declarations every custom
    // calculation calls into. Posting it before the load lands loses it.
    const open = session.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.requests.map((r) => r.type)).toEqual(['init']);
    fake.ready();
    const result = await open;
    expect(fake.requests.map((r) => r.type)).toEqual(['init', 'dispatch']);
    expect(result.values.get('a')).toBe('seeded');
    session.dispose();
  });

  it('reports every script as not run when the interpreter fails to load', async () => {
    const fake = fakeWorker(() => [], { error: 'Cannot start sandbox' });
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
      bodies: [
        { field: 'a', trigger: 'C', js: 'event.value = 1' },
        { field: 'b', trigger: 'K', js: 'event.rc = false' },
      ],
    });
    const result = await session.open();
    // Never silence: the panel has to be able to say which scripts did not run.
    expect(result.reports).toEqual([
      { field: 'a', trigger: 'C', kind: 'error', detail: 'sandbox: Cannot start sandbox' },
      { field: 'b', trigger: 'K', kind: 'error', detail: 'sandbox: Cannot start sandbox' },
    ]);
    expect(fake.requests.some((r) => r.type === 'dispatch')).toBe(false);
    session.dispose();
  });

  it('marks a commit the document refused, and never reports it as a value to keep', async () => {
    const fake = fakeWorker(() => [
      { kind: 'value', id: 'a', value: '', formattedValue: null, selRange: [0, 0], focus: true },
    ]);
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => fake.worker,
    });
    const result = await session.commit('a', '7');
    expect(result.rejected.has('a')).toBe(true);
    session.dispose();
  });

  it('drops a dead worker’s unsolicited messages instead of crediting them to the next event', async () => {
    vi.useFakeTimers();
    let answer: 'hang' | SandboxMessage[] = 'hang';
    let last: ReturnType<typeof fakeWorker> | null = null;
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      timeoutMs: 50,
      makeWorker: () => {
        last = fakeWorker(() => answer);
        return last.worker;
      },
    });
    const hung = session.commit('a', 'x');
    await vi.advanceTimersByTimeAsync(1);
    // A timer inside the doomed sandbox fires while the dispatch is still out.
    const dying = last as unknown as ReturnType<typeof fakeWorker>;
    dying.worker.onmessage?.({
      data: { type: 'emit', messages: [{ kind: 'value', id: 'ghost', value: 'stale' }] },
    });
    await vi.advanceTimersByTimeAsync(60);
    expect((await hung).timedOut).toBe(true);

    answer = [{ kind: 'value', id: 'a', value: '9' }];
    const after = session.commit('a', 'y');
    await vi.advanceTimersByTimeAsync(1);
    const result = await after;
    expect(result.values.get('ghost')).toBeUndefined();
    expect(result.values.get('a')).toBe('9');
    session.dispose();
    vi.useRealTimers();
  });

  it('returns an empty result rather than throwing where no worker can be built', async () => {
    const session = createFieldScriptSession({
      seed: SEED,
      wasmUrl: 'about:blank',
      makeWorker: () => null,
    });
    const result = await session.commit('a', 'x');
    expect(result.values.size).toBe(0);
    expect(result.timedOut).toBe(false);
    session.dispose();
  });
});

// ── the report store ───────────────────────────────────────────────────────

describe('script report store', () => {
  afterEach(() => resetScriptReports());

  it('accumulates across dispatches and collapses a repeat of the same (field, trigger)', () => {
    publishScriptReports('a.pdf', [{ field: 'x', trigger: 'C', kind: 'error', detail: 'one' }]);
    publishScriptReports('a.pdf', [{ field: 'x', trigger: 'C', kind: 'error', detail: 'two' }]);
    publishScriptReports('a.pdf', [{ field: 'y', trigger: 'V', kind: 'refused', detail: 'print' }]);
    expect(scriptReportsFor('a.pdf')).toEqual([
      { field: 'x', trigger: 'C', kind: 'error', detail: 'two' },
      { field: 'y', trigger: 'V', kind: 'refused', detail: 'print' },
    ]);
  });

  it('announces only a real change', () => {
    const seen = vi.fn();
    const stop = subscribeScriptReports(seen);
    publishScriptReports('a.pdf', [{ field: 'x', trigger: 'C', kind: 'error', detail: 'one' }]);
    publishScriptReports('a.pdf', [{ field: 'x', trigger: 'C', kind: 'error', detail: 'one' }]);
    publishScriptReports('a.pdf', []);
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
  });

  it('forgets a document whose bytes were replaced', () => {
    publishScriptReports('a.pdf', [{ field: 'x', trigger: 'C', kind: 'error', detail: 'one' }]);
    clearScriptReports('a.pdf');
    expect(scriptReportsFor('a.pdf')).toEqual([]);
  });
});
