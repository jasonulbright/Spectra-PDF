/**
 * Per-path locks for engine operations and workspace publication.
 *
 * The commit gate guarantees the engine reads bytes matching what the user
 * sees; it does NOT guarantee that two whole-file operations naming the SAME
 * path cannot run at once. Two rewrites of one path each write a temp and
 * rename, and the losing rename silently wins.
 *
 * A key is held SHARED or EXCLUSIVE. Shared holders of a key run together;
 * an exclusive holder waits for every earlier holder of the key and every
 * later holder waits for it, so neither mode starves the other. Rules that
 * keep this from becoming a deadlock surface:
 *
 *   - ALL of an acquisition's keys are claimed in ONE synchronous step,
 *     before any await. Two acquisitions therefore never hold a partial,
 *     opposing subset of each other's keys.
 *   - The lock is released in a `finally`; a rejected holder must not wedge
 *     the key it failed on.
 *   - Waiting uses `allSettled`: an earlier holder's failure is its caller's
 *     business and must not reject the next holder.
 *   - The commit gate runs OUTSIDE the lock. The gate itself writes files, so
 *     gating from inside would have an operation wait on a commit that waits
 *     on the operation.
 *   - Lock order, one for every holder: write chain (`withWriteChain`), then
 *     file locks of working copies, then the publication lane
 *     (`workspace-publication.ts`), then file locks of keys the holder created
 *     itself (stages, temps), which have no other holder. A holder that needs
 *     an earlier kind than one it holds releases the later kinds first. A
 *     lane holder therefore never waits for a reader, and no file-lock holder
 *     waits for a write chain.
 *   - Locks are not reentrant: a holder that locks a key it already holds
 *     waits for itself.
 */

export type LockMode = 'shared' | 'exclusive';
export interface LockClaim { key: string; mode: LockMode }

/**
 * `S` shared, `X` exclusive. `X:` followed by `|`-separated terms is exclusive
 * when any term holds and shared otherwise: `name` holds when the call's
 * `name` parameter is truthy, `!name` when it is falsy or absent. A folder run
 * rewrites, moves or deletes its sources only under such options, and a
 * writer with no output rewrites its input.
 */
type TableMode = 'S' | 'X' | `X:${string}`;

/**
 * Every engine method -> every path parameter it takes -> its lock mode. A
 * method with no keys names no document. The mode is per method, not per
 * parameter name: an in-place writer is exclusive on the key it rewrites.
 * `data` carries base64 bytes and is never a key. A folder key gives string
 * identity only; exclusion over a folder tree comes from the Rust claim
 * state. tests/test_engine_lock_table.py checks this table against every
 * registered handler signature and against the paths each handler writes,
 * moves or deletes; keep one row per line.
 */
