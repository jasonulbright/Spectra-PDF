import React, { useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome, type UiKey } from '../i18n';
import { dialog } from '../lib/tauri-bridge';
import { CountSymbolGlyph } from './CountSymbolGlyph';
import {
  getSymbolSets,
  removeSymbolSet,
  searchSymbols,
  subscribeSymbolSets,
  type SymbolDef,
  type SymbolHit,
  type SymbolSet,
} from '../lib/symbol-library';
import { exportSymbolSetToPath, importSymbolSetFromPath } from '../lib/symbol-set-io';
import { startSymbolDrag } from '../lib/symbol-drag';

// N11 slice D — the searchable symbol palette.
//
// ONE component, two surfaces (the brief's "one symbol registry, two
// consumers"): the Comment tool's stamp picker places symbols from it, and the
// Takeoff panel picks a count group's marker from it. The difference is a
// `mode`, not a second implementation — the alternative was two pickers
// drifting apart over which sets they knew about.
//
// Placement is a POINTER drag with window-level listeners (`symbol-drag.ts`),
// because HTML5 DnD cannot complete in this webview. A press that does not
// travel is a CLICK, which arms the symbol instead: both gestures live on the
// same button, which is what a drafter expects from a palette.

export interface SymbolPaletteProps {
  /** `place` = the stamp picker (drag onto the page, click to arm);
   *  `pick` = choose a marker (click only). */
  mode: 'place' | 'pick';
  /** The symbol shown as chosen, by ID — never by name (a localized label is
   * not identity; the STAMP_PRESETS landmine, recorded). */
  selectedId?: string;
  /** Draw colour for the glyphs and the drag ghost. */
  color: string;
  onPick: (hit: SymbolHit) => void;
  /** Show the set manager (import / export / remove). The dock panel has the
   * room for it; the toolbar shows import only. */
  manage?: boolean;
  /** Disambiguates the test hooks when two palettes are mounted at once. */
  idPrefix: string;
  /** Rows of symbols to show before the list scrolls. */
  compact?: boolean;
}

/** A symbol's shown name: OURS localizes (it is our word, like a built-in
 * stamp's), a user's is their own data and is shown verbatim. */
export function symbolDisplayName(set: SymbolSet, symbol: SymbolDef): string {
  return set.builtin ? tChrome(`panel.symbols.name.${symbol.id}` as UiKey) : symbol.name;
}

/** Same rule for the set's own name. */
export function symbolSetDisplayName(set: SymbolSet): string {
  return set.builtin ? tChrome(`panel.symbols.set.${set.id}` as UiKey) : set.name;
}

