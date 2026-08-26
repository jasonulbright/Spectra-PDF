// Render-thread half of the field-script sandbox.
//
// Owns the worker's life, the deadline that is the only way to stop a runaway
// script, and the translation in both directions: this app's `FormField` shape
// into the object model's seed, and the object model's outgoing `{id, value}`
// back into field names the overlay can draw.
//
// Only the renderer imports this. The Python engine, the CLI, the guided
// actions and the batch arms have no JavaScript engine in their process and
// gain none — the headless arms never execute a field script, structurally
// rather than by a check.
import {
  JS_TRIGGERS,
  isDeclarative,
  refusedCapabilities,
  type JsTrigger,
  type ScriptRunReport,
} from './field-js-policy';
import type {
  FieldScriptWorkerLike,
  SandboxEvent,
  SandboxFieldSeed,
  SandboxMessage,
  SandboxSeed,
  WorkerResponse,
} from './field-js-protocol';
import type { FormField, FormFieldType, FormFieldValue } from './forms';

/** How long one dispatch may run before the worker is assumed hung and killed.
 * A real field script is sub-millisecond; anything near this is a loop that
 * does not terminate, not a slow document. */
export const SCRIPT_TIMEOUT_MS = 2000;

/** The object model's event names, keyed by this app's `/AA` trigger. */
const EVENT_NAME: Record<JsTrigger, string> = {
  K: 'Keystroke',
  F: 'Format',
  V: 'Validate',
  C: 'Calculate',
  Fo: 'Focus',
  Bl: 'Blur',
};

/** The object model's type vocabulary, keyed by this app's field type. */
const SANDBOX_TYPE: Record<FormFieldType, string> = {
  text: 'text',
  checkbox: 'checkbox',
  radio: 'radiobutton',
  dropdown: 'combobox',
  optionlist: 'listbox',
  button: 'button',
  signature: 'signature',
};

/** The conventional on-state, used only when the widget carries no `/AP` `/N`
 * to read the document's own from. */
const CHECKBOX_ON = 'Yes';
const CHECKBOX_OFF = 'Off';

/** What this document stores when the box is checked. Read from the field's
 * own appearance states, because a script comparing `getField("cb").value` to
 * `"1"` is comparing against the name the FILE uses, not a convention. */
function checkboxOn(field: FormField): string {
  return field.exportValue && field.exportValue !== CHECKBOX_OFF
    ? field.exportValue
    : CHECKBOX_ON;
}

function seedValue(field: FormField): string | string[] {
  const v = field.value;
  if (typeof v === 'boolean') return v ? checkboxOn(field) : CHECKBOX_OFF;
  if (Array.isArray(v)) return v;
  return v;
}

/** One field's `/AA` bodies under the object model's event names — CUSTOM
 * bodies only. A declarative body is `af-calc`'s and never reaches the
 * sandbox, so seeding one here would run it twice under two evaluators. */
function seedActions(field: FormField): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const actions = field.actions;
  if (!actions) return out;
  for (const trigger of JS_TRIGGERS) {
    const js = actions[trigger];
    if (typeof js !== 'string' || js.trim() === '') continue;
    if (isDeclarative(js)) continue;
    out[EVENT_NAME[trigger]] = [js];
  }
  return out;
}

export interface SeedInput {
  fields: readonly FormField[];
  /** The document's `/CO`, as field names in its declared order. */
  calculationOrder: readonly string[];
  /** `/Names /JavaScript` bodies in name-tree order. */
  documentScripts: readonly string[];
  numPages: number;
  filename: string;
  language: string;
}

