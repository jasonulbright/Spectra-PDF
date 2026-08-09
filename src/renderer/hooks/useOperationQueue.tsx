import React, { createContext, useContext, useCallback, useState, useRef } from 'react';
import type { QueueItem } from '../components/OperationQueue';
import { app } from '../lib/tauri-bridge';
import { tChrome, tChromeCount, tQueueOp } from '../i18n';
import { rawEngineMessage } from '../lib/engine-messages';

interface QueueContextValue {
  items: QueueItem[];
  /** Track an async operation in the queue. Returns a promise that resolves when the operation completes. */
  track: (
    method: string,
    params: Record<string, unknown>,
    operation: () => Promise<unknown>,
  ) => Promise<unknown>;
  clear: () => void;
}

const QueueContext = createContext<QueueContextValue | null>(null);

/** The op NAME per engine method — a data table, so the i18n catalog gate
 * generates an `opqueue.op.<method>` key from every row (exported for it). */
export const FRIENDLY_NAMES: Record<string, string> = {
  merge: 'Merge',
  create_pdf: 'Create PDF',
  split: 'Split',
  add_attachment: 'Attach File',
  remove_attachment: 'Remove Attachment',
  make_portfolio: 'Convert to Portfolio',
  update_portfolio_member: 'Update Portfolio Member',
  rotate: 'Rotate',
  delete: 'Delete Pages',
  compress: 'Compress',
  optimize: 'Optimize',
  convert_pdfa: 'PDF/A',
  encrypt: 'Encrypt',
  decrypt: 'Decrypt',
  extract_text: 'Extract Text',
  set_metadata: 'Update Metadata',
  set_outline: 'Save Bookmarks',
  unlock: 'Unlock',
  redact: 'Redact',
  search_text_regions: 'Search & Redact',
  watermark: 'Watermark',
  compare_text: 'Compare',
  compare_visual: 'Compare (visual)',
  apply_ocr_layer: 'Apply OCR Text',
  // The document REWRITE. Its read half (`analyze_scan`) is deliberately
  // absent: it refetches on every setting change while the pane is open, and
  // a queue entry per keystroke pause is noise, not a record.
  enhance_scan: 'Enhance Scans',
  set_page_boxes: 'Crop Pages',
  content_crop: 'Crop to Content',
  delete_page_image: 'Delete Image',
  delete_page_images: 'Delete Images',
  replace_page_image: 'Replace Image',
  transform_page_image: 'Move Image',
  transform_page_images: 'Move Images',
  crop_page_image: 'Crop Image',
  set_image_opacity: 'Adjust Image',
  add_page_image: 'Add Image',
  add_page_vector_graphic: 'Add Graphic',
  replace_text_run: 'Edit Text',
  convert_text_run: 'Edit Text',
  print: 'Print',
  export_document: 'Export',
  export_images: 'Export Images',
  verify_signatures: 'Verify Signatures',
  // NB: the descriptor below is a WHITELIST — the signing password is not
  // among the fields it copies, so it can't reach the queue or the log.
  sign_pdf: 'Sign',
  // Same property: only whitelisted (non-secret) fields reach the queue
  // label; the .pfx password stays out of every sink.
  generate_signer: 'Create Signer',
  list_inks: 'Read Inks',
  render_separations: 'Render Separations',
  set_field_lock: 'Set Field Lock',
  set_document_js: 'Edit Document JavaScript',
  set_initial_view: 'Set Initial View',
  set_advanced_properties: 'Set Document Properties',
  set_struct_props: 'Edit Tag',
  move_struct_node: 'Move Tag',
  delete_struct_node: 'Delete Tag',
  add_struct_node: 'New Tag',
};

