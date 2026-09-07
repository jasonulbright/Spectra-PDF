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
// request is one traversal that runs to the end, so a run superseded part-way
// — the document changed, the user re-checked — cannot be dropped before the
// worker has finished paying for it. The stepped spelling is what supersession
// acts on: begin, a bounded step at a time, and a run abandoned at any step
// boundary stops costing anything.
//
// The token is engine-side state, so it is ENDED on every exit that is not
// `done`: a superseded run, a reply this build cannot parse, a step that
// throws, and a BEGIN this build refused — a rejected begin can still have
// opened a document, and its token is the only handle that closes it. An
// abandoned token holds an open file handle in the worker until it is evicted.

interface BeginReply {
  /** False when the reply was not the shape this build knows. A begin that
   * does not state its own contract is `failed`, never an empty clean sweep. */
  readonly ok: boolean;
  readonly token: string;
  readonly done: boolean;
  readonly pages: number;
  readonly status: 'collected' | 'undetermined';
  readonly facts: readonly HealthFact[];
}

interface StepReply {
  readonly ok: boolean;
  readonly done: boolean;
  readonly status: 'collected' | 'undetermined';
  readonly facts: readonly HealthFact[];
}

/** A page count this build will act on: an integer, non-negative, and small
 * enough that arithmetic on it stays exact. A negative one sizes the step cap
 * below zero, so the sweep would exit on its first pass reporting whatever the
 * begin happened to carry. */
function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** The token a reply carries, whether or not the rest of it parsed.
 *
 * A REJECTED begin can still have opened a document on the engine side, and
 * the token is the only handle that closes it. Salvaging it is what makes the
 * refusal free of a leaked file handle. */
export function salvageToken(result: unknown): string {
  const raw = asRecord(result);
  return typeof raw?.token === 'string' ? raw.token : '';
}

/**
 * Parse a `document_health_begin` reply against its contract.
 *
 * `done` false is a run to step, and it MUST carry the two things stepping
 * needs: a non-empty token and a page count. `done` true is a terminal answer,
 * and it MUST carry no token — a terminal reply holding one is either a run
 * this build would never end or a reply from something that is not this
 * protocol, and both are `failed`.
 */
export function parseBegin(result: unknown): BeginReply {
  const raw = asRecord(result);
  const base = parseEngineHealth(result);
  const done = raw?.done;
  const token = typeof raw?.token === 'string' ? raw.token : '';
  const pages = safeCount(raw?.pages);
  const shaped =
    base.ok &&
    typeof done === 'boolean' &&
    (done ? token === '' : token !== '' && pages !== null);
  return {
    ok: shaped,
    token,
    done: done === true,
    pages: pages ?? 0,
    status: base.status,
    facts: base.facts,
  };
}

/**
 * Parse a `document_health_step` reply against the token that was issued.
 *
 * The token is checked, not read: a step reply naming a different run is an
 * answer about a document this sweep did not ask about, and folding its facts
 * into this ledger row would file one document's findings under another's.
 */
export function parseStep(result: unknown, expected: string): StepReply {
  const raw = asRecord(result);
  const base = parseEngineHealth(result);
  const done = raw?.done;
  return {
    ok: base.ok && typeof done === 'boolean' && raw?.token === expected,
    done: done === true,
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

/** Close an engine-side run, best effort.
 *
 * NOT through the gate: this is the run's own cleanup, it is one bounded
 * request, and gating it would abandon the token exactly in the case the token
 * most needs releasing. */
function endRun(dispatch: HealthDispatch, token: string): void {
  if (!token) return;
  void dispatch('document_health_end', { token }).catch(() => undefined);
}

// Steps a sweep will take before it calls the reply stream broken. The engine
// ends every run itself; this only stops a reply that never says `done` from
// looping forever, and reaching it IS an unparseable answer.
//
// Sized off the page count, because a page can suspend part-way and resume, so
// the count of steps is a MULTIPLE of the count of pages rather than equal to
// it. The multiplier is the engine's own worst case with margin: one page can
// cost at most its object cap (`document_health.py` `_MAX_RESOURCE_OBJECTS`)
// worth of items, spent `_STEP_OBJECTS` at a time, which is eight steps, plus
// the page's own start and its font leg.
const STEP_CAP_PER_PAGE = 16;
const STEP_CAP_FLOOR = 128;

/**
 * Drive one document's health sweep a bounded step at a time.
 *
 * Every engine request goes through `gate`, which serialises this run against
 * the other background runs.
 *
 * Any violation of the begin/step contract is `failed` — which the ledger
 * records as undetermined — and the engine-side run is ended on every exit
 * that is not `done`, including the ones this build refused to parse.
 */
export async function runHealthSweep(
  dispatch: HealthDispatch,
  file: string,
  gate: <R>(send: () => Promise<R>) => Promise<R>,
): Promise<EngineHealthReply> {
  const raw = await gate(() => dispatch('document_health_begin', { file }));
  const begun = parseBegin(raw);
  if (!begun.ok) {
    endRun(dispatch, salvageToken(raw));
    return UNREADABLE;
  }
  const facts: HealthFact[] = [...begun.facts];
  if (begun.done) return { ok: true, status: begun.status, facts };

  const token = begun.token;
  let status = begun.status;
  let finished = false;
  try {
    const cap = Math.max(begun.pages * STEP_CAP_PER_PAGE, STEP_CAP_FLOOR);
    for (let step = 0; step < cap; step += 1) {
      const chunk = parseStep(
        await gate(() => dispatch('document_health_step', { token })),
        token,
      );
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
    if (!finished) endRun(dispatch, token);
  }
}

// WHICH SIDECAR a request goes to, decided structurally rather than by which
// caller remembered. Health work runs in its own killable worker process; a
// health method reaching the interactive sidecar would put an inspection back
// into the FIFO the user's operations wait in, which is the whole reason the
// second process exists.
const HEALTH_METHODS: ReadonlySet<string> = new Set([
  'document_health',
  'document_health_begin',
  'document_health_step',
  'document_health_end',
]);

export function isHealthMethod(method: string): boolean {
  return HEALTH_METHODS.has(method);
}
