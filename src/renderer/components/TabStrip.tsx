import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { isDocTab } from '../state/types';
import type { FocusedTab } from '../state/types';
import { invokeCommand } from '../commands/context';
import { tabFilePaths } from '../commands/registry';
import { ChromeIcon } from './chrome-icons';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import { useStripRegistration, useTabDragSource, useTabDropCaret, type TabDropHandler } from './useTabDrag';
import { TEST_HARNESS_ENABLED, registerTabDrag } from '../testHarness';
import { tabDrag } from '../lib/tauri-bridge';

// The tab strip: Home | Tools | one tab per open
// document. A 1:1 evolution of the old Home/Tools/Canvas switcher + the
// Tools-rail file list (both retire). Doc tabs carry a dirty dot, a close ×
// (also middle-click), and an overflow dropdown when they don't fit.
//
// A doc tab also drags to another window. This side owns only the gesture and
// its own caret: the strip publishes its box to Rust, which hit-tests every
// window's box and tells whichever one is hovered to draw a caret. A window
// never paints into another.

interface TabStripProps {
  onCloseFile: (path: string) => void;
  /** Resolve a released drag; true when the document changed hands. */
  onTabDrop: TabDropHandler;
}

const tabBase =
  'group relative flex items-center gap-1.5 h-8 px-3 text-[13px] border-r border-neutral-800 ' +
  'select-none cursor-default max-w-[220px] whitespace-nowrap outline-none';
const activeCls = 'bg-neutral-900 text-white';
const idleCls = 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800';

export function TabStrip({ onCloseFile, onTabDrop }: TabStripProps): React.ReactElement {
  // Re-render on language change; labels resolve via tChrome.
  useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const focused = state.ui.focusedTab;
  const docPaths = tabFilePaths(state);

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

  // The box Rust hit-tests, republished whenever the strip can have moved
  // inside the window or the tab count relaid it out.
  const stripRef = useRef<HTMLDivElement>(null);
  useStripRegistration(stripRef, docPaths.length);
  const { onTabPointerDown, draggingPath } = useTabDragSource(onTabDrop);
  const caret = useTabDropCaret();

  // The e2e seam sits directly above the pointer gesture — a real drag between
  // two windows needs OS-level input — so the drop it calls is the one
  // pointerup calls, and nothing below it is bypassed.
  const dropRef = useRef(onTabDrop);
  dropRef.current = onTabDrop;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerTabDrag({
      drop: (path, point) => dropRef.current(path, point),
      track: (point) => tabDrag.track(point),
    });
    return () => registerTabDrag(null);
  }, []);

  return (
    <div
      ref={stripRef}
      data-testid="tab-strip"
      // The hover offset in this window's own CSS pixels. Published so the
      // cross-window hit-test can be checked against where this window says
      // its strip is — the one place a device-pixel-ratio disagreement
      // between windows would show up.
      data-tabdrag-x={caret === null ? undefined : Math.round(caret)}
      className="app-shell-bar app-tabstrip flex items-stretch h-8 border-b border-neutral-800 shrink-0 overflow-hidden"
    >
      <button
        type="button"
        data-testid="tab-home"
        onClick={() => invokeCommand('view.home')}
        className={`${tabBase} ${focused === 'home' ? activeCls : idleCls}`}
      >
        <ChromeIcon icon="home" size={14} className="opacity-80" />
        {tChrome('chrome.tabs.home')}
      </button>
      {/* The Tools pseudo-tab is retired: ops panels live in
          the right dock (Shift+F4), the tile grid lives on Home. */}
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
              onPointerDown={(e) => {
                // The close × and anything else clickable inside the tab keep
                // their own press; only the tab body drags.
                if ((e.target as HTMLElement).closest('button')) return;
                onTabPointerDown(path, !f.importOnly, e);
              }}
              onClick={() => focus({ doc: path })}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseFile(path);
                }
              }}
              title={f.path}
              className={`${tabBase} ${active ? activeCls : idleCls} ${draggingPath === path ? 'opacity-40' : ''}`}
            >
              <ChromeIcon icon="document" size={13} className="opacity-70 shrink-0" />
              <span className="truncate">{f.name}</span>
              {dirty && (
                <span data-testid={`tab-dirty-${i}`} className="status-dot w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              )}
              <button
                type="button"
                data-testid={`tab-close-${i}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(path);
                }}
                title={tChrome('chrome.tabs.closeFile', { name: f.name })}
                className="ms-1 w-4 h-4 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-700 opacity-0 group-hover:opacity-100 shrink-0"
              >
                <ChromeIcon icon="close" size={11} />
              </button>
            </div>
          );
        })}
        {/* Where the incoming tab will actually land. Doc tabs carry no order
            of their own — the order is open order — so the caret marks the end
            of the strip rather than following the pointer to a gap the drop
            would not honour. */}
        {caret !== null && (
          <div
            data-testid="tab-drop-caret"
            className="self-stretch w-0.5 bg-blue-400 shrink-0"
          />
        )}
      </div>

      {overflowing && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-testid="tab-overflow"
              title={tChrome('chrome.tabs.allOpenDocuments')}
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
                    {isFileDirty(path) && <span className="status-dot w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
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