/** Build the object model's whole world from one read of a document. Pure. */
export function buildSeed(input: SeedInput): SandboxSeed {
  const objects: Record<string, SandboxFieldSeed[]> = {};
  for (const field of input.fields) {
    const page = field.widgets[0]?.pageIndex ?? 0;
    const seed: SandboxFieldSeed = {
      id: field.name,
      name: field.name,
      type: SANDBOX_TYPE[field.type],
      value: seedValue(field),
      defaultValue: seedValue(field),
      page,
      hidden: field.widgets.length > 0 && field.widgets.every((w) => w.hidden),
      readonly: field.readOnly,
      required: field.required,
      ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
      editable: field.editable,
      ...(field.options
        ? {
            items: field.options.map((o) => ({ displayValue: o, exportValue: o })),
            exportValues:
              field.type === 'checkbox' ? [CHECKBOX_OFF, checkboxOn(field)] : field.options,
          }
        : field.type === 'checkbox'
          ? { exportValues: [CHECKBOX_OFF, checkboxOn(field)] }
          : {}),
      actions: seedActions(field),
    };
    objects[field.name] = [seed];
  }
  // Document-level scripts ride the `Open` document action, in name-tree
  // order, which is where the reference implementation evaluates them: a field
  // action calling `FormatMoneyField(...)` needs that declaration in the same
  // global scope, and the corpus shows that shape dominating custom
  // calculations.
  const documentScripts = input.documentScripts.filter((s) => s.trim() !== '');
  return {
    objects,
    // `/CO` names only fields we actually seeded; an order entry naming a
    // field this read does not carry would silently stall the walk.
    calculationOrder: input.calculationOrder.filter((name) => name in objects),
    docInfo: {
      actions: documentScripts.length > 0 ? { Open: documentScripts } : {},
      numPages: input.numPages,
      filename: input.filename,
    },
    appInfo: { platform: 'Win', language: input.language },
  };
}

/** What one dispatch produced. Values are DERIVED: the caller layers them over
 * what the user typed and never writes them into the pending map, because a
 * calculated Total is routinely read-only and the fill names what that map
 * holds. */
export interface DispatchResult {
  /** fieldName -> the raw value the script stored. */
  values: Map<string, FormFieldValue>;
  /** fieldName -> the display string its Format action produced. */
  formatted: Map<string, string>;
  /** `app.alert` texts, in the order the scripts raised them. */
  alerts: string[];
  /** Scripts that could not produce a value, and why. */
  reports: ScriptRunReport[];
  /** Fields whose COMMIT the document's own validation refused. The object
   * model marks exactly this case by asking for focus back, and nothing else
   * sets that flag; a refused value must never reach the pending map the fill
   * names. */
  rejected: Set<string>;
  /** True when the watchdog killed the worker rather than the script finishing. */
  timedOut: boolean;
}

function emptyResult(): DispatchResult {
  return {
    values: new Map(),
    formatted: new Map(),
    alerts: [],
    reports: [],
    rejected: new Set(),
    timedOut: false,
  };
}

/** What a single edit turned `prev` into, as the object model's keystroke event
 * describes it: the inserted text and the pre-change selection it replaced.
 * Reconstructed from the two strings because a controlled `<input>`'s change
 * event reports the result, never the delta. One edit at a time is the only
 * shape a keystroke event can express, which is also the only shape typing,
 * pasting or deleting in one gesture produces. */
export function describeChange(
  prev: string,
  next: string,
): { change: string; selStart: number; selEnd: number } {
  let head = 0;
  const max = Math.min(prev.length, next.length);
  while (head < max && prev[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < max - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    change: next.slice(head, next.length - tail),
    selStart: head,
    selEnd: prev.length - tail,
  };
}

export type FieldScriptWorkerFactory = () => FieldScriptWorkerLike | null;

export const defaultFieldScriptWorkerFactory: FieldScriptWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./field-js.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as FieldScriptWorkerLike;
};

export interface FieldScriptSessionOptions {
  seed: SandboxSeed;
  /** Absolute URL of the directory holding `quickjs-eval.js`. */
  wasmUrl: string;
  makeWorker?: FieldScriptWorkerFactory;
  timeoutMs?: number;
  /** The raw bodies, by field and trigger, so a timeout can name the script
   * that hung and a refused capability can be attributed to one. */
  bodies?: readonly { field: string; trigger: JsTrigger; js: string }[];
}

export interface FieldScriptSession {
  /** A value was typed but not committed — keystroke, no validate. */
  keystroke: (field: string, value: string, change: string, selStart: number, selEnd: number) => Promise<DispatchResult>;
  /** A value was committed — keystroke(willCommit) drives validate, store,
   * calculate and format inside the object model, in that order. */
  commit: (field: string, value: FormFieldValue) => Promise<DispatchResult>;
  focus: (field: string, value: FormFieldValue) => Promise<DispatchResult>;
  blur: (field: string, value: FormFieldValue) => Promise<DispatchResult>;
  /** The document `Open` event: evaluates the document-level declarations and
   * runs the initial format pass. Run once, after seeding. */
  open: () => Promise<DispatchResult>;
  dispose: () => void;
}

/** The seed's own on-state per field, so a boolean the overlay hands back
 * becomes the string this document stores rather than the convention. */
