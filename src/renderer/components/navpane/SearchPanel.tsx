import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../../state/AppStateProvider';
import { getCanvasServices } from '../../commands/context';
import { useSearchContext } from '../../search/SearchProvider';
import { FindModeToggles } from '../../search/FindModeToggles';
import type { SearchOptions } from '../../search/normalize';
import type { NavPanelComponentProps } from './types';

// Search nav panel (Phase 4 M3.3, § 5.4) — a result-list view over the ONE
// workspace search index (shared with the canvas FindBar via SearchProvider,
// so there's no second index and no doubled OCR). It spans every open
// document, not just the active one: a query yields a per-file hit list with a
// context snippet per page. Clicking a hit drives the SAME tested find path the
// FindBar uses (`find.openWith`) — centering the camera on the page and
// lighting up the match highlights — rather than a bespoke highlight of its
// own. The panel owns only its query box; the index, the highlight, and the
// match navigation all live where they already did.

const DEBOUNCE_MS = 150; // match useFind — the index is in-memory but snippetsFor scans all page text

interface Hit {
  pageId: string;
  pageNumber: number; // 1-based position in its document
  snippet: string;
}
interface FileGroup {
  docId: string;
  name: string;
  hits: Hit[];
}

export function SearchPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  const state = useAppState();
  const { search, snippetsFor, version } = useSearchContext();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleOption = useCallback((key: keyof SearchOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const docs = state.workspace.documents;

  // Group matches by document. Matching against `result.pageIds` (and reading
  // snippets from the same page-id-keyed map) means we never reconstruct a page
  // id from position — the engine and this panel agree on identity by
  // construction, so a reorder/reindex can't misalign a hit with the wrong
  // page. `version` re-runs this when the index grows (OCR results landing).
  const { groups, totalHits, error } = useMemo(() => {
    const q = debounced.trim();
    if (q.length === 0) return { groups: [] as FileGroup[], totalHits: 0, error: null as string | null };
    const result = search(debounced, options);
    if (result.error) return { groups: [] as FileGroup[], totalHits: 0, error: result.error };
    if (result.pageIds.size === 0) return { groups: [] as FileGroup[], totalHits: 0, error: null };
    const snippets = snippetsFor(debounced, options);
    const out: FileGroup[] = [];
    let total = 0;
    for (const doc of docs) {
      const hits: Hit[] = [];
      doc.pages.forEach((page, i) => {
        if (!result.pageIds.has(page.id)) return;
        hits.push({ pageId: page.id, pageNumber: i + 1, snippet: snippets.get(page.id) ?? '' });
      });
      if (hits.length > 0) {
        out.push({ docId: doc.id, name: doc.name, hits });
        total += hits.length;
      }
    }
    return { groups: out, totalHits: total, error: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, options, search, snippetsFor, docs, version]);

  const openHit = (pageId: string) => {
    // Reuse the FindBar's find session: seed the query + the SAME modes, jump to
    // the page, and let the existing highlight overlay do the rest.
    getCanvasServices()?.find.openWith(debounced, pageId, options);
  };

  const hasQuery = debounced.trim().length > 0;

  return (
    <div className="search-panel flex flex-col h-full min-h-0" data-testid="search-panel">
      <div className="search-panel-input-row">
        <input
          ref={inputRef}
          data-testid="search-input"
          className="search-panel-input"
          type="text"
          placeholder="Search all open documents"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
        <FindModeToggles options={options} onToggle={toggleOption} testIdPrefix="search" />
      </div>
      <div className="navpanel-scroll search-results flex-1" data-testid="search-results">
        {!activeFile && <p className="navpanel-empty">No document open.</p>}
        {activeFile && !hasQuery && (
          <p className="navpanel-empty">Type to search the open documents.</p>
        )}
        {activeFile && hasQuery && error && (
          <p className="navpanel-empty" data-testid="search-error" style={{ color: '#f87171' }}>
            Invalid regular expression: {error}
          </p>
        )}
        {activeFile && hasQuery && !error && totalHits === 0 && (
          <p className="navpanel-empty" data-testid="search-no-results">
            No matches for “{debounced.trim()}”.
          </p>
        )}
        {totalHits > 0 && (
          <div className="search-summary" data-testid="search-summary" aria-live="polite">
            {totalHits} page{totalHits === 1 ? '' : 's'} in {groups.length} file{groups.length === 1 ? '' : 's'}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.docId} className="search-file-group" data-testid="search-file-group">
            <div className="search-file-name" data-testid="search-file-name" title={g.name}>
              {g.name}
            </div>
            {g.hits.map((h) => (
              <button
                key={h.pageId}
                type="button"
                data-testid="search-hit"
                className="search-hit"
                onClick={() => openHit(h.pageId)}
                title={`Go to page ${h.pageNumber}`}
              >
                <span className="search-hit-page">Page {h.pageNumber}</span>
                {h.snippet && <span className="search-hit-snippet">{h.snippet}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
