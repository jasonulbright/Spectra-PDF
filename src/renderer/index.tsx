import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initBackdrop } from './lib/backdrop';
import { stampInitialTheme } from './lib/theme-boot';
import './styles.css';

// The shell CSS keys on BOTH [data-theme] and [data-backdrop], so both are
// stamped before the first render (the window itself is already visible).
// Theme resolves synchronously; the backdrop signal is one IPC round-trip,
// timeout-guarded so a wedged bridge degrades to the solid look instead of
// a window that never mounts.
stampInitialTheme();
initBackdrop().finally(() => {
  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);
});
