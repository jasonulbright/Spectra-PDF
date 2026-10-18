import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gsBlocked } from '../../lib/gs-capability';
import { useGsCapability } from '../../hooks/useGsCapability';
import { useTranslation } from 'react-i18next';
import type { SearchResult } from '../../search/engine';
import { findResultPending } from './find-pending';
import type { SearchOptions } from '../../search/normalize';
import { FindModeToggles } from '../../search/FindModeToggles';
import { OCR_LANGUAGES } from '../../ocr/languages';
import { tChrome, tChromeCount, tNumber, tOcrLanguage } from '../../i18n';
import { ChromeIcon } from '../chrome-icons';
import { pointerScope } from '../../lib/pointer-scope';
import { isRtlUi } from '../../lib/inline-direction';
import { CANVAS_INSET_END, CANVAS_INSET_START } from './useCanvasChromeInsets';
import {
  FLOAT_DRAG_THRESHOLD,
  clampFloatOffset,
  dragFloatOffset,
  drawnFloatOffset,
  floatTranslation,
  keyFloatOffset,
  measureFloatBounds,
  sameFloatBounds,
  type FloatBounds,
  type FloatOffset,
} from '../../lib/float-offset';

const CONTROL = 'input, select, textarea, button, a, [role="button"], [contenteditable]';

/** Text the selection policy lets a reader copy (styles.css): error text. */
const COPYABLE = ".selectable, [class^='text-red-'], [class*=' text-red-']";

/** A press moves the bar from the grip, or from the bar's own background and
 * labels. A press on a control operates the control, and a press on copyable
 * text starts a selection. */
function movesBar(target: EventTarget): boolean {
  const el = target as Element;
  if (el.closest('[data-find-grip]') !== null) return true;
  return el.closest(CONTROL) === null && el.closest(COPYABLE) === null;
}

interface FindBarProps {
  query: string;
  result: SearchResult;
  /** The query `result` was computed for; differs from `query` while a
   * search is pending. */
  matchedQuery: string;
  matchCount: number;
  current: number;
  options: SearchOptions;
  onToggleOption: (key: keyof SearchOptions) => void;
  ocrRemaining: number;
  hasScanned: boolean;
  ocrLanguage: string;
  canApplyOcr: boolean;
  applyingOcr: boolean;
  onQuery: (query: string) => void;
  onOcrLanguage: (lang: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onApplyOcr: () => void;
  /** A clean "Make searchable" just finished on this workspace. */
  ocrApplied: boolean;
  /** How many files that apply wrote a text layer into. */
  ocrFileCount: number;
  /** Any of those files still holds unsaved changes. */
  ocrUnsaved: boolean;
  ocrTextState: 'idle' | 'copying' | 'copied';
  onSaveAfterOcr: () => void;
  onCopyOcrText: () => void;
  onClose: () => void;
  /** Where the user moved the bar from its default slot; null is the slot.
   * Held by the owner, so it outlives a close and reopen. The bar draws it
   * clamped to the canvas and never writes the clamp back. */
  offset: FloatOffset | null;
  onOffset: (offset: FloatOffset | null) => void;
}

function countLabel(query: string, matchedQuery: string, result: SearchResult): string {
  if (query.trim().length === 0) return '';
  if (findResultPending(query, matchedQuery)) return '';
  if (result.error) {
    return tChrome(
      result.errorKind === 'timeout' ? 'canvas.find.patternTooSlow' : 'canvas.find.invalidPattern',
    );
  }
  if (result.pages === 0) return tChrome('canvas.find.noResults');
  // Two counts, one sentence: the outer key agrees with the MATCH count and
  // takes the already-pluralized page phrase as a finished unit (the nav-pane
  // search precedent) — never two English fragments glued together here.
  return tChromeCount('canvas.find.summary', result.occurrences, {
    pages: tChromeCount('canvas.find.pageCount', result.pages),
  });
}

export function FindBar({
  query,
  result,
  matchedQuery,
  matchCount,
  current,
  options,
  onToggleOption,
  ocrRemaining,
  hasScanned,
  ocrLanguage,
  canApplyOcr,
  applyingOcr,
  onQuery,
  onOcrLanguage,
  onNext,
  onPrev,
  onApplyOcr,
  ocrApplied,
  ocrFileCount,
  ocrUnsaved,
  ocrTextState,
  onSaveAfterOcr,
  onCopyOcrText,
  onClose,
  offset,
  onOffset,
}: FindBarProps): React.ReactElement {
  useTranslation();
  const gsOff = gsBlocked(useGsCapability());
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The offset while a pointer moves the bar. The owner hears only the
  // release, so a move does not re-render the whole canvas on every event.
  const [moving, setMoving] = useState<FloatOffset | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const onOffsetRef = useRef(onOffset);
  onOffsetRef.current = onOffset;
  const endMoveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const measure = useCallback((): { bounds: FloatBounds; rtl: boolean } | null => {
    const bar = barRef.current;
    const view = bar?.offsetParent;
    if (!bar || !(view instanceof HTMLElement)) return null;
    const rtl = isRtlUi();
    const inset = (name: string): number => parseFloat(view.style.getPropertyValue(name)) || 0;
    return {
      bounds: measureFloatBounds(bar, view, { start: inset(CANVAS_INSET_START), end: inset(CANVAS_INSET_END) }, rtl),
      rtl,
    };
  }, []);

  // The layout the drawn offset is clamped to, measured again when the view,
  // the chrome around it, the window or the bar itself changes size: the bar
  // wraps onto more rows when the OCR controls appear.
  const [bounds, setBounds] = useState<FloatBounds | null>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const view = bar?.offsetParent;
    if (!bar || !(view instanceof HTMLElement)) return;
    const settle = (): void => {
      const next = measure()?.bounds ?? null;
      setBounds((prev) => (sameFloatBounds(prev, next) ? prev : next));
    };
    const resize = new ResizeObserver(settle);
    resize.observe(bar);
    resize.observe(view);
    const insets = new MutationObserver(settle);
    insets.observe(view, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', settle);
    settle();
    return () => {
      resize.disconnect();
      insets.disconnect();
      window.removeEventListener('resize', settle);
    };
  }, [measure]);

