import React from 'react';
import { useTranslation } from 'react-i18next';
import { isPanelErrorText } from '../i18n';

interface StatusBarProps {
  message: string;
  busy?: boolean;
}

export function StatusBar({ message, busy }: StatusBarProps): React.ReactElement | null {
  // Re-render on language change. The error TONE used to be picked by
  // sniffing this bar's own English text (`message.startsWith('Error')`) —
  // the RepairPanel landmine class — so a translated status silently lost
  // its red styling. `isPanelErrorText` asks the catalog's own
  // `panel.common.error` key for its prefix in the current locale instead.
  useTranslation();
  if (!message && !busy) return null;
  return (
    <div data-testid="status-bar" className={`panel-status-box px-4 py-2 rounded text-sm ${
      isPanelErrorText(message) ? 'bg-red-900/50 text-red-300' : 'bg-neutral-800 text-neutral-300'
    }`}>
      {busy && <span className="inline-block w-3 h-3 border-2 border-neutral-400 border-t-transparent rounded-full animate-spin me-2 align-middle" />}
      {message}
    </div>
  );
}
