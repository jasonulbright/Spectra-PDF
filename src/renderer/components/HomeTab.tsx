import React from 'react';
import { ChromeIcon } from './chrome-icons';
import { formatOpenedAt, type RecentEntry } from '../lib/recent-files';

// The Home tab (Phase 4 M2, § 8) — the Acrobat-DC Home surface that replaces
// WelcomeScreen. A recent-files table (name + folder + opened-when, the M2
// deviation closed at M7), an Open button, and a drop-target hint. Home is a
// tab you leave, not a gate you disable, so the old "skip this screen"
// toggle is gone.

interface HomeTabProps {
  recentFiles: RecentEntry[];
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

function folderOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join('\\') || path;
}

export function HomeTab({ recentFiles, onOpen, onOpenRecent, onClearRecent }: HomeTabProps): React.ReactElement {
  return (
    <div data-testid="home-tab" className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Home</h2>
          <button
            data-testid="home-open-btn"
            onClick={onOpen}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            <ChromeIcon icon="open" size={15} />
            Open a PDF
          </button>
        </div>

        <div
          data-testid="home-drop-hint"
          className="mb-8 flex flex-col items-center justify-center gap-2 py-10 border border-dashed border-neutral-700 rounded-lg text-neutral-500"
        >
          <ChromeIcon icon="document" size={28} className="opacity-50" />
          <p className="text-sm">Drop PDF files anywhere to open them</p>
        </div>

        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold">Recent Files</div>
          {recentFiles.length > 0 && (
            <button
              data-testid="home-clear-recent"
              onClick={onClearRecent}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {recentFiles.length === 0 ? (
          <p className="text-sm text-neutral-600 py-6 text-center">No recent files yet.</p>
        ) : (
          <div className="flex flex-col">
            {recentFiles.map(({ path, openedAt }) => (
              <button
                key={path}
                data-testid="home-recent-item"
                onClick={() => onOpenRecent(path)}
                title={path}
                className="flex items-center gap-3 px-3 py-2 text-left rounded hover:bg-neutral-800 transition-colors group"
              >
                <ChromeIcon icon="document" size={16} className="text-neutral-500 group-hover:text-neutral-300 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-200 truncate">{path.split(/[\\/]/).pop()}</div>
                  <div className="text-xs text-neutral-500 truncate">{folderOf(path)}</div>
                </div>
                <div
                  data-testid="home-recent-opened"
                  className="text-xs text-neutral-500 whitespace-nowrap shrink-0"
                >
                  {formatOpenedAt(openedAt, Date.now())}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
