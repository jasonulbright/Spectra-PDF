import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocViewMode } from '../../state/types';
import { tChrome, tChromeCount, type UiKey } from '../../i18n';
import { SNAP_ANGLE_MAX, SNAP_ANGLE_MIN, type SnapType } from '../../lib/snap';
import { GRID_SPACING_MAX, GRID_SPACING_MIN } from '../../lib/rulers';
import { MEASURE_UNITS, type MeasureUnit } from '../../lib/measure';
import {
  SNAP_RADIUS_MAX,
  SNAP_RADIUS_MIN,
  type SnapSettings,
} from '../../lib/snap-settings';

// The docked status bar.
// Replaces the floating bottom-right cluster: view state (page box, zoom,
// Read⇄Organize), the Comments toggle, and the PENDING-COMMIT segment (Apply / Fill
// N / Redact N) — the never-invisible invariant now holds by being ANCHORED
// chrome instead of buttons hovering over the page.
//
// Presentational by design: the page-box state machine (blur-no-teleport,
// doc-switch reset, the goToPage service focusing its ref) stays in
// WorkspaceCanvasView untouched — this component just gives it a docked home.
// Testids are UNCHANGED from the floating cluster so the e2e surface is
// stable (only the removed duplicate Find toggle is gone).

/**
 * The snap types the popover offers.
 *
 * All SEVEN are live: `guide` and `grid` were written and tested in
 * `lib/snap.ts` from birth but stayed hidden while they had no sources, since
 * a checkbox that toggles something with no source is a control that does
 * nothing. Ruler guides and the configurable grid are those sources, so the
 * rows appear — and because the persisted settings carried all seven from
 * birth, nothing migrates.
 */
const SNAP_TYPE_ROWS: readonly { type: SnapType; label: UiKey }[] = [
  { type: 'endpoint', label: 'canvas.snap.type.endpoint' },
  { type: 'intersection', label: 'canvas.snap.type.intersection' },
  { type: 'midpoint', label: 'canvas.snap.type.midpoint' },
  { type: 'center', label: 'canvas.snap.type.center' },
  { type: 'guide', label: 'canvas.snap.type.guide' },
  { type: 'grid', label: 'canvas.snap.type.grid' },
  { type: 'edge', label: 'canvas.snap.type.edge' },
];

/** The Snap segment: a master toggle plus a popover of per-type checkboxes
 * and the radius. Snap preferences are how you WORK, not a property of a
 * file, so they persist in app settings — the parent owns that write. */
