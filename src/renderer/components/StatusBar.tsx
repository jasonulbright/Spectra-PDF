import React from 'react';

interface StatusBarProps {
  message: string;
  busy?: boolean;
}

export function StatusBar({ message, busy }: StatusBarProps): React.ReactElement | null {
  if (!message && !busy) return null;
  return (
    <div data-testid="status-bar" className={`px-4 py-2 rounded text-sm ${
      message.startsWith('Error') ? 'bg-red-900/50 text-red-300' : 'bg-neutral-800 text-neutral-300'
    }`}>
      {busy && <span className="inline-block w-3 h-3 border-2 border-neutral-400 border-t-transparent rounded-full animate-spin mr-2 align-middle" />}
      {message}
    </div>
  );
}