export const ENGINE_LOCK_TABLE: Readonly<Record<string, Readonly<Record<string, TableMode>>>> = {
  ping: {},
  merge: { files: 'S', output: 'X' },
  split: { file: 'S', output_dir: 'X', output: 'X', output_paths: 'X' },
  split_plan: { file: 'S', destination_dir: 'S' },
  rotate: { file: 'S', output: 'X' },
  delete: { file: 'S', output: 'X' },
  compress: { file: 'S', output: 'X' },
  grayscale: { file: 'S', output: 'X' },
  convert_cmyk: { file: 'S', output: 'X' },
  convert_pdfx: { file: 'S', output: 'X' },
  optimize: { file: 'S', output: 'X' },
  convert_pdfa: { file: 'S', output: 'X' },
  encrypt: { file: 'S', output: 'X' },
  grant_accessibility_permission: { file: 'S', output: 'X' },
  decrypt: { file: 'S', output: 'X' },
  encrypt_pubkey: { file: 'S', output: 'X' },
  decrypt_pubkey: { file: 'S', output: 'X', pfx: 'S' },
  open_pubkey_document: { path: 'X', pfx: 'S' },
  pubkey_reseal: { path: 'S', output: 'X' },
  pubkey_reattach: { path: 'S', source: 'S', pfx: 'S' },
  extract_text: { file: 'S', output: 'X' },
  search_in_files: { paths: 'S' },
  search_text_regions: { file: 'S' },
  add_header_footer: { file: 'S', output: 'X' },
  set_page_boxes: { file: 'S', output: 'X' },
  content_crop: { file: 'S', output: 'X' },
  get_page_labels: { file: 'S' },
  set_page_labels: { file: 'S', output: 'X' },
  export_xfdf: { file: 'S', output: 'X' },
  import_xfdf: { file: 'S', xfdf: 'S', output: 'X' },
  export_count_summary: { file: 'S', output: 'X' },
  list_attachments: { file: 'S' },
  add_attachment: { file: 'S', output: 'X', source: 'S' },
  extract_attachment: { file: 'S', output: 'X' },
  remove_attachment: { file: 'S', output: 'X' },
  get_portfolio: { file: 'S' },
  create_portfolio: { output: 'X', sources: 'S' },
  make_portfolio: { file: 'S', output: 'X' },
  update_portfolio_member: { file: 'S', output: 'X', source: 'S' },
  extract_member_to_dir: { file: 'S', dest_dir: 'X' },
  list_layers: { file: 'S' },
  set_layer_visibility: { file: 'S', output: 'X' },
  check_accessibility: { file: 'S' },
  apply_accessibility_fixes: { file: 'S', output: 'X' },
  list_annotations: { file: 'S' },
  list_comments: { file: 'S' },
  summarize_comments: { file: 'S', output: 'X', font_path: 'S' },
  delete_all_annotations: { file: 'S', output: 'X' },
  preflight: { file: 'S', profile_path: 'S' },
  list_preflight_profiles: {},
  validate_preflight_profile: {},
  apply_preflight_fixups: { file: 'S', output: 'X', profile_path: 'S' },
  run_preflight_sweep: { source: 'X:in_place|move_processed_root', dest: 'X', profile_path: 'S', log_dir: 'X', move_processed_root: 'X' },
  list_inks: { file: 'S' },
  render_separations: { file: 'S' },
  composite_separations: { dir: 'X', output: 'X' },
  list_simulation_profiles: { file: 'S' },
  inspect_point: { file: 'S', plates_dir: 'S' },
  alias_ink: { file: 'S', output: 'X' },
  compare_ink_transforms: { file: 'S' },
  spot_to_process: { file: 'S', output: 'X' },
  ink_settings_defaults: { file: 'S' },
  add_printer_marks: { file: 'S', output: 'X' },
  remove_printer_marks: { file: 'S', output: 'X' },
  list_printer_marks: { file: 'S' },
  list_hairlines: { file: 'S' },
  fix_hairlines: { file: 'S', output: 'X' },
  list_transparency: { file: 'S' },
  flatten_transparency: { file: 'S', output: 'X' },
  list_outlines: { file: 'S' },
  trap_preset_defaults: {},
  validate_trap_preset: {},
  assign_trap_presets: { file: 'S', output: 'X' },
  list_trap_presets: { file: 'S' },
  emit_trapping_setup: { file: 'X:!output', output: 'X' },
  export_postscript: { file: 'S', output: 'X' },
  get_struct_tree: { file: 'S' },
  set_struct_props: { file: 'S', output: 'X' },
  set_table_headers: { file: 'S', output: 'X' },
  tag_page_content: { file: 'S', output: 'X' },
  move_struct_node: { file: 'S', output: 'X' },
  delete_struct_node: { file: 'S', output: 'X' },
  add_struct_node: { file: 'S', output: 'X' },
  list_links: { file: 'S' },
  set_link_url: { file: 'S', output: 'X' },
  set_link_target: { file: 'S', output: 'X' },
  set_link_appearance: { file: 'S', output: 'X' },
  set_link_rect: { file: 'S', output: 'X' },
  list_named_destinations: { file: 'S' },
  delete_link: { file: 'S', output: 'X' },
  add_links: { file: 'S', output: 'X' },
  export_document: { file: 'S', output: 'X' },
  supported_export_formats: {},
  detect_tables: { file: 'S' },
  export_images: { file: 'S', output: 'X' },
  get_metadata: { file: 'S' },
  set_metadata: { file: 'S', output: 'X' },
  strip_metadata: { file: 'S', output: 'X' },
  get_pdf_version: { file: 'S' },
  set_pdf_version: { file: 'S', output: 'X' },
  get_initial_view: { file: 'S' },
  set_initial_view: { file: 'S', output: 'X' },
  get_advanced_properties: { file: 'S' },
  set_advanced_properties: { file: 'S', output: 'X' },
  set_document_language: { file: 'S', output: 'X' },
  set_document_title: { file: 'S', output: 'X' },
  set_page_tab_order: { file: 'S', output: 'X' },
  list_document_fonts: { file: 'S' },
  get_page_count: { file: 'S' },
  get_page_info: { file: 'S' },
  check_encrypted: { file: 'S' },
  unlock: { file: 'X' },
  open_document: { path: 'X' },
  open_document_attempt: { path: 'X' },
  close_document: { path: 'S' },
  document_permissions: { path: 'S' },
  share_document: { path: 'S' },
  sealed_plaintext: { path: 'S' },
  sealed_reseal: { path: 'S', output: 'X' },
  repair: { file: 'S', output: 'X' },
  rebuild: { file: 'S', output: 'X' },
  recover: { file: 'S', output: 'X' },
  check: { file: 'S' },
  document_health: { file: 'S' },
  document_health_begin: { file: 'S' },
  document_health_step: {},
  document_health_end: {},
  get_outline: { file: 'S' },
  set_outline: { file: 'S', output: 'X' },
  preview_structure_outline: { file: 'S' },
  outline_from_structure: { file: 'S', output: 'X' },
  read_aloud_page: { file: 'S' },
  find_url_links: { file: 'S' },
  create_links_from_urls: { file: 'S', output: 'X' },
  list_threads: { file: 'S' },
  set_threads: { file: 'S', output: 'X' },
  list_document_js: { file: 'S' },
  set_document_js: { file: 'S', output: 'X' },
  redact: { file: 'S', output: 'X' },
  remove_redaction_residue: { file: 'S', output: 'X' },
  search_and_redact: { file: 'S', output: 'X' },
  audit_hidden_information: { file: 'S' },
  sanitize_pdf: { file: 'S', output: 'X' },
  audit_space_usage: { file: 'S' },
  watermark: { file: 'S', output: 'X', image: 'S', pdf_source: 'S' },
  compare_text: { file_a: 'S', file_b: 'S' },
  compare_visual: { file_a: 'S', file_b: 'S' },
  read_form_fields: { file: 'S' },
  fill_form_fields: { file: 'S', output: 'X' },
  reset_form_fields: { file: 'S', output: 'X' },
  export_form_data: { file: 'S', output: 'X', source: 'S' },
  import_form_data: { file: 'S', output: 'X' },
  set_widget_visibility: { file: 'S', output: 'X' },
  detect_form_fields: { file: 'S' },
  create_detected_fields: { file: 'S', output: 'X' },
  prepare_form_fields: { file: 'S', output: 'X' },
  set_field_lock: { file: 'S', output: 'X' },
  author_vertical_field_font: { file: 'S', output: 'X' },
  author_choice_appearance: { file: 'S', output: 'X' },
  set_field_actions: { file: 'S', output: 'X' },
  set_field_description: { file: 'S', output: 'X' },
  apply_ocr_layer: { file: 'S', output: 'X' },
  recognize: { file: 'S' },
  recognize_raster: {},
  analyze_scan: { file: 'S' },
  enhance_scan: { file: 'S', output: 'X' },
  batch_ocr: { source: 'X:in_place|moved_root|error_root|remove_empty_folders|replace_repaired_originals', dest: 'X', moved_root: 'X', error_root: 'X', log_dir: 'X' },
  ocr_file: { file: 'S', output: 'X' },
  remove_empty_folders: { root: 'X', protected: 'S' },
  run_action: { source: 'X:in_place|move_processed_root', dest: 'X', log_dir: 'X', move_processed_root: 'X' },
  autotag: { file: 'S', output: 'X' },
  list_page_images: { file: 'S' },
  summarize_image_resolution: { file: 'S' },
  delete_page_image: { file: 'S', output: 'X' },
  replace_page_image: { file: 'S', output: 'X', source: 'S' },
  extract_page_image: { file: 'S', output_prefix: 'X' },
  transform_page_image: { file: 'S', output: 'X' },
  transform_page_images: { file: 'S', output: 'X' },
  delete_page_images: { file: 'S', output: 'X' },
  add_page_image: { file: 'S', output: 'X', source: 'S' },
  add_page_vector_graphic: { file: 'S', output: 'X', svg_path: 'S' },
  crop_page_image: { file: 'S', output: 'X' },
  list_page_vectors: { file: 'S' },
  list_page_geometry: { file: 'S' },
  delete_page_vector: { file: 'S', output: 'X' },
  transform_page_vector: { file: 'S', output: 'X' },
  restyle_page_vector: { file: 'S', output: 'X' },
  set_image_opacity: { file: 'S', output: 'X' },
  replace_text_run: { file: 'S', output: 'X' },
  restyle_text_run: { file: 'S', output: 'X' },
  convert_text_run: { file: 'S', output: 'X', font_path: 'S' },
  list_text_paragraphs: { file: 'S' },
  replace_paragraph_text: { file: 'S', output: 'X', font_path: 'S' },
  merge_paragraph_with_previous: { file: 'S', output: 'X', font_path: 'S' },
  list_dictionaries: { user_dictionary_dir: 'S' },
  check_spelling: { file: 'S', user_dictionary_dir: 'S' },
  check_text: { user_dictionary_dir: 'S' },
  document_language: { file: 'S' },
  spelling_suggestions: { user_dictionary_dir: 'S' },
  add_user_dictionary: { user_dictionary_dir: 'X' },
  distill: { file: 'S', output: 'X' },
  create_pdf: { sources: 'S', output: 'X' },
  list_source_folders: { source: 'S' },
  create_pdf_folders: { source: 'S', dest: 'X', log_dir: 'X' },
  list_system_fonts: {},
  add_text_box: { file: 'S', output: 'X', font_path: 'S' },
  measure_text_box: { file: 'S', font_path: 'S' },
  print: { file: 'S' },
  print_preview: { file: 'S', cleanup_dir: 'X' },
  print_preview_cleanup: { directory: 'X' },
  printed_job: { file: 'S', output: 'X' },
  verify_signatures: { file: 'S' },
  sign_pdf: { file: 'S', output: 'X', pfx_path: 'S', key_path: 'S', cert_path: 'S' },
  generate_signer: { output: 'X' },
  list_pkcs11_certificates: {},
  list_csc_credentials: {},
  preview_stamp_appearance: {},
  transplant_incremental: { original: 'S', modified: 'S', output: 'X' },
  signature_policy: { path: 'S' },
  save_redaction_marks: { file: 'S', output: 'X' },
  list_redact_annotations: { file: 'S' },
};

