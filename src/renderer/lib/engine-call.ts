// The engine invoker signature shared by pure libs that call the Python engine
// without depending on the React `useEngine` hook. `useEngine`'s `call` and
// `callRaw` both satisfy it. The return is intentionally loose — each caller
// knows the op's own result shape and narrows it.
export type EngineCall = (
  method: string,
  params?: Record<string, unknown>,
  options?: EngineCallOptions,
) => Promise<unknown>;

/** A caller-owned revision check. It runs again inside the file lock, after
 * the commit gate, immediately before dispatch; a throw prevents the RPC. */
export interface EngineCallOptions { assertCurrent?: () => void }
