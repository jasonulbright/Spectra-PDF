/**
 * Tauri IPC bridge — typed wrappers around invoke() and listen().
 * All renderer code imports from here for backend communication.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rename as fsRename,
  remove as fsRemove,
} from '@tauri-apps/plugin-fs';
import { runCommitGate } from './commit-gate';

// ── Engine (Python sidecar) ───────────────────────────────────────────────

export const engine = {
  /** Start the Python engine sidecar process. */
  start: () => invoke('start_engine'),

  /** Send a JSON-RPC request to the engine. */
  request: (req: object) => invoke('send_to_engine', { request: req }),

  /** Listen for JSON-RPC responses from the engine. */
  onResponse: (callback: (response: unknown) => void) => {
    return listen<unknown>('engine:response', (event) => callback(event.payload));
  },
};

// ── File dialogs ──────────────────────────────────────────────────────────

// Dialogs are OS-modal (parented in Rust), but modality lands a beat after
// the click — serialize here too so a rapid second click joins the open
// dialog instead of stacking another.
let openDialogInflight: Promise<string[]> | null = null;
let saveDialogInflight: Promise<string | null> | null = null;

export const dialog = {
  openFiles: () => {
    if (!openDialogInflight) {
      openDialogInflight = invoke<string[]>('open_files_dialog').finally(() => {
        openDialogInflight = null;
      });
    }
    return openDialogInflight;
  },
  saveFile: (options?: { defaultPath?: string }) => {
    if (!saveDialogInflight) {
      saveDialogInflight = invoke<string | null>('save_file_dialog', {
        defaultPath: options?.defaultPath,
      }).finally(() => {
        saveDialogInflight = null;
      });
    }
    return saveDialogInflight;
  },
  /** Pick a PKCS#12 (.pfx/.p12) signer file. Returns null if cancelled. */
  pickCertificate: () => invoke<string | null>('pick_certificate_file'),
  pickPemFile: () => invoke<string | null>('pick_pem_file'),
};

// ── File operations ───────────────────────────────────────────────────────

// Binary file I/O goes through plugin-fs (efficient binary IPC, capability-
// scoped to $TEMP/openpdfstudio in capabilities/main.json) — the working copies,
// snapshots, and commit temp files all live there.
const snapshotRaw = (workingPath: string) => invoke<string>('snapshot', { workingPath });

export const file = {
  readBuffer: (filePath: string) => fsReadFile(filePath),
  writeBuffer: (filePath: string, bytes: Uint8Array) => fsWriteFile(filePath, bytes),
  rename: (fromPath: string, toPath: string) => fsRename(fromPath, toPath),
  remove: (filePath: string) => fsRemove(filePath),
  createWorkingCopy: (filePath: string) =>
    invoke<string>('create_working_copy', { filePath }),
  /**
   * Every mutating operation snapshots its working file first, which makes
   * this the natural choke point for the page-edit commit gate: pending
   * canvas edits land on disk before the snapshot is taken, so the undo
   * entry the caller pushes points at the committed state.
   */
  snapshot: async (workingPath: string) => {
    await runCommitGate();
    return snapshotRaw(workingPath);
  },
  /** Ungated variant — used by the commit implementation itself. */
  snapshotRaw,
  restoreSnapshot: (workingPath: string, snapshotPath: string) =>
    invoke('restore_snapshot', { workingPath, snapshotPath }),
  saveAs: (workingPath: string, destPath: string) =>
    invoke('save_as', { workingPath, destPath }),
};

// ── App ───────────────────────────────────────────────────────────────────

export interface GsInfo {
  path: string;
  version: string;
  product: string;
  vendor: string;
}

export interface PrinterList {
  printers: string[];
  default: string | null;
}

export const app = {
  getGsPath: () => invoke<string>('get_gs_path'),
  /** Installed Windows printers + the default (the Print dialog's picker). */
  listPrinters: () => invoke<PrinterList>('list_printers'),
  getBundledGsInfo: () => invoke<GsInfo>('get_bundled_gs_info'),
  detectExternalGs: () => invoke<GsInfo | null>('detect_external_gs'),
  getVersion: () => invoke<string>('get_app_version'),
  getSystemAccentColor: () => invoke<string | null>('get_system_accent_color'),
  /** Which backdrop the window was created with: "mica" or "none". */
  getWindowBackdrop: () => invoke<string>('get_window_backdrop'),
  appendOperationLog: (line: string) => invoke('append_operation_log', { line }),
  checkAutoUpdateDisabled: () => invoke<boolean>('check_auto_update_disabled'),

  /** Read the "Start with Windows" state. Returns [enabled, minimized]. */
  getStartupEnabled: () => invoke<[boolean, boolean]>('get_startup_enabled'),

  /** Set or remove the "Start with Windows" registry entry. */
  setStartupEnabled: (enabled: boolean, startMinimized: boolean) =>
    invoke('set_startup_enabled', { enabled, startMinimized }),

  /** Write start-minimized preference to Rust-readable config file. */
  setStartMinimized: (enabled: boolean) =>
    invoke('set_start_minimized', { enabled }),

  /** Actually close the window and quit the app. */
  confirmClose: () => invoke('confirm_close'),

  /** Hide the window to system tray instead of closing. */
  hideToTray: () => invoke('hide_to_tray'),

  /** Listen for close-requested event (Rust intercepted the window close). */
  onBeforeClose: (callback: () => void) => {
    return listen('app:beforeClose', () => callback());
  },

  /** Listen for file open requests (CLI args, second instance, context menu). */
  onOpenFile: (callback: (data: { files: string[]; merge: boolean }) => void) => {
    return listen<{ files: string[]; merge: boolean }>('app:openFile', (event) =>
      callback(event.payload)
    );
  },

  /** Listen for tray actions (Quick Merge). */
  onTrayAction: (callback: (action: string) => void) => {
    return listen<string>('app:trayAction', (event) => callback(event.payload));
  },
};

// ── Auto-updater ──────────────────────────────────────────────────────────
// Tauri's updater plugin is invoked from JS directly, not through custom commands.

export { check as checkForUpdate } from '@tauri-apps/plugin-updater';
