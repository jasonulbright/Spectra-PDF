// The vendored QuickJS sandbox, driven for real.
//
// `field-js.test.ts` drives a FAKE worker: it proves the host's bookkeeping
// (deadlines, correlation, attribution) and nothing about the interpreter. This
// suite loads the actual `pdfjs-dist` sandbox module, the actual
// `quickjs-eval.wasm`, and the actual `field-js.worker.ts` message loop, so the
// seed shapes, the `window` alias, the `support.win` swap and the object model
// are exercised as they ship.
//
// Two host facts make that possible off a browser: the worker reads `self` at
// module load, so a stub installed first receives its whole protocol; and the
// emscripten glue fetches its `.wasm` by URL, so a `file:` branch on `fetch`
// lets it load from the package. Neither touches product code.
//
// NOT covered here, deliberately: the watchdog against a real non-terminating
// script. The interpreter's dispatch is a synchronous `ccall`, so in-process it
// would hang this suite — killing it needs a real thread, which is the e2e
// spec's job (`e2e-tests/specs/159-field-js.spec.ts`).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSeed, createFieldScriptSession } from '../src/renderer/lib/field-js-host';
import type { FieldScriptSession } from '../src/renderer/lib/field-js-host';
import type {
  FieldScriptWorkerLike,
  WorkerRequest,
  WorkerResponse,
} from '../src/renderer/lib/field-js-protocol';
import type { FormField, FormFieldActions } from '../src/renderer/lib/forms';

const WASM_URL = `${pathToFileURL(path.resolve('node_modules/pdfjs-dist/wasm')).href}/`;

beforeAll(() => {
  // The emscripten glue loads the module binary with `fetch`, which in Node has
  // no `file:` scheme. Everything else stays the platform's.
  const platformFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    if (url.startsWith('file:')) {
      const bytes = await readFile(new URL(url));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'application/wasm' },
      });
    }
    return platformFetch(input, init);
  }) as typeof fetch;
});

interface WorkerGlobalStub {
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
  postMessage: (message: WorkerResponse) => void;
}

/** A `FieldScriptWorkerLike` whose other end is the real worker module running
 * in this process against the real interpreter. */
async function realWorker(): Promise<FieldScriptWorkerLike> {
  const adapter: FieldScriptWorkerLike = {
    postMessage: () => undefined,
    terminate: () => undefined,
    onmessage: null,
  };
  const stub: WorkerGlobalStub = {
    onmessage: null,
    postMessage: (message) => {
      adapter.onmessage?.({ data: message });
    },
  };
  vi.resetModules();
  (globalThis as unknown as { self: WorkerGlobalStub }).self = stub;
  await import('../src/renderer/lib/field-js.worker');
  adapter.postMessage = (message) => {
    stub.onmessage?.({ data: message });
  };
  adapter.terminate = () => {
    stub.onmessage?.({ data: { type: 'dispose' } });
  };
  return adapter;
}

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

interface Doc {
  fields: FormField[];
  calculationOrder?: string[];
  documentScripts?: string[];
}

let live: FieldScriptSession | null = null;

async function open(doc: Doc): Promise<FieldScriptSession> {
  const worker = await realWorker();
  const session = createFieldScriptSession({
    seed: buildSeed({
      fields: doc.fields,
      calculationOrder: doc.calculationOrder ?? [],
      documentScripts: doc.documentScripts ?? [],
      numPages: 1,
      filename: 'real.pdf',
      language: 'en-US',
    }),
    wasmUrl: WASM_URL,
    makeWorker: () => worker,
    timeoutMs: 20000,
    bodies: doc.fields.flatMap((f) =>
      f.actions?.C ? [{ field: f.name, trigger: 'C' as const, js: f.actions.C }] : [],
    ),
  });
  live = session;
  // The document `Open` pass is what evaluates the document-level declarations,
  // exactly as `useFieldScripts` runs it before any field gesture.
  await session.open();
  return session;
}

afterEach(() => {
  live?.dispose();
  live = null;
});

