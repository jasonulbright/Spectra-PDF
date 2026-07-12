import { app } from './tauri-bridge';

/**
 * Map the backend's backdrop report onto the <html data-backdrop> value.
 * Anything but a positive "mica" — including errors and unknown values —
 * means no attribute, which leaves the CSS delta at zero and the app
 * rendering exactly as it does without a backdrop.
 */
export function backdropAttrFor(kind: unknown): 'mica' | null {
  return kind === 'mica' ? 'mica' : null;
}

/**
 * How long the first render waits for the backdrop signal. The command is
 * a synchronous state read backend-side, so this only bites if IPC itself
 * is wedged — and rendering the solid look then beats a window that never
 * mounts at all.
 */
export const BACKDROP_SIGNAL_TIMEOUT_MS = 1000;

/**
 * Stamp the applied window backdrop on <html>. Awaited before the first
 * React render so translucent shell styling is already in place on first
 * paint (one IPC round-trip; no opaque-to-translucent pop-in).
 */
export async function initBackdrop(): Promise<void> {
  let kind: unknown = null;
  try {
    kind = await Promise.race([
      app.getWindowBackdrop(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), BACKDROP_SIGNAL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // No signal — keep the solid look.
  }
  const attr = backdropAttrFor(kind);
  if (attr) document.documentElement.setAttribute('data-backdrop', attr);
}