function SnapSegment({
  snap,
  scaleUnit,
  onChange,
}: {
  snap: SnapSettings;
  /** The measuring scale's REPORTED unit — what a scaled grid's spacing is
   * read in. Shown in the unit slot so "1" is never ambiguous. */
  scaleUnit: MeasureUnit;
  onChange: (next: SnapSettings) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="canvas-status-snap" ref={wrapRef}>
      <button
        type="button"
        data-testid="snap-toggle"
        aria-pressed={snap.enabled}
        title={`${tChrome('chrome.status.snapTitle')} — ${tChrome('chrome.status.snapHint')}`}
        onClick={() => onChange({ ...snap, enabled: !snap.enabled })}
        className={'canvas-status-action canvas-status-quiet' + (snap.enabled ? ' active' : '')}
      >
        {tChrome('chrome.status.snap')}
      </button>
      <button
        type="button"
        data-testid="snap-options-toggle"
        aria-expanded={open}
        aria-label={tChrome('chrome.status.snapOptions')}
        title={tChrome('chrome.status.snapOptions')}
        onClick={() => setOpen((v) => !v)}
        className="canvas-status-action canvas-status-quiet canvas-status-caret"
      >
        ▾
      </button>
      {open && (
        <div className="canvas-status-snap-popover" data-testid="snap-options-popover" role="group" aria-label={tChrome('chrome.status.snapOptions')}>
          <div className="canvas-status-snap-title">{tChrome('chrome.status.snapTypes')}</div>
          {SNAP_TYPE_ROWS.map((row) => (
            <label key={row.type} className="canvas-status-snap-row">
              <input
                type="checkbox"
                data-testid={`snap-type-${row.type}`}
                checked={snap.types[row.type]}
                onChange={(e) =>
                  onChange({
                    ...snap,
                    types: { ...snap.types, [row.type]: e.target.checked },
                  })
                }
              />
              <span>{tChrome(row.label)}</span>
            </label>
          ))}
          <label className="canvas-status-snap-row">
            <span>{tChrome('chrome.status.snapRadius')}</span>
            <input
              type="number"
              data-testid="snap-radius"
              min={SNAP_RADIUS_MIN}
              max={SNAP_RADIUS_MAX}
              value={snap.radiusPx}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                onChange({
                  ...snap,
                  radiusPx: Math.min(SNAP_RADIUS_MAX, Math.max(SNAP_RADIUS_MIN, Math.round(v))),
                });
              }}
              className="canvas-status-snap-number"
            />
            {/* `px` is notation, identical in every locale. */}
            <span aria-hidden="true">px</span>
          </label>
          <label className="canvas-status-snap-row" title={tChrome('chrome.status.snapAngleTitle')}>
            <span>{tChrome('chrome.status.snapAngle')}</span>
            <input
              type="number"
              data-testid="snap-angle"
              min={SNAP_ANGLE_MIN}
              max={SNAP_ANGLE_MAX}
              value={snap.angleDeg}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                onChange({
                  ...snap,
                  angleDeg: Math.min(SNAP_ANGLE_MAX, Math.max(SNAP_ANGLE_MIN, Math.round(v))),
                });
              }}
              className="canvas-status-snap-number"
            />
            {/* The degree sign is notation, like `px`. */}
            <span aria-hidden="true">°</span>
          </label>
          <div className="canvas-status-snap-title">{tChrome('chrome.status.snapGridTitle')}</div>
          <label className="canvas-status-snap-row">
            <input
              type="checkbox"
              data-testid="grid-show"
              checked={snap.showGrid}
              onChange={(e) => onChange({ ...snap, showGrid: e.target.checked })}
            />
            <span>{tChrome('chrome.status.snapGridShow')}</span>
          </label>
          <label className="canvas-status-snap-row">
            <span>{tChrome('chrome.status.snapGridSpacing')}</span>
            <input
              type="number"
              data-testid="grid-spacing"
              min={GRID_SPACING_MIN}
              max={GRID_SPACING_MAX}
              step="any"
              value={snap.grid.spacing}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v <= 0) return;
                onChange({
                  ...snap,
                  grid: {
                    ...snap.grid,
                    spacing: Math.min(GRID_SPACING_MAX, Math.max(GRID_SPACING_MIN, v)),
                  },
                });
              }}
              className="canvas-status-snap-number"
            />
          </label>
          <label className="canvas-status-snap-row">
            <span>{tChrome('chrome.status.snapGridUnit')}</span>
            {/* Unit SYMBOLS are notation (the measure-unit rule) — the label
                localizes, the options do not. Disabled while the spacing is
                read in the drawing scale's own unit, which the scale names. */}
            <select
              data-testid="grid-unit"
              aria-label={tChrome('chrome.status.snapGridUnit')}
              disabled={snap.grid.useScale}
              value={snap.grid.useScale ? scaleUnit : snap.grid.unit}
              onChange={(e) =>
                onChange({
                  ...snap,
                  grid: { ...snap.grid, unit: e.target.value as MeasureUnit },
                })
              }
              className="canvas-status-snap-select"
            >
              {MEASURE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label
            className="canvas-status-snap-row"
            title={tChrome('chrome.status.snapGridScaledTitle')}
          >
            <input
              type="checkbox"
              data-testid="grid-scaled"
              checked={snap.grid.useScale}
              onChange={(e) =>
                onChange({ ...snap, grid: { ...snap.grid, useScale: e.target.checked } })
              }
            />
            <span>{tChrome('chrome.status.snapGridScaled')}</span>
          </label>
        </div>
      )}
    </div>
  );
}

export interface StatusBarPageBox {
  inputRef: React.Ref<HTMLInputElement>;
  value: string;
  total: number;
  /** Follow-on: the document defines /PageLabels that differ from the
   * sheet numbers, so the box holds a LABEL and the sheet position has to be
   * shown alongside it — "iv (4 of 20)" — or the reader loses their place in
   * the file entirely. False keeps the shipped "/ N" readout. */
  labelled?: boolean;
  /** The 1-based sheet the reader is on (only shown when `labelled`). */
  sheet?: number;
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
  /** Write the pending marks into the file as /Redact annotations. */
  savingMarks: boolean;
  onSaveRedact: () => void;
  /** How many engine requests another window has in flight. One sidecar
   * serves every window serially, so this window's next operation queues
   * behind them and the wait would otherwise render as a hang. */
  otherWindowWork: number;
  /** The snap segment. Absent on the Organize board, which has
   * no drawing gestures to snap. */
  snap?: SnapSettings;
  /** Slice B: the live measuring scale's reported unit, for the grid rows. */
  snapScaleUnit?: MeasureUnit;
  onSnapChange?: (next: SnapSettings) => void;
}