describe('the vendored interpreter, loaded and run', () => {
  it('loads the wasm through the module worker and answers a dispatch', async () => {
    const session = await open({
      // Deliberately not `event.value = 42` — that is Simplified Field
      // Notation, which `af-calc` owns and the sandbox must never see.
      fields: [field('A'), field('T', { C: 'var n = 6; event.value = String(n * 7);' })],
      calculationOrder: ['T'],
    });
    const result = await session.commit('A', '1');
    expect(result.timedOut).toBe(false);
    expect(result.reports).toEqual([]);
    expect(result.values.get('T')).toBe('42');
  });

  it('calls a document-level helper from a field calculation', async () => {
    const session = await open({
      fields: [
        field('A', undefined, { value: '2' }),
        field('B', undefined, { value: '3' }),
        field('Total', { C: 'event.value = SumTwo("A", "B");' }),
      ],
      calculationOrder: ['Total'],
      documentScripts: [
        'function SumTwo(a, b) { return Number(this.getField(a).value) + Number(this.getField(b).value); }',
      ],
    });
    const result = await session.commit('A', '5');
    expect(result.reports).toEqual([]);
    expect(result.values.get('Total')).toBe('8');
  });

  it('reads this.getField().value and guards an empty input', async () => {
    const session = await open({
      fields: [
        field('Base'),
        field('Fee', {
          C: 'var v = this.getField("Base").value; event.value = (v === "" ? "" : Number(v) * 0.005);',
        }),
      ],
      calculationOrder: ['Fee'],
    });
    expect((await session.commit('Base', '1000')).values.get('Fee')).toBe('5');
    expect((await session.commit('Base', '')).values.get('Fee')).toBe('');
  });

  it('uppercases through an event.change keystroke', async () => {
    const session = await open({
      fields: [field('Name', { K: 'event.change = event.change.toUpperCase();' })],
    });
    const result = await session.keystroke('Name', '', 'ab', 0, 0);
    expect(result.reports).toEqual([]);
    expect(result.values.get('Name')).toBe('AB');
  });

  it('rejects a keystroke through event.rc', async () => {
    const session = await open({
      fields: [
        field('Digits', {
          K: 'if (event.change && !/^[0-9]$/.test(event.change)) { event.rc = false; }',
        }),
      ],
    });
    const ok = await session.keystroke('Digits', '', '7', 0, 0);
    expect(ok.values.get('Digits')).toBe('7');
    // A refused keystroke still answers, with the value the field had before
    // the change — the object model restores rather than staying silent, so the
    // overlay redraws the rejection instead of leaving the typed character.
    const bad = await session.keystroke('Digits', '', 'x', 0, 0);
    expect(bad.values.get('Digits')).toBe('');
  });

  it('formats through util.printx', async () => {
    const session = await open({
      fields: [field('Phone', { F: 'event.value = util.printx("(999) 999-9999", event.value);' })],
    });
    const result = await session.commit('Phone', '5551234567');
    expect(result.formatted.get('Phone')).toBe('(555) 123-4567');
  });

  it('raises app.alert as a host message, never a platform dialog', async () => {
    const session = await open({
      fields: [field('X', { C: 'app.alert("over the limit"); event.value = 1;' })],
      calculationOrder: ['X'],
    });
    const result = await session.commit('X', '1');
    expect(result.alerts).toEqual(['over the limit']);
  });

  it('reads a radio group through isBoxChecked', async () => {
    const session = await open({
      fields: [
        field('Choice', undefined, { type: 'radio', value: 'Yes', options: ['Yes', 'No'] }),
        field('Echo', {
          C: 'event.value = this.getField("Choice").isBoxChecked(0) ? "on" : "off";',
        }),
      ],
      calculationOrder: ['Echo'],
    });
    const result = await session.commit('Echo', '');
    expect(result.reports).toEqual([]);
    expect(result.values.get('Echo')).toBe('on');
  });

  it('reads a checkbox seeded with the synthesized Yes/Off export values', async () => {
    const session = await open({
      fields: [
        field('Box', undefined, { type: 'checkbox', value: true }),
        field('Echo', { C: 'event.value = this.getField("Box").value;' }),
      ],
      calculationOrder: ['Echo'],
    });
    expect((await session.commit('Echo', '')).values.get('Echo')).toBe('Yes');
  });

  it('leaves a rejecting Validate script harmless per character, and refuses only the commit', async () => {
    const session = await open({
      fields: [
        field('Amount', { V: 'if (Number(event.value) < 100) { event.rc = false; }' }),
      ],
    });
    // Typing `1` is a KEYSTROKE. The validate belongs to the commit, so the
    // character survives — dispatching a commit per character is what made a
    // field with this script impossible to type into.
    const typed = await session.keystroke('Amount', '', '1', 0, 0);
    expect(typed.rejected.size).toBe(0);
    expect(typed.values.get('Amount')).toBe('1');

    // Committing 1 IS refused, and the refusal is marked rather than arriving
    // as an ordinary empty value the pending map would keep.
    const bad = await session.commit('Amount', '1');
    expect(bad.rejected.has('Amount')).toBe(true);

    const good = await session.commit('Amount', '250');
    expect(good.rejected.size).toBe(0);
    expect(good.values.get('Amount')).toBe('250');
  });

  it('reads a checkbox whose on-state is not the Yes convention', async () => {
    const session = await open({
      fields: [
        field('Box', undefined, { type: 'checkbox', value: true, exportValue: '1' }),
        field('Echo', { C: 'event.value = this.getField("Box").value === "1" ? "on" : "off";' }),
      ],
      calculationOrder: ['Echo'],
    });
    expect((await session.commit('Echo', '')).values.get('Echo')).toBe('on');
  });

  it('dispatches /Fo and /Bl, and their value effects land', async () => {
    const session = await open({
      fields: [
        field('Entry', {
          Fo: 'this.getField("Log").value = "in";',
          Bl: 'this.getField("Log").value = "out";',
        }),
        field('Log'),
      ],
    });
    expect((await session.focus('Entry', '')).values.get('Log')).toBe('in');
    expect((await session.blur('Entry', '')).values.get('Log')).toBe('out');
  });

  it('reports every script as not run when the wasm cannot load', async () => {
    const worker = await realWorker();
    const session = createFieldScriptSession({
      seed: buildSeed({
        fields: [field('A', { C: 'event.value = 1' })],
        calculationOrder: ['A'],
        documentScripts: [],
        numPages: 1,
        filename: 'real.pdf',
        language: 'en-US',
      }),
      wasmUrl: 'file:///no/such/directory/',
      makeWorker: () => worker,
      timeoutMs: 20000,
      bodies: [{ field: 'A', trigger: 'C', js: 'event.value = 1' }],
    });
    live = session;
    const result = await session.open();
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ field: 'A', trigger: 'C', kind: 'error' });
    expect(result.reports[0].detail.startsWith('sandbox: ')).toBe(true);
  });

  it('attributes a thrown script to its field and trigger', async () => {
    const session = await open({
      fields: [field('Boom', { C: 'this.getField("nope").value = 1;' })],
      calculationOrder: ['Boom'],
    });
    const result = await session.commit('Boom', '');
    expect(result.reports.some((r) => r.kind === 'error' && r.field === 'Boom' && r.trigger === 'C')).toBe(
      true,
    );
  });

  it('runs a body naming a refused capability, and the stub really is inert', async () => {
    const session = await open({
      fields: [
        field('Send', { C: 'this.submitForm("https://example.invalid/post"); event.value = "ran";' }),
      ],
      calculationOrder: ['Send'],
    });
    const result = await session.commit('Send', '');
    // The vendored stub does nothing and does not throw, so the statements
    // after it still take effect — the F23 posture, proven against the engine.
    expect(result.values.get('Send')).toBe('ran');
    expect(result.reports.map((r) => `${r.kind}:${r.detail}`)).toContain('refused:submitForm');
  });

  it('walks /CO in the document’s own declared order', async () => {
    const session = await open({
      fields: [
        field('A', undefined, { value: '2' }),
        field('B', { C: 'event.value = Number(this.getField("A").value) * 10;' }),
        field('C', { C: 'event.value = Number(this.getField("B").value) + 1;' }),
      ],
      calculationOrder: ['B', 'C'],
    });
    const result = await session.commit('A', '3');
    expect(result.values.get('B')).toBe('30');
    expect(result.values.get('C')).toBe('31');
  });

  it('hands the host a string value, whatever type the script stored', async () => {
    const session = await open({
      fields: [field('N', { C: 'var a = 1; event.value = a + 1;' })],
      calculationOrder: ['N'],
    });
    const result = await session.commit('N', '');
    // The overlay's display path takes a string; a raw JS number from the
    // object model would draw as nothing.
    expect(typeof result.values.get('N')).toBe('string');
  });
});

