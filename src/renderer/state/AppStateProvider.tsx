import React, { createContext, useContext, useReducer, type Dispatch } from 'react';
import { AppState, AppAction } from './types';
import { appReducer, initialState } from './reducer';
import { readRecent } from '../lib/recent-files';
import { readWorkbenchUi } from '../lib/workbench-ui';
import { readToolbarOverrides } from '../lib/toolbar-layout';

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<AppAction>>(() => {});

// Boot lands on Home unless something is being opened (shell-open/CLI/tray
// flows focus their doc tab themselves) — Home is a tab you leave, not a
// gate you disable, so `spectra-skip-welcome` is no longer read (keys are
// never repurposed). Recent files hydrate from the same
// `spectra-recent` key App has always persisted. Lazy so the reads happen
// once per mount, not per render.
function bootState(base: AppState): AppState {
  // Hydrate persisted chrome state through the validated readers, so a corrupt
  // entry can't propagate a bad shape into state (recent-files precedent):
  // readRecent (spectra-recent) and readWorkbenchUi (workbench-ui, nav pane).
  const recentFiles = readRecent();
  const { navPane, toolDock, toolLock } = readWorkbenchUi({
    navPane: base.ui.navPane,
    toolDock: base.ui.toolDock,
    toolLock: base.ui.toolLock,
  });
  const toolbarOverrides = readToolbarOverrides();
  return {
    ...base,
    ui: { ...base.ui, recentFiles, navPane, toolDock, toolLock, toolbarOverrides },
  };
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
