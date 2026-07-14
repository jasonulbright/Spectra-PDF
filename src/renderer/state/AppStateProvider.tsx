import React, { createContext, useContext, useReducer, type Dispatch } from 'react';
import { AppState, AppAction } from './types';
import { appReducer, initialState } from './reducer';

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<AppAction>>(() => {});

// Boot lands on Home unless something is being opened (shell-open/CLI/tray
// flows focus their doc tab themselves) — Home is a tab you leave, not a
// gate you disable, so `spectra-skip-welcome` is no longer read (Phase 4 M2,
// § 8; keys are never repurposed). Recent files hydrate from the same
// `spectra-recent` key App has always persisted. Lazy so the reads happen
// once per mount, not per render.
function bootState(base: AppState): AppState {
  let recentFiles: string[] = [];
  try {
    recentFiles = JSON.parse(localStorage.getItem('spectra-recent') || '[]') as string[];
  } catch {
    // corrupt entry — start empty, the next addRecent rewrites it
  }
  if (recentFiles.length === 0) return base;
  return { ...base, ui: { ...base.ui, recentFiles } };
}

export function AppStateProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(appReducer, initialState, bootState);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  return useContext(StateContext);
}

export function useAppDispatch(): Dispatch<AppAction> {
  return useContext(DispatchContext);
}
