// Which workspace index run of each path may land.
//
// One run per (path, buffer): a newer buffer supersedes the run of an older
// one, and only the live run of a path lands its documents. A run whose pdf.js
// proxy is destroyed mid-read can hang forever (a request sent after the
// proxy's transport starts terminating never settles), so a destroyed proxy
// ABANDONS the live run reading it, and the path is indexed again. A commit
// waits for the workspace to settle; a hung run would hold it forever.
//
// DOM-free and pdf.js-free, so the bookkeeping tests in Node.
import type { PdfBuffer } from '../state/types';

export interface IndexRuns {
  /** Start a run of `buffer` for `path`; null when one is already live. */
  begin(path: string, buffer: PdfBuffer): number | null;
  /** Whether `token` is still the live run of `path`. */
  live(path: string, token: number): boolean;
  /** The run behind `token` finished, landed or not. */
  end(path: string, token: number): void;
  /** The proxy of `buffer` for `path` was destroyed. True when that ended a
   * live run, which then never lands and must be started again. */
  abandon(path: string, buffer: PdfBuffer): boolean;
}

export function createIndexRuns(): IndexRuns {
  const runs = new Map<string, { buffer: PdfBuffer; token: number }>();
  let tokens = 0;
  return {
    begin(path, buffer) {
      if (runs.get(path)?.buffer === buffer) return null;
      const token = ++tokens;
      runs.set(path, { buffer, token });
      return token;
    },
    live(path, token) {
      return runs.get(path)?.token === token;
    },
    end(path, token) {
      if (runs.get(path)?.token === token) runs.delete(path);
    },
    abandon(path, buffer) {
      if (runs.get(path)?.buffer !== buffer) return false;
      runs.delete(path);
      return true;
    },
  };
}