function onStates(seed: SandboxSeed): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, seeds] of Object.entries(seed.objects)) {
    const first = seeds[0];
    if (first?.type !== 'checkbox') continue;
    const on = first.exportValues?.[1];
    if (typeof on === 'string') out.set(name, on);
  }
  return out;
}

/** Attribute an object-model error string to a field and trigger. The vendored
 * dispatcher prefixes them `Error when executing "<Event>" for field "<id>"`,
 * which is the only structured thing in the text; anything else is reported
 * against the document rather than guessed at. */
function attributeError(text: string): { field: string; trigger: JsTrigger } | null {
  const m = /^Error when executing "([^"]+)" for field "([^"]*)"/.exec(text);
  if (!m) return null;
  const trigger = (Object.keys(EVENT_NAME) as JsTrigger[]).find((t) => EVENT_NAME[t] === m[1]);
  if (!trigger) return null;
  return { field: m[2], trigger };
}

export function createFieldScriptSession(
  options: FieldScriptSessionOptions,
): FieldScriptSession {
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const makeWorker = options.makeWorker ?? defaultFieldScriptWorkerFactory;
  const bodies = options.bodies ?? [];
  let worker: FieldScriptWorkerLike | null = null;
  let seq = 0;
  let disposed = false;
  const exportOf = onStates(options.seed);
  // The interpreter loads asynchronously (a dynamic import plus a wasm
  // compile). Every dispatch waits on the load's verdict before it is posted,
  // so the deadline measures the SCRIPT rather than the load, and a load that
  // failed is answered as a named not-run instead of silence.
  let ready: Promise<{ ok: boolean; error: string }> | null = null;
  const pending = new Map<
    number,
    { resolve: (messages: SandboxMessage[] | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  // Emissions that arrived outside a dispatch (a script's own setTimeout) are
  // folded into the next result rather than dropped: they are the same class of
  // value and the overlay has nowhere else to receive them.
  let unsolicited: SandboxMessage[] = [];

  function kill(): void {
    const victims = [...pending.values()];
    pending.clear();
    for (const entry of victims) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    // Whatever a dying worker's timers emitted belongs to the sandbox that is
    // going away: carrying it into the next dispatch would attribute values
    // from a stale seed to a different event.
    unsolicited = [];
    ready = null;
    worker?.terminate();
    worker = null;
  }

  function ensureWorker(): FieldScriptWorkerLike | null {
    if (worker) return worker;
    if (disposed) return null;
    let created: FieldScriptWorkerLike | null;
    try {
      created = makeWorker();
    } catch {
      created = null;
    }
    if (!created) return null;
    let settle: (state: { ok: boolean; error: string }) => void = () => undefined;
    ready = new Promise((resolve) => {
      settle = resolve;
    });
    created.onmessage = ({ data }: { data: WorkerResponse }): void => {
      if (data.type === 'ready') {
        settle(data.ok ? { ok: true, error: '' } : { ok: false, error: data.error });
        return;
      }
      if (data.type === 'emit') {
        unsolicited.push(...data.messages);
        return;
      }
      if (data.type !== 'done') return;
      const entry = pending.get(data.id);
      if (!entry) return; // a response that outlived its deadline
      pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve(data.messages);
    };
    worker = created;
    // The seed goes with the build: a worker that was killed and rebuilt must
    // start from the document again, never from a half-state.
    created.postMessage({ type: 'init', wasmUrl: options.wasmUrl, seed: options.seed });
    return worker;
  }

  /** A load that never produced an interpreter, reported against every script
   * the document carries: the panel's job is to say which scripts did not run
   * and why, and "all of them, the sandbox did not start" is the answer. */
  function loadFailureResult(error: string, event: SandboxEvent): DispatchResult {
    const result = emptyResult();
    const detail = `sandbox: ${error}`;
    if (bodies.length > 0) {
      for (const body of bodies) {
        result.reports.push({ field: body.field, trigger: body.trigger, kind: 'error', detail });
      }
    } else {
      result.reports.push({ field: event.id, trigger: 'C', kind: 'error', detail });
    }
    return result;
  }

  function collect(messages: SandboxMessage[] | null, event: SandboxEvent): DispatchResult {
    const result = emptyResult();
    if (messages === null) {
      result.timedOut = true;
      // The dispatch that hung is the one whose script did not return. Name it
      // by the field and trigger the event carried — that is the only thing
      // known for certain about a worker that never answered.
      const trigger = (Object.keys(EVENT_NAME) as JsTrigger[]).find(
        (t) => EVENT_NAME[t] === event.name,
      );
      result.reports.push({
        field: event.id,
        trigger: trigger ?? 'C',
        kind: 'timeout',
        detail: String(timeoutMs),
      });
      return result;
    }
    for (const message of messages) {
      switch (message.kind) {
        case 'value': {
          if (message.value !== undefined) {
            result.values.set(message.id, message.value as FormFieldValue);
          }
          if (typeof message.formattedValue === 'string') {
            result.formatted.set(message.id, message.formattedValue);
          }
          // The object model asks for focus back on exactly one path: a
          // Validate that returned false on a committing keystroke. The empty
          // value it sends with it is the refusal, not a computed result.
          if (message.focus === true) result.rejected.add(message.id);
          break;
        }
        case 'alert':
          result.alerts.push(message.text);
          break;
        case 'error': {
          const where = attributeError(message.text);
          result.reports.push({
            field: where?.field ?? event.id,
            trigger: where?.trigger ?? 'C',
            kind: 'error',
            detail: message.text,
          });
          break;
        }
        case 'refused':
          result.reports.push({
            field: event.id,
            trigger: 'C',
            kind: 'refused',
            detail: message.capability,
          });
          break;
        default:
          break;
      }
    }
    return result;
  }

  function eventValue(field: string, value: FormFieldValue): string | string[] {
    if (typeof value === 'boolean') {
      return value ? (exportOf.get(field) ?? CHECKBOX_ON) : CHECKBOX_OFF;
    }
    return value;
  }

  /** Refusals are a REPORT over the source, not a gate: the vendored object
   * model already stubs every one of these to do nothing, so the body runs and
   * its other statements still take effect. Reporting them here is what makes
   * the incapability visible instead of silent. */
  function staticRefusals(field: string): ScriptRunReport[] {
    const out: ScriptRunReport[] = [];
    for (const body of bodies) {
      if (body.field !== field) continue;
      const refused = refusedCapabilities(body.js);
      if (refused.length > 0) {
        out.push({
          field: body.field,
          trigger: body.trigger,
          kind: 'refused',
          detail: refused.join(', '),
        });
      }
    }
    return out;
  }

  async function dispatch(event: SandboxEvent): Promise<DispatchResult> {
    const w = ensureWorker();
    if (!w) return emptyResult();
    // Wait for the load's verdict rather than posting into a sandbox that does
    // not exist yet: the first dispatch on a fresh worker is the document
    // `Open` pass, and losing it loses every document-level helper the field
    // scripts call.
    const state = await (ready ?? Promise.resolve({ ok: true, error: '' }));
    if (!state.ok) return loadFailureResult(state.error, event);
    if (disposed || worker !== w) return emptyResult();
    const id = ++seq;
    const messages = await new Promise<SandboxMessage[] | null>((resolve) => {
      const timer = setTimeout(kill, timeoutMs);
      pending.set(id, { resolve, timer });
      w.postMessage({ type: 'dispatch', id, event });
    });
    const carried = unsolicited;
    unsolicited = [];
    const result = collect(messages === null ? null : [...carried, ...messages], event);
    if (event.id !== 'doc') result.reports.push(...staticRefusals(event.id));
    return result;
  }

  return {
    keystroke: (field, value, change, selStart, selEnd) =>
      dispatch({
        id: field,
        name: 'Keystroke',
        value,
        change,
        changeEx: undefined,
        selStart,
        selEnd,
        willCommit: false,
      }),
    commit: (field, value) =>
      dispatch({
        id: field,
        name: 'Keystroke',
        value: eventValue(field, value),
        change: '',
        selStart: -1,
        selEnd: -1,
        willCommit: true,
      }),
    focus: (field, value) =>
      dispatch({ id: field, name: 'Focus', value: eventValue(field, value) }),
    blur: (field, value) => dispatch({ id: field, name: 'Blur', value: eventValue(field, value) }),
    open: () => dispatch({ id: 'doc', name: 'Open' }),
    dispose() {
      disposed = true;
      ready = null;
      unsolicited = [];
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      try {
        worker?.postMessage({ type: 'dispose' });
      } catch {
        // A worker already terminated has nothing to dispose.
      }
      worker?.terminate();
      worker = null;
    },
  };
}
