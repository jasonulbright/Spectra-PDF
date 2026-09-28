// The engine invoker signature shared by pure libs that call the Python engine
// without depending on the React `useEngine` hook. `useEngine`'s `call` and
// `callRaw` both satisfy it. The return is intentionally loose — each caller
// knows the op's own result shape and narrows it.
export type EngineCall = (
  method: string,
  params?: Record<string, unknown>,
  options?: EngineCallOptions,
) => Promise<unknown>;

export interface EngineCallOptions {
  /** A caller-owned revision check. It runs again inside the file lock, after
   * the commit gate, immediately before dispatch; a throw prevents the RPC. */
  assertCurrent?: () => void;
  /** Aborting asks the interactive engine to stop the request at its next
   * safe point. The promise still settles with the engine's own answer: a
   * handler that honours the cancel returns a partial result, not an error. */
  signal?: AbortSignal;
}
