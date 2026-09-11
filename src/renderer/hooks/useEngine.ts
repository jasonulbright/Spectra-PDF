import { useCallback, useEffect, useState } from 'react';
import { engine, dialog, batch, file as fileIO } from '../lib/tauri-bridge';
import { EngineError } from '../lib/engine-messages';
import { runCommitGate } from '../lib/commit-gate';
import { lockKeysFor, withFileLock } from '../lib/engine-lock';
import { useOperationQueue, isTrackableMethod } from './useOperationQueue';
import { beginInteractive, submitIdle, trackInteractive } from '../lib/engine-idle-lane';
import { isHealthMethod, runHealthSweep, type EngineHealthReply } from '../lib/doc-health-engine';
import { withHealthInput } from '../lib/doc-health-input';
import type { PdfBuffer } from '../state/types';
import type { EngineCallOptions } from '../lib/engine-call';

interface PendingRequest {
  resolve: (value: EngineResult) => void;
  reject: (reason: unknown) => void;
}

/** The raw shape both sidecars answer on `engine:response` with. */
interface EngineResponse {
  id: number;
  error?: { message: string };
  result?: unknown;
}

/**
 * Resolves ONE pending request out of the map, by id, and only that one.
 *
 * Pulled out as a pure function so the collision question — two sidecars
 * answering with the same id — is testable without mounting the hook (this
 * repo runs no DOM test environment; see `state/selectors.ts`'s note on the
 * same constraint). Both sidecars' replies arrive on the same
 * `engine:response` event and are correlated by id alone against this ONE
 * map, so a response naming an id nothing is pending under is silently
 * dropped rather than resolving an unrelated request.
 */
export function resolvePendingResponse(
  pending: Map<number, PendingRequest>,
  response: EngineResponse,
): void {
  const req = pending.get(response.id);
  if (!req) return;
  pending.delete(response.id);
  if (response.error) {
    // The engine-message boundary. The refusal keeps its English in `raw`
    // (the log, the batch report and the CLI read that); `message` renders
    // it through the catalog when the UI shows it, and passes it through
    // verbatim when the table doesn't know it.
    req.reject(new EngineError(response.error.message));
  } else {
    req.resolve(response.result as EngineResult);
  }
}

// Canonical outline node type lives in the (dependency-free) reorder lib so the
// sidebar's reorder and the engine contract share one definition; its index
// signature carries the opaque action/dest/action_lossy payloads untouched.
export type { OutlineNode } from '../lib/outline-reorder';
import type { OutlineNode } from '../lib/outline-reorder';
import type { AlterationRow } from '../lib/standards-report';

/** Result of an engine operation. Which fields are populated depends on the operation invoked. */
export interface EngineResult {
  outline: OutlineNode[];
  count: number;
  truncated: boolean;
  pages: number;
  pages_extracted: number;
  size_bytes: number;
  compressed_size: number;
  output_size: number;
  rebuilt_size: number;
  repaired_size: number;
  original_size: number;
  length: number;
  text: string;
  /** export_document: the file that was written, and how much text it carries. */
  output: string;
  characters: number;
  title: string;
  author: string;
  subject: string;
  keywords: string;
  version: string;
  original_version: string;
  target_version: string;
  level: string;
  /** convert_pdfa: the conformance the OUTPUT declares, read back out of its
   * own metadata. Not the level that was asked for — the two agree because the
   * engine refuses and discards the file when they do not. */
  declared_conformance: string;
  encryption: string;
  encrypted: boolean;
  /** compress/grayscale/rebuild: the run wrote an UNPROTECTED copy of a
   * protected document, because the user consented to losing the protection
   * the operation cannot carry. False on every run that kept or never had
   * any (`engine/pdf_save.py` `refuse_encrypted_source`). */
  encryption_removed: boolean;
  /** check_encrypted: which credentials open it — "password" | "pubkey". */
  kind: string;
  /** encrypt_pubkey: how many recipient certificates the file is locked to. */
  recipients: number;
  /** convert_pdfx: the GTS version string the output actually carries. */
  pdfx_version: string;
  /** convert_pdfx: whether the output intent embeds a destination profile. */
  embedded_profile: boolean;
  /** convert_pdfa / convert_pdfx: one row per thing reaching conformance cost
   * the document, plus one per check that could not run. */
  altered: AlterationRow[];
  /** convert_pdfa / convert_pdfx: producer text no known shape matched. */
  producer_notices: string[];
  notices_truncated: boolean;
  has_user_password: boolean;
  recovered: number;
  total_pages: number;
  /** recover: total_pages is only an observed lower bound if false. */
  page_count_known?: boolean;
  enumeration_error?: string | null;
  lost: number;
  recovered_pages: number[];
  lost_pages: { page: number; error: string }[];
  updated_fields: string[];
  issues: { severity: string; message: string; type: string; category: string }[];
  issues_found: unknown[];
  /** document_health: the read-only health facts for one document, and
   * whether every traversal ran to the end. Parsed (never trusted raw) by
   * `lib/doc-health-engine.ts`. */
  facts: unknown[];
  status: string;
  summary: { errors: number; warnings: number };
}

