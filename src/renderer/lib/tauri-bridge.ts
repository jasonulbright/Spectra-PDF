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
import type { ClipboardSourceResult } from './clipboard-source';
import type { CaptureRequest, CaptureResult } from './web-capture';
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

  /** Listen for JSON-RPC responses from the engine. Rust addresses each one
   * to the window that sent the request, so a response can never satisfy
   * another window's pending entry for the same id. */
  onResponse: (callback: (response: unknown) => void) => {
    return listen<unknown>('engine:response', (event) => callback(event.payload));
  },

  /** How many engine requests the OTHER windows have in flight. One sidecar
   * serves them all, strictly serially, so this window's next operation waits
   * behind them. */
  onOtherWindows: (callback: (count: number) => void) => {
    return listen<number>('engine:otherWindows', (event) => callback(event.payload));
  },
};

// ── Window ownership ──────────────────────────────────────────────────────

export interface ClaimResult {
  granted: boolean;
  owner: string;
}

/** What handing a document to another window did.
 *
 * `transferred` — the window named by `label` owns it and its open is queued.
 * `tornOff` — the same, into a window built for it.
 * `sameWindow` — the pointer never left home; nothing moved.
 * `refused` — `owner` still holds the path; the document has not gone anywhere.
 *
 * A move that reports anything but `transferred` or `tornOff` must leave the
 * document open where it is: closing the tab on a refusal loses it. */
export interface TabDragResult {
  outcome: 'transferred' | 'tornOff' | 'sameWindow' | 'refused';
  label: string;
  owner: string;
}

/** A handover that has happened and not yet been reported.
 *
 * `outcome` is what the commit will say. The destination is decided under the
 * far side's lock and HELD against re-resolution until the token is spent, so
 * the document can be written back over the user's own file in between knowing
 * where it is going. A `token` of zero holds nothing: there is no commit to
 * make, no cancel to make, and no file to write. */
export interface TabDragReservation extends TabDragResult {
  token: number;
}

/** A point or box in PHYSICAL screen pixels — the only coordinate space the
 * strip registry speaks, because it is the only one every window agrees on. */
export interface PhysicalScreenPoint {
  x: number;
  y: number;
}

export interface PhysicalScreenRect extends PhysicalScreenPoint {
  width: number;
  height: number;
}

/** The cross-window tab drag. The source window streams the pointer here and
 * Rust answers the two questions a renderer cannot: whose strip is under the
 * cursor, and who owns the document after the release. Only the PATH ever
 * crosses — page and document ids are minted against a per-window generation
 * counter, so the same id string names a different physical page in each. */
