import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initBackdrop } from './lib/backdrop';
import './styles.css';

// Backdrop stamp first, render second — translucent shell styling must be
// present on the first paint (the window itself is already visible).
initBackdrop().finally(() => {
  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);
});
