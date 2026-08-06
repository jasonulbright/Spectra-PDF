import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { FindModeToggles } from '../search/FindModeToggles';
import { getCanvasServices, invokeCommand } from '../commands/context';
import { tChrome, tChromeCount } from '../i18n';
import type { SearchOptions } from '../search/normalize';
import { batch, dialog } from '../lib/tauri-bridge';
import {
  EXPAND_MODES,
  PATTERN_IDS,
  groupByPage,
  groupState,
  hitIsMarked,
  hitKey,
  markRequests,
  parsePageRange,
  parseWordList,
  requestIsEmpty,
  toggleGroup,
  toggleOne,
  type ExpandMode,
  type FileSearchResult,
  type PatternId,
  type SearchHit,
} from '../lib/search-redact';
import { RedactionPropertiesFields } from '../components/RedactionPropertiesFields';

// **The panel produces MARKS. It never produces a redaction.** Every checked
// hit becomes an ordinary `RedactionMark` through the canvas's own page-space
// → display conversion, shared with the mark seed, and from there the
// SHIPPED path takes over: the status bar's apply / save marks / clear,
// `buildRedactionRegions`, the commit gate and `performOperation`'s undo
// chain. That is what keeps the review-hardened destructive path the ONLY
// destructive path, and it is also what gives the user a review step for free
// — marks are visible, movable, removable and undoable before anything is
// destroyed, which is how a redaction job is actually done.
//
// The search itself goes through the GATED `call`, not `callRaw`, and that is
// load-bearing: a hit's page number is the page's position IN THE FILE, and
// the mark it becomes is bound to the Nth PageRef of the document. Those two
// agree only once pending page edits (a reorder, a deletion) have been
// committed — which is exactly what the gate does before the engine reads.

/** A pending mark's page-space rect, as the canvas reports it. */
interface MarkedRect {
  path: string;
  page: number;
  rect: [number, number, number, number];
}

interface ScopeState {
  kind: 'document' | 'all' | 'pages';
  pages: string;
}

const MAX_HITS = 50000;

