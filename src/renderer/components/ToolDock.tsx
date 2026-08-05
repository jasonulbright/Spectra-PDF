import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { TOOL_DOCK_LIST_WIDTH } from '../state/types';
import { OPERATION_TITLES, type Operation } from '../commands/operations';
import { toolForOp } from '../commands/tools';
import { invokeCommand } from '../commands/context';
import { ToolsCenter } from './ToolsCenter';
import { ExtractTextPanel } from '../panels/ExtractTextPanel';
import { ToolIcon } from './tool-icons';
import { useTranslation } from 'react-i18next';
import { tChrome, tOperationTitle, tToolTitle } from '../i18n';

// The right tool dock (Phase 10 slice B1 — 25-workbench-relayout.md § 3.B1).
// Ops-tool panels render HERE, beside an always-visible document, instead of
// on the full-page Tools tab (which survives as a redundant-but-working
// legacy surface until slice C). The dock shows the active operation's panel
// with the owning tool's op switcher; the ⊞ button flips to the ToolsCenter
// grid — the same tile data — as the dock's "all tools" view.

interface ToolDockProps {
  panels: Record<Operation, React.ComponentType>;
  /** Extract-from-canvas hands the panel its page (slice C: the special case
   * the Tools tab used to render — the dock carries it now). */
  extractPage: number | null;
  onConsumeExtractPage: () => void;
}

export function ToolDock({ panels, extractPage, onConsumeExtractPage }: ToolDockProps): React.JSX.Element {
  // N12: re-render on language change; strings resolve via tChrome/tTool*.
  useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const width = state.ui.toolDock.width;
  const activeOp = state.ui.activeOp as Operation;
  const owner = toolForOp(activeOp);
  const [showGrid, setShowGrid] = useState(false);
  // Width animates between the list and a panel, but must NOT animate while a
  // drag is driving it — a transition on a pointer-tracked width lags behind
  // the cursor.
  const [resizing, setResizing] = useState(false);

  // Anchored at the RIGHT edge: width = right − pointerX (the NavPane drag
  // mirrored). Window-level listeners, detached on unmount mid-drag.
  const bodyRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setResizing(true);
      const right = bodyRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      const onMove = (ev: PointerEvent) => {
        dispatch({ type: 'UI_SET_TOOL_DOCK_WIDTH', width: right - ev.clientX });
      };
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        resizeCleanup.current = null;
        setResizing(false);
      };
      const onUp = () => detach();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      resizeCleanup.current = detach;
    },
    [dispatch],
  );

  const Panel = panels[activeOp];
  // The dock is sized to what it currently HOLDS (U1): the all-tools list is a
  // fixed-width index of names, so it contracts to TOOL_DOCK_LIST_WIDTH, and
  // opening a tool expands back to the user's own width.
  const listView = showGrid;
  const effectiveWidth = listView ? TOOL_DOCK_LIST_WIDTH : width;

  return (
    <div
      ref={bodyRef}
      className={'tool-dock app-content' + (resizing ? '' : ' tool-dock-animated')}
      style={{ width: effectiveWidth }}
      data-testid="tool-dock"
      data-dock-view={listView ? "list" : "tool"}
      role="complementary"
      aria-label={tChrome('dock.paneLabel')}
    >
      {/* No resize grip on the list: its width is a constant, and a drag would
          otherwise write a clamped (>= 300px) value into the width the TOOL
          panels remember. */}
      {!listView && (
        <div className="tool-dock-resize" data-testid="tool-dock-resize" onPointerDown={onResizeDown} title={tChrome('dock.resize')} />
      )}
      <div className="tool-dock-header">
        {/* Inside a tool this is a labeled back control. In the list it stays
            the compact toggle back to the open tool. The test id and handler
            stay the same; only the affordance changes. */}
        <button
          type="button"
          data-testid="tool-dock-grid"
          title={listView ? tChrome('dock.backTitle') : tChrome('dock.allTools')}
          aria-label={listView ? tChrome('dock.backTitle') : tChrome('dock.backAria')}
          aria-pressed={listView}
          onClick={() => setShowGrid((v) => !v)}
          className={listView ? 'tool-dock-btn active' : 'tool-dock-btn tool-dock-back'}
        >
          {listView ? '⊞' : tChrome('dock.backLabel')}
        </button>
        <span className="tool-dock-title" data-testid="tool-dock-title">
          {showGrid
            ? tChrome('dock.allTools')
            : owner
              ? tToolTitle(owner.id, owner.title)
              : tOperationTitle(activeOp, OPERATION_TITLES[activeOp])}
        </span>
        <button
          type="button"
          data-testid="tool-dock-close"
          title={tChrome('dock.close')}
          aria-label={tChrome('dock.close')}
          onClick={() => dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: false })}
          className="tool-dock-btn"
        >
          ×
        </button>
      </div>
      {!showGrid && owner && owner.ops.length > 1 && (
        <div className="tool-dock-ops" data-testid="tool-dock-ops">
          {owner.ops.map((op) => (
            <button
              key={op}
              type="button"
              data-testid={`dock-op-${op}`}
              aria-pressed={activeOp === op}
              className={'tool-op' + (activeOp === op ? ' active' : '')}
              onClick={() => invokeCommand(`tools.panel.${op}`)}
            >
              <ToolIcon op={op} />
              {tOperationTitle(op, OPERATION_TITLES[op])}
            </button>
          ))}
        </div>
      )}
      <div className="tool-dock-body">
        {showGrid ? (
          <ToolsCenter
            embedded
            onOpenTool={(id) => {
              setShowGrid(false);
              invokeCommand(`tools.open.${id}`);
            }}
          />
        ) : activeOp === 'extract_text' ? (
          <ExtractTextPanel initialPage={extractPage} onConsumeInitialPage={onConsumeExtractPage} />
        ) : (
          <Panel />
        )}
      </div>
    </div>
  );
}