/** Methods that are internal lookups, not user-facing operations. */
// Reads. They are NOT user-facing operations, so they don't belong in the
// queue — and, more importantly, `useEngine.call` runs the COMMIT GATE for
// anything trackable, which would make merely LOOKING at a document flush its
// pending page edits to disk.
//
// `get_pdf_version` was missing from this list (found by the Properties
// e2e): every read of the PDF version — the Optimize pane's, and now the
// Properties dialog's — was queuing as an operation and gating a commit.
const INTERNAL_METHODS = new Set([
  'get_page_count',
  'get_page_info',
  'check_encrypted',
  'get_metadata',
  'get_pdf_version',
  // The Properties dialog's three read-only tabs. Same hazard as
  // `get_pdf_version`: the dialog runs the commit gate ONCE on open, and a
  // per-read gate would flush pending page edits every time a tab is clicked.
  // The initial-view read also runs on every OPEN, where gating would commit
  // another document's pending edits merely because a file was opened.
  'get_initial_view',
  'get_advanced_properties',
  'list_document_fonts',
  'get_outline',
  // Reading the document's JavaScript is a pure lookup — trackable would
  // route it through the commit gate and flush pending page edits just for
  // opening the panel (the get_pdf_version/get_outline hazard).
  'list_document_js',
  // Fit indicator: a pure read despite taking a file
  // — it measures how NEW text would wrap, independent of page content, so
  // gating it would force-commit unrelated pending page edits on every
  // keystroke pause in the Add Text card (the exact get_pdf_version bug).
  'measure_text_box',
  // The GUI form read routes through the engine (`lib/forms.ts`). It is a
  // pure lookup that drives the FormsPanel + the on-canvas overlay on every
  // buffer change — gating it would flush the user's pending page edits to disk
  // just for showing a form's fields (the get_pdf_version/measure_text_box
  // hazard). Fills still go through the gated `fill_form_fields`.
  'read_form_fields',
  // Reading /PageLabels to seed the editor panel — a lookup, not an edit;
  // set_page_labels stays gated.
  'get_page_labels',
  // Enumerating the machine's installed fonts touches no document at
  // all — it names no file, so the commit gate and the per-file lock have
  // nothing to gate, and running it through them would put a font-picker
  // open in front of the user's actual work in the serial engine queue.
  'list_system_fonts',
  // The spell checker's reads. Three of them name no file at all — the
  // dictionary listing, the editor's per-keystroke text check and a single
  // word's suggestions — so there is nothing for the gate or the per-file
  // lock to act on, and routing the editor's debounced check through the
  // serial queue would put a squiggle in front of the user's actual work.
  // Adding a user dictionary copies the user's own files and never touches a
  // document (the extract_attachment case). Reading /Lang seeds the panel's
  // default language on open, where gating would flush pending page edits
  // merely for looking (the get_pdf_version hazard). check_spelling itself
  // stays GATED: it must see the edits the user can see, and it is a
  // deliberate action, not a background read.
  'list_dictionaries',
  'check_text',
  'spelling_suggestions',
  'add_user_dictionary',
  'document_language',
  // Listing embedded attachments to seed the panel — a read; add/remove
  // (mutations) stay gated.
  'list_attachments',
  // Extracting an attachment writes it OUT to a user path; it never mutates the
  // document, so it must not gate/flush pending page edits.
  'extract_attachment',
  // Portfolio-ness + member list seeds the Portfolio panel AND the open-time
  // auto-check on every document — a read; gating it would flush pending page
  // edits just for opening a file (the get_pdf_version hazard).
  'get_portfolio',
  // The open-member extract writes a member OUT to the managed folder; like
  // extract_attachment it never mutates the document.
  'extract_member_to_dir',
  // Listing optional-content groups to seed the Layers panel — a read;
  // set_layer_visibility (mutation) stays gated.
  'list_layers',
  // The accessibility checker is pure analysis — no mutation.
  'check_accessibility',
  // Listing markup annotations for the Comments overview — a read;
  // delete_all_annotations (mutation) stays gated.
  'list_annotations',
  // Preflight is pure print-production analysis — no mutation.
  'preflight',
  // Listing link regions to seed the Links panel — a read; set_link_url /
  // delete_link (mutations) stay gated.
  'list_links',
  // Reading the structure tree to seed the Tags + Reading Order panels — a
  // read; the set/move/delete/add tag mutations stay gated.
  'get_struct_tree',
  // The snap-geometry probe. A pure read, and the
  // get_pdf_version/measure_text_box hazard in its sharpest form: it refetches
  // whenever the workspace changes, and an ANNOTATION is a pending page edit,
  // so gating it would flush the user's just-drawn markup to disk the instant
  // they drew it (e2e regression: specs 87 and 88 lost their page-tier
  // annotations mid-suite). Correctness does NOT rest on the gate here — the
  // probe addresses the SOURCE file at `sourcePageIndex`, exactly the page
  // pdf.js rasterizes, so a pending reorder cannot mis-address it and a
  // pending rotation is applied by the same projection the raster gets.
  'list_page_geometry',
  // The hidden-information inventory. A pure read, and one that refetches
  // whenever its panel is open — an ANNOTATION is a pending page edit, so
  // gating it would flush the user's just-drawn markup to disk the instant
  // they drew it (the list_page_geometry hazard). `sanitize_pdf` replaces the
  // file's bytes and stays gated.
  'audit_hidden_information',
  // The per-category byte breakdown. A pure read on the same terms: it runs
  // when the Optimize panel opens and again on every buffer change, so gating
  // it would commit the user's pending page edits merely for looking.
  'audit_space_usage',
  // What a document's signatures permit. A structural read consulted before
  // every edit — gating it would flush the user's pending annotations to disk
  // merely to ask whether the edit may proceed (the audit_hidden_information
  // hazard). The edit that follows runs the gate itself.
  'signature_policy',
  // The effective-resolution summary behind the Images row and the Compress
  // panel's DPI context. A pure read that walks every page's content stream,
  // and one the Compress panel refetches on every buffer change — gating it
  // would commit the user's pending page edits merely for looking (the
  // audit_space_usage hazard).
  'summarize_image_resolution',
  // Compositing cached separation plates into a preview image. It names a
  // PLATE DIRECTORY, not a document — there is nothing for the commit gate to
  // gate, and routing it through would commit the user's pending page edits
  // on every ink checkbox.
  'composite_separations',
]);

