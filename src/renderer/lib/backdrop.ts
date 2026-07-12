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
 * Stamp the applied window backdrop on <html>. Awaited before the first
 * React render so translucent shell styling is already in place on first
 * paint (one IPC round-trip; no opaque-to-translucent pop-in).
 */
export async function initBackdrop(): Promise<void> {
  let kind: unknown = null;
  try {
    kind = await app.getWindowBackdrop();
  } catch {
    // No signal — keep the solid look.
  }
  const attr = backdropAttrFor(kind);
  if (attr) document.documentElement.setAttribute('data-backdrop', attr);
}
