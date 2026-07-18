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
  /** Pick a folder (Batch OCR source/destination). Returns null if cancelled. */
  pickFolder: (title?: string) => invoke<string | null>('pick_folder_dialog', { title }),
  /** Pick a replacement image (Edit ▸ Replace Image). Null if cancelled. */
  pickImageFile: () => invoke<string | null>('pick_image_file'),
  /** Save location for an extracted image (base name; engine adds the real
   * extension). Null if cancelled. */
  saveImageFile: (defaultName?: string) =>
    invoke<string | null>('save_image_file_dialog', { defaultName }),
};

// ── Batch OCR (Phase 6) ───────────────────────────────────────────────────
//
// Batch operates on paths OUTSIDE the workspace (never OPEN_FILE'd, never in
// $TEMP), so its file IO goes through plain Rust commands, not the
// capability-scoped plugin-fs used for working copies.

export interface BatchPdfEntry {
  abs: string;
  rel: string;
}

export interface BatchPdfListing {
  files: BatchPdfEntry[];
  skippedDirs: string[];
}

export const batch = {
  /** Every *.pdf under root (recursive; cycle-safe; unreadable subdirs reported). */
  listPdfsRecursive: (root: string) => invoke<BatchPdfListing>('list_pdfs_recursive', { root }),
  /** Byte copy creating destination parents — the mirror's pass-through.
   * Refuses same-physical-file overwrites; clears a read-only dest first. */
  copyFile: (src: string, dest: string) => invoke<void>('copy_file_creating_dirs', { src, dest }),
  /** Pre-create a mirror output's parents (apply_ocr_layer saves to the exact
   * path it is given and does not create directories). */
  ensureParentDirs: (path: string) => invoke<void>('ensure_parent_dirs', { path }),
  /** TRUE file identity (volume serial + file index): canonical STRINGS can
   * disagree about one physical folder (UNC vs mapped letter), so the
   * dest-conflict guard asks the filesystem, not the spelling. */
  pathsSameFile: (a: string, b: string) => invoke<boolean>('paths_same_file', { a, b }),
  /** Read arbitrary-path bytes (batch sources live outside the plugin-fs
   * scope). Raw binary IPC — the serde number[] form balloons a long
   * unattended run over large scanned PDFs. */
  readFileBuffer: async (path: string) =>
    new Uint8Array(await invoke<ArrayBuffer>('read_file_binary', { filePath: path })),
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
  /** The bundled Edit-tool fallback font (7.4; resources/fonts). */
  getEditFontPath: () => invoke<string>('get_edit_font_path'),
  /** Installed Windows printers + the default (the Print dialog's picker). */
  listPrinters: () => invoke<PrinterList>('list_printers'),
  /** The path-identity gate (M7): file identity is the raw path string
   * app-wide, so every path entering the open/import funnels resolves to ONE
   * canonical spelling first. Rust producers (dialogs, argv, second
   * instance) canonicalize at the source; this covers paths that arrive
   * through the WEBVIEW (drops, the harness, recents persisted before the
   * gate existed). */
  canonicalizePaths: (paths: string[]) =>
    invoke<string[]>('canonicalize_paths', { paths }),
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