/** Parameter names a method missing from the table is locked on, all exclusive. */
const UNKNOWN_METHOD_KEYS = ['file', 'output', 'source', 'dest', 'path', 'output_path', 'files', 'inputs', 'sources'] as const;

/** Truthiness as the engine's handlers test it: an empty list or object is
 * false, as are `''`, `0`, `false`, `null` and an absent parameter. */
function engineTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Whether a table mode is exclusive for a call with `params`. */
function isExclusive(mode: TableMode, params: Record<string, unknown>): boolean {
  if (mode === 'X') return true;
  if (mode === 'S') return false;
  return mode.slice(2).split('|').some(term =>
    term.startsWith('!') ? !engineTruthy(params[term.slice(1)]) : engineTruthy(params[term]));
}

/** A path value: a string, a list of strings, or a list of `{ path }` source rows. */
function pathsOf(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item) out.push(item);
    } else if (item && typeof item === 'object') {
      const path = (item as { path?: unknown }).path;
      if (typeof path === 'string' && path) out.push(path);
    }
  }
  return out;
}

/**
 * The keys an engine call holds, with their modes, sorted by key. A key named
 * twice is exclusive when either naming is. Paths are compared as raw
 * strings: producers canonicalize at the Rust boundary, and normalizing
 * locally with string tricks is forbidden.
 *
 * A method missing from the table is locked exclusively on every common path
 * parameter, so an unlisted method is never weaker than a listed writer.
 */
