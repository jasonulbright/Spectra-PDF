import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formattingLocale, tChrome, type UiKey } from '../../i18n';
import { getCanvasServices, invokeCommand } from '../../commands/context';
import type { CommandId } from '../../commands/registry';
import { useActiveReadingView } from '../../lib/reading-view-store';
import type { LayoutMode, ScrollMode, ZoomMode } from '../../lib/reading-view-types';
import { ZOOM_PERCENT_MAX, ZOOM_PERCENT_MIN, parseZoomPercentInput } from '../../lib/zoom-input';
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape';

const FIT_ROWS: readonly { mode: ZoomMode; command: CommandId; label: UiKey; testid: string }[] = [
  { mode: 'actual', command: 'view.actualSize', label: 'chrome.status.fitActual', testid: 'reading-fit-actual' },
  { mode: 'fitPage', command: 'view.fit', label: 'chrome.status.fitPage', testid: 'reading-fit-page' },
  { mode: 'fitWidth', command: 'view.fitWidth', label: 'chrome.status.fitWidth', testid: 'reading-fit-width' },
  { mode: 'fitHeight', command: 'view.fitHeight', label: 'chrome.status.fitHeight', testid: 'reading-fit-height' },
];

const LAYOUT_ROWS: readonly { mode: LayoutMode; command: CommandId; label: UiKey; title: UiKey; testid: string }[] = [
  {
    mode: 'single',
    command: 'view.singlePage',
    label: 'chrome.status.layoutSingle',
    title: 'chrome.status.layoutSingleTitle',
    testid: 'reading-layout-single',
  },
  {
    mode: 'grid',
    command: 'view.multiPage',
    label: 'chrome.status.layoutMultiple',
    title: 'chrome.status.layoutMultipleTitle',
    testid: 'reading-layout-grid',
  },
];

const SCROLL_ROWS: readonly { mode: ScrollMode; command: CommandId; label: UiKey; title: UiKey; testid: string }[] = [
  {
    mode: 'continuous',
    command: 'view.scrollContinuous',
    label: 'chrome.status.scrollContinuous',
    title: 'chrome.status.scrollContinuousTitle',
    testid: 'reading-scroll-continuous',
  },
  {
    mode: 'paged',
    command: 'view.scrollPaged',
    label: 'chrome.status.scrollPaged',
    title: 'chrome.status.scrollPagedTitle',
    testid: 'reading-scroll-paged',
  },
];

// Longer than the zoom settle beat after which the pane publishes.
const SUBMITTED_HOLD_MS = 1000;

function formatPercent(percent: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(percent / 100);
}

