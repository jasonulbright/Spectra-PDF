import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { isDocTab } from '../state/types';
import type { FocusedTab } from '../state/types';
import { invokeCommand } from '../commands/context';
import { tabFiles } from '../commands/registry';
import { ChromeIcon } from './chrome-icons';

// The tab strip (Phase 4 M2, § 3.1): Home | Tools | one tab per open
// document. A 1:1 evolution of the old Home/Tools/Canvas switcher + the
// Tools-rail file list (both retire). Doc tabs carry a dirty dot, a close ×
// (also middle-click), and an overflow dropdown when they don't fit.

interface TabStripProps {
  onCloseFile: (path: string) => void;
}

const tabBase =
  'group relative flex items-center gap-1.5 h-8 px-3 text-[13px] border-r border-neutral-800 ' +
  'select-none cursor-default max-w-[220px] whitespace-nowrap outline-none';
const activeCls = 'bg-neutral-900 text-white';
const idleCls = 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800';

export function TabStrip({ onCloseFile }: TabStripProps): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const focused = state.ui.focusedTab;
  const docPaths = tabFiles(state);

  const isFileDirty = useCallback(
    (path: string): boolean => {
      const f = state.files.get(path);
      return !!f && (f.dirty || state.pageDirtyPaths.includes(path));
    },
    [state.files, state.pageDirtyPaths],
  );

  // Overflow: the doc-tab lane scrolls, and a chevron dropdown appears only
  // when the tabs actually overflow their lane (measured, not count-guessed).
  const laneRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const measure = () => setOverflowing(lane.scrollWidth > lane.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(lane);
    return () => ro.disconnect();
  }, [docPaths.length]);

  // Keep the focused doc tab in view when focus changes (Ctrl+Tab, open).
  useEffect(() => {
    if (!isDocTab(focused)) return;
    const el = laneRef.current?.querySelector<HTMLElement>(
      `[data-tab-path="${CSS.escape(focused.doc)}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focused]);

  const focus = (tab: FocusedTab) => dispatch({ type: 'UI_FOCUS_TAB', tab });

  return (
    <div data-testid="tab-strip" className="app-shell-bar app-tabstrip flex items-stretch h-8 border-b border-neutral-800 shrink-0 overflow-hidden">
      <button
        type="button"
        data-testid="tab-home"
        onClick={() => invokeCommand('view.home')}
        className={`${tabBase} ${focused === 'home' ? activeCls : idleCls}`}
      >
        <ChromeIcon icon="home" size={14} className="opacity-80" />
        Home
      </button>
      <button
        type="button"
        data-testid="tab-tools"
        onClick={() => invokeCommand('view.tools')}
        className={`${tabBase} ${focused === 'tools' ? activeCls : idleCls}`}
      >
        <ChromeIcon icon="tools" size={14} className="opacity-80" />
        Tools
      </button>

      <div ref={laneRef} className="flex items-stretch overflow-x-auto app-tab-lane">
        {docPaths.map((path, i) => {
          const f = state.files.get(path);
          if (!f) return null;
          const active = isDocTab(focused) && focused.doc === path;
          const dirty = isFileDirty(path);
          return (
            <div
              key={path}
              data-tab-path={path}
              data-testid={`tab-doc-${i}`}
              onClick={() => focus({ doc: path })}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseFile(path);
                }
              }}
              title={f.path}
              className={`${tabBase} ${active ? activeCls : idleCls}`}
            >
              <ChromeIcon icon="document" size={13} className="opacity-70 shrink-0" />
              <span className="truncate">{f.name}</span>
              {dirty && (
                <span data-testid={`tab-dirty-${i}`} className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              )}
              <button
                type="button"
                data-testid={`tab-close-${i}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(path);
                }}
                title={`Close ${f.name}`}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-700 opacity-0 group-hover:opacity-100 shrink-0"
              >
                <ChromeIcon icon="close" size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {overflowing && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-testid="tab-overflow"
              title="All open documents"
              className="flex items-center justify-center w-8 border-l border-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-800 shrink-0 outline-none"
            >
              <ChromeIcon icon="overflow" size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={2}
              className="min-w-[220px] max-h-[60vh] overflow-y-auto bg-neutral-800 border border-neutral-700 rounded-md shadow-2xl p-1 z-50"
            >
              {docPaths.map((path) => {
                const f = state.files.get(path);
                if (!f) return null;
                const active = isDocTab(focused) && focused.doc === path;
                return (
                  <DropdownMenu.Item
                    key={path}
                    onSelect={() => focus({ doc: path })}
                    className="flex items-center gap-2 px-2.5 py-1 text-[13px] rounded-sm cursor-default select-none text-neutral-200 outline-none data-[highlighted]:bg-blue-600 data-[highlighted]:text-white"
                  >
                    <ChromeIcon icon="document" size={13} className="opacity-70 shrink-0" />
                    <span className="truncate flex-1">{f.name}</span>
                    {isFileDirty(path) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
                    {active && <span className="text-[11px] text-blue-300">●</span>}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
