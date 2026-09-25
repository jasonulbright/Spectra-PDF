interface RatioWindow {
  devicePixelRatio: number;
  matchMedia(query: string): Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Calls `onChange` each time the device pixel ratio changes (a move to a
 * monitor with another scale, an OS scale change). A resolution query matches
 * one ratio only, so the watch re-arms on the new ratio after every change.
 * Returns the unsubscribe.
 */
export function watchDevicePixelRatio(win: RatioWindow, onChange: () => void): () => void {
  let query: ReturnType<RatioWindow['matchMedia']> | null = null;
  const listener = (): void => {
    arm();
    onChange();
  };
  const arm = (): void => {
    query?.removeEventListener('change', listener);
    query = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', listener);
  };
  arm();
  return () => query?.removeEventListener('change', listener);
}
