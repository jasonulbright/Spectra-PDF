import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

interface PendingOpenPaneProps {
  name: string;
  onCancel: () => void;
}

// The body of a tab whose document is still opening (issue #43). It covers
// the content area rather than replacing it, so whatever the user was on
// underneath — Home, or another document's canvas — stays mounted and comes
// back exactly as it was if the open is cancelled or refused.
export function PendingOpenPane({ name, onCancel }: PendingOpenPaneProps): React.ReactElement {
  useTranslation();
  return (
    <div
      data-testid="pending-open-pane"
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-900"
    >
      <div className="flex flex-col items-center gap-4 text-center px-6">
        <span className="inline-block w-8 h-8 border-[3px] border-neutral-600 border-t-blue-400 rounded-full animate-spin" />
        <p dir="auto" className="text-neutral-300 text-sm break-all">
          {tChrome('chrome.tabs.opening', { name })}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-xs rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
        >
          {tChrome('chrome.tabs.cancelOpen', { name })}
        </button>
      </div>
    </div>
  );
}
