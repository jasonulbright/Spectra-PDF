import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppStateProvider';
import { OPERATION_TITLES, type Operation } from '../commands/operations';
import { toolForOp } from '../commands/tools';
import { invokeCommand } from '../commands/context';
import { ToolsCenter } from './ToolsCenter';
import { ExtractTextPanel } from '../panels/ExtractTextPanel';
import { CommentSidebar } from './canvas/CommentSidebar';
import { getCanvasServices } from '../commands/context';
import { ToolIcon } from './tool-icons';

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
  const state = useAppState();
  const dispatch = useAppDispatch();
  const width = state.ui.toolDock.width;
  const activeOp = state.ui.activeOp as Operation;
  const owner = toolForOp(activeOp);
  const [showGrid, setShowGrid] = useState(false);

  // Anchored at the RIGHT edge: width = right − pointerX (the NavPane drag
  // mirrored). Window-level listeners, detached on unmount mid-drag.
  const bodyRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const right = bodyRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      const onMove = (ev: PointerEvent) => {
        dispatch({ type: 'UI_SET_TOOL_DOCK_WIDTH', width: right - ev.clientX });
      };
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        resizeCleanup.current = null;
      };
      const onUp = () => detach();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      resizeCleanup.current = detach;
    },
    [dispatch],
  );

  const Panel = panels[activeOp];
  const view = state.ui.toolDock.view;

  return (
    <div
      ref={bodyRef}
      className="tool-dock app-content"
      style={{ width }}
      data-testid="tool-dock"
      role="complementary"
      aria-label="Tool pane"
    >
      <div className="tool-dock-resize" data-testid="tool-dock-resize" onPointerDown={onResizeDown} title="Drag to resize" />
      <div className="tool-dock-header">
        <button
          type="button"
          data-testid="tool-dock-grid"
          title={showGrid ? 'Back to the open tool' : 'All tools'}
          aria-pressed={showGrid}
          onClick={() => setShowGrid((v) => !v)}
          className={'tool-dock-btn' + (showGrid ? ' active' : '')}
        >
          ⊞
        </button>
        <span className="tool-dock-title" data-testid="tool-dock-title">
          {view === 'comments'
            ? 'Comments'
            : showGrid
              ? 'All tools'
              : (owner?.title ?? OPERATION_TITLES[activeOp])}
        </span>
        <button
          type="button"
          data-testid="tool-dock-close"
          title="Close the tool pane"
          aria-label="Close the tool pane"
          onClick={() => dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: false })}
          className="tool-dock-btn"
        >
          ×
        </button>
      </div>
      {view === 'tool' && !showGrid && owner && owner.ops.length > 1 && (
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
              {OPERATION_TITLES[op]}
            </button>
          ))}
        </div>
      )}
      <div className="tool-dock-body">
        {view === 'comments' ? (
          // Slice D: the comment list re-homed from the floating sidebar into
          // the dock (the constitution's right-dock-actions rule). Data and
          // handlers come from state/dispatch; the jump rides the canvas
          // services' one true jump (openPageForReading).
          <CommentSidebar
            docs={state.workspace.documents}
            onSelectPage={() => {}}
            onJumpToPage={(pageId) => getCanvasServices()?.openPageForReading(pageId)}
            onUpdateAnnotation={(docId, pageId, annotationId, note) =>
              dispatch({ type: 'UPDATE_ANNOTATION', docId, pageId, annotationId, note })
            }
            onRecolorAnnotation={(docId, pageId, annotationId, color) =>
              dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color })
            }
            onRemoveAnnotation={(docId, pageId, annotationId) =>
              dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId })
            }
            onClose={() => dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: false })}
          />
        ) : showGrid ? (
          <ToolsCenter
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
