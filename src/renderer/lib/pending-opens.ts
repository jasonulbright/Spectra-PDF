// Opens the user has asked for that have not landed yet (issue #43).
//
// Between a request to open a file and its OPEN_FILE there can be seconds of
// work — the ownership claim, a fresh working copy, the engine's first reads
// (a cold engine on a launch from Explorer), a password prompt. A document
// that does not exist yet cannot be a tab in `state.files`: every reader of
// that map (commit, credentials, session, commands) takes an entry as a real
// document with bytes. So the placeholder lives here, beside the reducer and
// outside it: one entry per path, rendered as a tab with a spinner, and gone
// the moment the open reaches a verdict.
//
// Closing a placeholder is a cancel. It cannot interrupt the engine call in
// flight; it marks the handle, and the open funnel checks the mark before it
// reads anything and again before it lands OPEN_FILE, discarding what it
// prepared instead.
//
// DOM-free and IPC-free, so the rule tests in Node.

export interface PendingOpen {
  readonly path: string;
  readonly name: string;
}

/** The funnel's handle on its placeholder. `cancelled` turns true when the
 * user closes the tab; the funnel reads it, nothing else writes it. */
export interface PendingOpenHandle extends PendingOpen {
  cancelled: boolean;
}

export interface PendingOpensSnapshot {
  readonly items: readonly PendingOpen[];
  /** The placeholder whose loading pane is showing, or null. */
  readonly focused: string | null;
}

export interface PendingOpens {
  /** Show a placeholder for `path`. Null when one already stands for it:
   * another open of the path owns that placeholder. */
  begin(path: string, name: string): PendingOpenHandle | null;
  /** The open reached a verdict: remove the placeholder if it is still this
   * handle's. */
  settle(handle: PendingOpenHandle | null | undefined): void;
  /** The document for `path` landed, whichever open landed it. */
  settlePath(path: string): void;
  /** The user closed the placeholder. */
  cancel(path: string): void;
  focus(path: string | null): void;
  snapshot(): PendingOpensSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createPendingOpens(): PendingOpens {
  const handles = new Map<string, PendingOpenHandle>();
  let focused: string | null = null;
  let current: PendingOpensSnapshot = { items: [], focused: null };
  const listeners = new Set<() => void>();

  const publish = (): void => {
    if (focused !== null && !handles.has(focused)) focused = null;
    current = {
      items: [...handles.values()].map(({ path, name }) => ({ path, name })),
      focused,
    };
    for (const listener of [...listeners]) listener();
  };

  const remove = (path: string): void => {
    if (!handles.delete(path)) return;
    publish();
  };

  return {
    begin(path, name) {
      if (handles.has(path)) return null;
      const handle: PendingOpenHandle = { path, name, cancelled: false };
      handles.set(path, handle);
      publish();
      return handle;
    },
    settle(handle) {
      if (handle && handles.get(handle.path) === handle) remove(handle.path);
    },
    settlePath(path) {
      remove(path);
    },
    cancel(path) {
      const handle = handles.get(path);
      if (!handle) return;
      handle.cancelled = true;
      remove(path);
    },
    focus(path) {
      const next = path !== null && handles.has(path) ? path : null;
      if (next === focused) return;
      focused = next;
      publish();
    },
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** This window's placeholders. One renderer is one window. */
export const pendingOpens = createPendingOpens();