export function SymbolPalette({
  mode,
  selectedId,
  color,
  onPick,
  manage = false,
  idPrefix,
  compact = false,
}: SymbolPaletteProps): React.JSX.Element {
  useTranslation();
  const sets = useSyncExternalStore(subscribeSymbolSets, getSymbolSets, getSymbolSets);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  // A press that became a drag must not also fire the click that would arm the
  // symbol — one gesture, one outcome.
  const suppressClick = useRef(false);

  // Recomputed every render, deliberately: the search runs over a few dozen
  // symbols, and its inputs include the LANGUAGE (a display name is what a
  // query matches) — a dependency list would have to name something the
  // linter cannot see, for work too small to be worth memoizing.
  const grouped: { set: SymbolSet; symbols: SymbolDef[] }[] = [];
  for (const hit of searchSymbols(query, symbolDisplayName, sets)) {
    const row = grouped.find((g) => g.set.id === hit.set.id);
    if (row) row.symbols.push(hit.symbol);
    else grouped.push({ set: hit.set, symbols: [hit.symbol] });
  }

  const importSet = async (): Promise<void> => {
    const path = await dialog.pickAnyFile();
    if (!path) return;
    try {
      const res = await importSymbolSetFromPath(path);
      setStatus({
        text: tChrome(
          res.outcome === 'updated' ? 'panel.symbols.updated' : 'panel.symbols.imported',
          { name: res.set.name, count: res.set.symbols.length },
        ),
        error: false,
      });
    } catch (e: unknown) {
      setStatus({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const exportSet = async (set: SymbolSet): Promise<void> => {
    const path = await dialog.saveFile({
      defaultPath: `${set.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'symbols'}.json`,
    });
    if (!path) return;
    try {
      await exportSymbolSetToPath(set, path);
      setStatus({ text: tChrome('panel.symbols.exported', { name: set.name }), error: false });
    } catch (e: unknown) {
      setStatus({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <div className="symbol-palette" data-testid={`${idPrefix}-palette`}>
      <div className="symbol-palette-head">
        <input
          type="search"
          className="symbol-palette-search"
          data-testid={`${idPrefix}-search`}
          value={query}
          placeholder={tChrome('panel.symbols.search')}
          aria-label={tChrome('panel.symbols.searchAria')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="symbol-palette-action"
          data-testid={`${idPrefix}-import`}
          title={tChrome('panel.symbols.importHint')}
          onClick={() => void importSet()}
        >
          {tChrome('panel.symbols.import')}
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="symbol-palette-empty" data-testid={`${idPrefix}-nomatch`}>
          {tChrome('panel.symbols.noMatch')}
        </p>
      ) : (
        <div className={'symbol-palette-sets' + (compact ? ' compact' : '')}>
          {grouped.map(({ set, symbols }) => (
            <div key={set.id} className="symbol-palette-set" data-testid={`${idPrefix}-set-${set.id}`}>
              <div className="symbol-palette-set-head">
                <span className="symbol-palette-set-name">{symbolSetDisplayName(set)}</span>
                {manage && !set.builtin && (
                  <>
                    <button
                      type="button"
                      className="symbol-palette-action"
                      data-testid={`${idPrefix}-export-${set.id}`}
                      onClick={() => void exportSet(set)}
                    >
                      {tChrome('panel.symbols.export')}
                    </button>
                    <button
                      type="button"
                      className="symbol-palette-action"
                      data-testid={`${idPrefix}-remove-${set.id}`}
                      title={tChrome('panel.symbols.removeHint')}
                      onClick={() => {
                        removeSymbolSet(set.id);
                        setStatus({
                          text: tChrome('panel.symbols.removed', { name: set.name }),
                          error: false,
                        });
                      }}
                    >
                      {tChrome('panel.symbols.remove')}
                    </button>
                  </>
                )}
              </div>
              <div className="symbol-palette-grid" role="group" aria-label={symbolSetDisplayName(set)}>
                {symbols.map((symbol) => {
                  const name = symbolDisplayName(set, symbol);
                  const chosen = selectedId === symbol.id;
                  return (
                    <button
                      key={symbol.id}
                      type="button"
                      // The ID is the hook and the armed state, never the
                      // localized name.
                      data-testid={`${idPrefix}-item-${symbol.id}`}
                      aria-pressed={chosen}
                      aria-label={name}
                      title={
                        mode === 'place' ? tChrome('panel.symbols.placeHint', { name }) : name
                      }
                      className={'symbol-palette-item' + (chosen ? ' active' : '')}
                      onPointerDown={(e) => {
                        if (mode !== 'place' || e.button !== 0) return;
                        startSymbolDrag(
                          { symbolId: symbol.id, name, parts: symbol.parts, color },
                          e.clientX,
                          e.clientY,
                          (dragged) => {
                            suppressClick.current = dragged;
                          },
                        );
                      }}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onPick({ set, symbol });
                      }}
                    >
                      <CountSymbolGlyph parts={symbol.parts} color={color} size={20} />
                      <span className="symbol-palette-item-name">{name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {status && (
        <div
          className={'symbol-palette-status' + (status.error ? ' error' : '')}
          data-testid={`${idPrefix}-status`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