  useEffect(() => () => endMoveRef.current?.(), []);

  /** Where the bar is drawn now, from a fresh measurement. A move or a key
   * starts here: the user sees this place, not the one they chose before a
   * narrower canvas pulled the bar in. */
  const drawnNow = (measured: { bounds: FloatBounds }): FloatOffset =>
    drawnFloatOffset(offsetRef.current, measured.bounds) ?? { inline: 0, block: 0 };

  const startMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || endMoveRef.current || !movesBar(e.target)) return;
    const measuredAtPress = measure();
    if (!measuredAtPress) return;
    // The capturing element receives the clicks that follow, so a press on
    // the grip is captured by the grip, where its double-click is heard.
    const el = (e.target as Element).closest<HTMLElement>('[data-find-grip]') ?? e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const start = drawnNow(measuredAtPress);
    let latest: FloatOffset | null = null;
    const pointers = pointerScope(pointerId);
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (latest === null && Math.hypot(dx, dy) < FLOAT_DRAG_THRESHOLD) return;
      const measured = measure();
      if (!measured) return;
      latest = clampFloatOffset(dragFloatOffset(start, dx, dy, measured.rtl), measured.bounds);
      setMoving(latest);
    };
    const detach = (): void => {
      pointers.remove('pointermove', move);
      pointers.remove('pointerup', release);
      pointers.remove('pointercancel', cancel);
      pointers.remove('blur', cancel);
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // already released, or the bar is gone
      }
      endMoveRef.current = null;
      setMoving(null);
    };
    const release = (): void => {
      detach();
      if (latest !== null) onOffsetRef.current(latest);
    };
    // A cancelled gesture leaves the bar where the press found it.
    const cancel = (): void => detach();
    pointers.add('pointermove', move);
    pointers.add('pointerup', release);
    pointers.add('pointercancel', cancel);
    pointers.add('blur', cancel);
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // capture is best-effort; the window listeners still track the move
    }
    endMoveRef.current = cancel;
  };

  const gripKey = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      onOffset(null);
      return;
    }
    const measured = measure();
    if (!measured) return;
    const next = keyFloatOffset(drawnNow(measured), e.key, e.shiftKey, measured.rtl);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    onOffset(clampFloatOffset(next, measured.bounds));
  };

  const shown = moving ?? drawnFloatOffset(offset, bounds);
  const shift = shown ? floatTranslation(shown, isRtlUi()) : null;

  return (
    <div
      ref={barRef}
      data-testid="find-bar"
      role="search"
      // Capped to the canvas less its margins, wrapping onto a second row:
      // with the tool dock at its widest, one row of the bar is wider than
      // the canvas and would reach past it over the side rail.
      className={`find-bar${moving ? ' moving' : ''} absolute canvas-float-top end-4 z-30 max-w-[calc(100%-2rem)] flex flex-wrap items-center gap-2 px-3 py-2 bg-neutral-800/95 border border-neutral-700 rounded-lg shadow-xl`}
      style={shift ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : undefined}
      onPointerDown={startMove}
      // The press starts no text selection and leaves the focus in the find
      // field.
      onMouseDown={(e) => {
        if (e.button === 0 && movesBar(e.target)) e.preventDefault();
      }}
    >
      <button
        type="button"
        data-testid="find-grip"
        data-find-grip=""
        className="find-bar-grip -ms-1.5 px-0.5 py-1 text-neutral-500 hover:text-neutral-300 rounded"
        aria-label={tChrome('canvas.find.moveBar')}
        title={tChrome('canvas.find.moveBarHint')}
        onDoubleClick={() => onOffset(null)}
        onKeyDown={gripKey}
      >
        <ChromeIcon icon="grip" size={14} />
      </button>
      <input
        ref={inputRef}
        data-testid="find-input"
        className={`w-56 min-w-0 max-w-full px-2 py-1 bg-neutral-900 border rounded text-sm focus:outline-none ${
          result.error ? 'border-red-500 focus:border-red-500' : 'border-neutral-700 focus:border-blue-500'
        }`}
        type="text"
        placeholder={tChrome('canvas.find.placeholder')}
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
      />
      <FindModeToggles options={options} onToggle={onToggleOption} testIdPrefix="find" />
      <span
        data-testid="find-count"
        className={`text-xs whitespace-nowrap ${result.error ? 'text-red-400' : 'text-neutral-400'}`}
        title={result.error ?? undefined}
        aria-live="polite"
      >
        {countLabel(query, matchedQuery, result)}
      </span>
      {matchCount > 0 && (
        <>
          <span data-testid="find-cursor" className="text-xs text-neutral-500 whitespace-nowrap">
            {current >= 0
              ? tChrome('canvas.find.cursor', {
                  current: tNumber(current + 1),
                  total: tNumber(matchCount),
                })
              : tChrome('canvas.find.cursorTotal', { total: tNumber(matchCount) })}
          </span>
          <button
            data-testid="find-prev"
            title={tChrome('canvas.find.prev')}
            onClick={onPrev}
            className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            ↑
          </button>
          <button
            data-testid="find-next"
            title={tChrome('canvas.find.next')}
            onClick={onNext}
            className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            ↓
          </button>
        </>
      )}
      {/* Recognition rasterises through Ghostscript, so the OCR half of the
          find bar disappears without one — the TEXT search beside it needs
          none and is untouched. */}
      {!gsOff && ocrRemaining > 0 && (
        <span
          data-testid="find-ocr-progress"
          className="text-xs text-amber-300/90 whitespace-nowrap"
          title={tChrome('canvas.find.ocrProgressTitle')}
        >
          {tChrome('canvas.find.ocrProgress', { count: tNumber(ocrRemaining) })}
        </span>
      )}
      {!gsOff && hasScanned && (
        <select
          data-testid="find-ocr-lang"
          title={tChrome('canvas.find.ocrLanguage')}
          value={ocrLanguage}
          onChange={(e) => onOcrLanguage(e.target.value)}
          className="px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-xs"
        >
          {OCR_LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {tOcrLanguage(language.code)}
            </option>
          ))}
        </select>
      )}
      {!gsOff && canApplyOcr && (
        <button
          data-testid="find-apply-ocr"
          disabled={applyingOcr}
          onClick={onApplyOcr}
          title={tChrome('canvas.find.applyOcrTitle')}
          className="px-2 py-0.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium whitespace-nowrap"
        >
          {tChrome(applyingOcr ? 'canvas.find.applying' : 'canvas.find.makeSearchable')}
        </button>
      )}
      {ocrApplied && (
        <>
          {ocrUnsaved && (
            <button
              data-testid="find-ocr-save"
              data-files={ocrFileCount}
              onClick={onSaveAfterOcr}
              title={tChrome(ocrFileCount > 1 ? 'canvas.find.saveAllAfterOcrTitle' : 'canvas.find.saveAfterOcrTitle')}
              className="px-2 py-0.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium whitespace-nowrap"
            >
              {tChrome(ocrFileCount > 1 ? 'canvas.find.saveAll' : 'dialog.common.save')}
            </button>
          )}
          <button
            data-testid="find-ocr-copy"
            disabled={ocrTextState === 'copying'}
            onClick={onCopyOcrText}
            title={tChrome('canvas.find.copyTextTitle')}
            className="px-2 py-0.5 text-xs bg-neutral-800 text-neutral-200 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-60 rounded font-medium whitespace-nowrap"
          >
            {tChrome(ocrTextState === 'copied' ? 'canvas.find.textCopied' : 'canvas.find.copyText')}
          </button>
        </>
      )}
      <button title={tChrome('canvas.find.close')} onClick={onClose} className="px-1.5 py-0.5 text-xs text-neutral-400 hover:text-neutral-200">
        ×
      </button>
    </div>
  );
}
