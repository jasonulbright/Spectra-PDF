import React, { createContext, useContext } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { usePdfProxies } from '../hooks/usePdfProxies';
import { useSearchIndex, type SearchIndex } from './useSearchIndex';

// One shared search index for the whole workspace (Phase 4 M3.3). Before M3.3
// the index lived inside WorkspaceCanvasView (for the floating FindBar); the
// nav-pane Search panel needs the SAME index (double-instantiating would
// double the OCR work and desync results), so it's lifted here and consumed by
// both. Mounted high in AppContent, so the index PERSISTS across tab switches
// (no re-index when leaving/entering the document board).
const SearchContext = createContext<SearchIndex | null>(null);

export function SearchProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const state = useAppState();
  // Own proxy map (pdfDocCache dedupes against the canvas's), so the index
  // reconciles independently of what's rendered.
  const proxies = usePdfProxies(state.files);
  const index = useSearchIndex(state.workspace.documents, proxies, state.files);
  return <SearchContext.Provider value={index}>{children}</SearchContext.Provider>;
}

/** The shared workspace search index. Throws if used outside the provider. */
export function useSearchContext(): SearchIndex {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error('useSearchContext must be used within <SearchProvider>');
  return ctx;
}
