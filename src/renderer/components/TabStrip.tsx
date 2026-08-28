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
import {
  useStripRegistration,
  useTabDragSource,
  useTabDropCaret,
  useTabOrderPublication,
  type TabReleaseHandler,
} from './useTabDrag';
import {
  ownStripX,
  reorderIndexFor,
  tabGapFor,
  type OwnStripFrame,
  type TabBox,
  type TabGap,
} from '../lib/tab-drag';
import { TEST_HARNESS_ENABLED, registerTabDrag } from '../testHarness';
import { tabDrag, type PhysicalScreenPoint } from '../lib/tauri-bridge';

// The tab strip: Home | Tools | one tab per open
// document. A 1:1 evolution of the old Home/Tools/Canvas switcher + the
// Tools-rail file list (both retire). Doc tabs carry a dirty dot, a close ×
// (also middle-click), and an overflow dropdown when they don't fit.
//
// A doc tab drags to another window, and within this one it reorders. Across
// windows this side owns only the gesture: the strip publishes its box to Rust,
// which hit-tests every window's box and tells whichever one is hovered to draw
// a caret. A window never paints into another. Within one window nothing
// crosses at all — the strip is right here, so the gap a release names is
// measured off this DOM, by the same arithmetic the hovered window uses.

interface TabStripProps {
  onCloseFile: (path: string) => void;
  /** Resolve a released drag; true when the document changed hands. */
  onTabDrop: TabReleaseHandler;
}

// A tab is as wide as its name until the lane runs out of room, and only then
// does it shrink. The fixed 220px cap truncated "Quarterly Operations Re…"
// with 1400px of empty strip beside it, and truncated the ACTIVE tab while a
// shorter inactive sibling stayed whole — because the cap was never a function
// of available width. `shrink` plus `min-w` makes the lane distribute the
// pressure: full names when there is room, even compression when there is not,
// and the overflow dropdown below once even that is exhausted.
const tabBase =
  'group relative flex items-center gap-1.5 h-8 px-3 text-[13px] border-r border-neutral-800 ' +
  'select-none cursor-default shrink min-w-[104px] max-w-[420px] whitespace-nowrap outline-none';
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
  // What a session snapshot arranges this window's documents by.
  useTabOrderPublication(docPaths);

  // Measured on demand rather than held in state: a strip that scrolled, a
  // window that moved and a tab that was closed all change these numbers
  // without re-rendering anything, and a drag reads them at most once a frame.
  const measureFrame = useCallback((): OwnStripFrame | null => {
    const el = stripRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      originX: window.screenX,
      originY: window.screenY,
      devicePixelRatio: window.devicePixelRatio || 1,
      strip: { left: box.left, top: box.top, width: box.width, height: box.height },
    };
  }, []);

  /** Every doc tab's box, in the strip's own space. Includes the tab being
   * dragged: it still occupies its place until the release moves it. */
  const tabBoxes = useCallback((stripLeft: number): TabBox[] => {
    const lane = laneRef.current;
    if (!lane) return [];
    return Array.from(lane.querySelectorAll<HTMLElement>('[data-tab-path]')).map((el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left - stripLeft, width: box.width };
    });
  }, []);

  /** The gap an offset into this strip names. */
  const gapAtX = useCallback(
    (x: number): TabGap | null => {
      const frame = measureFrame();
      return frame ? tabGapFor(tabBoxes(frame.strip.left), x) : null;
    },
    [measureFrame, tabBoxes],
  );

  /** The gap a physical screen point names, or null when the point is not over
   * this window's own strip — where the release is a hand-off instead. */
  const ownGapAt = useCallback(
    (point: PhysicalScreenPoint): TabGap | null => {
      const frame = measureFrame();
      if (!frame) return null;
      const x = ownStripX(point, frame);
      return x === null ? null : tabGapFor(tabBoxes(frame.strip.left), x);
    },
    [measureFrame, tabBoxes],
  );

  const pathsRef = useRef(docPaths);
  pathsRef.current = docPaths;
  const handlerRef = useRef(onTabDrop);
  handlerRef.current = onTabDrop;

  // Where a release goes, decided before anything else runs: a point over this
  // window's own strip is a reorder and asks the far side nothing, and every
  // other point is the hand-off it has always been.
  const releaseDragAt = useCallback(
    async (path: string, point: PhysicalScreenPoint): Promise<boolean> => {
      const gap = ownGapAt(point);
      const from = pathsRef.current.indexOf(path);
      if (gap === null || from === -1) return handlerRef.current(path, point, null);
      return handlerRef.current(path, point, reorderIndexFor(from, gap.index));
    },
    [ownGapAt],
  );

  const { onTabPointerDown, draggingPath, ownGap } = useTabDragSource(releaseDragAt, ownGapAt);
  const caret = useTabDropCaret(gapAtX);
  // A drag of this window's own tab and a drag hovering in from another cannot
  // both be live: the far side never reports a hover to the window holding the
  // pointer.
  const gap = ownGap ?? caret.gap;

  // The e2e seam sits directly above the pointer gesture — a real drag between
  // two windows needs OS-level input — so the drop it calls is the one
  // pointerup calls, and nothing below it is bypassed.
  const dropRef = useRef(releaseDragAt);
  dropRef.current = releaseDragAt;
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
      // The hover offset in this window's own CSS pixels, RAW — where the
      // pointer is, not where the caret snapped to. Published so the
      // cross-window hit-test can be checked against where this window says
      // its strip is — the one place a device-pixel-ratio disagreement
      // between windows would show up.
      data-tabdrag-x={caret.x === null ? undefined : Math.round(caret.x)}
      // The insertion gap that offset resolves to among THIS window's tabs,
      // for either caret. What a release actually honours.
      data-tabdrag-gap={gap === null ? undefined : gap.index}
      className="app-shell-bar app-tabstrip relative flex items-stretch h-8 border-b border-neutral-800 shrink-0 overflow-hidden"
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
      {/* `overflow-y-hidden` is load-bearing, not tidying: with only
          `overflow-x-auto` the block axis computes to `auto` too, and the lane
          grew a vertical scrollbar whose thumb was the unexplained pill beside
          the last tab. There is nothing to scroll vertically here — the lane is
          one row of fixed-height tabs. */}
      <div ref={laneRef} className="flex items-stretch overflow-x-auto overflow-y-hidden app-tab-lane">
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
      </div>

      {/* Where the tab will actually land — the gap the release honours,
          whether the drag belongs to this window or is hovering in from
          another. Positioned against the strip rather than laid out in the
          lane, so it can mark a gap BETWEEN two tabs without moving them. */}
      {gap !== null && (
        <div
          data-testid="tab-drop-caret"
          className="absolute top-0 bottom-0 w-0.5 bg-blue-400 pointer-events-none"
          style={{ left: `${gap.offset}px` }}
        />
      )}

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