export function lockKeysFor(method: string, params: Record<string, unknown>): LockClaim[] {
  const row = Object.prototype.hasOwnProperty.call(ENGINE_LOCK_TABLE, method) ? ENGINE_LOCK_TABLE[method] : undefined;
  const modes = new Map<string, LockMode>();
  const add = (key: string, mode: LockMode) => {
    if (modes.get(key) !== 'exclusive') modes.set(key, mode);
  };
  if (row) {
    for (const [param, mode] of Object.entries(row)) {
      const exclusive = isExclusive(mode, params);
      for (const key of pathsOf(params[param])) add(key, exclusive ? 'exclusive' : 'shared');
    }
  } else {
    for (const param of UNKNOWN_METHOD_KEYS) for (const key of pathsOf(params[param])) add(key, 'exclusive');
  }
  return Array.from(modes, ([key, mode]) => ({ key, mode })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Per key: the newest unreleased exclusive claim, and the unreleased shared
 * claims made after it. A claim made before that exclusive claim is no longer
 * recorded; the exclusive claim waits for it, and every later claim waits for
 * the exclusive claim.
 */
interface KeyState {
  exclusive: Promise<void> | null;
  shared: Set<Promise<void>>;
}

function normalize(claims: readonly (string | LockClaim)[]): LockClaim[] {
  const modes = new Map<string, LockMode>();
  for (const claim of claims) {
    const { key, mode } = typeof claim === 'string' ? { key: claim, mode: 'exclusive' as const } : claim;
    if (modes.get(key) !== 'exclusive') modes.set(key, mode);
  }
  return Array.from(modes, ([key, mode]) => ({ key, mode }));
}

/** One independent set of keyed locks. File locks and write chains are two
 * such sets: a key held in one never conflicts with the same key in the other. */
function keyedLocks() {
  const keys = new Map<string, KeyState>();
  const acquire = async <T>(claims: readonly (string | LockClaim)[], body: () => Promise<T>): Promise<T> => {
    const wanted = normalize(claims);
    if (!wanted.length) return body();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior: Promise<void>[] = [];
    // Claim every key before the first await: that is what makes one
    // acquisition atomic and keeps arrival order per key.
    for (const { key, mode } of wanted) {
      let state = keys.get(key);
      if (!state) {
        state = { exclusive: null, shared: new Set() };
        keys.set(key, state);
      }
      if (state.exclusive) prior.push(state.exclusive);
      if (mode === 'exclusive') {
        prior.push(...state.shared);
        state.exclusive = held;
        state.shared = new Set();
      } else {
        state.shared.add(held);
      }
    }
    if (prior.length) await Promise.allSettled(prior);
    try {
      return await body();
    } finally {
      release();
      for (const { key } of wanted) {
        const state = keys.get(key);
        if (!state) continue;
        if (state.exclusive === held) state.exclusive = null;
        state.shared.delete(held);
        if (!state.exclusive && !state.shared.size) keys.delete(key);
      }
    }
  };
  return { acquire, count: () => keys.size };
}

const fileLocks = keyedLocks();
const writeChains = keyedLocks();

/**
 * Run `body` holding `claims`. A plain string claims its key exclusively.
 * With no claims it runs straight through: a call that names no path cannot
 * conflict with one that does. With nothing to wait for, `body` starts
 * synchronously.
 */
export function withFileLock<T>(claims: readonly (string | LockClaim)[], body: () => Promise<T>): Promise<T> {
  return fileLocks.acquire(claims, body);
}

/**
 * Run `body` holding the write chain of every path in `paths`: per path, one
 * holder at a time, in claim order. Every writer of a working copy takes it
 * before any file lock, and holds it for the whole write, including a staged
 * rewrite's engine step, which runs under a SHARED file lock. A second writer
 * of the path therefore waits for the first one's publication instead of
 * reading the bytes the first one is about to replace. With nothing to wait
 * for, `body` starts synchronously.
 */
export function withWriteChain<T>(paths: readonly string[], body: () => Promise<T>): Promise<T> {
  return writeChains.acquire(paths, body);
}

/** The keys a call writes: the keys of its exclusive claims. */
export function exclusiveKeys(claims: readonly LockClaim[]): string[] {
  return claims.filter(claim => claim.mode === 'exclusive').map(claim => claim.key);
}

/** Test seam: how many keys have a holder. */
export function __lockedCount(): number {
  return fileLocks.count();
}

/** Test seam: how many paths have a write-chain holder. */
export function __chainedCount(): number {
  return writeChains.count();
}
