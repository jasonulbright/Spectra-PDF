import React, { createContext, useContext, useReducer, type Dispatch } from 'react';
import { AppState, AppAction } from './types';
import { appReducer, initialState } from './reducer';

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<AppAction>>(() => {});

// Boot view: the welcome screen unless the user opted out (the same
// localStorage gate App.tsx used to read; the key stays live per the
// rename keep-list). Lazy so the read happens once per mount, not per render.
function bootState(base: AppState): AppState {
  const skip = localStorage.getItem('spectra-skip-welcome') === 'true';
  return skip ? { ...base, ui: { ...base.ui, view: 'operations' } } : base;
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
