import React, { useCallback, useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { ChromeIcon } from '../chrome-icons';
import { NAV_PANEL_DEFS, navPanelDef } from './registry';
import type { NavPanelComponentProps } from './types';

// The left navigation pane (Phase 4 M3, § 5): a thin, always-docked icon strip
// (one button per AVAILABLE panel) + the active panel body at the persisted
// width, shown while the pane is open. The strip is chrome (frame under Mica);
// the body is content (opaque). F4 / the strip toggle open; clicking a strip
// icon switches panel (or closes if it's already active). Only rendered while
// a document tab is focused — App owns that gate.

type NavPaneProps = Omit<NavPanelComponentProps, 'activeFile'> & { activeFile: NavPanelComponentProps['activeFile'] };

export function NavPane(props: NavPaneProps): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { open, panel, width } = state.ui.navPane;

  // The selected panel may not exist yet (persisted a not-yet-built id); fall
  // back to the first available panel so the strip/body always resolve.
  const activeDef = navPanelDef(panel) ?? NAV_PANEL_DEFS[0];
  const ActivePanel = activeDef.Component;

  // Drag-resize (window-level pointer listeners, the canvas pattern). The pane
  // is anchored at its left edge; width = pointerX − left. The reducer clamps
  // to the minimum.
  const bodyRef = useRef<HTMLDivElement>(null);
  // Detach an in-flight resize's window listeners if the pane unmounts mid-drag
  // (e.g. a tab switch) — otherwise they leak.
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
      const onMove = (ev: PointerEvent) => {
        dispatch({ type: 'UI_SET_NAV_PANE_WIDTH', width: ev.clientX - left });
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

  return (
    <div className="nav-pane flex shrink-0" data-testid="nav-pane">
      <div className="nav-icon-strip app-rail" data-testid="nav-icon-strip">
        {NAV_PANEL_DEFS.map((def) => {
          // Highlight the panel actually SHOWN (activeDef, after the fallback),
          // not the raw persisted id — which may be a not-yet-built panel
          // (review-caught: strip would show nothing pressed while pages shows).
          const isActive = open && activeDef.id === def.id;
          return (
          <button
            key={def.id}
            type="button"
            data-testid={`navicon-${def.id}`}
            title={def.title}
            aria-label={def.title}
            aria-pressed={isActive}
            onClick={() => dispatch({ type: 'UI_OPEN_NAV_PANEL', panel: def.id })}
            className={'nav-icon-btn' + (isActive ? ' active' : '')}
          >
            <ChromeIcon icon={def.icon} />
          </button>
          );
        })}
      </div>
      {open && (
        <div
          ref={bodyRef}
          className="nav-panel-body app-content flex flex-col"
          style={{ width }}
          data-testid="nav-panel-body"
        >
          <div className="nav-panel-header" data-testid="nav-panel-title">
            {activeDef.title}
          </div>
          <div className="flex-1 min-h-0 relative">
            <ActivePanel {...props} />
          </div>
          <div
            className="nav-resize-handle"
            data-testid="nav-resize-handle"
            onPointerDown={onResizeDown}
            title="Drag to resize"
          />
        </div>
      )}
    </div>
  );
}