export const tabDrag = {
  /** Publish this window's strip box, in physical pixels RELATIVE to the
   * window: the screen origin is read on the far side, under the lock it
   * re-anchors with, so no rect is assembled from two positions sampled at
   * different moments. A box with no area forgets the strip, which is how a
   * window with no visible strip stops taking drops. */
  registerStrip: (rect: PhysicalScreenRect) =>
    invoke<void>('register_strip_rect', {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }),
  /** Follow the pointer; resolves to the window now drawing an insertion
   * caret, or null. The caret itself is painted by that window from its own
   * `onHover`, so the source never paints into a target. */
  track: (point: PhysicalScreenPoint) =>
    invoke<string | null>('tabdrag_track', { screenX: point.x, screenY: point.y }),
  /** Abandon a drag. Nothing crosses; the caret stops being drawn. */
  cancel: () => invoke<void>('tabdrag_cancel'),
  /** Resolve a release and HOLD what it resolved to.
   *
   * The claim and the queued open move here, under the far side's lock, and
   * stay held under the returned token: the document is written back over the
   * user's own path between this call and the commit, and a destination
   * re-resolved after that write would leave a document saved and its history
   * discarded for a move that never happened. Asking twice is what made that
   * possible, so the answer is held rather than repeated. */
  reserve: (path: string, point: PhysicalScreenPoint) =>
    invoke<TabDragReservation>('tabdrag_reserve', {
      path,
      screenX: point.x,
      screenY: point.y,
    }),
  /** Pop one document into a window built for it — Window ▸ Move to New
   * Window. The same handover, minus the drop point; the window is built
   * hidden and appears only when the handover is committed. */
  reserveNewWindow: (path: string) =>
    invoke<TabDragReservation>('tabdrag_reserve_new_window', { path }),
  /** Report a held handover and deliver it. A destination destroyed since the
   * reservation was taken has already handed the document back, and this is
   * where the source hears it — as a refusal, with its tab still the only
   * copy. */
  commit: (token: number) => invoke<TabDragResult>('tabdrag_commit', { token }),
  /** Undo a held handover the source is not going to commit — the write a move
   * costs failed, so the document must not arrive anywhere. */
  release: (token: number) => invoke<TabDragResult>('tabdrag_release', { token }),
  /** `x` is physical pixels from THIS window's own strip's left edge. */
  onHover: (callback: (x: number) => void) =>
    listen<{ x: number }>('tabdrag://hover', (event) => callback(event.payload.x)),
  onLeave: (callback: () => void) => listen('tabdrag://leave', () => callback()),
  /** A document coming back from a handover that was reported as done and then
   * undone — the window it went to was destroyed before it ever opened it.
   * Ownership is already back here; what arrives is the instruction to put the
   * document on screen again. Only the path crosses. */
  onReturned: (callback: (path: string) => void) =>
    listen<{ path: string }>('tabdrag://returned', (event) => callback(event.payload.path)),
  /** The insertion gap this window is painting for someone else's drag,
   * derived from its OWN tabs. A drop resolves to the index last reported by
   * the window it lands in; the far side clears it with the caret. */
  hoverIndex: (index: number) => invoke<void>('tabdrag_hover_index', { index }),
  /** This window's tab order, published whenever it changes. Data only: the
   * quit capture reads the LAST published order and never waits for one. */
  setTabOrder: (paths: string[]) => invoke<void>('set_tab_order', { paths }),
};

/** Paths and output folders this window holds. The arbiter is Rust managed
 * state — one process, one table — and every claim is released when the
 * window is destroyed, so a hung renderer cannot wedge a path. */
export const claims = {
  claim: (path: string, mode: 'write' | 'read') =>
    invoke<ClaimResult>('claim_document', { path, mode }),
  release: (path: string) => invoke<void>('release_document', { path }),
  claimOutputRoot: (path: string) => invoke<ClaimResult>('claim_output_root', { path }),
  releaseOutputRoot: (path: string) => invoke<void>('release_output_root', { path }),
};

// ── File dialogs ──────────────────────────────────────────────────────────

// Dialogs are OS-modal (parented in Rust), but modality lands a beat after
// the click — serialize here too so a rapid second click joins the open
// dialog instead of stacking another.
let openDialogInflight: Promise<string[]> | null = null;
let saveDialogInflight: Promise<string | null> | null = null;
let createPdfDialogInflight: Promise<string[]> | null = null;

/** One row of the Windows certificate store's signing-capable certificates. */
export interface StoreCertificate {
  thumbprint: string;
  subject: string;
  issuer: string;
  not_after: string;
  eku: string[];
  hardware_backed: boolean;
  machine_store: boolean;
}

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
  /**
   * Certificates in the Windows certificate store that can sign a document.
   *
   * Read-only and key-free: the rows describe certificates, and the only
   * thing a signing request later carries is a thumbprint. Enumeration runs
   * under a silent context, so opening the picker never raises a PIN prompt.
   */
  listStoreCertificates: () => invoke<StoreCertificate[]>('list_store_certificates'),
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
  /** Where a saved accessibility report goes — one picker, both formats. The
   * extension the user lands on decides which emitter runs. Null if
   * cancelled. */
  saveReportFile: (defaultName?: string) =>
    invoke<string | null>('save_report_file', { defaultName }),
};

/** Write a report to a path the save dialog returned. The Rust side refuses
 * any name that is not a report's, so this cannot become a general write. */