// MODULE-scoped id counter, deliberately: per-mount counters restarted at
// 1, so a call abandoned by an unmount (its listener gone, the engine
// still running it — the engine is strictly serial FIFO) could complete
// and satisfy a LATER mount's pending entry that reused the same id —
// resolving conversion B's promise with conversion A's result
// (regression via the Create PDF dialog, but the class was
// app-wide). Globally-unique ids make a stale response land on no map
// and drop, which is the correct fate for an abandoned call's result.
let nextEngineRequestId = 1;

/** The module-scoped counter's next value. Exported so the "ids are drawn
 * from one counter, so a same-id collision between the two sidecars is
 * impossible by construction" invariant is provable directly, rather than
 * only by inspection of `dispatch` below. */
export function nextEngineRequestIdForTest(): number {
  return nextEngineRequestId++;
}

// Transport belongs to the WebView window, not the tool panel that happens
// to call it. Unmounting a panel must not discard an outstanding response:
// its promise may own a file lock or a health input awaiting cleanup.
const pendingRequests = new Map<number, PendingRequest>();
let listenerReady: Promise<void> | undefined;
function ensureEngineResponses(): Promise<void> {
  if (!listenerReady) {
    listenerReady = engine.onResponse((response) => {
      resolvePendingResponse(pendingRequests, response as EngineResponse);
    }).then(() => undefined, (error: unknown) => {
      listenerReady = undefined;
      throw error;
    });
  }
  return listenerReady;
}

/** One window-wide listener serves both workers and survives panel changes.
 * Register before sending: a fast reply must never outrun its listener. */
