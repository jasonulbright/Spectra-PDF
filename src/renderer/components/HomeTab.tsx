import React from 'react';
import { ChromeIcon } from './chrome-icons';
import { formatOpenedAt, type RecentEntry } from '../lib/recent-files';
import { ToolsCenter } from './ToolsCenter';
import { invokeCommand, isCommandEnabled } from '../commands/context';
import type { CommandId } from '../commands/registry';
import type { ToolId } from '../commands/tools';

// Home (Phase 10 slice E — the redesign the owner asked for: "much cleaner
// and prettier - even in darkmode", the king's bar). A landing surface you
// leave the moment a document opens, not a product identity: quick actions,
// the drop target, recents with real hierarchy, and the all-tools grid
// (Home is the docless tools surface since slice C). All original testids
// preserved; additions only.

interface HomeTabProps {
  recentFiles: RecentEntry[];
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  /** Phase 10 slice C: Home hosts the tile grid (the docless tools surface —
   * the Tools tab is gone; ops tiles run the picker-first flow). */
  onOpenTool: (id: ToolId) => void;
}

function folderOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.slice(-2).join('\\') || path;
}

// The king's "recommended tools" strip, from our own command registry — the
// same ids the menus run, so enablement can never disagree.
const QUICK_ACTIONS: ReadonlyArray<{ command: CommandId; label: string; icon: Parameters<typeof ChromeIcon>[0]['icon'] }> = [
  { command: 'document.combineFiles', label: 'Combine files', icon: 'pages' },
  { command: 'file.createPdfFromPostScript', label: 'Create PDF', icon: 'document' },
  { command: 'tools.batchOcr', label: 'Batch OCR', icon: 'find' },
];

export function HomeTab({ recentFiles, onOpen, onOpenRecent, onClearRecent, onOpenTool }: HomeTabProps): React.ReactElement {
  return (
    <div data-testid="home-tab" className="flex-1 overflow-y-auto">
      <div className="home-shell">
        <div className="home-hero">
          <div>
            <h2 className="home-title">Home</h2>
            <p className="home-sub">Open a document to start, or pick a tool below.</p>
          </div>
          <div className="home-actions" data-testid="home-quick-actions">
            <button
              data-testid="home-open-btn"
              onClick={onOpen}
              className="home-action home-action-primary"
            >
              <ChromeIcon icon="open" size={15} />
              Open a PDF
            </button>
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.command}
                data-testid={`home-qa-${qa.command}`}
                disabled={!isCommandEnabled(qa.command)}
                onClick={() => invokeCommand(qa.command)}
                className="home-action"
              >
                <ChromeIcon icon={qa.icon} size={14} />
                {qa.label}
              </button>
            ))}
          </div>
        </div>

        <div data-testid="home-drop-hint" className="home-drop">
          <ChromeIcon icon="document" size={26} className="opacity-40" />
          <p>Drop PDF files anywhere to open them</p>
        </div>

        <div className="home-section-head">
          <div className="home-section-title">Recent files</div>
          {recentFiles.length > 0 && (
            <button
              data-testid="home-clear-recent"
              onClick={onClearRecent}
              className="home-section-action"
            >
              Clear
            </button>
          )}
        </div>

        {recentFiles.length === 0 ? (
          <p className="home-empty">No recent files yet — anything you open shows up here.</p>
        ) : (
          <div className="home-recents">
            {recentFiles.map(({ path, openedAt }) => (
              <button
                key={path}
                data-testid="home-recent-item"
                onClick={() => onOpenRecent(path)}
                title={path}
                className="home-recent"
              >
                <span className="home-recent-icon">
                  <ChromeIcon icon="document" size={16} />
                </span>
                <span className="home-recent-name">{path.split(/[\\/]/).pop()}</span>
                <span className="home-recent-folder">{folderOf(path)}</span>
                <span data-testid="home-recent-opened" className="home-recent-when">
                  {formatOpenedAt(openedAt, Date.now())}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* The tile grid's home since the Tools tab's retirement (slice C). */}
        <div className="home-section-head home-tools-head">
          <div className="home-section-title">All tools</div>
        </div>
        <ToolsCenter onOpenTool={onOpenTool} embedded />
      </div>
    </div>
  );
}
