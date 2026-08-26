// The QuickJS field-script sandbox, off the render thread.
//
// WHY A WORKER: the interpreter's entry point is a SYNCHRONOUS `ccall` into
// WebAssembly and exposes no interrupt handler, so a field script with an
// unterminated loop hangs whatever thread dispatched it. On the render thread
// that is an unrecoverable freeze of the app. Here it costs one worker, which
// the host terminates on its deadline — the same watchdog shape, for the same
// reason, as `search/search.worker.ts`.
//
// Nothing vendored is patched. `SandboxSupportBase` reads `this.win` at CALL
// time, so replacing `sandbox.support.win` after construction redirects every
// host effect the sandbox can reach: alerts become messages the app draws its
// own dialog for, confirm/prompt refuse rather than block, and the outgoing
// `send` never dispatches a DOM event.
import type {
  SandboxMessage,
  WorkerRequest,
  WorkerResponse,
} from './field-js-protocol';

interface VendoredSandbox {
  support: { win: unknown } | null;
  create: (data: unknown) => void;
  dispatchEvent: (event: unknown) => void;
  nukeSandbox: () => void;
}

const ctx = self as unknown as {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
};

let sandbox: VendoredSandbox | null = null;
let collected: SandboxMessage[] | null = null;
const timers = new Set<ReturnType<typeof setTimeout>>();

function emit(message: SandboxMessage): void {
  if (collected) collected.push(message);
  else ctx.postMessage({ type: 'emit', messages: [message] });
}

/** A field value as the protocol declares it. The object model stores whatever
 * a script assigned, so `event.value = a + 1` arrives as a JS number; the
 * display path takes a string and draws nothing for anything else. */
function normalizeValue(value: unknown): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return value;
  return String(value);
}

/** Classify one outgoing payload from the object model. `_send` emits either a
 * field update (it carries an `id`) or a command; the command vocabulary is
 * small and everything outside it is reported rather than acted on. */
function classify(detail: Record<string, unknown>): SandboxMessage {
  if (typeof detail.command === 'string') {
    if (detail.command === 'error') {
      return { kind: 'error', text: String(detail.value ?? '') };
    }
    if (detail.command === 'alert') {
      return { kind: 'alert', text: String(detail.value ?? '') };
    }
    if (detail.command === 'print') {
      return { kind: 'refused', capability: 'print' };
    }
    return { kind: 'other', command: detail.command };
  }
  if (typeof detail.id === 'string') {
    return {
      kind: 'value',
      id: detail.id,
      value: normalizeValue(detail.value),
      formattedValue: detail.formattedValue == null ? undefined : String(detail.formattedValue),
      selRange: detail.selRange as [number, number] | undefined,
      focus: detail.focus === true,
    };
  }
  return { kind: 'other', command: 'unknown' };
}

/** The window the sandbox's externals see. Every member the vendored externals
 * table touches is here and nothing else is reachable. */
function hostShim(): Record<string, unknown> {
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn: () => void, ms: number) => {
      const id = setInterval(fn, ms) as unknown as ReturnType<typeof setTimeout>;
      timers.add(id);
      return id;
    },
    clearInterval: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id);
      clearInterval(id as unknown as ReturnType<typeof setInterval>);
    },
    // `app.alert` reaches here. It becomes a message the render thread draws
    // with the app's own dialog component — never a platform alert, which in a
    // worker does not exist and on the render thread would be unstyled and
    // unclosable by the app.
    alert: (text: string) => {
      emit({ kind: 'alert', text: String(text) });
    },
    // A field script does not get to block a fill on a modal question.
    confirm: () => false,
    prompt: () => null,
    URL,
    // The vendored `send` builds a CustomEvent and dispatches it on `win`.
    // Both ends are ours, so the payload is read straight off the event and no
    // event is ever dispatched anywhere.
    CustomEvent: class {
      detail: unknown;
      constructor(_name: string, init?: { detail?: unknown }) {
        this.detail = init?.detail;
      }
    },
    dispatchEvent: (event: { detail?: unknown }) => {
      const detail = event?.detail;
      if (detail && typeof detail === 'object') {
        emit(classify(detail as Record<string, unknown>));
      }
      return true;
    },
    console: {
      error: (text: unknown) => emit({ kind: 'error', text: String(text) }),
      log: () => undefined,
      warn: () => undefined,
    },
  };
}

async function init(wasmUrl: string, seed: unknown): Promise<void> {
  // The vendored factory constructs `new Sandbox(window, module)` by name, and
  // a worker has no `window`. Aliasing it to the worker global is what lets
  // the unmodified module load here; the shim below replaces the reference the
  // externals actually read.
  (globalThis as unknown as { window: unknown }).window = globalThis;
  const { QuickJSSandbox } = (await import('pdfjs-dist/build/pdf.sandbox.mjs')) as unknown as {
    QuickJSSandbox: (wasmUrl?: string) => Promise<VendoredSandbox>;
  };
  const created = await QuickJSSandbox(wasmUrl);
  if (created.support) created.support.win = hostShim();
  created.create(seed);
  sandbox = created;
}

function dispose(): void {
  for (const id of timers) clearTimeout(id);
  timers.clear();
  try {
    sandbox?.nukeSandbox();
  } catch {
    // A sandbox that failed to start has nothing to nuke.
  }
  sandbox = null;
}

// Loading the interpreter is asynchronous (a dynamic import plus a wasm
// compile) and the host posts `init` and the document `Open` dispatch in one
// tick, so a dispatch handled as it arrives would find no sandbox and answer
// with nothing — silently losing the pass that evaluates the document-level
// declarations every custom calculation calls into. Every dispatch therefore
// queues behind the load, and behind each other, which is also what keeps the
// object model's synchronous dispatches in the order the host sent them.
let queue: Promise<void> = Promise.resolve();

function serialize(work: () => void): void {
  queue = queue.then(work, work);
}

ctx.onmessage = ({ data }): void => {
  if (data.type === 'init') {
    queue = init(data.wasmUrl, data.seed).then(
      () => ctx.postMessage({ type: 'ready', ok: true }),
      (error: unknown) =>
        ctx.postMessage({
          type: 'ready',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }
  if (data.type === 'dispatch') {
    // Everything the object model emits during the synchronous dispatch is
    // collected and answered with the request, so the host correlates a value
    // with the event that produced it. Timer-driven emissions arrive later,
    // unsolicited.
    serialize(() => {
      const messages: SandboxMessage[] = [];
      collected = messages;
      try {
        sandbox?.dispatchEvent(data.event);
      } catch (error: unknown) {
        messages.push({
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        collected = null;
      }
      ctx.postMessage({ type: 'done', id: data.id, messages });
    });
    return;
  }
  serialize(dispose);
};