function FitMenu({ zoomMode, disabled }: { zoomMode: ZoomMode | null; disabled: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useDismissOnEscape(open, () => setOpen(false));
  const fitted = zoomMode === 'fitPage' || zoomMode === 'fitWidth' || zoomMode === 'fitHeight';
  return (
    <div className="reading-fit" ref={wrapRef}>
      <button
        type="button"
        data-testid="reading-fit-menu"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        title={tChrome('chrome.status.fitMenuTitle')}
        onClick={() => setOpen((v) => !v)}
        className={'canvas-status-action canvas-status-quiet' + (fitted ? ' active' : '')}
      >
        {tChrome('chrome.status.fitMenu')}
        <span className="reading-fit-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="canvas-status-snap-popover reading-fit-popover"
          data-testid="reading-fit-popover"
          role="group"
          aria-label={tChrome('chrome.status.fitMenu')}
        >
          {FIT_ROWS.map((row) => (
            <button
              key={row.mode}
              type="button"
              data-testid={row.testid}
              aria-pressed={zoomMode === row.mode}
              onClick={() => {
                setOpen(false);
                invokeCommand(row.command);
              }}
              className="reading-fit-item"
            >
              {tChrome(row.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Segment<M extends string>({
  label,
  rows,
  current,
  disabled,
}: {
  label: UiKey;
  rows: readonly { mode: M; command: CommandId; label: UiKey; title: UiKey; testid: string }[];
  current: M | null;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <div className="reading-segment" role="group" aria-label={tChrome(label)}>
      {rows.map((row) => (
        <button
          key={row.mode}
          type="button"
          data-testid={row.testid}
          aria-pressed={current === row.mode}
          disabled={disabled}
          title={tChrome(row.title)}
          onClick={() => invokeCommand(row.command)}
          className={'canvas-status-action canvas-status-quiet' + (current === row.mode ? ' active' : '')}
        >
          {tChrome(row.label)}
        </button>
      ))}
    </div>
  );
}

/**
 * The reading view's control group: zoom steppers around a percent box, the
 * fit presets, the page layout and the scrolling mode of the active pane.
 * State is read from the reading-view store only; every change goes through
 * a command or the active canvas handle, so the controls act on the active
 * document and pane alone.
 */
export function ReadingViewControls(): React.JSX.Element {
  useTranslation();
  const view = useActiveReadingView();
  const disabled = view === null;
  const locale = formattingLocale();
  const shown = view ? formatPercent(view.zoomPercent, locale) : '';
  // Non-null while the reader is typing; the snapshot owns the box otherwise.
  const [draft, setDraft] = useState<string | null>(null);
  // The submitted zoom, shown until the pane publishes its next zoom: the
  // snapshot follows a change on the settle beat, so without it the box
  // shows the old value in between. A submit that changes nothing publishes
  // nothing (the pane already at the requested or the largest zoom), so the
  // timer bounds how long the submitted text can stand in for the snapshot.
  // `seq` restarts the timer on every submit, a repeated value included.
  const [submitted, setSubmitted] = useState<{ text: string; seq: number } | null>(null);
  const submitSeq = useRef(0);
  // Only a zoom change ends the hold: a page or scroll publish carries the
  // zoom from before the submit.
  const zoomPercent = view?.zoomPercent;
  const zoomMode = view?.zoomMode;
  useEffect(() => {
    setSubmitted(null);
  }, [zoomPercent, zoomMode]);
  const heldSeq = submitted?.seq ?? null;
  useEffect(() => {
    if (heldSeq === null) return;
    const timer = window.setTimeout(() => setSubmitted(null), SUBMITTED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [heldSeq]);
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  const submit = (input: HTMLInputElement): void => {
    const percent = parseZoomPercentInput(input.value, locale);
    if (percent !== null) {
      getCanvasServices()?.canvas()?.setZoomPercent?.(percent);
      submitSeq.current += 1;
      setSubmitted({ text: formatPercent(percent, locale), seq: submitSeq.current });
    }
    setDraft(null);
    input.blur();
  };

  return (
    <div className="reading-view-controls" role="group" aria-label={tChrome('chrome.status.viewControls')}>
      <div className="canvas-status-zoom" role="group" aria-label={tChrome('chrome.status.zoom')}>
        <button
          type="button"
          data-testid="reading-zoom-out"
          title={tChrome('chrome.status.zoomOut')}
          aria-label={tChrome('chrome.status.zoomOut')}
          disabled={disabled}
          onClick={() => invokeCommand('view.zoomOut')}
          className="canvas-status-action canvas-status-quiet"
        >
          −
        </button>
        <input
          type="text"
          inputMode="decimal"
          data-testid="reading-zoom-percent"
          aria-label={tChrome('chrome.status.zoomPercent')}
          title={tChrome('chrome.status.zoomPercentTitle', {
            min: integer.format(ZOOM_PERCENT_MIN),
            max: integer.format(ZOOM_PERCENT_MAX),
          })}
          placeholder={tChrome('chrome.status.zoomPercentPlaceholder')}
          disabled={disabled}
          value={draft ?? submitted?.text ?? shown}
          onFocus={(e) => {
            setDraft(e.target.value);
            e.target.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit(e.currentTarget);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          className="canvas-status-pageinput reading-zoom-input"
        />
        <button
          type="button"
          data-testid="reading-zoom-in"
          title={tChrome('chrome.status.zoomIn')}
          aria-label={tChrome('chrome.status.zoomIn')}
          disabled={disabled}
          onClick={() => invokeCommand('view.zoomIn')}
          className="canvas-status-action canvas-status-quiet"
        >
          +
        </button>
      </div>
      <FitMenu zoomMode={view?.zoomMode ?? null} disabled={disabled} />
      <span className="reading-view-sep" aria-hidden="true" />
      <Segment
        label="chrome.status.layoutGroup"
        rows={LAYOUT_ROWS}
        current={view?.layoutMode ?? null}
        disabled={disabled}
      />
      <span className="reading-view-sep" aria-hidden="true" />
      <Segment
        label="chrome.status.scrollGroup"
        rows={SCROLL_ROWS}
        current={view?.scrollMode ?? null}
        disabled={disabled}
      />
    </div>
  );
}
