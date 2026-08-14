/**
 * Tauri IPC bridge — typed wrappers around invoke() and listen().
 * All renderer code imports from here for backend communication.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ScanEvent,
  ScanResult,
  ScanSettings,
  ScannerCapabilities,
  ScannerList,
} from './scan';
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
let createPdfDialogInflight: Promise<string[]> | null = null;

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
  /** Pick one or more Create PDF sources (images, Office, text, web,
   * PostScript and PDFs). Serialized like openFiles/saveFile — modality lands
   * a beat after the click, so a rapid second click must join the open dialog,
   * not stack another (regression: the single-file version this replaces
   * was added without the guard the comment above exists to explain). */
  pickCreatePdfSources: () => {
    if (!createPdfDialogInflight) {
      createPdfDialogInflight = invoke<string[]>('pick_create_pdf_sources').finally(() => {
        createPdfDialogInflight = null;
      });
    }
    return createPdfDialogInflight;
  },
  pickPemFile: () => invoke<string | null>('pick_pem_file'),
  pickIccFile: () => invoke<string | null>('pick_icc_file'),
  pickPkcs11Module: () => invoke<string | null>('pick_pkcs11_module'),
  /** Pick ANY file to embed as a PDF attachment (no extension filter). */
  pickAnyFile: () => invoke<string | null>('pick_any_file'),
  /** Pick MULTIPLE files of any type (portfolio members). Empty if cancelled. */
  pickAnyFiles: () => invoke<string[]>('pick_any_files'),
  /** Pick a folder (Batch OCR source/destination). Returns null if cancelled. */
  pickFolder: (title?: string) => invoke<string | null>('pick_folder_dialog', { title }),
  /** A user's own Hunspell pair (.aff + .dic) in ONE dialog — picking them
   *  separately invites a pair from two different languages. */
  pickDictionaryFiles: () => invoke<string[] | null>('pick_dictionary_files'),
  /** Pick ONE picture to stamp as a watermark. Filtered to the Create PDF
   * image set — the same set the engine accepts. Null if cancelled. */
  pickWatermarkImage: () => invoke<string | null>('pick_watermark_image'),
  /** Pick ONE PDF whose page is stamped as a watermark. The file is never
   * opened as a document. Null if cancelled. */
  pickWatermarkPdf: () => invoke<string | null>('pick_watermark_pdf'),
  /** Pick a replacement image (Edit ▸ Replace Image). Null if cancelled.
   * `includeSvg` widens the filter for Add Image (SVG places as real
   * vector content); Replace stays raster-only. */
  pickImageFile: (includeSvg?: boolean) =>
    invoke<string | null>('pick_image_file', { includeSvg: includeSvg ?? false }),
  /** Save location for an extracted image (base name; engine adds the real
   * extension). Null if cancelled. */
  saveImageFile: (defaultName?: string) =>
    invoke<string | null>('save_image_file_dialog', { defaultName }),
  /** Pick a form-DATA file (FDF/XFDF) to import into the open form. Null if
   * cancelled. An `/ImportData` action names a file of its own; this app asks
   * the user instead, so a document can never make it open a path nobody
   * chose. */
  pickFormDataFile: () => invoke<string | null>('pick_form_data_file'),
  /** Where a built form submission is written. Null if cancelled. */
  saveFormDataFile: (defaultName?: string) =>
    invoke<string | null>('save_form_data_file', { defaultName }),
};

// ── Image clipboard ───────────────────────────────────────────────────────

/** What the clipboard HOLDS afterwards — read back out of its own DIB header
 * by the Rust command, not reported by the call that wrote it. */
export interface ClipboardImage {
  width: number;
  height: number;
  formats: string[];
}

export const imageClipboard = {
  /**
   * Publish one raster to the clipboard as both a DIB and a PNG.
   *
   * The two blobs cross as ONE raw body (`png || dib`) rather than a JSON
   * argument: a megabyte of pixels serialized as an array of numbers is an
   * order of magnitude larger and slower, and both formats must land in the
   * same clipboard session.
   */
  copyImage: (bytes: Uint8Array, pngLength: number) =>
    invoke<ClipboardImage>('copy_image_to_clipboard', bytes, {
      headers: { 'snapshot-png-length': String(pngLength) },
    }),
  /** Write the captured PNG to a path the save dialog returned. The
   * capability-scoped filesystem plugin reaches only the app's own temp
   * tree, so a user-chosen destination goes through the command instead. */
  savePng: (png: Uint8Array, path: string) =>
    invoke<string>('save_snapshot_png', png, {
      headers: { 'snapshot-path': encodeURIComponent(path) },
    }),
};

