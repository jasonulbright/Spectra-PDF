import React, { useRef } from 'react';
import type { DocViewMode } from '../../state/types';

// The docked status bar (Phase 10 slice A — 25-workbench-relayout.md § 3.A).
// Replaces the floating bottom-right cluster: view state (page box, zoom,
// Read⇄Organize), the Comments toggle (temporary home until slice D moves the
// sidebar into the right dock), and the PENDING-COMMIT segment (Apply / Fill
// N / Redact N) — the never-invisible invariant now holds by being ANCHORED
// chrome instead of buttons hovering over the page.
//
// Presentational by design: the page-box state machine (blur-no-teleport,
// doc-switch reset, the goToPage service focusing its ref) stays in
// WorkspaceCanvasView untouched — this component just gives it a docked home.
// Testids are UNCHANGED from the floating cluster so the e2e surface is
// stable (only the removed duplicate Find toggle is gone).

export interface StatusBarPageBox {
  inputRef: React.Ref<HTMLInputElement>;
  value: string;
  total: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

interface CanvasStatusBarProps {
  docViewMode: DocViewMode;
  onToggleView: () => void;
  showComments: boolean;
  onToggleComments: () => void;
  /** null hides the page segment (Organize board has no "current" page). */
  pageBox: StatusBarPageBox | null;
  onZoomOut: () => void;
  onFit: () => void;
  onZoomIn: () => void;
  dirty: boolean;
  onApplyPageEdits: () => void;
  pendingFormCount: number;
  fillingForms: boolean;
  onApplyForms: () => void;
  onClearForms: () => void;
  markCount: number;
  redacting: boolean;
  onApplyRedact: () => void;
  onClearRedact: () => void;
  /** F10: write the pending marks into the file as /Redact annotations. */
  savingMarks: boolean;
  onSaveRedact: () => void;
}

export function CanvasStatusBar(props: CanvasStatusBarProps): React.JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null);
  // One tab stop for the BUTTONS (the MainToolbar roving pattern); the page
  // input stays its own stop — arrow keys inside a text input edit text, so
  // it is excluded from the roving set rather than half-hijacked.
  const rovingRef = useRef(0);
  const buttonsOf = (): HTMLButtonElement[] =>
    Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = buttonsOf();
    if (buttons.length === 0) return;
    e.preventDefault();
    const current = buttons.indexOf(e.target as HTMLButtonElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'ArrowRight') next = current < 0 ? 0 : Math.min(current + 1, buttons.length - 1);
    else next = current <= 0 ? 0 : current - 1;
    rovingRef.current = next;
    buttons.forEach((b, i) => { b.tabIndex = i === next ? 0 : -1; });
    buttons[next].focus();
  };
  // First button tabbable, rest reachable by arrows. Recomputed cheaply per
  // render via ref callback on the container (children change with pending
  // state, so a static index array would go stale).
  const applyRoving = (el: HTMLDivElement | null): void => {
    barRef.current = el;
    if (!el) return;
    const buttons = buttonsOf();
    const active = Math.min(rovingRef.current, Math.max(0, buttons.length - 1));
    buttons.forEach((b, i) => { b.tabIndex = i === active ? 0 : -1; });
  };

  const hasPending = props.dirty || props.pendingFormCount > 0 || props.markCount > 0;

  return (
    <div
      ref={applyRoving}
      data-testid="canvas-status-bar"
      role="toolbar"
      aria-label="Document status bar"
      onKeyDown={onKeyDown}
      className="canvas-status-bar"
    >
      {hasPending && (
        <div className="canvas-status-pending" data-testid="status-pending-segment">
          {props.pendingFormCount > 0 && (
            <>
              <button
                type="button"
                data-testid="forms-fill-btn"
                disabled={props.fillingForms}
                onClick={props.onApplyForms}
                className="canvas-status-action bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {props.fillingForms
                  ? 'Filling…'
                  : `Fill ${props.pendingFormCount} field${props.pendingFormCount === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                data-testid="forms-clear-btn"
                disabled={props.fillingForms}
                onClick={props.onClearForms}
                title="Discard all pending form values"
                className="canvas-status-action canvas-status-quiet"
              >
                Clear
              </button>
            </>
          )}
          {props.markCount > 0 && (
            <>
              <button
                type="button"
                data-testid="redact-apply-btn"
                disabled={props.redacting}
                onClick={props.onApplyRedact}
                className="canvas-status-action bg-red-600 hover:bg-red-500 text-white"
              >
                {props.redacting
                  ? 'Redacting…'
                  : `Redact ${props.markCount} region${props.markCount === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                data-testid="redact-save-btn"
                disabled={props.redacting || props.savingMarks}
                onClick={props.onSaveRedact}
                title="Save the pending marks into the document to revisit later (nothing is redacted yet)"
                className="canvas-status-action canvas-status-quiet"
              >
                {props.savingMarks ? 'Saving…' : 'Save marks'}
              </button>
              <button
                type="button"
                data-testid="redact-clear-btn"
                disabled={props.redacting}
                onClick={props.onClearRedact}
                title="Clear all pending redaction marks"
                className="canvas-status-action canvas-status-quiet"
              >
                Clear
              </button>
            </>
          )}
          {props.dirty && (
            <button
              type="button"
              data-testid="apply-page-edits-btn"
              onClick={props.onApplyPageEdits}
              className="canvas-status-action bg-blue-600 hover:bg-blue-500 text-white"
            >
              Apply changes
            </button>
          )}
        </div>
      )}
      <div className="flex-1" />
      <button
        type="button"
        data-testid="toggle-comments"
        title="Show annotation notes"
        aria-pressed={props.showComments}
        onClick={props.onToggleComments}
        className={'canvas-status-action canvas-status-quiet' + (props.showComments ? ' active' : '')}
      >
        Comments
      </button>
      {props.pageBox && (
        <div className="canvas-status-pages" data-testid="status-page-segment">
          <input
            data-testid="page-nav-box"
            ref={props.pageBox.inputRef}
            value={props.pageBox.value}
            onChange={props.pageBox.onChange}
            onFocus={props.pageBox.onFocus}
            onBlur={props.pageBox.onBlur}
            onKeyDown={props.pageBox.onKeyDown}
            className="canvas-status-pageinput"
            aria-label="Current page"
          />
          <span data-testid="page-nav-total">/ {props.pageBox.total}</span>
        </div>
      )}
      <div className="canvas-status-zoom" role="group" aria-label="Zoom">
        <button type="button" title="Zoom out" onClick={props.onZoomOut} className="canvas-status-action canvas-status-quiet">
          −
        </button>
        <button type="button" title="Fit to view" onClick={props.onFit} className="canvas-status-action canvas-status-quiet">
          Fit
        </button>
        <button type="button" title="Zoom in" onClick={props.onZoomIn} className="canvas-status-action canvas-status-quiet">
          +
        </button>
      </div>
      <button
        type="button"
        data-testid="toggle-doc-view"
        title={props.docViewMode === 'document' ? 'Switch to the page organizer' : 'Switch to the reading view'}
        onClick={props.onToggleView}
        className="canvas-status-action canvas-status-quiet"
      >
        {props.docViewMode === 'document' ? 'Organize' : 'Read'}
      </button>
    </div>
  );
}