export function SearchRedactPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, allFiles, openNewFiles } = useActiveFile();
  const { call } = useEngine();

  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({});
  const [scope, setScope] = useState<ScopeState>({ kind: 'document', pages: '' });
  const [wordList, setWordList] = useState('');
  const [showWordList, setShowWordList] = useState(false);
  const [patterns, setPatterns] = useState<Set<PatternId>>(new Set());
  const [expand, setExpand] = useState<ExpandMode>('match');
  const [results, setResults] = useState<FileSearchResult[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marked, setMarked] = useState<MarkedRect[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [markCount, setMarkCount] = useState(() => getCanvasServices()?.redaction.count() ?? 0);
  const [showProperties, setShowProperties] = useState(false);

  // The results describe BYTES. When a file's buffer changes underneath them
  // (a commit, a whole-file op, an undo, an apply) every rect in the list
  // addresses content that may no longer be there — the same invalidation
  // marks themselves take, and for the same reason. The list says it is stale
  // rather than offering rows into bytes that no longer exist.
  const buffers = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const file of allFiles) map.set(file.path, file.buffer);
    return map;
  }, [allFiles]);
  const lastBuffersRef = useRef(buffers);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const prev = lastBuffersRef.current;
    lastBuffersRef.current = buffers;
    if (!results) return;
    for (const file of results) {
      if (prev.has(file.path) && prev.get(file.path) !== buffers.get(file.path)) {
        setStale(true);
        return;
      }
      if (!buffers.has(file.path)) {
        setStale(true);
        return;
      }
    }
  }, [buffers, results]);

  // Already-marked state has to stay LIVE while the user also draws bands by
  // hand — a disabled checkbox that no longer reflects the marks is a
  // checkbox that lies on a destructive tool.
  const refreshMarked = useCallback(async () => {
    const service = getCanvasServices()?.redaction;
    if (!service) {
      setMarked([]);
      setMarkCount(0);
      return;
    }
    setMarkCount(service.count());
    try {
      setMarked(await service.markedRects());
    } catch {
      // A geometry read can fail while a buffer is being swapped; the panel
      // simply shows nothing as already-marked until the next change, which
      // over-offers rather than under-offers (the safe direction here: an
      // extra mark is deletable, a missing one is unredacted content).
      setMarked([]);
    }
  }, []);

  useEffect(() => {
    const service = getCanvasServices()?.redaction;
    if (!service) return;
    void refreshMarked();
    return service.subscribe(() => void refreshMarked());
  }, [refreshMarked, results]);

  const toggleOption = useCallback((key: keyof SearchOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const togglePattern = useCallback((id: PatternId) => {
    setPatterns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const importWordList = useCallback(async () => {
    // The symbol-set import's own path: pick any file, read its bytes through
    // the arbitrary-path reader, decode as UTF-8. A word list is a list the
    // user already keeps somewhere, so an extension filter would be a filter
    // and not a safeguard.
    const picked = await dialog.pickAnyFile();
    if (!picked) return;
    try {
      const text = new TextDecoder('utf-8').decode(await batch.readFileBuffer(picked));
      setWordList((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
      setShowWordList(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runSearch = useCallback(async () => {
    if (!activeFile) return;
    const terms = parseWordList(wordList);
    const patternIds = [...patterns];
    const request = {
      query,
      terms,
      patterns: patternIds,
      options,
      expand,
      pages: null as number[] | null,
      maxHits: MAX_HITS,
    };
    if (requestIsEmpty(request)) {
      setError(tChrome('panel.searchRedact.nothingToSearch'));
      return;
    }
    const targets = scope.kind === 'all' ? allFiles : [activeFile];
    let pageSelection: number[] | null = null;
    if (scope.kind === 'pages') {
      try {
        pageSelection = parsePageRange(scope.pages, activeFile.pageCount);
      } catch (e) {
        setError(tChrome('panel.searchRedact.badRange', { token: e instanceof Error ? e.message : '' }));
        return;
      }
    }

    setBusy(true);
    setError(null);
    setStale(false);
    setStatus(tChrome('panel.searchRedact.searching'));
    const next: FileSearchResult[] = [];
    try {
      for (const file of targets) {
        const raw = (await call('search_text_regions', {
          file: file.workingPath,
          query,
          terms,
          patterns: patternIds,
          pages: pageSelection ?? 'all',
          regex: !!options.regex,
          case_sensitive: !!options.caseSensitive,
          whole_word: !!options.wholeWord,
          expand,
          max_hits: MAX_HITS,
        })) as unknown as {
          hits: SearchHit[];
          truncated: boolean;
          pages_without_text: number[];
          error: string | null;
        };
        const hits = [...(raw.hits ?? [])];
        // The SECOND authority: a page the engine found no text on is
        // an image-only page, and the in-app index may already hold its OCR
        // word boxes. Searching them here is what keeps a scanned discovery
        // set usable — reporting "N pages carry no text" and stopping would
        // be a silent shortfall on exactly the documents redaction is for.
        const stillWithoutText: number[] = [];
        const service = getCanvasServices()?.redaction;
        for (const page of raw.pages_without_text ?? []) {
          const words = service
            ? await service.searchOcrPage(file.path, page, query, options)
            : [];
          if (words.length === 0) {
            stillWithoutText.push(page);
            continue;
          }
          for (const word of words) {
            hits.push({
              page,
              index: hits.length,
              text: word.text,
              source: 'ocr',
              context: word.text,
              rects: [
                {
                  run: -1,
                  rect: word.rect,
                  codes: [0, 0],
                  partial: false,
                  // An OCR box is the recogniser's word box, not a per-code
                  // slice — honest about being a different authority.
                  imprecise: true,
                },
              ],
              runs: [],
            });
          }
        }
        hits.sort((a, b) => a.page - b.page || a.index - b.index);
        next.push({
          path: file.path,
          name: file.name,
          hits: hits.map((hit, index) => ({ ...hit, index })),
          pagesWithoutText: stillWithoutText,
          truncated: !!raw.truncated,
          error: raw.error ?? null,
        });
      }
      setResults(next);
      // NOTHING is checked by default. A destructive tool does not pre-consent
      // on the user's behalf.
      setSelected(new Set());
      const total = next.reduce((sum, file) => sum + file.hits.length, 0);
      const firstError = next.find((file) => file.error)?.error ?? null;
      if (firstError) setError(firstError);
      setStatus(tChromeCount('panel.searchRedact.found', total));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, [activeFile, allFiles, call, expand, options, patterns, query, scope, wordList]);

  const markedByPath = useMemo(() => {
    const map = new Map<string, { page: number; rect: [number, number, number, number] }[]>();
    for (const mark of marked) {
      const path = mark.path;
      const list = map.get(path);
      if (list) list.push(mark);
      else map.set(path, [mark]);
    }
    return map;
  }, [marked]);

  const isMarked = useCallback(
    (path: string, hit: SearchHit) => hitIsMarked(hit, markedByPath.get(path) ?? []),
    [markedByPath],
  );

  /** The keys a group header may toggle: already-marked hits are excluded,
   * because ticking a box that cannot become a mark is a control that does
   * nothing. */
  const selectableKeys = useCallback(
    (path: string, hits: SearchHit[]) =>
      hits.filter((hit) => !isMarked(path, hit)).map((hit) => hitKey(path, hit)),
    [isMarked],
  );

  const anyTruncated = !!results?.some((file) => file.truncated);

  const markChecked = useCallback(async () => {
    if (!results) return;
    const service = getCanvasServices()?.redaction;
    if (!service) {
      setError(tChrome('panel.searchRedact.noCanvas'));
      return;
    }
    const requests = markRequests(results, selected);
    if (requests.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await service.addMarks(requests);
      await refreshMarked();
      setSelected(new Set());
      setStatus(
        tChrome('panel.searchRedact.marked', {
          added: outcome.added,
          duplicates: outcome.duplicates,
          skipped: outcome.skipped,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refreshMarked, results, selected]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.searchRedact.open')} />;
  }

  return (
    <div className="flex flex-col gap-3 h-full min-h-0" data-testid="search-redact-panel">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tChrome('panel.searchRedact.queryPlaceholder')}
          aria-label={tChrome('panel.searchRedact.queryAria')}
          data-testid="search-redact-query"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
          className="flex-1 min-w-0 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500"
        />
        <FindModeToggles options={options} onToggle={toggleOption} testIdPrefix="search-redact-mode" />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-sm text-neutral-400">{tChrome('panel.searchRedact.scope')}</label>
        <select
          value={scope.kind}
          onChange={(e) => setScope((prev) => ({ ...prev, kind: e.target.value as ScopeState['kind'] }))}
          aria-label={tChrome('panel.searchRedact.scopeAria')}
          data-testid="search-redact-scope"
          className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="document">{tChrome('panel.searchRedact.scopeDocument')}</option>
          <option value="all">{tChrome('panel.searchRedact.scopeAll')}</option>
          <option value="pages">{tChrome('panel.searchRedact.scopePages')}</option>
        </select>
        {scope.kind === 'pages' && (
          <input
            type="text"
            value={scope.pages}
            onChange={(e) => setScope((prev) => ({ ...prev, pages: e.target.value }))}
            placeholder="1,3,5-9"
            aria-label={tChrome('panel.searchRedact.pagesAria')}
            data-testid="search-redact-pages"
            className="w-32 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm"
          />
        )}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowWordList((v) => !v)}
          data-testid="search-redact-wordlist-toggle"
          aria-expanded={showWordList}
          className="text-sm text-neutral-300 hover:text-white"
        >
          {/* The caret is DECORATION, and it lives in its own element so the
              button's own text is the catalog string — a glyph glued to the
              front of it reads as bare English to the qps sweep, which is
              exactly the check that caught it. */}
          <span aria-hidden="true">{showWordList ? '▾' : '▸'}</span>{' '}
          {tChrome('panel.searchRedact.wordList')}
        </button>
        {showWordList && (
          <div className="mt-1 flex flex-col gap-1">
            <textarea
              value={wordList}
              onChange={(e) => setWordList(e.target.value)}
              rows={4}
              placeholder={tChrome('panel.searchRedact.wordListPlaceholder')}
              aria-label={tChrome('panel.searchRedact.wordListAria')}
              data-testid="search-redact-wordlist"
              className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm font-mono resize-y"
            />
            <button
              type="button"
              onClick={() => void importWordList()}
              className="self-start px-2 py-1 bg-neutral-700 hover:bg-neutral-600 rounded text-xs"
            >
              {tChrome('panel.searchRedact.importWordList')}
            </button>
          </div>
        )}
      </div>

      <fieldset className="border border-neutral-700 rounded p-2">
        <legend className="text-xs text-neutral-400 px-1">
          {tChrome('panel.searchRedact.patterns')}
        </legend>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {PATTERN_IDS.map((id) => (
            <label key={id} className="flex items-center gap-1.5 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={patterns.has(id)}
                onChange={() => togglePattern(id)}
                data-testid={`search-redact-pattern-${id}`}
              />
              {tChrome(`panel.searchRedact.pattern.${id}` as Parameters<typeof tChrome>[0])}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="border border-neutral-700 rounded p-2">
        <legend className="text-xs text-neutral-400 px-1">
          {tChrome('panel.searchRedact.expand')}
        </legend>
        <div className="flex flex-col gap-1">
          {EXPAND_MODES.map((mode) => (
            <label key={mode} className="flex items-start gap-1.5 text-sm text-neutral-300">
              <input
                type="radio"
                name="search-redact-expand"
                checked={expand === mode}
                onChange={() => setExpand(mode)}
                data-testid={`search-redact-expand-${mode}`}
                className="mt-1"
              />
              <span>
                {tChrome(`panel.searchRedact.expand.${mode}` as Parameters<typeof tChrome>[0])}
                <span className="block text-xs text-neutral-500">
                  {tChrome(`panel.searchRedact.expandHint.${mode}` as Parameters<typeof tChrome>[0])}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <button
          type="button"
          onClick={() => setShowProperties((v) => !v)}
          data-testid="search-redact-properties-toggle"
          aria-expanded={showProperties}
          className="text-sm text-neutral-300 hover:text-white"
        >
          <span aria-hidden="true">{showProperties ? '▾' : '▸'}</span>{' '}
          {tChrome('panel.searchRedact.properties')}
        </button>
        {/* The same control surface the hand-drawn band reads: the properties
            persist and govern both producers, so a code chosen here is on the
            next band too. */}
        {showProperties && <RedactionPropertiesFields />}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={busy}
          data-testid="search-redact-run"
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          {busy ? tChrome('panel.searchRedact.searching') : tChrome('panel.searchRedact.search')}
        </button>
        <button
          type="button"
          onClick={() => void markChecked()}
          disabled={busy || selected.size === 0 || stale}
          data-testid="search-redact-mark"
          className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          {tChromeCount('panel.searchRedact.markChecked', selected.size)}
        </button>
        {markCount > 0 && (
          <span className="text-xs text-neutral-400" data-testid="search-redact-markcount">
            {tChromeCount('panel.searchRedact.pending', markCount)}
          </span>
        )}
      </div>

      {/* The disk scope is a dialog of its own — it needs no open document and
          its results become files rather than marks — so this is the door to
          it from the surface someone reached for first. */}
      <button
        type="button"
        onClick={() => invokeCommand('tools.diskRedact')}
        data-testid="search-redact-folder"
        className="self-start text-xs text-neutral-400 hover:text-neutral-200 underline"
      >
        {tChrome('dialog.diskRedact.openPanel')}
      </button>

      {stale && (
        <div className="text-xs text-amber-400" data-testid="search-redact-stale">
          {tChrome('panel.searchRedact.stale')}
        </div>
      )}
      {anyTruncated && (
        <div className="text-xs text-amber-400" data-testid="search-redact-truncated">
          {tChrome('panel.searchRedact.truncated', { max: MAX_HITS })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto" data-testid="search-redact-results">
        {results?.map((file) => {
          const pages = groupByPage(file.hits);
          const fileKeys = selectableKeys(file.path, file.hits);
          const fileState = groupState(fileKeys, selected);
          return (
            <div key={file.path} className="mb-3">
              {results.length > 1 && (
                <div className="flex items-center gap-1.5 text-sm text-neutral-200 sticky top-0 bg-neutral-900 py-1">
                  <input
                    type="checkbox"
                    checked={fileState === 'all'}
                    ref={(el) => {
                      if (el) el.indeterminate = fileState === 'some';
                    }}
                    disabled={anyTruncated || fileKeys.length === 0}
                    title={anyTruncated ? tChrome('panel.searchRedact.truncatedSelectAll') : undefined}
                    onChange={() => setSelected((prev) => toggleGroup(fileKeys, prev))}
                    data-testid={`search-redact-file-check-${file.name}`}
                  />
                  <span className="truncate">{file.name}</span>
                  <span className="text-xs text-neutral-500">
                    {tChromeCount('panel.searchRedact.hitCount', file.hits.length)}
                  </span>
                </div>
              )}
              {file.pagesWithoutText.length > 0 && (
                <div className="text-xs text-amber-400 mb-1 flex items-center gap-2" data-testid="search-redact-notext">
                  <span>
                    {tChromeCount('panel.searchRedact.pagesWithoutText', file.pagesWithoutText.length)}
                  </span>
                  <button
                    type="button"
                    onClick={() => invokeCommand('tools.open.ocr')}
                    className="px-1.5 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded"
                  >
                    {tChrome('panel.searchRedact.runOcr')}
                  </button>
                </div>
              )}
              {pages.map((group) => {
                const keys = selectableKeys(file.path, group.hits);
                const state = groupState(keys, selected);
                return (
                  <div key={group.page} className="mb-2">
                    <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                      <input
                        type="checkbox"
                        checked={state === 'all'}
                        ref={(el) => {
                          if (el) el.indeterminate = state === 'some';
                        }}
                        disabled={keys.length === 0}
                        onChange={() => setSelected((prev) => toggleGroup(keys, prev))}
                        data-testid={`search-redact-page-check-${file.name}-${group.page}`}
                      />
                      {tChrome('panel.searchRedact.page', { page: group.page })}
                    </div>
                    {group.hits.map((hit) => {
                      const key = hitKey(file.path, hit);
                      const already = isMarked(file.path, hit);
                      return (
                        <div
                          key={key}
                          className="flex items-start gap-1.5 ps-4 py-0.5 text-sm hover:bg-neutral-800 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            disabled={already}
                            title={already ? tChrome('panel.searchRedact.alreadyMarked') : undefined}
                            onChange={() => setSelected((prev) => toggleOne(key, prev))}
                            data-testid={`search-redact-hit-${file.name}-${hit.page}-${hit.index}`}
                            className="mt-1"
                          />
                          <button
                            type="button"
                            onClick={() => getCanvasServices()?.jumpToFilePage(file.path, hit.page)}
                            className="flex-1 min-w-0 text-start"
                            title={tChrome('panel.searchRedact.jump')}
                          >
                            <span className="text-neutral-200">{hit.text}</span>
                            <span className="block text-xs text-neutral-500 truncate">
                              {hit.context}
                            </span>
                          </button>
                          <span className="text-[10px] text-neutral-500 mt-1 shrink-0">
                            {hit.source === 'query' || hit.source === 'terms'
                              ? ''
                              : hit.source === 'ocr'
                                ? tChrome('panel.searchRedact.sourceOcr')
                                : tChrome(
                                    `panel.searchRedact.pattern.${hit.source}` as Parameters<
                                      typeof tChrome
                                    >[0],
                                  )}
                            {hit.rects.some((r) => r.imprecise) && (
                              <span
                                className="ms-1 text-amber-500"
                                title={tChrome('panel.searchRedact.impreciseHint')}
                              >
                                ~
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
        {results && results.every((file) => file.hits.length === 0) && !busy && (
          <div className="text-sm text-neutral-500" data-testid="search-redact-none">
            {tChrome('panel.searchRedact.noHits')}
          </div>
        )}
      </div>

      {error && <div className="text-sm text-red-400">{tChrome('panel.common.error', { message: error })}</div>}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
