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

/** Parse a `document_health` reply. */
export function parseEngineHealth(result: unknown): EngineHealthReply {
  const raw = asRecord(result);
  const ok = raw !== null && Array.isArray(raw.facts);
  const facts = ok ? (raw!.facts as unknown[]).map(parseFact) : [];
  const status = raw?.status === 'collected' ? 'collected' : 'undetermined';
  return { ok, status, facts };
}