export function isTrackableMethod(method: string): boolean {
  return !INTERNAL_METHODS.has(method);
}

function fileName(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path.split(/[\\/]/).pop() || '';
}

/**
 * What a queue line SAYS, as data rather than as a finished
 * English sentence. The queue stores this descriptor and renders it at the
 * current language on every paint, while the operation LOG renders the same
 * descriptor pinned to English (a diagnostic sink — the slice-D boundary).
 *
 * SECURITY, strengthened here: the descriptor is a WHITELIST of the few
 * values a label needs (a base file name, a page list, a count, a format).
 * The engine params — which for `sign_pdf` include the signing password and
 * for a token flow the PIN — are read once, synchronously, and never stored.
 * Previously the safety rested on the formatter's default branch happening
 * not to touch anything but `params.file`; now no param can reach the queue
 * unless it is named below.
 */
export interface QueueLabel {
  method: string;
  /** Base name of the operated file, if the label names one. */
  file?: string;
  fileA?: string;
  fileB?: string;
  /** Joined page list, or null for "every page". */
  pages?: string | null;
  ranges?: string | null;
  copies?: number;
  detail?: string;
  level?: string;
  fileCount?: number;
  regionCount?: number;
  fmt?: string;
  dpi?: string;
  angle?: number;
}

function pageList(pages: unknown): string | null {
  if (Array.isArray(pages)) return pages.join(',');
  if (typeof pages === 'string' && pages) return pages;
  return null;
}

/** Build the descriptor for an engine call. Pure, and the only place that
 * ever reads `params` on the queue's behalf. */
export function describeOperation(
  method: string,
  params: Record<string, unknown> = {},
): QueueLabel {
  const l: QueueLabel = { method, file: fileName(params.file) };
  switch (method) {
    case 'rotate':
      l.angle = Number(params.angle);
      l.pages = pageList(params.pages);
      break;
    case 'delete':
    case 'extract_text':
      l.pages = pageList(params.pages);
      break;
    case 'print':
      l.pages = pageList(params.pages);
      l.copies = Number(params.copies);
      break;
    case 'split':
      l.ranges = typeof params.ranges === 'string' && params.ranges ? params.ranges : null;
      break;
    case 'compress':
      l.detail = typeof params.quality === 'string' && params.quality ? params.quality : 'ebook';
      break;
    case 'convert_pdfa':
      l.level = typeof params.level === 'string' && params.level ? params.level : '2b';
      break;
    case 'merge':
      l.fileCount = Array.isArray(params.files) ? params.files.length : 0;
      break;
    case 'redact':
      l.regionCount = Array.isArray(params.regions) ? params.regions.length : 0;
      break;
    case 'compare_text':
      l.fileA = fileName(params.file_a);
      l.fileB = fileName(params.file_b);
      break;
    case 'export_document':
      l.fmt = String(params.fmt ?? '').toUpperCase();
      break;
    case 'export_images':
      l.fmt = String(params.fmt ?? '').toUpperCase();
      l.dpi = String(params.dpi ?? '');
      break;
    default:
      break;
  }
  return l;
}