export const report = {
  write: (path: string, contents: string) =>
    invoke<string>('write_report_file', { path, contents }),
};

/** A preflight profile at a path the user picked. Both directions go around
 * the capability-scoped filesystem plugin, which reaches only the app's own
 * temp tree: a profile exists to be handed to someone, so it is written and
 * read wherever they keep it. The Rust write refuses any name that is not a
 * profile's, so this cannot become a general write. */
export const profileFile = {
  write: (path: string, contents: string) =>
    invoke<string>('write_profile_file', { path, contents }),
  read: async (path: string) =>
    new Uint8Array(await invoke<ArrayBuffer>('read_file_binary', { filePath: path })),
};

/** A guided action at a path the user picked — the same shape, for the same
 * reason: an action is exported so it can be handed to someone or fed to the
 * command line, and the scoped filesystem plugin reaches only the app's own
 * temp tree. Its own Rust command, so neither arbitrary-path write can be
 * steered into producing the other's artifact. */
export const actionFile = {
  write: (path: string, contents: string) =>
    invoke<string>('write_action_file', { path, contents }),
  read: async (path: string) =>
    new Uint8Array(await invoke<ArrayBuffer>('read_file_binary', { filePath: path })),
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

/** `src-tauri/src/gs.rs` `GsAnswer` — one validated answer about one path.
 * `reason` is a named code (`not-configured`, `not-executable`,
 * `probe-failed`, `version-below-minimum`), never a sentence to match on. */
export interface GsAnswer {
  available: boolean;
  path: string;
  version: string;
  reason: string;
  detail: string;
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
  /** Whatever is on the clipboard, written to a scratch file Create PDF
   * already accepts. The BYTES never cross this boundary — a pasted
   * screenshot is megabytes and the engine needs a file anyway. */
  readClipboardSource: () => invoke<ClipboardSourceResult>('read_clipboard_source'),
  /** Capture a web page in a VISIBLE browser window, through WebView2's own
   * print-to-PDF. Every fetch this makes is one the user started and can
   * watch; the engine is not involved and gains no network code. */
  captureWebPage: (options: CaptureRequest) =>
    invoke<CaptureResult>('capture_web_page', {
      options: {
        url: options.url,
        depth: options.depth,
        maxPages: options.maxPages,
        pageWidthIn: options.pageWidthIn,
        pageHeightIn: options.pageHeightIn,
        orientation: options.orientation,
        marginIn: options.marginIn,
        headersFooters: options.headersFooters,
        backgrounds: options.backgrounds,
        scale: options.scale,
      },
    }),
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
  /** The installed ICC press profiles' directory. Mirrors getDictionaryPath:
   * Rust owns the resource path, and the engine reads the profiles itself —
   * the bytes never cross this boundary. */
  getIccPath: () => invoke<string>('get_icc_path'),
  /** Whether the bundled profiles' licence has been accepted, and whether this
   * container can ask. See `lib/icc-assent.ts`; the shape is
   * `portable::AssentState`. */
  iccAssentState: () =>
    invoke<{ portable: boolean; assent: string; licensePath: string }>('icc_assent_state'),
  /** The Exhibit B text, read from the file the profiles ship beside — the
   * same file the installer's licence page presents. */
  iccLicenseText: () => invoke<string>('icc_license_text'),
  /** Records the answer, drops the running engine so the next call carries it,
   * and returns the new state. */
  recordIccAssent: (accepted: boolean) =>
    invoke<{ portable: boolean; assent: string; licensePath: string }>('record_icc_assent', {
      accepted,
    }),
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
  /** The validated capability answer for `path`, or for discovery when it is
   * omitted. Cached in Rust per path + mtime + size. */
  gsCapability: (path?: string) => invoke<GsAnswer>('gs_capability', { path: path ?? null }),
  /** The same answer with Rust's probe cache dropped first — what a Browse,
   * a cleared path, or a Ghostscript installed while the app is open needs. */
  refreshGsCapability: (path?: string) =>
    invoke<GsAnswer>('refresh_gs_capability', { path: path ?? null }),
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

  /** Mirror restore-windows-on-launch into the same Rust-readable file. The
   * windows are rebuilt during startup, before a renderer exists to be asked
   * what the preference says. */
  setRestoreWindowsOnLaunch: (enabled: boolean) =>
    invoke('set_restore_windows_on_launch', { enabled }),

  /** Close THIS window, quitting only when it was the last one. The count is
   * taken in Rust: a renderer knows nothing about another window's unsaved
   * work, and destroying a fixed label discards whichever window did not ask. */
  confirmClose: () => invoke<boolean>('confirm_close'),

  /** The window × : close, or hide to tray when this is the only window left.
   * Tray residency is an app-level state, so a second window's × closes that
   * window rather than hiding the app.
   *
   * False means the window is still standing: the last window out captures the
   * session, and a capture that did not reach disk calls the teardown off
   * rather than exiting with an older run's record on the file. */
  closeWindow: (minimizeToTray: boolean) => invoke<boolean>('close_window', { minimizeToTray }),

  /** Ask every other window to run its own close flow. Each answers by closing
   * itself and the last one out exits, so a window that cancels keeps the app.
   *
   * Resolves to whether this window may now close. The request is not assumed
   * delivered: a window whose renderer has not installed its listener never
   * hears it and never closes, and closing anyway would leave it standing
   * behind a session record frozen at the moment Exit was chosen. False means
   * the quit is off — nothing closed, and the record is live again. */
  requestQuit: () => invoke<boolean>('request_quit'),

  /** Acknowledge a beforeClose that belongs to a quit. Receipt only: it says
   * this renderer heard the request and is running its close flow, which is
   * what an emit cannot report on its own. */
  quitAck: (quitId: number) => invoke('quit_ack', { quitId }),

  /** Report that this window's close prompt was cancelled, so the quit the
   * prompt belonged to is off. The quit recorded the session and froze the
   * record before prompting; the app is still running, so the record goes back
   * to following the windows that are left. Safe to call unprompted. */
  quitCancelled: () => invoke('quit_cancelled'),

  /** Hide this window to the system tray instead of closing. */
  hideToTray: () => invoke('hide_to_tray'),

  /** Open an empty second workspace; resolves to its label. */
  openNewWindow: () => invoke<string>('open_new_window'),

  /** Raise a window by label (the "it is open over there" refusal's action). */
  focusWindow: (label: string) => invoke<void>('focus_app_window', { label }),

  /** Listen for close-requested event (Rust intercepted the window close).
   * The quit id names the app-level quit this request belongs to, and is null
   * for a window × — which no quit is waiting on. */
  onBeforeClose: (callback: (quitId: number | null) => void) => {
    return listen<{ quitId: number | null }>('app:beforeClose', (event) =>
      callback(event.payload?.quitId ?? null),
    );
  },

  /** Listen for the round that runs BEFORE a quit captures the session.
   * Each peer finishes publishing what it has measured and acknowledges; only
   * once every one of them has is the record taken and sealed. Without it a
   * reorder made in this window was sealed over whenever another one exited —
   * the capture ran before anybody was asked anything. */
  onPrepareClose: (callback: (quitId: number) => void) => {
    return listen<{ quitId: number | null }>('app:prepareClose', (event) => {
      const quitId = event.payload?.quitId;
      if (typeof quitId === 'number') callback(quitId);
    });
  },

  /** Listen for the open signal (CLI args, second instance, context menu,
   * virtual printer, pop-out). The payload is drained with `takePendingOpens`
   * rather than carried on the event: a window created FOR an open has no
   * listener yet when the event fires. */
  onOpenFile: (callback: () => void) => {
    return listen('app:openFile', () => callback());
  },

  /** Take (and clear) the opens queued for this window. `index` is the tab
   * position the first file lands at when the open came from a gesture that
   * named one (a dropped tab); null for every other open, which appends. */
  takePendingOpens: () =>
    invoke<{ files: string[]; merge: boolean; index: number | null }[]>('take_pending_opens'),

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
