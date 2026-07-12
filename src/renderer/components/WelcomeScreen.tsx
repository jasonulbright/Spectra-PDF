import React, { useState } from 'react';

interface WelcomeAction {
  id: string;
  title: string;
  description: string;
  icon: string;
}

const actions: WelcomeAction[] = [
  {
    id: 'open',
    title: 'Open a PDF',
    description: 'View pages, rotate, delete, or extract text',
    icon: '📄',
  },
  {
    id: 'merge',
    title: 'Merge Documents',
    description: 'Combine two or more PDFs into a single file',
    icon: '📑',
  },
  {
    id: 'compress',
    title: 'Reduce File Size',
    description: 'Compress images and optimize for sharing',
    icon: '📦',
  },
  {
    id: 'secure',
    title: 'Encrypt or Decrypt',
    description: 'Add password protection or remove it',
    icon: '🔒',
  },
  {
    id: 'content',
    title: 'Content',
    description: 'Extract text or edit document metadata',
    icon: '🔍',
  },
  {
    id: 'recent',
    title: 'Recent Document',
    description: 'Continue where you left off',
    icon: '🕐',
  },
];

interface WelcomeScreenProps {
  onAction: (action: string) => void;
  recentFiles: string[];
  onSkipChanged: (skip: boolean) => void;
  onClearRecent?: () => void;
}

export function WelcomeScreen({ onAction, recentFiles, onSkipChanged, onClearRecent }: WelcomeScreenProps): React.ReactElement {
  const [skip, setSkip] = useState(() => localStorage.getItem('spectra-skip-welcome') === 'true');

  const handleToggle = () => {
    const next = !skip;
    setSkip(next);
    localStorage.setItem('spectra-skip-welcome', String(next));
    onSkipChanged(next);
  };

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-xl w-full">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold mb-1">Welcome to Open PDF Studio</h2>
          <p className="text-neutral-500 text-sm">What would you like to do?</p>
        </div>

        <div className="grid grid-cols-1 gap-2">
          {actions.map((action) => {
            if (action.id === 'recent' && recentFiles.length === 0) return null;
            return (
              <button
                key={action.id}
                onClick={() => onAction(action.id)}
                className="flex items-center gap-4 px-5 py-4 bg-neutral-800 hover:bg-neutral-750 border border-neutral-700 hover:border-neutral-600 rounded-lg text-left transition-colors group"
              >
                <span className="text-2xl">{action.icon}</span>
                <div>
                  <div className="text-sm font-medium text-neutral-100 group-hover:text-white">{action.title}</div>
                  <div className="text-xs text-neutral-500">{action.description}</div>
                </div>
              </button>
            );
          })}
        </div>

        {recentFiles.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold">Recent Files</div>
              {onClearRecent && (
                <button
                  onClick={onClearRecent}
                  className="text-neutral-500 hover:text-neutral-400 transition-colors"
                  title="Clear recent files"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                  </svg>
                </button>
              )}
            </div>
            <div className="flex flex-col gap-1">
              {recentFiles.slice(0, 5).map((file) => (
                <button
                  key={file}
                  onClick={() => onAction(`open:${file}`)}
                  className="px-3 py-1.5 text-left text-sm text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded truncate transition-colors"
                  title={file}
                >
                  {file.split(/[\\/]/).pop()}
                  <span className="text-neutral-500 ml-2 text-xs">{file}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="mt-6 flex items-center gap-2 justify-center cursor-pointer text-neutral-500 hover:text-neutral-400 transition-colors">
          <input
            type="checkbox"
            checked={skip}
            onChange={handleToggle}
            className="rounded bg-neutral-800 border-neutral-700"
          />
          <span className="text-xs">Skip this screen and go straight to Tools</span>
        </label>
      </div>
    </div>
  );
}
