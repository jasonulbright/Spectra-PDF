// The document-health LEDGER: what the boundaries that read a document
// actually reported about it, per document, per bytes.
//
// Observability only. Nothing here repairs, offers to repair, or infers. A row
// exists because a boundary said something; a class no boundary reports is
// absent from the ledger rather than reported as clean.
//
// Keyed on FILE PATH **and** BUFFER IDENTITY, the `render-health.ts` rule and
// for the same reason: a document whose bytes are replaced (a commit, an undo,
// `REFRESH_BUFFER`, `UPDATE_FILE`, a re-open) is a fresh question, so the
// previous evidence must not outlive the bytes that earned it. Retirement is
// therefore structural — a ledger entry whose buffer is no longer the file's
// current buffer answers `no-evidence`, with no invalidation step to forget.
//
// The ledger lives per RENDERER REALM. A second window is a second workspace
// and collects its own evidence; no fact, and no id inside one, ever crosses a
// window boundary.

/** The buffer identity a row was collected against — compared by reference. */
type BufferIdentity = object;

/**
 * Which reader produced a fact. `pdfjs` is the on-screen renderer, `qpdf` the
 * recovery record of the open, `engine` this repo's own traversals. Grouping
 * by it is what lets the panel say who is reporting rather than blur three
 * readers into one voice.
 */
export type HealthBoundary = 'pdfjs' | 'qpdf' | 'engine';

/** The reader whose collection RUN a status belongs to. qpdf's facts arrive on
 * the engine's run — one process reads the file once — so a run is one of
 * these two, while a FACT still names the boundary that produced it. */
export type HealthSource = 'pdfjs' | 'engine';

/**
 * What a fact is about.
 *
 * `undetermined` is a class, not an absence: a font whose embedding will not
 * read, or a traversal that stopped, is recorded as unknown and drags the
 * document's verdict to `undetermined`. Unreadability never becomes a clean
 * answer.
 */
export type HealthKind = 'recovered' | 'font' | 'skipped' | 'undetermined';

export type HealthSeverity = 'info' | 'warning';

export interface HealthFact {
  readonly kind: HealthKind;
  readonly severity: HealthSeverity;
  readonly boundary: HealthBoundary;
  /** Stable id; the renderer maps it to a catalog key. Never a sentence. */
  readonly code: string;
  /** 0-based page INDEX within the file, or null for a document-level fact.
   * An index, never a page id: ids are generation-tagged and a stored one
   * could re-bind to a different physical page after any commit. */
  readonly page: number | null;
  readonly params: Readonly<Record<string, string | number>>;
}

/** Per-run outcome. `pending` is a run in flight; `failed` is a run that could
 * not reach the end, which is what makes the verdict `undetermined` rather
 * than letting a partial sweep read as a complete one. */
export type CollectionStatus = 'pending' | 'collected' | 'failed';

export interface HealthEntry {
  readonly buffer: BufferIdentity;
  readonly pdfjs: CollectionStatus;
  readonly engine: CollectionStatus;
  readonly facts: readonly HealthFact[];
}

export interface HealthLedger {
  readonly byPath: ReadonlyMap<string, HealthEntry>;
}

export const EMPTY_HEALTH_LEDGER: HealthLedger = { byPath: new Map() };

/**
 * The document's overall state.
 *
 * `no-evidence`  — nothing collected for these bytes yet, or collection was
 *                  skipped. NOT a clean bill.
 * `undetermined` — a run failed, or a fact says something could not be
 *                  determined. Never reported as healthy.
 * `facts`        — both runs finished and reported something.
 * `healthy`      — both runs finished and reported nothing.
 */
export type HealthVerdict = 'no-evidence' | 'undetermined' | 'facts' | 'healthy';

function entryFor(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity | null | undefined,
): HealthEntry | null {
  if (!buffer) return null;
  const entry = ledger.byPath.get(path);
  return entry && entry.buffer === buffer ? entry : null;
}

function withEntry(ledger: HealthLedger, path: string, entry: HealthEntry): HealthLedger {
  const byPath = new Map(ledger.byPath);
  byPath.set(path, entry);
  return { byPath };
}

/**
 * Start (or restart) collection for one file's CURRENT bytes.
 *
 * A buffer change lands here as a brand-new entry rather than an edit of the
 * old one, so no fact from the previous bytes can survive into the new row.
 */
export function beginCollection(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity,
): HealthLedger {
  return withEntry(ledger, path, {
    buffer,
    pdfjs: 'pending',
    engine: 'pending',
    facts: [],
  });
}