/** Render a descriptor. `lng` pins the language — the log passes 'en'. */
export function formatQueueLabel(l: QueueLabel, lng?: string): string {
  const op = tQueueOp(l.method, FRIENDLY_NAMES[l.method] || l.method, lng);
  const file = l.file ?? '';
  const pages =
    l.pages === null || l.pages === undefined
      ? tChrome('dialog.opqueue.allPages', undefined, lng)
      : tChrome('dialog.opqueue.pageList', { pages: l.pages }, lng);

  switch (l.method) {
    case 'rotate': {
      const dir =
        l.angle === 90
          ? tChrome('dialog.opqueue.cw', undefined, lng)
          : l.angle === 270
            ? tChrome('dialog.opqueue.ccw', undefined, lng)
            : tChrome('dialog.opqueue.degrees', { angle: Number(l.angle) }, lng);
      return tChrome('dialog.opqueue.rotate', { op, dir, pages, file }, lng);
    }
    case 'delete':
    case 'extract_text':
      return tChrome('dialog.opqueue.pages', { op, pages, file }, lng);
    case 'print':
      return Number(l.copies) > 1
        ? tChrome('dialog.opqueue.printCopies', {
            op, pages, copies: Number(l.copies), file,
          }, lng)
        : tChrome('dialog.opqueue.pages', { op, pages, file }, lng);
    case 'split':
      return tChrome('dialog.opqueue.ranges', {
        op,
        ranges: l.ranges ?? tChrome('dialog.opqueue.allPages', undefined, lng),
        file,
      }, lng);
    case 'compress':
      return tChrome('dialog.opqueue.detail', { op, detail: l.detail ?? '', file }, lng);
    case 'convert_pdfa':
      return tChrome('dialog.opqueue.level', { op, level: l.level ?? '', file }, lng);
    case 'encrypt':
    case 'decrypt':
    case 'set_metadata':
    case 'unlock':
      return tChrome('dialog.opqueue.file', { op, file }, lng);
    case 'merge':
      return tChromeCount('dialog.opqueue.mergeFiles', l.fileCount ?? 0, { op }, lng);
    case 'redact':
      return tChromeCount('dialog.opqueue.redactRegions', l.regionCount ?? 0, { op, file }, lng);
    case 'compare_text':
      return tChrome('dialog.opqueue.compare', { op, a: l.fileA ?? '', b: l.fileB ?? '' }, lng);
    case 'export_document':
      return tChrome('dialog.opqueue.format', { op, fmt: l.fmt ?? '', file }, lng);
    case 'export_images':
      return tChrome('dialog.opqueue.formatDpi', {
        op, fmt: l.fmt ?? '', dpi: l.dpi ?? '', file,
      }, lng);
    default:
      return file
        ? tChrome('dialog.opqueue.file', { op, file }, lng)
        : tChrome('dialog.opqueue.plain', { op }, lng);
  }
}

export function QueueProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = useState<QueueItem[]>([]);
  const idCounter = useRef(0);

  const track = useCallback((
    method: string,
    params: Record<string, unknown>,
    operation: () => Promise<unknown>,
  ) => {
    const id = String(++idCounter.current);
    const startTime = Date.now();
    // Read `params` ONCE, here, into the whitelisted descriptor — nothing
    // else about the call is retained (see describeOperation's note).
    const label = describeOperation(method, params);
    setItems((prev) => [...prev, { id, label, status: 'running', message: '', startTime }]);

    // The log is a DIAGNOSTIC sink and stays English regardless of the UI
    // language (the same boundary the engine's own messages sit on).
    const logLine = (status: string, detail: string) => {
      const ts = new Date(startTime).toISOString();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const english = formatQueueLabel(label, 'en');
      app.appendOperationLog(`${ts} [${status}] ${english} — ${detail} (${elapsed}s)`).catch(() => {});
    };

    return operation().then(
      (result) => {
        setItems((prev) => prev.map((item) =>
          item.id === id ? { ...item, status: 'done' as const, message: '' } : item
        ));
        logLine('OK', 'Complete');
        return result;
      },
      (err) => {
        // The queue LINE renders in the UI language; the LOG stays English
        // (an engine refusal keeps its original text in the
        // diagnostic sink, exactly as the label above passes `lng: 'en'`).
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) => prev.map((item) =>
          item.id === id ? { ...item, status: 'error' as const, message } : item
        ));
        logLine('ERROR', rawEngineMessage(err));
        throw err;
      },
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return (
    <QueueContext.Provider value={{ items, track, clear }}>
      {children}
    </QueueContext.Provider>
  );
}

export function useOperationQueue(): QueueContextValue {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useOperationQueue must be used within QueueProvider');
  return ctx;
}
