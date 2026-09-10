import { tChrome } from '../i18n';

export interface PageCommitEntry {
  workingPath: string; stagedPath: string;
  expectedWorkingSha256?: string; expectedStagedSha256?: string;
}
export interface PageCommitIo {
  publish: (id: string, entries: PageCommitEntry[]) => Promise<unknown>;
  abort: (id: string) => Promise<unknown>;
  acknowledge: (id: string) => Promise<unknown>;
}

type Reply = { status: 'committed' | 'rolledBack' | 'recoveryRequired'; snapshots: string[]; detail: string };
function reply(value: unknown): Reply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (!['committed', 'rolledBack', 'recoveryRequired'].includes(r.status as string)
      || typeof r.detail !== 'string' || !Array.isArray(r.snapshots)
      || r.snapshots.some(p => typeof p !== 'string' || !p)) return null;
  return r as Reply;
}

type Pending = { id: string; io: PageCommitIo; cleanup: () => Promise<void> };
let recovery: Pending | null = null;
let recovering: Promise<void> | null = null;
const acknowledgements = new Map<string, PageCommitIo>();

export function hasPendingPageCommit(): boolean {
  return recovery !== null || acknowledgements.size > 0;
}

function blocked(): Error { return new Error(tChrome('app.commit.recoveryRequired')); }

async function acknowledge(): Promise<void> {
  for (const [id, io] of acknowledgements) {
    await io.acknowledge(id);
    acknowledgements.delete(id);
  }
}

/** Runs even when pageDirtyPaths became empty (e.g. the user undid a move).
 * A missing abort reply is NOT proof of restored originals. The native id is
 * retained, and every later gate/undo retries this same id before touching disk. */
export function recoverPendingPageCommit(): Promise<void> {
  if (recovering) return recovering;
  const run = (async () => {
    try {
      if (recovery) {
        const pending = recovery;
        const answer = reply(await pending.io.abort(pending.id));
        if (answer?.status !== 'rolledBack') throw blocked();
        // Abort also fences a publish that has not arrived yet. Only now is it
        // safe to remove this run's stages or allow another edit to reach disk.
        await pending.cleanup();
        acknowledgements.set(pending.id, pending.io);
        recovery = null;
      }
      await acknowledge();
    } catch {
      throw blocked();
    }
  })();
  recovering = run;
  void run.finally(() => { recovering = null; }).catch(() => {});
  return run;
}

/** Keep the native backup set live until the whole renderer update is handed
 * over. Any failure before that point aborts, including a lost publish reply,
 * malformed receipt or rejected dispatch. A failed abort retains a gate. */
export async function publishPageCommit(
  io: PageCommitIo,
  entries: PageCommitEntry[],
  publishState: (snapshots: string[]) => void,
  cleanup: () => Promise<void>,
): Promise<void> {
  await recoverPendingPageCommit();
  const id = crypto.randomUUID();
  try {
    const result = reply(await io.publish(id, entries));
    const inputs = new Set(entries.flatMap(e => [e.workingPath, e.stagedPath]));
    if (!result || result.status !== 'committed' || result.snapshots.length !== entries.length
        || new Set(result.snapshots).size !== entries.length || result.snapshots.some(p => inputs.has(p))) {
      throw new Error(result?.detail || 'Invalid page commit receipt');
    }
    publishState(result.snapshots);
  } catch (error) {
    recovery = { id, io, cleanup };
    await recoverPendingPageCommit();
    throw error;
  }
  // State has been published; acknowledgement failure must never roll it back.
  // Keep the acknowledgement for the next gate rather than retrying the edit.
  acknowledgements.set(id, io);
  try { await acknowledge(); } catch { /* the next gate settles this id */ }
  // Published state never needs its private stages again, even when the ack
  // reply was lost. Retain only native originals/history, not orphan stages.
  await cleanup().catch(() => {});
}
