// Adapted from PDFx src/renderer/src/components/FindBar.tsx (same owner):
// same search/OCR-progress/language surface, restyled to this app's Tailwind
// idiom, plus match navigation (↑/↓/Enter) and the "Make searchable" action
// (persist OCR text via the engine — the 2m addition PDFx doesn't have).
import React, { useEffect, useRef } from 'react';
import type { SearchResult } from '../../search/engine';
import type { SearchOptions } from '../../search/normalize';
import { FindModeToggles } from '../../search/FindModeToggles';
import { OCR_LANGUAGES } from '../../ocr/languages';

interface FindBarProps {
  query: string;
  result: SearchResult;
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
  onClose: () => void;
}

function countLabel(query: string, result: SearchResult): string {
  if (query.trim().length === 0) return '';
  if (result.error) return result.errorKind === 'timeout' ? 'Pattern too slow' : 'Invalid pattern';
  if (result.pages === 0) return 'No results';
  const occ = result.occurrences;
  return `${occ} match${occ === 1 ? '' : 'es'} on ${result.pages} page${result.pages === 1 ? '' : 's'}`;
}

export function FindBar({
  query,
  result,
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
  onClose,
}: FindBarProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  return (
    <div
      data-testid="find-bar"
      role="search"
      className="absolute top-4 right-4 z-30 flex items-center gap-2 px-3 py-2 bg-neutral-800/95 border border-neutral-700 rounded-lg shadow-xl"
    >
      <input
        ref={inputRef}
        data-testid="find-input"
        className={`w-56 px-2 py-1 bg-neutral-900 border rounded text-sm focus:outline-none ${
          result.error ? 'border-red-500 focus:border-red-500' : 'border-neutral-700 focus:border-blue-500'
        }`}
        type="text"
        placeholder="Find in documents"
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
        {countLabel(query, result)}
      </span>
      {matchCount > 0 && (
        <>
          <span data-testid="find-cursor" className="text-xs text-neutral-500 whitespace-nowrap">
            {current >= 0 ? `${current + 1}/${matchCount}` : `${matchCount}`}
          </span>
          <button
            data-testid="find-prev"
            title="Previous match page (Shift+Enter)"
            onClick={onPrev}
            className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            ↑
          </button>
          <button
            data-testid="find-next"
            title="Next match page (Enter)"
            onClick={onNext}
            className="px-1.5 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded"
          >
            ↓
          </button>
        </>
      )}
      {ocrRemaining > 0 && (
        <span data-testid="find-ocr-progress" className="text-xs text-amber-300/90 whitespace-nowrap" title="Reading scanned pages">
          Recognizing {ocrRemaining}…
        </span>
      )}
      {hasScanned && (
        <select
          data-testid="find-ocr-lang"
          title="OCR language for scanned pages"
          value={ocrLanguage}
          onChange={(e) => onOcrLanguage(e.target.value)}
          className="px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-xs"
        >
          {OCR_LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      )}
      {canApplyOcr && (
        <button
          data-testid="find-apply-ocr"
          disabled={applyingOcr}
          onClick={onApplyOcr}
          title="Write the recognized text into the scanned pages as an invisible, searchable text layer"
          className="px-2 py-0.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium whitespace-nowrap"
        >
          {applyingOcr ? 'Applying…' : 'Make searchable'}
        </button>
      )}
      <button title="Close (Esc)" onClick={onClose} className="px-1.5 py-0.5 text-xs text-neutral-400 hover:text-neutral-200">
        ×
      </button>
    </div>
  );
}