export function CanvasStatusBar(props: CanvasStatusBarProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome below.
  useTranslation();
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

  const hasPending =
    props.dirty ||
    props.pendingFormCount > 0 ||
    props.markCount > 0 ||
    props.otherWindowWork > 0;

  return (
    <div
      ref={applyRoving}
      data-testid="canvas-status-bar"
      role="toolbar"
      aria-label={tChrome('chrome.status.barLabel')}
      onKeyDown={onKeyDown}
      className="canvas-status-bar"
    >
      {hasPending && (
        <div className="canvas-status-pending" data-testid="status-pending-segment">
          {props.otherWindowWork > 0 && (
            <span
              data-testid="other-window-busy"
              className="canvas-status-quiet px-2"
              title={tChrome('chrome.status.otherWindowBusyTitle')}
            >
              {tChrome('chrome.status.otherWindowBusy')}
            </span>
          )}
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
                  ? tChrome('chrome.status.filling')
                  : tChromeCount('chrome.status.fillFields', props.pendingFormCount)}
              </button>
              <button
                type="button"
                data-testid="forms-clear-btn"
                disabled={props.fillingForms}
                onClick={props.onClearForms}
                title={tChrome('chrome.status.clearFormsTitle')}
                className="canvas-status-action canvas-status-quiet"
              >
                {tChrome('chrome.status.clear')}
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
                className="canvas-status-action danger-action"
              >
                {props.redacting
                  ? tChrome('chrome.status.redacting')
                  : tChromeCount('chrome.status.redactRegions', props.markCount)}
              </button>
              <button
                type="button"
                data-testid="redact-save-btn"
                disabled={props.redacting || props.savingMarks}
                onClick={props.onSaveRedact}
                title={tChrome('chrome.status.saveMarksTitle')}
                className="canvas-status-action canvas-status-quiet"
              >
                {props.savingMarks
                  ? tChrome('chrome.status.savingMarks')
                  : tChrome('chrome.status.saveMarks')}
              </button>
              <button
                type="button"
                data-testid="redact-clear-btn"
                disabled={props.redacting}
                onClick={props.onClearRedact}
                title={tChrome('chrome.status.clearMarksTitle')}
                className="canvas-status-action canvas-status-quiet"
              >
                {tChrome('chrome.status.clear')}
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
              {tChrome('chrome.status.applyChanges')}
            </button>
          )}
        </div>
      )}
      <div className="flex-1" />
      {props.snap && props.onSnapChange && (
        <SnapSegment
          snap={props.snap}
          scaleUnit={props.snapScaleUnit ?? 'in'}
          onChange={props.onSnapChange}
        />
      )}
      <button
        type="button"
        data-testid="toggle-comments"
        title={tChrome('chrome.status.commentsTitle')}
        aria-pressed={props.showComments}
        onClick={props.onToggleComments}
        className={'canvas-status-action canvas-status-quiet' + (props.showComments ? ' active' : '')}
      >
        {tChrome('chrome.status.comments')}
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
            aria-label={tChrome('chrome.status.currentPage')}
            title={
              props.pageBox.labelled
                ? tChrome('chrome.status.pageLabelHint')
                : tChrome('chrome.status.pageNumberHint')
            }
          />
          <span data-testid="page-nav-total">
            {props.pageBox.labelled
              ? tChrome('chrome.status.sheetOfTotal', {
                  sheet: props.pageBox.sheet ?? 1,
                  total: props.pageBox.total,
                })
              : tChrome('chrome.status.ofTotal', { total: props.pageBox.total })}
          </span>
        </div>
      )}
      <div className="canvas-status-zoom" role="group" aria-label={tChrome('chrome.status.zoom')}>
        <button type="button" title={tChrome('chrome.status.zoomOut')} onClick={props.onZoomOut} className="canvas-status-action canvas-status-quiet">
          −
        </button>
        <button type="button" title={tChrome('chrome.status.fitTitle')} onClick={props.onFit} className="canvas-status-action canvas-status-quiet">
          {tChrome('chrome.status.fit')}
        </button>
        <button type="button" title={tChrome('chrome.status.zoomIn')} onClick={props.onZoomIn} className="canvas-status-action canvas-status-quiet">
          +
        </button>
      </div>
      <button
        type="button"
        data-testid="toggle-doc-view"
        title={
          props.docViewMode === 'document'
            ? tChrome('chrome.status.toOrganizer')
            : tChrome('chrome.status.toReading')
        }
        onClick={props.onToggleView}
        className="canvas-status-action canvas-status-quiet"
      >
        {props.docViewMode === 'document'
          ? tChrome('chrome.status.organize')
          : tChrome('chrome.status.read')}
      </button>
    </div>
  );
}
