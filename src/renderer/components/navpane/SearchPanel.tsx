import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../../state/AppStateProvider';
import { getCanvasServices, getCommandContext } from '../../commands/context';
import { useSearchContext } from '../../search/SearchProvider';
import { useEngine } from '../../hooks/useEngine';
import { FindModeToggles } from '../../search/FindModeToggles';
import { dialog, batch } from '../../lib/tauri-bridge';
import type { SearchOptions } from '../../search/normalize';
import type { NavPanelComponentProps } from './types';

// Search nav panel (Phase 4 M3.3, § 5.4) — a result-list view with TWO scopes:
//   • "Open documents" — over the ONE shared workspace index (SearchProvider),
//     so there's no second index and no doubled OCR. A hit reuses the FindBar's
//     find session (`find.openWith`) — camera + highlights — not a bespoke path.
//   • "On disk" (P4 part 2) — cross-file search of every PDF under a chosen
//     folder that ISN'T open, run in the engine (off the render thread) so a
//     big folder or a pathological regex can't freeze the UI. A hit opens the
//     file and reveals the page (`openPathAtPage`).
// Both scopes share the ONE query box + the three advanced modes.

const DEBOUNCE_MS = 150;

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

interface DiskHit {
  path: string;
  page: number;
  count: number;
  snippet: string;
}
interface DiskResult {
  hits: DiskHit[];
  files_searched: number;
  files_total: number;
  truncated: boolean;
  errors: { path: string; error: string }[];
  error: string | null;
}

type Scope = 'open' | 'disk';

interface OpenScopeResult {
  groups: FileGroup[];
  totalHits: number;
  error: string | null;
  errorKind: 'invalid' | 'timeout' | null;
}
const EMPTY_OPEN_RESULT: OpenScopeResult = { groups: [], totalHits: 0, error: null, errorKind: null };

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

