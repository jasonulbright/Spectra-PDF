import React from 'react';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

interface NoFileOpenProps {
  onOpen: () => void;
  message?: string;
}

export function NoFileOpen({ onOpen, message }: NoFileOpenProps): React.ReactElement {
  // Re-render on language change; the default message resolves here so
  // the DEFAULT localizes while an explicit caller message passes through.
  useTranslation();
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <p className="text-neutral-500 mb-3">{message ?? tChrome('chrome.empty.openToStart')}</p>
        <button onClick={onOpen} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium">
          {tChrome('chrome.empty.openPdf')}
        </button>
      </div>
    </div>
  );
}
