export interface OtherWindowWorkSource {
  listen: (onCount: (count: number) => void) => Promise<() => void>;
  snapshot: () => Promise<number>;
}

/**
 * Subscribe to cross-window activity and seed the current value. Tauri events
 * are not replayed to a renderer that opens after another window's request
 * began, so the snapshot closes that initial-state gap. An event revision
 * prevents a delayed snapshot from overwriting a newer event.
 */
export function watchOtherWindowWork(
  source: OtherWindowWorkSource,
  onCount: (count: number) => void,
): () => void {
  let active = true;
  let eventRevision = 0;
  let unlisten: (() => void) | undefined;

  const ready = source.listen((count) => {
    if (!active) return;
    eventRevision += 1;
    onCount(count);
  }).then(
    (stop) => {
      if (active) unlisten = stop;
      else stop();
    },
    () => undefined,
  );

  void ready.then(async () => {
    if (!active) return;
    const revision = eventRevision;
    try {
      const count = await source.snapshot();
      if (active && eventRevision === revision) onCount(count);
    } catch {
      // The event stream remains useful when a snapshot is unavailable.
    }
  });

  return () => {
    active = false;
    if (unlisten) {
      unlisten();
      unlisten = undefined;
    } else {
      void ready.then(() => {
        unlisten?.();
        unlisten = undefined;
      });
    }
  };
}