// ── Batch OCR ─────────────────────────────────────────────────────────────
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
  /** Move a SOURCE file into a moved/error tree —
   * the only batch call that mutates the user's own folders. Resolves to the
   * path actually written: a collision is suffixed, never overwritten. */
  moveFile: (src: string, dest: string) => invoke<string>('move_file_creating_dirs', { src, dest }),
  /** Allocate a scratch path for the auto-repair step. */
  createScratch: (tag: string) => invoke<string>('create_batch_scratch', { tag }),
  /** Delete a scratch file — refused Rust-side for anything outside the
   * scratch folder, so this can never become a general remove. */
  deleteScratch: (path: string) => invoke<void>('delete_batch_scratch', { path }),
  /** TRUE file identity (volume serial + file index): canonical STRINGS can
   * disagree about one physical folder (UNC vs mapped letter), so the
   * dest-conflict guard asks the filesystem, not the spelling. */
  pathsSameFile: (a: string, b: string) => invoke<boolean>('paths_same_file', { a, b }),
  /** Read arbitrary-path bytes (batch sources live outside the plugin-fs
   * scope). Raw binary IPC — the serde number[] form balloons a long
   * unattended run over large scanned PDFs. */
  readFileBuffer: async (path: string) =>
    new Uint8Array(await invoke<ArrayBuffer>('read_file_binary', { filePath: path })),
  /** Write one run's log; returns its full path. `dir` is the user's
   * configured log folder (empty/undefined = the app-data default). The NAME
   * is still validated Rust-side against the exact pattern this app writes —
   * the folder is user-chosen, a crafted filename is how a write escapes it. */
  writeLog: (name: string, contents: string, dir?: string) =>
    invoke<string>('write_batch_log', { name, contents, dir: dir || null }),
  /** The resolved log folder (configured or the app-data default), created
   *  on demand — for callers that hand the ENGINE a log destination. */
  logDir: (dir?: string) => invoke<string>('get_batch_log_dir', { dir: dir || null }),
  /** Age sweep over that folder. 0 = keep forever (a no-op, not a purge), and
   * it only ever removes files matching this app's own log-name pattern. */
  pruneLogs: (retentionDays: number, dir?: string) =>
    invoke<number>('prune_batch_logs', { retentionDays, dir: dir || null }),
  /** Reveal the log folder. Rust refuses anything that is not a directory. */
  openLogFolder: (dir?: string) =>
    invoke<void>('open_batch_log_folder', { dir: dir || null }),
};

// ── Scheduled batch runs ──────────────────────────────────────────────────
//
// Windows Task Scheduler runs them; this app owns the whole lifecycle so the
// user never opens taskschd.msc. Every call is scoped Rust-side to our own
// `\Spectra PDF\` task folder.

export interface ScheduleProfile {
  name: string;
  source: string;
  dest: string;
  lang: string;
  movedRoot: string;
  errorRoot: string;
  repairDamaged: boolean;
  replaceRepairedOriginals: boolean;
  /** Required when `account` is set — the default log folder belongs to
   * whichever account runs the batch. */
  logDir: string;
  /** Recurring only. A one-shot would need real date arithmetic and the
   * request is recurring ("every day at 09:30"); shipping a broken option is
   * worse than not offering it. */
  frequency: 'daily' | 'weekly';
  /** HH:MM, 24-hour, local. */
  time: string;
  /** Weekly only: MON,TUE,… */
  days: string;
  /** Empty = the current user. Otherwise DOMAIN\\user, or DOMAIN\\gmsa$. */
  account: string;
  /** DESTRUCTIVE: replace each original with its searchable version. Retires
   * `dest` and `movedRoot`, which the Rust validator refuses alongside it. */
  inPlace: boolean;
  mrc: boolean;
  mrcPreset: string;
  mrcVerifyText: boolean;
  enhance: boolean;
  /** Shipped default ON; only read when `enhance` is set. */
  enhanceOrientation: boolean;
  /** Which CLI arm the task invokes: 'batch-ocr' (default; also for '') or
   * 'action' — a guided-action run over the source tree. */
  runType: string;
  /** Action runs: the frozen action file the task reads. Set by create,
   * never by the caller. */
  actionFile: string;
}

export interface ScheduledRun {
  name: string;
  /** Read back from the command line the task will actually run — there is no
   * second store to disagree with it. Null if it was edited outside the app. */
  profile: ScheduleProfile | null;
  /** Task Scheduler's own status text. DISPLAY ONLY — Windows localizes it,
   * so nothing branches on its wording; `enabled` is the discriminant. */
  status: string;
  /** Read from the task XML's `<Settings><Enabled>` — locale-independent. */
  enabled: boolean;
  nextRun: string;
  lastRun: string;
  lastResult: string;
  /** Action runs: the action's display name + step ops read from the frozen
   * file (empty for batch-OCR runs). */
  actionName: string;
  actionSteps: string[];
  /** True when the task references an action file that cannot be read — it
   * will still FIRE and fail, so it is shown rather than hidden. */
  actionMissing: boolean;
}

