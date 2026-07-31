import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppModal } from '../hooks/useAppModal';
import { dialog, batch, watchers } from '../lib/tauri-bridge';
import type { WatchedFolder } from '../lib/tauri-bridge';
import { getSettings } from '../lib/app-settings';
import {
  actionFileJson,
  loadGuidedActions,
  stepDefFor,
  unattendedBlocker,
} from '../lib/guided-actions';
import { TEST_HARNESS_ENABLED, registerWatchedFolders } from '../testHarness';

// Tools ▸ Watched Folders (O7). Drop a PDF into an intake folder and a saved
// guided action runs over it automatically: processed copies mirror into the
// destination, originals file into the processed folder (In → Out → Done —
// what keeps the intake holding only unprocessed work). Watching is in-app
// polling (tray-residency counts; no background service — the scheduler
// posture); each run spawns the CLI, byte-identical to a scheduled run, and
// logs through the same action-run logs.
//
// The action is FROZEN into the Rust-owned config at save (the
// scheduled-actions lesson — never localStorage), and ask-at-run actions are
// refused here for the same reason they cannot be scheduled: an unattended
// run has nobody to ask.

export interface WatchedFoldersDialogProps {
  onClose: () => void;
}

export function WatchedFoldersDialog({ onClose }: WatchedFoldersDialogProps): React.JSX.Element {
  const [folders, setFolders] = useState<WatchedFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    name: string;
    source: string;
    dest: string;
    processedRoot: string;
    actionId: string;
  } | null>(null);
  const [libraryActions] = useState(() => loadGuidedActions());

  const refresh = useCallback(async () => {
    try {
      setFolders(await watchers.list());
      setError(null);
    } catch (e: unknown) {
      setFolders([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const save = useCallback(async () => {
    if (!editing) return;
    const chosen = libraryActions.find((a) => a.id === editing.actionId);
    if (!chosen) {
      setError('Choose which guided action runs on arrivals.');
      return;
    }
    // An unattended run has nobody to ask — same refusal as scheduling.
    const blocker = unattendedBlocker(chosen);
    if (blocker) {
      setError(blocker);
      return;
    }
    const settings = getSettings();
    const logDir = settings.batchLogEnabled ? await batch.logDir(settings.batchLogDir) : '';
    const folder: WatchedFolder = {
      id: crypto.randomUUID(),
      name: editing.name.trim() || chosen.name,
      source: editing.source,
      dest: editing.dest,
      processedRoot: editing.processedRoot,
      action: JSON.parse(actionFileJson(chosen)) as unknown,
      logDir,
      enabled: true,
    };
    await act(() => watchers.upsert(folder));
    setEditing(null);
  }, [editing, libraryActions, act]);

  // Harness: the folder pickers are native — a spec injects a whole entry
  // through the SAME upsert path the form uses.
  const createRef = useRef<(f: WatchedFolder) => Promise<void>>(null!);
  createRef.current = (f) => watchers.upsert(f);
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerWatchedFolders({
      create: (f) => createRef.current(f as unknown as WatchedFolder),
      list: () => watchers.list(),
      remove: (id) => watchers.remove(id),
    });
    return () => registerWatchedFolders(null);
  }, []);

  const pick = async (label: string, apply: (path: string) => void): Promise<void> => {
    const path = await dialog.pickFolder(label);
    if (path) apply(path);
  };

  return (
    <Shell onClose={onClose}>
      {editing === null ? (
        <div className="flex flex-col gap-3" data-testid="watchers-list-view">
          <p className="text-xs text-neutral-500">
            A watched folder runs a saved guided action on every PDF dropped into it:
            processed copies land in the destination, the originals file into the processed
            folder. Watching runs while Spectra PDF is open (including minimized to the
            tray); runs are logged with the batch logs.
          </p>
          {folders === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : folders.length === 0 ? (
            <p className="text-sm text-neutral-400" data-testid="watchers-empty">
              No watched folders yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto" data-testid="watchers-list">
              {folders.map((f) => (
                <div
                  key={f.id}
                  data-testid={`watcher-row-${f.id}`}
                  className="px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-neutral-200 flex-1 truncate">{f.name}</span>
                    <span className="text-xs text-neutral-500">{f.enabled ? 'Watching' : 'Paused'}</span>
                  </div>
                  <div className="text-xs text-neutral-400 mt-0.5 truncate" title={f.source}>
                    {f.source} → {f.dest}
                  </div>
                  <div className="flex gap-2 mt-1.5">
                    <button
                      data-testid={`watcher-toggle-${f.id}`}
                      disabled={busy}
                      onClick={() => void act(() => watchers.upsert({ ...f, enabled: !f.enabled }))}
                      className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 rounded"
                    >
                      {f.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <div className="flex-1" />
                    {confirmDelete === f.id ? (
                      <>
                        <span className="text-xs text-amber-400 self-center">Delete it?</span>
                        <button
                          data-testid={`watcher-delete-confirm-${f.id}`}
                          disabled={busy}
                          onClick={() => {
                            setConfirmDelete(null);
                            void act(() => watchers.remove(f.id));
                          }}
                          className="px-2 py-0.5 text-xs bg-red-700/80 hover:bg-red-600 disabled:opacity-50 rounded"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-0.5 text-xs text-neutral-400 hover:text-neutral-200"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        data-testid={`watcher-delete-${f.id}`}
                        disabled={busy}
                        onClick={() => setConfirmDelete(f.id)}
                        className="px-2 py-0.5 text-xs text-neutral-400 hover:text-red-400 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && (
            <p className="text-sm text-red-400" data-testid="watchers-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              data-testid="watchers-close"
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              Close
            </button>
            <button
              data-testid="watchers-new"
              onClick={() => {
                setEditing({ name: '', source: '', dest: '', processedRoot: '', actionId: '' });
                setError(null);
              }}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
            >
              New watched folder
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="watchers-form">
          <Field label="Name (blank = the action's name)">
            <input
              data-testid="watcher-name"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
            />
          </Field>
          <Field label="Guided action to run on arrivals">
            <select
              data-testid="watcher-action"
              value={editing.actionId}
              onChange={(e) => setEditing({ ...editing, actionId: e.target.value })}
              className="w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
            >
              <option value="">Choose an action…</option>
              {libraryActions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.steps.map((s) => stepDefFor(s.op).title).join(' → ')}
                </option>
              ))}
            </select>
            <p className="text-xs text-neutral-500 mt-1">
              The watcher keeps its own copy of the action. Actions that ask for values when
              they run can't watch a folder — arrivals are processed with nobody at the
              keyboard.
            </p>
          </Field>
          <FolderField
            label="Watched folder (the intake)"
            testid="watcher-source"
            value={editing.source}
            onPick={() => void pick('Choose the folder to watch', (p) => setEditing({ ...editing, source: p }))}
          />
          <FolderField
            label="Destination (processed copies)"
            testid="watcher-dest"
            value={editing.dest}
            onPick={() => void pick('Choose the destination folder', (p) => setEditing({ ...editing, dest: p }))}
          />
          <FolderField
            label="Processed originals move to"
            testid="watcher-done"
            value={editing.processedRoot}
            onPick={() => void pick('Choose where processed originals go', (p) => setEditing({ ...editing, processedRoot: p }))}
          />
          {error && (
            <p className="text-sm text-red-400" data-testid="watchers-form-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              Cancel
            </button>
            <button
              data-testid="watcher-save"
              disabled={busy}
              onClick={() => void save()}
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
            >
              {busy ? 'Saving…' : 'Start watching'}
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <span className="block text-xs text-neutral-400 mb-1">{label}</span>
      {children}
    </div>
  );
}

function FolderField({
  label,
  testid,
  value,
  onPick,
}: {
  label: string;
  testid: string;
  value: string;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <div>
      <span className="block text-xs text-neutral-400 mb-1">{label}</span>
      <div className="flex items-center gap-2">
        <button
          data-testid={`${testid}-pick`}
          onClick={onPick}
          className="px-2.5 py-1 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium shrink-0"
        >
          Choose…
        </button>
        <span data-testid={testid} className="text-sm text-neutral-300 truncate" title={value}>
          {value || 'Not set'}
        </span>
      </div>
    </div>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): React.JSX.Element {
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
        aria-label="Watched Folders"
        data-testid="watchers-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[620px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">Watched Folders</h3>
          <button
            data-testid="watchers-x"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            Close
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
