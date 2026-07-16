import React from 'react';
import { useAppModal } from '../hooks/useAppModal';

// About dialog (Phase 4 M2) — the app name/version/repo, moved out of the
// old header chrome (the native title bar carries the name now). Version is
// passed in (App already fetches it via app.getVersion).

interface AboutDialogProps {
  version: string;
  onClose: () => void;
}

const REPO_URL = 'https://github.com/jasonulbright/Open-PDF-Studio';

export function AboutDialog({ version, onClose }: AboutDialogProps): React.ReactElement {
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
      data-testid="about-dialog"
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="About Open PDF Studio"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[380px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 text-center">
          <h2 className="text-lg font-semibold">Open PDF Studio</h2>
          <p data-testid="about-version" className="text-sm text-neutral-400 mt-1">
            Version {version}
          </p>
          <p className="text-xs text-neutral-500 mt-4">
            A modern, offline-first PDF workbench.
          </p>
          <p className="text-xs text-neutral-500 mt-1 break-all">{REPO_URL}</p>
        </div>
        <div className="flex justify-end px-5 py-3 border-t border-neutral-800">
          <button
            onClick={onClose}
            className="px-3 py-1 text-sm bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