export function SearchPanel({ activeFile }: NavPanelComponentProps): React.ReactElement {
  const state = useAppState();
  const { search, snippetsFor, version } = useSearchContext();
  const { callRaw } = useEngine();
  const [scope, setScope] = useState<Scope>('open');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const [folder, setFolder] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskResult | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const diskToken = useRef(0);

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

  // ── Open-documents scope (in-memory index) ───────────────────────────────
  // Async since P4's ReDoS hardening: a regex-mode scan runs in a worker under
  // a time budget, so this is an effect with a liveness guard rather than a
  // useMemo. Literal queries still resolve in the same tick.
  const [openResult, setOpenResult] = useState<OpenScopeResult>(EMPTY_OPEN_RESULT);
  useEffect(() => {
    const q = debounced.trim();
    if (scope !== 'open' || q.length === 0) {
      setOpenResult(EMPTY_OPEN_RESULT);
      return;
    }
    let alive = true;
    void (async () => {
      const result = await search(debounced, options);
      if (!alive) return;
      if (result.error) {
        setOpenResult({ groups: [], totalHits: 0, error: result.error, errorKind: result.errorKind });
        return;
      }
      if (result.pageIds.size === 0) {
        setOpenResult(EMPTY_OPEN_RESULT);
        return;
      }
      const snippets = await snippetsFor(debounced, options);
      if (!alive) return;
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
      setOpenResult({ groups: out, totalHits: total, error: null, errorKind: null });
    })();
    return () => {
      alive = false;
    };
    // `version` is deliberately a dependency without being read: it is the
    // index's change signal (OCR text landing), and a bump must re-run the scan.
  }, [scope, debounced, options, search, snippetsFor, docs, version]);
  const { groups, totalHits, error, errorKind } = openResult;

  // ── On-disk scope (engine cross-file search) ─────────────────────────────
  useEffect(() => {
    const q = debounced.trim();
    if (scope !== 'disk' || !folder || q.length === 0) {
      setDisk(null);
      setSearching(false);
      return;
    }
    const token = ++diskToken.current;
    setSearching(true);
    void (async () => {
      try {
        const listing = await batch.listPdfsRecursive(folder);
        if (token !== diskToken.current) return;
        const paths = listing.files.map((f) => f.abs);
        const res = (await callRaw('search_in_files', {
          paths,
          query: debounced,
          regex: !!options.regex,
          case_sensitive: !!options.caseSensitive,
          whole_word: !!options.wholeWord,
        })) as unknown as DiskResult;
        if (token !== diskToken.current) return;
        setDisk(res);
      } catch (e) {
        if (token !== diskToken.current) return;
        setDisk({
          hits: [],
          files_searched: 0,
          files_total: 0,
          truncated: false,
          errors: [],
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (token === diskToken.current) setSearching(false);
      }
    })();
  }, [scope, folder, debounced, options, callRaw]);

  const diskGroups = useMemo(() => {
    if (!disk) return [] as { path: string; hits: DiskHit[] }[];
    const byPath = new Map<string, DiskHit[]>();
    for (const h of disk.hits) {
      const arr = byPath.get(h.path);
      if (arr) arr.push(h);
      else byPath.set(h.path, [h]);
    }
    return [...byPath.entries()].map(([path, hits]) => ({ path, hits }));
  }, [disk]);

  const openHit = (pageId: string) => {
    getCanvasServices()?.find.openWith(debounced, pageId, options);
  };
  const openDiskHit = (path: string, page: number) => {
    void getCommandContext()?.app?.openPathAtPage(path, page);
  };
  const chooseFolder = async () => {
    const picked = await dialog.pickFolder('Choose a folder to search');
    if (picked) setFolder(picked);
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
          placeholder={scope === 'open' ? 'Search all open documents' : 'Search PDFs in a folder'}
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
      <div className="flex items-center gap-1 px-2 py-1 text-xs">
        <button
          type="button"
          data-testid="search-scope-open"
          aria-pressed={scope === 'open'}
          onClick={() => setScope('open')}
          className={`px-2 py-0.5 rounded border ${scope === 'open' ? 'bg-blue-600 text-white border-blue-500' : 'bg-neutral-900 text-neutral-400 border-neutral-700 hover:bg-neutral-700'}`}
        >
          Open documents
        </button>
        <button
          type="button"
          data-testid="search-scope-disk"
          aria-pressed={scope === 'disk'}
          onClick={() => setScope('disk')}
          className={`px-2 py-0.5 rounded border ${scope === 'disk' ? 'bg-blue-600 text-white border-blue-500' : 'bg-neutral-900 text-neutral-400 border-neutral-700 hover:bg-neutral-700'}`}
        >
          On disk
        </button>
        {scope === 'disk' && (
          <button
            type="button"
            data-testid="search-choose-folder"
            onClick={() => void chooseFolder()}
            title={folder ?? undefined}
            className="ml-auto px-2 py-0.5 rounded border bg-neutral-900 text-neutral-300 border-neutral-700 hover:bg-neutral-700 truncate max-w-[140px]"
          >
            {folder ? baseName(folder) : 'Choose folder…'}
          </button>
        )}
      </div>

      <div className="navpanel-scroll search-results flex-1" data-testid="search-results">
        {scope === 'open' && (
          <>
            {!activeFile && <p className="navpanel-empty">No document open.</p>}
            {activeFile && !hasQuery && (
              <p className="navpanel-empty">Type to search the open documents.</p>
            )}
            {activeFile && hasQuery && error && (
              <p className="navpanel-empty" data-testid="search-error" style={{ color: '#f87171' }}>
                {errorKind === 'timeout' ? error : `Invalid regular expression: ${error}`}
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
          </>
        )}

        {scope === 'disk' && (
          <>
            {!folder && <p className="navpanel-empty">Choose a folder to search its PDFs.</p>}
            {folder && !hasQuery && <p className="navpanel-empty">Type to search this folder.</p>}
            {folder && hasQuery && searching && (
              <p className="navpanel-empty" data-testid="search-disk-busy">Searching…</p>
            )}
            {folder && hasQuery && !searching && disk?.error && (
              <p className="navpanel-empty" data-testid="search-error" style={{ color: '#f87171' }}>
                Invalid regular expression: {disk.error}
              </p>
            )}
            {folder && hasQuery && !searching && disk && !disk.error && disk.hits.length === 0 && (
              <p className="navpanel-empty" data-testid="search-no-results">
                No matches for “{debounced.trim()}” in {baseName(folder)}.
              </p>
            )}
            {disk && !disk.error && disk.hits.length > 0 && (
              <div className="search-summary" data-testid="search-summary" aria-live="polite">
                {disk.hits.length} page{disk.hits.length === 1 ? '' : 's'} in {diskGroups.length} file
                {diskGroups.length === 1 ? '' : 's'} ({disk.files_searched} searched)
                {disk.truncated && ` — first ${disk.files_searched} of ${disk.files_total} files`}
              </div>
            )}
            {disk && disk.errors.length > 0 && (
              <div className="search-summary" data-testid="search-disk-errors" style={{ color: '#fbbf24' }}>
                {disk.errors.length} file{disk.errors.length === 1 ? '' : 's'} could not be read
              </div>
            )}
            {diskGroups.map((g) => (
              <div key={g.path} className="search-file-group" data-testid="search-file-group">
                <div className="search-file-name" data-testid="search-file-name" title={g.path}>
                  {baseName(g.path)}
                </div>
                {g.hits.map((h) => (
                  <button
                    key={`${h.path}:${h.page}`}
                    type="button"
                    data-testid="search-hit"
                    className="search-hit"
                    onClick={() => openDiskHit(h.path, h.page)}
                    title={`Open ${baseName(h.path)} at page ${h.page}`}
                  >
                    <span className="search-hit-page">Page {h.page}</span>
                    {h.snippet && <span className="search-hit-snippet">{h.snippet}</span>}
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
