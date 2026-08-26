// The message contract between the render thread and the field-script worker.
// Shared by `field-js-host.ts` and `field-js.worker.ts`, and by the fake
// worker the host's tests drive — so a change to the shape breaks compilation
// on every side at once.

/** A field as the sandbox's object model wants to see it. Field NAME is the
 * id: names are unique in a read of one document, and every message that comes
 * back out carries an id we have to resolve to a field again. */
export interface SandboxFieldSeed {
  id: string;
  name: string;
  /** The object model's own type vocabulary, not this app's `FormFieldType`. */
  type: string;
  value: string | string[];
  defaultValue: string | string[];
  page: number;
  hidden: boolean;
  readonly: boolean;
  required: boolean;
  multiline?: boolean;
  editable?: boolean;
  items?: { displayValue: string; exportValue: string }[];
  exportValues?: string[];
  /** `/AA` bodies keyed by the object model's event names (Keystroke, Format,
   * Validate, Calculate, Focus, Blur), each a list of sources. */
  actions: Record<string, string[]>;
}

export interface SandboxSeed {
  /** fieldName -> its one seed object. */
  objects: Record<string, SandboxFieldSeed[]>;
  /** `/CO` as field names, in the document's declared order. */
  calculationOrder: string[];
  docInfo: {
    /** Document-level `/Names /JavaScript` bodies, in name-tree order, under
     * the object model's `Open` document action — the same place the reference
     * implementation puts them, so a field action can call a helper the
     * document defines. */
    actions: Record<string, string[]>;
    numPages: number;
    filename: string;
  };
  appInfo: { platform: string; language: string };
}

/** One event as the object model's dispatcher expects it. */
export interface SandboxEvent {
  id: string;
  name: string;
  value?: string | string[];
  change?: string;
  changeEx?: string | string[];
  selStart?: number;
  selEnd?: number;
  willCommit?: boolean;
  shift?: boolean;
  modifier?: boolean;
  pageNumber?: number;
  actions?: Record<string, string[]>;
}

/** What the sandbox sends back out. Every shape the vendored object model can
 * emit is one of these; anything unrecognized is reported, never acted on. */
export type SandboxMessage =
  | { kind: 'value'; id: string; value?: string | string[]; formattedValue?: string | null; selRange?: [number, number]; focus?: boolean }
  | { kind: 'alert'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'refused'; capability: string }
  | { kind: 'other'; command: string };

export type WorkerRequest =
  | { type: 'init'; wasmUrl: string; seed: SandboxSeed }
  | { type: 'dispatch'; id: number; event: SandboxEvent }
  | { type: 'dispose' };

export type WorkerResponse =
  | { type: 'ready'; ok: true }
  | { type: 'ready'; ok: false; error: string }
  | { type: 'done'; id: number; messages: SandboxMessage[] }
  | { type: 'emit'; messages: SandboxMessage[] };

/** The subset of `Worker` this code uses — so the host takes a fake in tests
 * without a DOM (the `search-worker-client.ts` shape). */
export interface FieldScriptWorkerLike {
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
}
