import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initBackdrop } from './lib/backdrop';
import { watchWindowCompose } from './lib/compose-settle';
import { signalFirstPaint } from './lib/first-paint';
import { stampInitialTheme } from './lib/theme-boot';
import './i18n'; // Initializes i18next before anything renders a string
import './styles.css';

// The shell CSS keys on BOTH [data-theme] and [data-backdrop], so both are
// stamped before the first render. Theme resolves synchronously; the backdrop
// signal is one IPC round-trip, timeout-guarded so a wedged bridge degrades to
// the solid look instead of a window that never mounts.
//
// The window is hidden until `signalFirstPaint` reports, so everything above
// happens off screen: there is no unstyled frame and no opaque-to-translucent
// pop-in to see.
/**
 * Reports the first paint from a committed effect, so the signal is anchored
 * to React having actually mounted the shell rather than to `render` having
 * been called — the initial render is scheduled, not synchronous.
 */
function FirstPaintSignal(): null {
  React.useEffect(() => {
    signalFirstPaint();
  }, []);
  return null;
}

/**
 * Keeps the webview's rectangle tied to the window's client area for the life
 * of the window. Mounted alongside the first-paint signal because it guards
 * the same thing from the other end: that one gets the window on screen only
 * once there is something to see, this one keeps what is on screen from
 * collapsing into a corner later.
 */
function ComposeSettle(): null {
  React.useEffect(() => watchWindowCompose(), []);
  return null;
}

// The safety net, deliberately console-only. A promise nobody caught used to
// die with no trace at all; it is now logged. It is NOT a user surface: a
// rejection reaching here has no file, no operation and no recourse to offer,
// and inventing a message for it would be the noise the open path does not
// have. The surfaces that CAN say something useful catch at their own seam.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

stampInitialTheme();
initBackdrop().finally(() => {
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <>
      <App />
      <FirstPaintSignal />
      <ComposeSettle />
    </>,
  );
});
