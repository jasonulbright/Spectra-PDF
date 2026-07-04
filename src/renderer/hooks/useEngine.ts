import { useCallback, useEffect, useRef, useState } from 'react';
import { engine, dialog } from '../lib/tauri-bridge';
import { runCommitGate } from '../lib/commit-gate';
import { useOperationQueue, isTrackableMethod, getFriendlyName } from './useOperationQueue';

interface PendingRequest {
  resolve: (value: EngineResult) => void;
  reject: (reason: unknown) => void;
}

export interface OutlineNode {
  title: string;
  page: number | null; // 1-based; null = no resolvable target
  children: OutlineNode[];
}

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
  title: string;
  author: string;
  subject: string;
  keywords: string;
  version: string;
  original_version: string;
  target_version: string;
  level: string;
  encryption: string;
  encrypted: boolean;
  has_user_password: boolean;
  recovered: number;
  total_pages: number;
  lost: number;
  recovered_pages: number[];
  lost_pages: { page: number; error: string }[];
  updated_fields: string[];
  issues: { severity: string; message: string; type: string; category: string }[];
  issues_found: unknown[];
  summary: { errors: number; warnings: number };
}

export function useEngine() {
  const nextId = useRef(1);
  const pending = useRef<Map<number, PendingRequest>>(new Map());
  const [ready, setReady] = useState(false);
  const { track } = useOperationQueue();

  useEffect(() => {
    // Start the Python engine sidecar
    engine.start().catch((e) => console.error('[engine] Failed to start:', e));

    // Listen for JSON-RPC responses
    const unlisten = engine.onResponse((response) => {
      const res = response as { id: number; error?: { message: string }; result?: unknown };
      const req = pending.current.get(res.id);
      if (!req) return;
      pending.current.delete(res.id);

      if (res.error) {
        req.reject(new Error(res.error.message));
      } else {
        req.resolve(res.result as EngineResult);
      }
    });
    setReady(true);

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const rawCall = useCallback(async (method: string, params: Record<string, unknown> = {}): Promise<EngineResult> => {
    const id = nextId.current++;
    const request = { jsonrpc: '2.0', method, params, id };

    return new Promise<EngineResult>((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      engine.request(request).catch((err: unknown) => {
        pending.current.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }, []);

  const call = useCallback(async (method: string, params: Record<string, unknown> = {}): Promise<EngineResult> => {
    if (isTrackableMethod(method)) {
      // Every user-facing operation reads (and usually rewrites) the working
      // file — pending in-memory page edits must be committed to disk first.
      // A gate failure rejects here, so the operation aborts instead of
      // running against bytes that don't match what the user sees.
      await runCommitGate();
      return track(getFriendlyName(method, params), () => rawCall(method, params)) as Promise<EngineResult>;
    }
    return rawCall(method, params);
  }, [rawCall, track]);

  const openFiles = useCallback(() => dialog.openFiles(), []);
  const saveFile = useCallback((defaultPath?: string) =>
    dialog.saveFile({ defaultPath }), []);

  return { call, openFiles, saveFile, ready };
}
