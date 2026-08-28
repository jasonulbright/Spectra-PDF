import React, { useCallback } from 'react';
import { useAppState } from '../state/AppStateProvider';
import { selectedPageNumbers } from '../state/selectors';
import { formatPageRange } from '../lib/page-range';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';
import type { PanelKey } from '../i18n-panels';

// The page-scope field every scoping panel shows: the text input plus the
// affordance that writes the current page selection into it. The selection
// already exists (the board and the Pages panel share `ui.selectedPageIds`)
// and the field already accepts what it spells, so retyping the numbers was
// the only thing standing between the two.
//
// Thin by construction: the syntax lives in `lib/page-range.ts` and the
// selection mapping in `state/selectors.ts`, both of which have tests — there
// is no DOM test environment, so nothing breakable may live here.

export interface PageRangeFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: PanelKey;
  ariaLabel: PanelKey;
  /** Prefix for the data-testid attributes, so each host addresses its own. */
  testIdPrefix: string;
  className?: string;
}

export function PageRangeField({
  value,
  onChange,
  label,
  ariaLabel,
  testIdPrefix,
  className,
}: PageRangeFieldProps): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const state = useAppState();
  const selected = selectedPageNumbers(state);
  const useSelection = useCallback(() => {
    onChange(formatPageRange(selected));
  }, [onChange, selected]);

  return (
    <div>
      <label className="block text-sm text-neutral-400 mb-1">{tChrome(label)}</label>
      <div className="flex items-center gap-2">
        <input
          data-testid={`${testIdPrefix}-pages`}
          aria-label={tChrome(ariaLabel)}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={
            className ??
            'w-48 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm focus:outline-none focus:border-blue-500'
          }
        />
        <button
          type="button"
          data-testid={`${testIdPrefix}-use-selection`}
          onClick={useSelection}
          disabled={selected.length === 0}
          title={tChrome('panel.common.useSelectionTitle')}
          className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-60"
        >
          {tChrome('panel.common.useSelection')}
        </button>
      </div>
    </div>
  );
}