/**
 * Record one run's outcome against the bytes it read.
 *
 * A result for a buffer the file no longer holds is DROPPED: it describes
 * bytes nobody is looking at, and merging it would date-stamp the live row
 * with evidence from a dead one. That is the only defence the ledger needs
 * against a slow run landing after a commit.
 */
export function recordCollection(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity,
  source: HealthSource,
  status: 'collected' | 'failed',
  facts: readonly HealthFact[],
): HealthLedger {
  const entry = ledger.byPath.get(path);
  if (!entry || entry.buffer !== buffer) return ledger;
  const kept = entry.facts.filter((f) => runOf(f.boundary) !== source);
  return withEntry(ledger, path, {
    buffer: entry.buffer,
    pdfjs: source === 'pdfjs' ? status : entry.pdfjs,
    engine: source === 'engine' ? status : entry.engine,
    facts: [...kept, ...facts],
  });
}

/** Which RUN a boundary's facts arrive on — qpdf reads the file on the
 * engine's run, so its facts are replaced when the engine run is replaced. */
export function runOf(boundary: HealthBoundary): HealthSource {
  return boundary === 'pdfjs' ? 'pdfjs' : 'engine';
}

/** Drops rows for files that are no longer open. Returns the SAME ledger when
 * nothing changes, so callers can compare by identity. */
export function pruneHealthLedger(
  ledger: HealthLedger,
  openPaths: ReadonlySet<string>,
): HealthLedger {
  let changed = false;
  const byPath = new Map(ledger.byPath);
  for (const path of byPath.keys()) {
    if (openPaths.has(path)) continue;
    byPath.delete(path);
    changed = true;
  }
  return changed ? { byPath } : ledger;
}

/** Discard one document's row entirely — the manual "Re-check" gesture. The
 * verdict falls back to `no-evidence` until the new runs answer, because a
 * stale row shown while a re-check is under way would report the previous
 * answer as current. */
export function retireHealth(ledger: HealthLedger, path: string): HealthLedger {
  if (!ledger.byPath.has(path)) return ledger;
  const byPath = new Map(ledger.byPath);
  byPath.delete(path);
  return { byPath };
}

/** True while a run for these exact bytes is already under way or finished —
 * the guard that stops a re-render from re-collecting. */
export function isTracked(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity | null | undefined,
): boolean {
  return entryFor(ledger, path, buffer) !== null;
}

/** True while at least one run for these exact bytes is still in flight. The
 * verdict stays `no-evidence` throughout — a half-finished sweep is not a
 * verdict — so the panel needs this to say "checking" rather than "nothing
 * checked yet". */
export function isCollecting(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity | null | undefined,
): boolean {
  const entry = entryFor(ledger, path, buffer);
  return entry !== null && (entry.pdfjs === 'pending' || entry.engine === 'pending');
}

/** The facts for one file's CURRENT bytes; empty for retired or absent rows. */
export function factsFor(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity | null | undefined,
): readonly HealthFact[] {
  return entryFor(ledger, path, buffer)?.facts ?? [];
}

export function verdictFor(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity | null | undefined,
): HealthVerdict {
  const entry = entryFor(ledger, path, buffer);
  if (!entry) return 'no-evidence';
  if (entry.pdfjs === 'failed' || entry.engine === 'failed') return 'undetermined';
  if (entry.facts.some((f) => f.kind === 'undetermined')) return 'undetermined';
  if (entry.pdfjs === 'pending' || entry.engine === 'pending') return 'no-evidence';
  return entry.facts.length === 0 ? 'healthy' : 'facts';
}

/** How many facts the indicator shows beside the glyph. */
export function factCount(
  ledger: HealthLedger,
  path: string,
  buffer: BufferIdentity | null | undefined,
): number {
  return factsFor(ledger, path, buffer).length;
}

/** Facts grouped for the panel: by boundary, then in the order collected. The
 * grouping is a display question answered once, so the panel and any future
 * consumer cannot group the same ledger two different ways. */
export function groupByBoundary(
  facts: readonly HealthFact[],
): { boundary: HealthBoundary; facts: HealthFact[] }[] {
  const order: HealthBoundary[] = ['pdfjs', 'qpdf', 'engine'];
  return order
    .map((boundary) => ({ boundary, facts: facts.filter((f) => f.boundary === boundary) }))
    .filter((g) => g.facts.length > 0);
}
