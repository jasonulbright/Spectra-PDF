import React from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { tChrome } from '../i18n';

// The chrome every folder-sweep dialog wears: a folder row with its picker, a
// running view with the progress bar and the stop button, and the modal shell.
//
// One implementation rather than one per sweep — these are the parts a second
// dialog copies verbatim, and a copy is where two sweeps start behaving
// differently at the edges (what a stop looks like, whether a progress bar
// exists at all).

export function FolderRow({
  label,
  testid,
  value,
  onPick,
  note,
  buttonRef,
}: {
  label: string;
  testid: string;
  value: string | null;
  onPick: () => void;
  note: string | null;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <div>
      <span className="block text-sm text-neutral-400 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          data-testid={`${testid}-pick`}
          onClick={onPick}
          className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
        >
          {tChrome('dialog.common.choose')}
        </button>
        <span
          data-testid={testid}
          className="text-sm text-neutral-300 truncate"
          title={value ?? undefined}
        >
          {value ?? tChrome('dialog.batch.noFolder')}
        </span>
      </div>
      {note && <p className="text-xs text-neutral-500 mt-1">{note}</p>}
    </div>
  );
}

export function RunningView({
  label,
  fileIndex,
  fileCount,
  stopping,
  onStop,
  buttonRef,
  testid,
  stopTestid,
}: {
  label: string;
  fileIndex: number | null;
  fileCount: number;
  stopping: boolean;
  onStop: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  testid: string;
  stopTestid: string;
}): React.JSX.Element {
  const fraction = fileIndex === null ? 0 : (fileIndex + 1) / Math.max(1, fileCount);
  return (
    <div className="flex flex-col gap-3" data-testid={testid}>
      <p className="text-sm text-neutral-300 truncate">
        {stopping ? tChrome('dialog.batch.progressStopping') : label}
      </p>
      <div className="h-1.5 bg-neutral-800 rounded overflow-hidden">
        <div
          className="h-full bg-blue-600 transition-all"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          ref={buttonRef}
          onClick={onStop}
          disabled={stopping}
          data-testid={stopTestid}
          className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-60 rounded text-sm"
        >
          {stopping ? tChrome('dialog.batch.stopping') : tChrome('dialog.batch.stop')}
        </button>
      </div>
    </div>
  );
}

export function SweepShell({
  title,
  testid,
  closeTestid,
  children,
  onClose,
}: {
  title: string;
  testid: string;
  closeTestid: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testid}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[620px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            data-testid={closeTestid}
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