// ── Watched folders ───────────────────────────────────────────────────────
//
// Drop a PDF into an intake folder and a saved guided action runs over it
// (In → Out → Done). Watchers poll IN-APP (tray-residency counts) and each
// run spawns the CLI — byte-identical to a scheduled run. Config is
// Rust-owned; the action is FROZEN at save (never localStorage).

export interface WatchedFolder {
  id: string;
  name: string;
  source: string;
  dest: string;
  /** Where processed ORIGINALS file to — required (it is what keeps the
   * intake holding only unprocessed work). */
  processedRoot: string;
  /** The frozen `{name, steps}` action body (the export construction). */
  action: unknown;
  logDir: string;
  enabled: boolean;
}

// ── Virtual printer ───────────────────────────────────────────────────────

export interface VirtualPrinterStatus {
  installed: boolean;
  /** 'listening', or the named reason the loopback listener is down. */
  listener: string;
  lastJobError: string;
  printerName: string;
}

export const virtualPrinter = {
  status: () => invoke<VirtualPrinterStatus>('virtual_printer_status'),
  /** One visible UAC elevation over a staged pure-ASCII script. */
  install: () => invoke<void>('install_virtual_printer'),
  uninstall: () => invoke<void>('uninstall_virtual_printer'),
};

export const watchers = {
  list: () => invoke<WatchedFolder[]>('list_watched_folders'),
  upsert: (folder: WatchedFolder) => invoke<void>('upsert_watched_folder', { folder }),
  remove: (id: string) => invoke<void>('delete_watched_folder', { id }),
};

export const schedule = {
  /** `password` is passed to Windows and never stored by this app.
   * `actionJson` (action runs) is the frozen sanitized `{name, steps}` shape
   * — the export construction, so it can never carry a password. Omit it
   * when replacing an action schedule to keep the file already on disk. */
  create: (profile: ScheduleProfile, password?: string, actionJson?: string) =>
    invoke<string>('create_scheduled_run', {
      profile,
      password: password || null,
      actionJson: actionJson || null,
    }),
  list: () => invoke<ScheduledRun[]>('list_scheduled_runs'),
  remove: (name: string) => invoke<void>('delete_scheduled_run', { name }),
  runNow: (name: string) => invoke<void>('run_scheduled_now', { name }),
  setEnabled: (name: string, enabled: boolean) =>
    invoke<void>('set_scheduled_run_enabled', { name, enabled }),
};

// ── File operations ───────────────────────────────────────────────────────

// Binary file I/O goes through plugin-fs (efficient binary IPC, capability-
// scoped to $TEMP/spectrapdf in capabilities/main.json) — the working copies,
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
  /** Show a file in the file manager, SELECTED. Rust refuses anything that is
   * not an existing file, and browses rather than shell-opens — see
   * `commands::reveal_in_file_manager`. */
  reveal: (filePath: string) => invoke<void>('reveal_in_file_manager', { path: filePath }),
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

export interface PaperOption {
  id: number;
  name: string;
  width_pt: number;
  height_pt: number;
}

export interface PrinterCapabilities {
  papers: PaperOption[];
  default_paper: number | null;
  duplex: boolean;
  color: boolean;
  collate: boolean;
  max_copies: number;
}

