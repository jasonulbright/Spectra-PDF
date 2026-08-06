import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { useSearchContext } from '../search/SearchProvider';
import { TOOL_DEFS, type ToolId } from '../commands/tools';
import { rankToolMatches } from '../search/omnisearch-rank';
import { invokeCommand, isCommandEnabled, getCanvasServices } from '../commands/context';
import { showableDoc } from '../state/selectors';
import { ToolIcon } from './tool-icons';
import { TILE_GLYPH } from './ToolsCenter';
import { useTranslation } from 'react-i18next';
import { formattingLocale, tChrome, tToolDescription, tToolTitle } from '../i18n';

// The universal search box in the toolbar row.
//
// ONE box, TWO kinds of answer: the tools you can run and the text in the
// document you are reading. That pairing is the point — a user who types
// "redact" wants the tool, and a user who types a phrase from page 12 wants
// page 12, and making them choose a surface first is the thing being removed.
//
// Two rules this leans on rather than reimplements:
//  - Tool results INVOKE THE COMMAND (`tools.open.<id>`) and read enablement
//    from `isCommandEnabled`, so this surface can never offer a tool the menus
//    consider unrunnable. Same discipline as the tiles.
//  - Text results come from the shared search index (`useSearchContext`),
//    whose regex path runs in a time-budgeted worker. Nothing here scans text
//    itself, so the ReDoS hardening keeps covering this entry point too.

interface ToolHit {
  kind: 'tool';
  id: ToolId;
  title: string;
  description: string;
  enabled: boolean;
}
interface TextHit {
  kind: 'text';
  pageId: string;
  docName: string;
  pageNumber: number;
  snippet: string;
}
type Hit = ToolHit | TextHit;

const MAX_TOOL_HITS = 5;
const MAX_TEXT_HITS = 8;

export function OmniSearch(): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  const { i18n } = useTranslation();
  const language = i18n.language;
  const state = useAppState();
  const { search, snippetsFor, version } = useSearchContext();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [textHits, setTextHits] = useState<TextHit[]>([]);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same 150ms the Search panel uses — a keystroke must not start a scan.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(id);
  }, [query]);

  // Rank over the LOCALIZED names, not TOOL_DEFS' English. A search box
  // that scores what the user cannot see is a search box that returns nothing
  // for every query typed in the UI language — and the ranking's tie-break
  // collates in the language it is handed, which must be the displayed one.
  const toolHits: ToolHit[] = useMemo(
    () =>
      rankToolMatches(
        debounced,
        TOOL_DEFS.map((t) => ({
          id: t.id,
          title: tToolTitle(t.id, t.title, language),
          description: tToolDescription(t.id, t.description, language),
        })),
        formattingLocale(language),
      )
        .slice(0, MAX_TOOL_HITS)
        .map((t) => ({
          kind: 'tool' as const,
          id: t.id,
          title: t.title,
          description: t.description,
          enabled: isCommandEnabled(`tools.open.${t.id}`),
        })),
    [debounced, language],
  );

  const docs = state.workspace.documents;
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setTextHits([]);
      return;
    }
    let alive = true;
    void (async () => {
      const result = await search(q);
      if (!alive) return;
      // An unusable pattern is not an error worth shouting about HERE — the
      // box is also a tool launcher, and "(a+)+" is a perfectly good prefix of
      // nothing. The Search panel remains the surface that explains why.
      if (result.error || result.pageIds.size === 0) {
        setTextHits([]);
        return;
      }
      const snippets = await snippetsFor(q);
      if (!alive) return;
      const out: TextHit[] = [];
      for (const doc of docs) {
        doc.pages.forEach((page, i) => {
          if (out.length >= MAX_TEXT_HITS) return;
          if (!result.pageIds.has(page.id)) return;
          out.push({
            kind: 'text',
            pageId: page.id,
            docName: doc.name,
            pageNumber: i + 1,
            snippet: snippets.get(page.id) ?? '',
          });
        });
      }
      setTextHits(out);
    })();
    return () => {
      alive = false;
    };
    // `version` is the index's change signal (OCR text landing) — a bump must
    // re-run the scan even though the value itself is never read.
  }, [debounced, search, snippetsFor, docs, version]);

  const hits: Hit[] = useMemo(() => [...toolHits, ...textHits], [toolHits, textHits]);
  useEffect(() => setActive(0), [debounced]);

  const close = useCallback(() => {
    setOpen(false);
    setActive(0);
  }, []);

  const run = useCallback(
    (hit: Hit) => {
      if (hit.kind === 'tool') {
        if (!hit.enabled) return;
        invokeCommand(`tools.open.${hit.id}`);
      } else {
        getCanvasServices()?.openPageForReading(hit.pageId);
      }
      setQuery('');
      setDebounced('');
      close();
      inputRef.current?.blur();
    },
    [close],
  );

  // Dismiss on an outside pointerdown. Window-level, like the other overlays.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
        setDebounced('');
      } else {
        close();
        inputRef.current?.blur();
      }
      return;
    }
    if (hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[active];
      if (hit) run(hit);
    }
  };

  const hasDoc = showableDoc(state) !== null;
  const showPanel = open && debounced.trim().length > 0;

  return (
    <div className="omnisearch" ref={rootRef} data-testid="omnisearch">
      <input
        ref={inputRef}
        data-testid="omnisearch-input"
        className="omnisearch-input"
        type="text"
        value={query}
        placeholder={tChrome('chrome.search.placeholder')}
        aria-label={tChrome('chrome.search.ariaLabel')}
        aria-expanded={showPanel}
        role="combobox"
        aria-controls="omnisearch-results"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {showPanel && (
        <div className="omnisearch-panel" id="omnisearch-results" role="listbox" data-testid="omnisearch-results">
          {hits.length === 0 && (
            <div className="omnisearch-empty" data-testid="omnisearch-empty">
              {tChrome('chrome.search.noMatch', { query: debounced.trim() })}
            </div>
          )}
          {toolHits.length > 0 && (
            <div className="omnisearch-head">{tChrome('chrome.search.tools')}</div>
          )}
          {toolHits.map((hit, i) => (
            <button
              key={`tool-${hit.id}`}
              type="button"
              role="option"
              aria-selected={active === i}
              data-testid={`omnisearch-tool-${hit.id}`}
              disabled={!hit.enabled}
              title={hit.enabled ? hit.description : tChrome('chrome.search.openFirst')}
              className={'omnisearch-row' + (active === i ? ' active' : '')}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => run(hit)}
            >
              <span className="omnisearch-icon" aria-hidden="true">
                <ToolIcon op={TILE_GLYPH[hit.id]} size={14} />
              </span>
              <span className="omnisearch-label">{hit.title}</span>
            </button>
          ))}
          {textHits.length > 0 && (
            <div className="omnisearch-head">
              {hasDoc
                ? tChrome('chrome.search.inThisDocument')
                : tChrome('chrome.search.inOpenDocuments')}
            </div>
          )}
          {textHits.map((hit, i) => {
            const idx = toolHits.length + i;
            return (
              <button
                key={`text-${hit.pageId}`}
                type="button"
                role="option"
                aria-selected={active === idx}
                data-testid={`omnisearch-text-${hit.pageId}`}
                className={'omnisearch-row' + (active === idx ? ' active' : '')}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => run(hit)}
              >
                <span className="omnisearch-page">p.{hit.pageNumber}</span>
                <span className="omnisearch-snippet">{hit.snippet || hit.docName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
