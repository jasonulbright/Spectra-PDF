// Whether the canvas can draw a document the ENGINE was able to open.
//
// The engine and pdf.js do not agree about what is recoverable: qpdf
// reconstructs a truncated file and reports a page count, while pdf.js refuses
// the same bytes outright. The tab follows the engine and the canvas follows
// pdf.js, so without this the user gets a tab with the real filename and the
// right page count over a canvas that will never show anything, and no message
// at any point.
//
// The state is keyed on BUFFER IDENTITY, not on the path: a document whose
// bytes are replaced (a repair, an undo, a whole-file op) is a fresh question,
// so the previous refusal must not outlive the bytes that earned it. That is
// also what makes the state self-clearing — a later load that succeeds, or any
// new buffer, drops the entry.

/** The buffer identity a verdict was reached against — compared by reference. */
type BufferIdentity = object;

export interface RenderHealth {
  readonly failed: ReadonlyMap<string, BufferIdentity>;
}

export const EMPTY_RENDER_HEALTH: RenderHealth = { failed: new Map() };

export function markRenderFailed(
  state: RenderHealth,
  path: string,
  buffer: BufferIdentity,
): RenderHealth {
  if (state.failed.get(path) === buffer) return state;
  return { failed: new Map(state.failed).set(path, buffer) };
}

export function markRenderSucceeded(state: RenderHealth, path: string): RenderHealth {
  if (!state.failed.has(path)) return state;
  const failed = new Map(state.failed);
  failed.delete(path);
  return { failed };
}

/** Drops verdicts for files that are no longer open. */
export function pruneRenderHealth(
  state: RenderHealth,
  openPaths: ReadonlySet<string>,
): RenderHealth {
  let changed = false;
  const failed = new Map(state.failed);
  for (const path of failed.keys()) {
    if (openPaths.has(path)) continue;
    failed.delete(path);
    changed = true;
  }
  return changed ? { failed } : state;
}

/**
 * True only while the CURRENT bytes are the ones pdf.js refused. A document
 * whose buffer has since been replaced is pending, not unrenderable — the load
 * for the new bytes is in flight and has not reached a verdict.
 */
export function isUnrenderable(
  state: RenderHealth,
  path: string,
  currentBuffer: BufferIdentity | null | undefined,
): boolean {
  if (!currentBuffer) return false;
  return state.failed.get(path) === currentBuffer;
}

/** The open documents, by path, whose current bytes the canvas cannot draw. */
export function unrenderablePaths(
  state: RenderHealth,
  buffers: ReadonlyMap<string, BufferIdentity | null | undefined>,
): string[] {
  const out: string[] = [];
  for (const [path, buffer] of buffers) {
    if (isUnrenderable(state, path, buffer)) out.push(path);
  }
  return out;
}