export async function dispatchEngineRequest(method: string, params: Record<string, unknown>): Promise<EngineResult> {
  await ensureEngineResponses();
  const id = nextEngineRequestId++;
  const request = { jsonrpc: '2.0', method, params, id };
  const send = isHealthMethod(method) ? engine.healthRequest : engine.request;
  return new Promise<EngineResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    void Promise.resolve().then(() => send(request)).catch((err: unknown) => {
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export function useEngine() {
  const [ready, setReady] = useState(false);
  const { track } = useOperationQueue();

  useEffect(() => {
    let mounted = true;
    void Promise.all([ensureEngineResponses(), engine.start()]).then(() => {
      if (mounted) setReady(true);
    }).catch((e: unknown) => console.error('[engine] Failed to start:', e));
    // The window owns the listener; native window teardown owns its lifetime.
    return () => { mounted = false; };
  }, []);

  // WHICH SIDECAR, decided from the method rather than from the caller. Health
  // inspection runs in its own killable worker; a health method that reached
  // the interactive sidecar would put an unbounded traversal of a document
  // nobody asked about into the FIFO the user's operations wait in. Both
  // sidecars answer on the same `engine:response` event with the id this
  // renderer issued, so one pending map correlates both.
  const dispatch = dispatchEngineRequest;

  // Every request a user's action produced is counted while it is outstanding,
  // which is what `interactiveInFlight` reports.
  const rawCall = useCallback((method: string, params: Record<string, unknown> = {}): Promise<EngineResult> =>
    trackInteractive(() => dispatch(method, params)), [dispatch]);

  const call = useCallback(async (method: string, params: Record<string, unknown> = {}, options?: EngineCallOptions): Promise<EngineResult> => {
    options?.assertCurrent?.();
    if (isTrackableMethod(method)) {
      // Counted interactive from HERE, not from the dispatch below: the gate
      // and the lock run first and can take arbitrarily long, and the question
      // the count answers is "has a user asked for something", not "has a
      // request reached the engine".
      const release = beginInteractive();
      try {
        // Every user-facing operation reads (and usually rewrites) the working
        // file — pending in-memory page edits must be committed to disk first.
        // A gate failure rejects here, so the operation aborts instead of
        // running against bytes that don't match what the user sees.
        await runCommitGate();
        // The gate runs OUTSIDE the lock, deliberately — it writes files
        // itself, so gating from inside would have this operation wait on a
        // commit that is waiting on this operation. Once the gate is clear,
        // the call serializes against any other operation naming the same
        // file: two whole-file rewrites of one path each write a temp and
        // rename, so without this the later rename silently wins and the
        // earlier operation's work is gone with no error anywhere.
        return (await withFileLock(lockKeysFor(params), () => {
          options?.assertCurrent?.();
          return track(method, params, async () => {
            options?.assertCurrent?.();
            return rawCall(method, params);
          });
        })) as EngineResult;
      } finally {
        release();
      }
    }
    // Read-only is not handle-free: qpdf can hold the working file while an
    // index is built. Serialize these readers with Undo/Save/publication too,
    // without running the commit gate or creating an operation-queue entry.
    return withFileLock(lockKeysFor(params), () => {
      options?.assertCurrent?.();
      return rawCall(method, params);
    });
  }, [rawCall, track]);

  // Background work nobody asked for: a passive, read-only sweep driven by a
  // document changing rather than by a user. It runs in the health worker, one
  // run at a time, a bounded step at a time, so a run superseded part-way stops
  // at its next step boundary. Resolves to `null` for a run abandoned before it
  // finished — which is not a failure and must not be recorded as one.
  const collectHealth = useCallback(
    (buffer: PdfBuffer, isCurrent: () => boolean): Promise<EngineHealthReply | null> =>
      submitIdle((gate) => withHealthInput(buffer, gate, {
        allocate: () => batch.createScratch(`health-${crypto.randomUUID()}`),
        write: fileIO.writeBuffer,
        remove: batch.deleteHealthScratch,
      }, (path) => runHealthSweep(dispatch, path, gate)), isCurrent),
    [dispatch],
  );

  const openFiles = useCallback(() => dialog.openFiles(), []);
  const saveFile = useCallback((defaultPath?: string) =>
    dialog.saveFile({ defaultPath }), []);

  // `callRaw` skips the commit gate and the operation queue — for engine work
  // on files OUTSIDE the workspace only (Batch OCR mirror outputs). A
  // workspace file op must use `call`: the gate is what guarantees the engine
  // reads bytes matching what the user sees, and skipping it for an open
  // file's working copy would reintroduce the exact stale-read class the gate
  // exists to prevent. Batch reads ORIGINAL paths (not working copies), so
  // neither concern applies — and gating there would side-effect-commit the
  // user's unrelated pending page edits mid-batch.
  return { call, callRaw: rawCall, collectHealth, openFiles, saveFile, ready };
}
