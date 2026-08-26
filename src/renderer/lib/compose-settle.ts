import { app } from './tauri-bridge';

/** How long the viewport must hold still before the settle is asked for. */
export const SETTLE_DEBOUNCE_MS = 120;

/** The viewport in the physical pixels the window reports its client area in. */
export function physicalViewport(view: Window = window): [number, number] {
  const ratio = view.devicePixelRatio || 1;
  return [Math.round(view.innerWidth * ratio), Math.round(view.innerHeight * ratio)];
}

/**
 * Keep the webview's rectangle tied to the window's client area.
 *
 * The webview is normally re-placed by the window's own resize message. An
 * automation client resizes the webview directly instead: the page is laid out
 * at the size it asked for and the webview is re-placed at twice the client
 * origin, so the shell composes as a strip in the far corner of an otherwise
 * empty window. No window message follows and the recorded rectangle still
 * reads as the client area, so nothing on the backend side can see it — the
 * viewport this reports is the only evidence that exists.
 *
 * The renderer's `resize` fires for both kinds, which is what makes it the
 * trigger. The backend compares the reported viewport against the window
 * before it writes, so an ordinary resize costs one debounced round trip and
 * changes nothing.
 *
 * Returns its own teardown. Fire-and-forget by construction: a refused or
 * wedged signal leaves the window exactly as it already was.
 */
export function watchWindowCompose(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  settle: (w: number, h: number) => Promise<unknown> = (w, h) => app.settleWindowCompose(w, h),
  delayMs: number = SETTLE_DEBOUNCE_MS,
  viewport: () => [number, number] = () => physicalViewport(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        const [w, h] = viewport();
        void settle(w, h).catch(() => {});
      } catch {
        // No bridge — there is no webview rectangle to settle.
      }
    }, delayMs);
  };
  target.addEventListener('resize', onResize);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    target.removeEventListener('resize', onResize);
  };
}