// ── a string literal is not Simplified Field Notation ──────────────────────
//
// SFN's factor grammar has no string literal: a quoted token is a field name
// and `event.value` parses as a dotted one. A body assigning a literal is
// therefore ACCEPTED by the recognizer and, routed to the declarative
// evaluator, produces arithmetic over fields that do not exist — the assigned
// string never reaches the document. These bodies belong to the sandbox.

describe('bodies that only look like field notation', () => {
  it('runs a Calculate that assigns a string literal', async () => {
    const session = await open({
      fields: [field('A'), field('T', { C: 'event.value = "N/A";' })],
      calculationOrder: ['T'],
    });
    const result = await session.commit('A', '1');
    expect(result.reports).toEqual([]);
    expect(result.values.get('T')).toBe('N/A');
  });

  it('runs a Format that concatenates a literal onto the value', async () => {
    const session = await open({
      fields: [field('Fee', { F: 'event.value = "$" + event.value;' })],
    });
    const result = await session.commit('Fee', '12');
    expect(result.formatted.get('Fee')).toBe('$12');
  });

  it('runs a Format that assigns a bare literal', async () => {
    const session = await open({
      fields: [field('L', { F: 'event.value = "LITERAL";' })],
    });
    const result = await session.commit('L', '12');
    expect(result.formatted.get('L')).toBe('LITERAL');
  });

  it('leaves a genuine field-notation calculation to the declarative evaluator', async () => {
    // Every name resolves, so the body is never seeded as a Calculate action.
    // The calculation-order walk still reports the field's stored value; what
    // it must not report is a result the sandbox computed from the body.
    const session = await open({
      fields: [
        field('Line Total', undefined, { value: '50' }),
        field('Half', { C: 'event.value = "Line Total" / 2;' }),
      ],
      calculationOrder: ['Half'],
    });
    const result = await session.commit('Line Total', '50');
    expect(result.values.get('Half')).toBe('');
  });
});
