import type { HealthBoundary, HealthFact, HealthKind, HealthSeverity } from './doc-health';

// The engine boundary's reply, parsed into ledger facts.
//
// The reply is DATA from another process, so every field is checked rather
// than trusted: a row whose shape is wrong is kept as an unrecognized fact
// rather than dropped, because a fact silently thrown away is the ledger
// reporting a document as cleaner than the engine found it.
//
// Page numbers cross the boundary 1-BASED (the engine's own convention, and
// what every engine report prints); the ledger stores a 0-based INDEX, which
// is what the panel resolves against the current page list. Ids never cross:
// the engine has no notion of the renderer's generation-tagged page ids, and
// a stored one could re-bind to a different physical page after any commit.

const KINDS: readonly HealthKind[] = ['recovered', 'font', 'skipped', 'undetermined'];
const SEVERITIES: readonly HealthSeverity[] = ['info', 'warning'];
const BOUNDARIES: readonly HealthBoundary[] = ['pdfjs', 'qpdf', 'engine'];

export interface EngineHealthReply {
  /** False when the reply was not the shape this build knows. The caller
   * records a FAILED run for it, which is `undetermined` — an unparseable
   * answer must never read as a clean one. */
  readonly ok: boolean;
  /** 'collected' when every traversal on the engine side ran to the end. */
  readonly status: 'collected' | 'undetermined';
  readonly facts: readonly HealthFact[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function params(value: unknown): Record<string, string | number> {
  const raw = asRecord(value);
  if (!raw) return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

function parseFact(value: unknown): HealthFact {
  const raw = asRecord(value) ?? {};
  const kind = raw.kind as HealthKind;
  const severity = raw.severity as HealthSeverity;
  const boundary = raw.boundary as HealthBoundary;
  const code = typeof raw.code === 'string' ? raw.code : '';
  const number = typeof raw.page === 'number' && Number.isInteger(raw.page) ? raw.page : null;
  return {
    // An unrecognized kind is `undetermined`, never a benign one: a fact this
    // build cannot classify must not be able to leave a verdict healthy.
    kind: KINDS.includes(kind) ? kind : 'undetermined',
    severity: SEVERITIES.includes(severity) ? severity : 'warning',
    boundary: BOUNDARIES.includes(boundary) ? boundary : 'engine',
    code,
    page: number !== null && number > 0 ? number - 1 : null,
    params: params(raw.params),
  };
}

const STATUSES: readonly string[] = ['collected', 'undetermined'];

/** Parse a `document_health` reply.
 *
 * A reply whose `status` is missing or is not one of the enumerated values is
 * NOT ok: the engine states whether its traversals ran to the end, and a reply
 * that does not state it cannot be read as one that ran to the end. */
export function parseEngineHealth(result: unknown): EngineHealthReply {
  const raw = asRecord(result);
  const stated = typeof raw?.status === 'string' && STATUSES.includes(raw.status);
  const ok = raw !== null && Array.isArray(raw.facts) && stated;
  const facts = ok ? (raw!.facts as unknown[]).map(parseFact) : [];
  const status = stated && raw!.status === 'collected' ? 'collected' : 'undetermined';
  return { ok, status, facts };
}

// The STEPPED sweep.
//
// The engine answers `document_health` in one request, and that spelling is
// still the one a test or the CLI uses. The renderer does not use it: one
// request is one unbounded traversal handed to a FIFO that cannot be
// preempted, so a user operation arriving during it waits for the whole
// document. The stepped spelling is what the idle lane can interleave with —
// begin, then a bounded batch per step, each submitted only while the engine
// is idle.
//
// The token is engine-side state, so it is ENDED on every exit that is not
// `done`: a superseded run, a reply this build cannot parse, a step that
// throws. An abandoned token holds an open file handle in the engine until it
// is evicted.

interface HealthChunk {
  readonly ok: boolean;
  readonly token: string;
  readonly done: boolean;
  readonly pages: number;
  readonly status: 'collected' | 'undetermined';
  readonly facts: readonly HealthFact[];
}

function parseChunk(result: unknown): HealthChunk {
  const raw = asRecord(result);
  const base = parseEngineHealth(result);
  return {
    ok: base.ok && typeof raw?.done === 'boolean',
    token: typeof raw?.token === 'string' ? raw.token : '',
    done: raw?.done === true,
    pages: typeof raw?.pages === 'number' && Number.isInteger(raw.pages) ? raw.pages : 0,
    status: base.status,
    facts: base.facts,
  };
}

const UNREADABLE: EngineHealthReply = { ok: false, status: 'undetermined', facts: [] };

/** Engine dispatch, WITHOUT the queue or the commit gate — the sweep is a
 * passive read of the working copy the ledger files its row under. */
export type HealthDispatch = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Drive one document's health sweep a bounded step at a time.
 *
 * Every engine request goes through `gate`, which is what holds the lane's
 * invariant: a user request arriving mid-sweep waits for at most the step
 * already in flight.
 */
export async function runHealthSweep(
  dispatch: HealthDispatch,
  file: string,
  gate: <R>(send: () => Promise<R>) => Promise<R>,
): Promise<EngineHealthReply> {
  const begun = parseChunk(await gate(() => dispatch('document_health_begin', { file })));
  if (!begun.ok) return UNREADABLE;
  const facts: HealthFact[] = [...begun.facts];
  let status = begun.status;
  if (begun.done || !begun.token) return { ok: true, status, facts };

  const token = begun.token;
  let finished = false;
  try {
    // The engine ends every run; the cap only stops a reply that never says
    // `done` from looping here forever, and is itself an unparseable answer.
    const cap = begun.pages + 8;
    for (let step = 0; step <= cap; step += 1) {
      const chunk = parseChunk(await gate(() => dispatch('document_health_step', { token })));
      if (!chunk.ok) return UNREADABLE;
      facts.push(...chunk.facts);
      if (chunk.status === 'undetermined') status = 'undetermined';
      if (chunk.done) {
        finished = true;
        return { ok: true, status, facts };
      }
    }
    return UNREADABLE;
  } finally {
    if (!finished) {
      // NOT through the gate: this is the run's own cleanup, it is one
      // bounded request, and gating it would abandon the token exactly in the
      // case the token most needs releasing.
      void dispatch('document_health_end', { token }).catch(() => undefined);
    }
  }
}