export const app = {
  getGsPath: () => invoke<string>('get_gs_path'),
  /** File ▸ Send To ▸ Email stages a copy of the
   * working file under the document's real name (mail clients may read the
   * attachment lazily — the live working copy would race later edits)… */
  stageSendCopy: (path: string, displayName: string) =>
    invoke<string>('stage_send_copy', { path, displayName }),
  /** …then hand it to the default desktop mail client via MAPI. Resolves as
   * soon as the compose window is up (or with a fast, named refusal — e.g.
   * no mail client registered). Never sends anything by itself. */
  sendByEmail: (stagedPath: string) => invoke<void>('send_by_email', { stagedPath }),
  /** The vendored native Tesseract. One recognizer for every surface. */
  getTesseractPath: () => invoke<string>('get_tesseract_path'),
  /** The bundled (or system-fallback) LibreOffice soffice path for Office export.
   *  '' when none is found — the engine then refuses with a clear message. */
  getSofficePath: () => invoke<string>('get_soffice_path'),
  /** The bundled Edit-tool fallback font (resources/fonts). */
  getEditFontPath: () => invoke<string>('get_edit_font_path'),
  /** The bundled spelling dictionaries DIRECTORY (resources/dictionaries) —
   *  the engine resolves a language tag against what is on disk. */
  getDictionaryPath: () => invoke<string>('get_dictionary_path'),
  /** The managed folder a user's own dictionaries are copied into (Rust owns
   *  the path, so an added dictionary outlives the folder it came from). */
  userDictionaryDir: () => invoke<string>('user_dictionary_dir'),
  /** Installed Windows printers + the default (the Print dialog's picker). */
  listPrinters: () => invoke<PrinterList>('list_printers'),
  /** One printer's papers/duplex/color — gates the Print dialog's option
   *  surface and resolves sheet sizes for the layout modes. */
  printerCapabilities: (name: string) =>
    invoke<PrinterCapabilities>('printer_capabilities', { name }),
  /** The path-identity gate: file identity is the raw path string
   * app-wide, so every path entering the open/import funnels resolves to ONE
   * canonical spelling first. Rust producers (dialogs, argv, second
   * instance) canonicalize at the source; this covers paths that arrive
   * through the WEBVIEW (drops, the harness, recents persisted before the
   * gate existed). */
  canonicalizePaths: (paths: string[]) =>
    invoke<string[]>('canonicalize_paths', { paths }),
  /** The managed app-data folder a portfolio's members extract into for
   *  "Open member" (per-portfolio, created on demand; Rust owns the path). */
  portfolioMemberDir: (portfolioPath: string) =>
    invoke<string>('portfolio_member_dir', { portfolioPath }),
  /** Shell-open an extracted member with the OS default handler. Rust restricts
   * the path to the managed portfolio-members directory. */
  openPortfolioMemberFile: (path: string) =>
    invoke<void>('open_portfolio_member_file', { path }),
  getBundledGsInfo: () => invoke<GsInfo>('get_bundled_gs_info'),
  detectExternalGs: () => invoke<GsInfo | null>('detect_external_gs'),
  getVersion: () => invoke<string>('get_app_version'),
  /** Open a SHIPPED third-party licenses file (allowlisted name) with the
   *  OS default handler — resolved against the app's resource dir in Rust. */
  openThirdPartyLicenses: (file: 'THIRD-PARTY-LICENSES.md' | 'THIRD-PARTY-LICENSES-RUST.html') =>
    invoke('open_third_party_licenses', { file }),
  /** Open the releases page in the browser. Destination is compiled into the
   *  Rust command — nothing about it comes from the update manifest. */
  openReleasesPage: () => invoke('open_releases_page'),
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

// ── Scanner (WIA) ─────────────────────────────────────────────────────────
//
// Its own namespace rather than more of `app`: a scan session holds a DEVICE
// LOCK, so which calls open one and which release one has to be readable in
// one place.

export const scanner = {
  /** Attached scanners plus `lastUsed` when it is still one of them (the
   * phantom-default rule). An empty list is the ANSWER, never an error. */
  listScanners: (lastUsed: string | null) =>
    invoke<ScannerList>('list_scanners', { lastUsed }),
  /** One device's scan sources and what each reports it can do — the only
   * thing the dialog's controls are derived from. Opens a session. */
  scannerCapabilities: (deviceId: string) =>
    invoke<ScannerCapabilities>('scanner_capabilities', { deviceId }),
  /** Release a device now rather than at the session's idle timeout. WIA
   * locks a device while an item on it lives, so a dialog that closes without
   * this makes every other imaging application wait the timeout out. */
  scannerClose: (deviceId: string) => invoke<void>('scanner_close', { deviceId }),
  /** The system device picker — the door for a device the enumeration filter
   * drops. Returns an id, which then flows through the ordinary capability
   * path; `null` when the user cancels. */
  scannerSelectDialog: () => invoke<string | null>('scanner_select_dialog'),
  /** Acquire pages. Progress rides a per-invocation channel rather than a
   * named event: two runs sharing one event name would cross their progress.
   * A cancelled run RESOLVES, carrying the pages that completed. */
  scanAcquire: (deviceId: string, settings: ScanSettings, onEvent: (event: ScanEvent) => void) => {
    const channel = new Channel<ScanEvent>();
    channel.onmessage = onEvent;
    return invoke<ScanResult>('scan_acquire', { deviceId, settings, onEvent: channel });
  },
  /** Ask the run in flight to stop at the driver's next callback tick. */
  scanCancel: (deviceId: string) => invoke<void>('scan_cancel', { deviceId }),
  /** Delete one run's staged pages — refused Rust-side for anything outside
   * the scan scratch root, so this can never become a general remove. */
  scanDiscard: (scratch: string) => invoke<void>('scan_discard', { scratch }),
};

// ── Auto-updater ──────────────────────────────────────────────────────────
// Tauri's updater plugin is invoked from JS directly, not through custom commands.

export { check as checkForUpdate } from '@tauri-apps/plugin-updater';
