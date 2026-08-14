use crate::engine::{self, EngineState};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

// ── Path canonicalization (the path-identity gate) ───────────────────────
//
// File identity is the raw path STRING app-wide (`state.files` is keyed on
// it; tabs/recents/PageRef.sourceDocId take string equality), and Windows
// hands the same file over as several spellings — case, slash direction,
// 8.3 short names, mapped drives. The fix is ONE rule: every path
// canonicalizes at the Rust boundary before the renderer ever sees it, so
// string identity IS identity for every existing consumer. `dunce` because
// std's canonicalize returns \\?\-prefixed verbatim paths on Windows, which
// would leak into titles and recents.

pub(crate) fn canonical_path(p: &str) -> String {
    dunce::canonicalize(p)
        .map(|pb| pb.to_string_lossy().to_string())
        // A path that doesn't resolve (not-yet-created Save As target, race)
        // passes through untouched — refusing here would break flows that
        // legitimately name new files.
        .unwrap_or_else(|_| p.to_string())
}

/// Renderer-callable form, for paths that arrive THROUGH the webview (file
/// drops) rather than from a Rust producer.
#[tauri::command]
pub async fn canonicalize_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    Ok(paths.iter().map(|p| canonical_path(p)).collect())
}

/// The managed folder a portfolio's members extract into for "Open member":
/// `app-data/portfolio-members/<stem>-<hash16>` — the stem for readability,
/// a hash of the full canonical path so two same-named portfolios in
/// different folders never mix members. DefaultHasher's instability across
/// Rust versions is fine here: a changed hash just mints a fresh folder, and
/// the extracted copies are working files, not a durable store.
#[tauri::command]
pub async fn portfolio_member_dir(
    app: AppHandle,
    portfolio_path: String,
) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let canonical = canonical_path(&portfolio_path);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    canonical.hash(&mut h);
    let stem = std::path::Path::new(&canonical)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "portfolio".into());
    let safe_stem: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(40)
        .collect();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{}", e))?
        .join("portfolio-members")
        .join(format!("{}-{:016x}", safe_stem, h.finish()));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the members folder {}: {}", dir.display(), e))?;
    Ok(dunce::simplified(&dir).to_string_lossy().into_owned())
}

/// Where an extracted member may live for `open_portfolio_member_file` —
/// pure so the scope gate is testable without an AppHandle.
pub(crate) fn is_managed_member_path(base: &std::path::Path, canonical: &std::path::Path) -> bool {
    canonical.starts_with(base) && canonical != base
}

/// Shell-open an extracted portfolio member with the OS default handler.
/// The scope is the managed portfolio-members directory only: the path is
/// re-canonicalized and must sit inside it, so this command can never open
/// (or probe) an arbitrary path. Extraction happens first through the
/// engine; this only ever launches what that flow just wrote.
#[tauri::command]
pub async fn open_portfolio_member_file(app: AppHandle, path: String) -> Result<(), String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("portfolio-members");
    let base = dunce::simplified(&base).to_path_buf();
    let canonical = std::path::PathBuf::from(canonical_path(&path));
    if !is_managed_member_path(&base, &canonical) {
        return Err("Not a managed portfolio member file.".to_string());
    }
    if !canonical.is_file() {
        return Err(format!("Member file not found: {}", canonical.display()));
    }
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell()
        .open(canonical.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())
}

// ── File dialogs ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_files_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    // Parenting makes the native dialog modal to the app window — without it
    // the main window stays interactive and can stack dialogs.
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF Files", &["pdf", "pdfx"])
        .blocking_pick_files();

    match result {
        Some(paths) => {
            let mut out = Vec::new();
            for p in paths {
                if let Ok(pb) = p.into_path() {
                    out.push(canonical_path(&pb.to_string_lossy()));
                }
            }
            Ok(out)
        }
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn save_file_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF Files", &["pdf", "pdfx"]);
    if let Some(ref path) = default_path {
        builder = builder.set_file_name(path);
    }
    let result = builder.blocking_save_file();
    match result {
        Some(path) => match path.into_path() {
            // An EXISTING target canonicalizes (overwrite flows can be
            // reopened later under the same spelling); a brand-new file
            // fails to resolve and passes through as the dialog spelled it.
            Ok(pb) => {
                let resolved = canonical_path(&pb.to_string_lossy());
                allow_picked_path(&app, &resolved);
                Ok(Some(resolved))
            }
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Add a USER-PICKED path to the fs plugin's runtime scope — the official
/// dialog plugin's own trust model (a path the user chose in a native dialog
/// becomes readable/writable to the webview), mirrored here because these
/// dialogs are custom Rust commands the plugin cannot see. Without this the
/// static `$TEMP/spectrapdf/**` scope refuses renderer-side fs IO on any
/// picked path (found live by guided-actions export/import — the first
/// renderer feature to write a picked path with plugin-fs).
fn allow_picked_path(app: &AppHandle, path: &str) {
    use tauri_plugin_fs::FsExt;
    if let Err(e) = app.fs_scope().allow_file(path) {
        eprintln!("fs scope: could not allow picked path {path}: {e}");
    }
}

/// Pick a user's own Hunspell dictionary — the `.aff` and the `.dic`.
#[tauri::command]
pub async fn pick_dictionary_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<Vec<String>>, String> {
    // BOTH halves in one dialog: a Hunspell dictionary is an .aff and a .dic
    // that belong together, and picking them in two dialogs invites a pair
    // from two different languages. The engine still refuses a mismatch.
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Hunspell dictionary", &["aff", "dic"])
        .blocking_pick_files();
    match result {
        Some(paths) => {
            let mut out = Vec::new();
            for p in paths {
                match p.into_path() {
                    Ok(pb) => out.push(canonical_path(&pb.to_string_lossy())),
                    Err(e) => return Err(format!("Path error: {}", e)),
                }
            }
            Ok(Some(out))
        }
        None => Ok(None),
    }
}

/// Pick ONE picture to stamp as a watermark. The filter is the Create PDF
/// image set — the engine accepts exactly that set, so a narrower picker
/// would hide files the operation would have taken.
#[tauri::command]
pub async fn pick_watermark_image(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Images", crate::create_pdf_sources::IMAGES)
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(canonical_path(&pb.to_string_lossy()))),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick ONE PDF whose page is stamped as a watermark. Separate from the
/// document picker: this file is never opened as a document, and separate from
/// the image picker because the engine lifts a page as vector artwork rather
/// than embedding a picture.
#[tauri::command]
pub async fn pick_watermark_pdf(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PDF Files", &["pdf", "pdfx"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(canonical_path(&pb.to_string_lossy()))),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick one or more Create PDF sources. Separate from the PDF picker
/// (much wider filter, and MULTI-select); window-parented for modality.
#[tauri::command]
pub async fn pick_create_pdf_sources(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    // The filter covers every kind converted by the engine, and multi-select
    // builds an ordered source list.
    // The set itself lives in `create_pdf_sources` so this picker and the
    // CLI's `batch --operation create-pdf` walk share ONE Rust copy.
    use crate::create_pdf_sources::{IMAGES, OFFICE, POSTSCRIPT};
    let all = crate::create_pdf_sources::all();

    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        // The combined filter is FIRST so the default view shows everything
        // Create PDF takes; the per-kind filters below are for narrowing.
        .add_filter("All Supported Files", &all)
        .add_filter("PDF Files", &["pdf"])
        .add_filter("Images", IMAGES)
        .add_filter("Documents", OFFICE)
        .add_filter("PostScript Files", POSTSCRIPT)
        .blocking_pick_files();
    match result {
        Some(paths) => {
            let mut out = Vec::with_capacity(paths.len());
            for path in paths {
                match path.into_path() {
                    Ok(pb) => out.push(canonical_path(&pb.to_string_lossy())),
                    Err(e) => return Err(format!("Path error: {}", e)),
                }
            }
            Ok(out)
        }
        None => Ok(Vec::new()),
    }
}

/// Pick a PKCS#12 signer file (.pfx/.p12) for signing. Separate from the PDF
/// picker (different filter); window-parented for the same modality reason.
#[tauri::command]
pub async fn pick_certificate_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PKCS#12 signer", &["pfx", "p12"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick MULTIPLE files of any type — the portfolio-create member picker.
#[tauri::command]
pub async fn pick_any_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    match result {
        Some(paths) => {
            let mut out = Vec::with_capacity(paths.len());
            for p in paths {
                match p.into_path() {
                    Ok(pb) => out.push(canonical_path(&pb.to_string_lossy())),
                    Err(e) => return Err(format!("Path error: {}", e)),
                }
            }
            Ok(out)
        }
        None => Ok(Vec::new()),
    }
}

/// Pick ANY file to embed as a PDF attachment — no extension filter (a
/// document can carry a file of any type beside it).
#[tauri::command]
pub async fn pick_any_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => {
                let picked = pb.to_string_lossy().to_string();
                allow_picked_path(&app, &picked);
                Ok(Some(picked))
            }
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick a PEM/DER signer component (private key or certificate) — the PEM
/// signer source's two file inputs. Loose filter: key/cert files wear many
/// extensions in the wild, so "all files" stays one click away.
#[tauri::command]
pub async fn pick_pem_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PEM/DER key or certificate", &["pem", "key", "crt", "cer", "der"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick a PKCS#11 provider module — the token-signing source. The
/// vendor's cryptoki DLL is the one artifact every token ships.
#[tauri::command]
pub async fn pick_pkcs11_module(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("PKCS#11 module", &["dll"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick an ICC colour profile — the prepress destination-profile picker
/// (tail). .icm is the same format under Windows' preferred extension.
#[tauri::command]
pub async fn pick_icc_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("ICC colour profile", &["icc", "icm"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick a folder — Batch OCR's source/destination pickers.
/// Canonicalized like every other Rust path producer (the path rule).
#[tauri::command]
pub async fn pick_folder_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file().set_parent(&window);
    if let Some(ref t) = title {
        builder = builder.set_title(t);
    }
    match builder.blocking_pick_folder() {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(canonical_path(&pb.to_string_lossy()))),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

#[derive(serde::Serialize)]
pub struct PdfEntry {
    /// Canonical absolute path (engine/copy input).
    pub abs: String,
    /// Path relative to the picked root (the mirror key) — NOT canonicalized,
    /// it's a tree position, not a file identity.
    pub rel: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfListing {
    pub files: Vec<PdfEntry>,
    /// Directories the walk could not read (permissions). Surfaced so the
    /// batch report never has silent holes.
    pub skipped_dirs: Vec<String>,
}

/// Recursively list every `*.pdf` under `root` (Batch OCR enumeration).
/// Junction/symlink cycles are broken with a canonical-path visited set; a
/// defensive depth cap bounds pathological trees. Unreadable SUBdirectories
/// are reported, not fatal; an unreadable root is an error.
#[tauri::command]
pub async fn list_pdfs_recursive(root: String) -> Result<PdfListing, String> {
    let root_c = canonical_path(&root);
    let root_path = Path::new(&root_c).to_path_buf();
    if !root_path.is_dir() {
        return Err(format!("Not a folder: {}", root_c));
    }
    // The walk is sync fs work — keep it off the async runtime's main thread.
    tauri::async_runtime::spawn_blocking(move || {
        // An unreadable ROOT is an error (the user picked it); unreadable
        // subdirectories are reported in skipped_dirs instead.
        fs::read_dir(&root_path).map_err(|e| format!("Cannot read folder {}: {}", root_path.display(), e))?;
        let mut listing = PdfListing { files: Vec::new(), skipped_dirs: Vec::new() };
        let mut visited = std::collections::HashSet::new();
        walk_pdfs(&root_path, &root_path, &mut listing, &mut visited, 0);
        // Deterministic order for progress display and tests.
        listing.files.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        Ok(listing)
    })
    .await
    .map_err(|e| format!("Folder walk failed: {}", e))?
}

fn walk_pdfs(
    root: &Path,
    dir: &Path,
    listing: &mut PdfListing,
    visited: &mut std::collections::HashSet<String>,
    depth: u32,
) {
    const MAX_DEPTH: u32 = 64;
    if depth > MAX_DEPTH {
        listing.skipped_dirs.push(dir.to_string_lossy().to_string());
        return;
    }
    // Revisit guard: canonical identity of the DIRECTORY (case-folded —
    // Windows). A hit is either a junction/symlink CYCLE or an ALIAS of a
    // subtree already walked (two junctions to one physical folder) — in
    // both cases this occurrence goes unmirrored, so it is REPORTED, not
    // silently dropped ("never has silent holes" is the contract).
    let canon = dunce::canonicalize(dir)
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_else(|_| dir.to_string_lossy().to_lowercase());
    if !visited.insert(canon) {
        if depth > 0 {
            listing
                .skipped_dirs
                .push(format!("{} (already visited via another path)", dir.to_string_lossy()));
        }
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            listing.skipped_dirs.push(dir.to_string_lossy().to_string());
            return;
        }
    };
    for entry in entries {
        // A per-entry error (permission-denied item, delete race) names no
        // file; report it against the parent so the hole is visible.
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                listing
                    .skipped_dirs
                    .push(format!("{} (an entry was unreadable: {})", dir.to_string_lossy(), err));
                continue;
            }
        };
        let path = entry.path();
        if path.is_dir() {
            walk_pdfs(root, &path, listing, visited, depth + 1);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
        {
            let rel = path
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            listing.files.push(PdfEntry {
                abs: canonical_path(&path.to_string_lossy()),
                rel,
            });
        }
    }
}

/// Pick an image (Edit ▸ Replace Image / Add Image). Not canonicalized into
/// an identity — it's a media source, read once. `include_svg` widens
/// the filter for ADD (SVG places as real vector content); Replace stays
/// raster-only (a vector placement refuses replace by design).
#[tauri::command]
pub async fn pick_image_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    include_svg: Option<bool>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_parent(&window);
    dialog = if include_svg.unwrap_or(false) {
        dialog.add_filter(
            "Images and vector graphics",
            &["png", "jpg", "jpeg", "bmp", "gif", "webp", "svg"],
        )
    } else {
        dialog.add_filter("Images", &["png", "jpg", "jpeg", "bmp", "gif", "webp"])
    };
    let result = dialog.blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Save-location picker for an EXTRACTED image. The engine appends the
/// format's real extension to the prefix, so the dialog collects a base
/// name; an extension the user typed is stripped renderer-side.
#[tauri::command]
pub async fn save_image_file_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Images", &["png", "jpg", "jpeg", "tif", "tiff", "bmp"]);
    if let Some(ref name) = default_name {
        builder = builder.set_file_name(name);
    }
    match builder.blocking_save_file() {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Pick a form-DATA file to import (`/ImportData`). FDF and XFDF carry field
/// values; the reader chooses by what the file contains, so the filter is a
/// convenience rather than the decision.
#[tauri::command]
pub async fn pick_form_data_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Form data", &["fdf", "xfdf"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();
    match result {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// Where a form SUBMISSION is written. The app builds the submission in full
/// and performs no outbound request, so the payload needs a destination on
/// disk the user chose.
#[tauri::command]
pub async fn save_form_data_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Form data", &["fdf", "xfdf", "txt", "pdf"])
        .add_filter("All files", &["*"]);
    if let Some(ref name) = default_name {
        builder = builder.set_file_name(name);
    }
    match builder.blocking_save_file() {
        Some(p) => match p.into_path() {
            Ok(pb) => Ok(Some(pb.to_string_lossy().to_string())),
            Err(e) => Err(format!("Path error: {}", e)),
        },
        None => Ok(None),
    }
}

/// True when both paths exist and are the SAME physical file/directory
/// (volume serial + file index — not string comparison). Canonical strings
/// can disagree about one physical file (UNC vs mapped letter, hardlinks);
/// this is the identity truth the batch same-file refusals rest on.
#[tauri::command]
pub async fn paths_same_file(a: String, b: String) -> Result<bool, String> {
    Ok(same_file::is_same_file(&a, &b).unwrap_or(false))
}

/// Copy `src` to `dest`, creating `dest`'s parent directories — the batch
/// mirror's pass-through for already-searchable PDFs. Plain fs::copy: no PDF
/// logic in Rust. Two guards:
/// - REFUSES when dest already exists and IS src (true file identity — a
///   string-alias geometry the dialog's root check couldn't see would
///   otherwise truncate the user's original: CopyFileExW opens dest for
///   write while reading the identical file).
/// - Clears a read-only attribute on an existing dest before overwriting
///   (fs::copy propagates attributes, so a read-only SOURCE makes a
///   read-only mirror file on run 1 that would fail run 2's promised
///   overwrite with a bare access-denied).
#[tauri::command]
pub async fn copy_file_creating_dirs(src: String, dest: String) -> Result<(), String> {
    let dest_path = Path::new(&dest);
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    if dest_path.exists() {
        if same_file::is_same_file(&src, &dest).unwrap_or(false) {
            return Err("source and destination are the same file".to_string());
        }
        let meta = fs::metadata(dest_path)
            .map_err(|e| format!("Cannot inspect {}: {}", dest, e))?;
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            fs::set_permissions(dest_path, perms)
                .map_err(|e| format!("Destination is read-only and could not be made writable: {}", e))?;
        }
    }
    fs::copy(&src, &dest).map_err(|e| format!("Copy failed {} -> {}: {}", src, dest, e))?;
    Ok(())
}

/// Move `src` to `dest`, creating `dest`'s parents. Returns the path actually
/// written, which may differ from `dest` (see the collision rule below).
///
/// This is the ONLY batch operation that mutates the user's SOURCE tree
/// (the "moved" and "error" folders), so it carries the
/// paranoia the mirror's copy does not need:
///
/// - **Same-file refusal, by identity.** A rename onto itself is a harmless
///   no-op, but the cross-volume fallback below is copy-then-delete, and
///   copy-then-delete onto itself DELETES THE FILE. String comparison cannot
///   see a UNC-vs-mapped-letter alias; `same_file` can.
/// - **Rename first.** Within a volume `fs::rename` is atomic, so an
///   interrupted move leaves the file at one end or the other — never neither.
/// - **Copy-then-delete only across volumes**, where rename cannot work
///   (Windows: ERROR_NOT_SAME_DEVICE). That is the shape files get lost in, so
///   the copy's length is verified BEFORE the original is removed, and a failed
///   delete is reported rather than swallowed: a file present in both places is
///   a mess the user can fix, a file present in neither is not.
/// - **Never overwrites.** A colliding destination takes a ` (2)` suffix and
///   the chosen name comes back to the caller. The mirror may legitimately
///   contain a same-named file from an earlier run, and silently replacing a
///   previously-moved ORIGINAL would be unreported data loss.
#[tauri::command]
pub async fn move_file_creating_dirs(src: String, dest: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dest_path = Path::new(&dest);
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    if same_file::is_same_file(&src, &dest).unwrap_or(false) {
        return Err("source and destination are the same file".to_string());
    }
    let target = unique_destination(dest_path);
    // Same volume: atomic.
    if fs::rename(src_path, &target).is_ok() {
        return Ok(target.to_string_lossy().to_string());
    }
    // Different volume: copy, VERIFY, then delete.
    let copied = fs::copy(src_path, &target)
        .map_err(|e| format!("Move failed {} -> {}: {}", src, target.display(), e))?;
    let original = fs::metadata(src_path).map(|m| m.len()).unwrap_or(0);
    if copied != original {
        // Do not delete the original on a short write — take the litter.
        let _ = fs::remove_file(&target);
        return Err(format!(
            "Move aborted: copied {} of {} bytes to {} — the original was left in place",
            copied,
            original,
            target.display()
        ));
    }
    fs::remove_file(src_path).map_err(|e| {
        format!(
            "Copied to {} but could not remove the original {}: {} — the file now exists in BOTH places",
            target.display(),
            src,
            e
        )
    })?;
    Ok(target.to_string_lossy().to_string())
}

/// First free name at or beside `dest`: `x.pdf`, then `x (2).pdf`, `x (3).pdf`…
/// Bounded — after 999 tries it gives the caller the original path back and lets
/// the move fail loudly rather than spinning in an unattended run.
fn unique_destination(dest: &Path) -> std::path::PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().unwrap_or_else(|| Path::new(""));
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|s| s.to_string_lossy().to_string());
    for n in 2..1000 {
        let name = match &ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dest.to_path_buf()
}

/// A unique scratch path for the batch auto-repair step, under the app's own
/// temp folder. The repaired bytes need to exist SEPARATELY from both the
/// source and the mirror output: the mirror copy may then receive an OCR layer,
/// and "put the repaired file back" must return the repaired original, not a
/// searchable derivative of it.
#[tauri::command]
pub async fn create_batch_scratch(app: AppHandle, tag: String) -> Result<String, String> {
    let dir = std::env::temp_dir().join("spectrapdf").join("batch-scratch");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create scratch folder: {}", e))?;
    let _ = &app; // handle kept for symmetry with the other app-scoped commands
    let safe: String = tag
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(40)
        .collect();
    for n in 0..10_000u32 {
        let candidate = dir.join(format!("{safe}-{n}.pdf"));
        if !candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err("could not allocate a scratch file".to_string())
}

/// Delete a scratch file — and ONLY one inside the scratch folder. Same
/// discipline as the log sweep: an unattended delete names exactly what it may
/// take, so a caller cannot turn this into a general remove by passing a
/// source path.
#[tauri::command]
pub async fn delete_batch_scratch(path: String) -> Result<(), String> {
    let dir = std::env::temp_dir().join("spectrapdf").join("batch-scratch");
    let target = Path::new(&path);
    let inside = target
        .canonicalize()
        .ok()
        .zip(dir.canonicalize().ok())
        .map(|(t, d)| t.starts_with(d))
        .unwrap_or(false);
    if !inside {
        return Err(format!("not a batch scratch file: {path}"));
    }
    fs::remove_file(target).map_err(|e| format!("Failed to remove scratch file: {}", e))?;
    Ok(())
}

/// Arbitrary-path binary read for the batch driver. The serde `Vec<u8>` form
/// (`read_file_buffer`) JSON-encodes every byte as a number — fine for one
/// open, hostile to a long unattended run over large scanned PDFs. A raw
/// `Response` body crosses the IPC as binary.
#[tauri::command]
pub async fn read_file_binary(file_path: String) -> Result<tauri::ipc::Response, String> {
    let bytes =
        fs::read(&file_path).map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Create the parent directories of `path` — run before the engine writes a
/// mirror output (`apply_ocr_layer` saves to the exact path it's given and
/// does not create directories; the contract stays engine-unchanged).
#[tauri::command]
pub async fn ensure_parent_dirs(path: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    Ok(())
}

// ── File operations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_file_buffer(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(&file_path).map_err(|e| format!("Failed to read {}: {}", file_path, e))
}

#[tauri::command]
pub async fn create_working_copy(file_path: String) -> Result<String, String> {
    let work_dir = std::env::temp_dir()
        .join("spectrapdf")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let filename = Path::new(&file_path)
        .file_name()
        .ok_or("Invalid filename")?;
    let dest = work_dir.join(filename);
    fs::copy(&file_path, &dest)
        .map_err(|e| format!("Failed to copy: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn snapshot(working_path: String) -> Result<String, String> {
    let path = Path::new(&working_path);
    let dir = path.parent().ok_or("Invalid path")?;
    let stem = path.file_stem().ok_or("Invalid filename")?.to_string_lossy();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let snap_path = dir.join(format!("{}_snap_{}{}", stem, timestamp, ext));

    fs::copy(&working_path, &snap_path)
        .map_err(|e| format!("Failed to snapshot: {}", e))?;

    Ok(snap_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn restore_snapshot(
    working_path: String,
    snapshot_path: String,
) -> Result<(), String> {
    fs::copy(&snapshot_path, &working_path)
        .map_err(|e| format!("Failed to restore: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn save_as(working_path: String, dest_path: String) -> Result<(), String> {
    fs::copy(&working_path, &dest_path)
        .map_err(|e| format!("Failed to save: {}", e))?;
    Ok(())
}

// ── App info ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_tesseract_path(app: AppHandle) -> Result<String, String> {
    Ok(engine::get_tesseract_path(&app))
}

#[tauri::command]
pub async fn get_gs_path(app: AppHandle) -> Result<String, String> {
    Ok(engine::get_gs_path(&app))
}

#[tauri::command]
pub async fn get_soffice_path(app: AppHandle) -> Result<String, String> {
    Ok(engine::get_soffice_path(&app))
}

#[tauri::command]
pub async fn get_edit_font_path(app: AppHandle) -> Result<String, String> {
    Ok(engine::get_edit_font_path(&app))
}

#[tauri::command]
pub async fn get_dictionary_path(app: AppHandle) -> Result<String, String> {
    Ok(engine::get_dictionary_path(&app))
}

/// The managed folder a user's own spelling dictionaries are copied into.
///
/// Rust owns the path so a dictionary added from the panel outlives whatever
/// folder the user picked it from — a dictionary read in place would stop
/// resolving the moment that folder moved, and the check would then report
/// every word of the language as wrong.
#[tauri::command]
pub async fn user_dictionary_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{}", e))?
        .join("dictionaries");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the dictionaries folder {}: {}", dir.display(), e))?;
    Ok(dunce::simplified(&dir).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

/// Opens the project's releases page in the user's browser.
///
/// Takes no argument on purpose. The update check is notify-only: the app
/// never downloads or installs a release itself,
/// and the destination is compiled in rather than read from the update
/// manifest. So even a forged `latest.json` can only lie about a version
/// NUMBER — it cannot point a user anywhere, and there is no install path for
/// it to reach. That is the whole security argument for this design.
#[tauri::command]
pub async fn open_releases_page(app: AppHandle) -> Result<(), String> {
    const RELEASES_URL: &str = "https://github.com/jasonulbright/Spectra-PDF/releases/latest";
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell()
        .open(RELEASES_URL, None)
        .map_err(|e| e.to_string())
}

/// Shows a file in the file manager with the file SELECTED.
///
/// Not a shell-open, which is the whole point: `shell().open` on a file RUNS
/// whatever the OS associates with it, so a path arriving from the webview
/// could execute. `explorer /select,<path>` browses to the file and
/// highlights it — the argument is a navigation target, never a program. The
/// path is canonicalized and required to be an existing FILE before it is
/// passed, so a directory, a missing entry, or a crafted argument string
/// cannot reach the command line.
#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let canonical = canonical_path(&path);
    let p = std::path::Path::new(&canonical);
    if !p.is_file() {
        return Err(format!("not a file: {canonical}"));
    }
    // `/select,<path>` is ONE argument to explorer; passing it as two would
    // make the comma-prefixed path a separate argument explorer ignores, and
    // it would then open the user's Documents folder instead.
    let arg = format!("/select,{canonical}");
    std::process::Command::new("explorer.exe")
        .arg(arg)
        .spawn()
        // explorer.exe exits non-zero even when it succeeds, so the spawn is
        // the only thing worth checking; the process is not awaited.
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens one of the SHIPPED third-party license notice files with the OS
/// default handler. Allowlisted names only — this is a licenses opener, not
/// a general path opener, and the webview has no shell-open capability.
#[tauri::command]
pub async fn open_third_party_licenses(app: AppHandle, file: String) -> Result<(), String> {
    const ALLOWED: [&str; 2] = ["THIRD-PARTY-LICENSES.md", "THIRD-PARTY-LICENSES-RUST.html"];
    if !ALLOWED.contains(&file.as_str()) {
        return Err(format!("not a shipped licenses file: {file}"));
    }
    let path = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(&file);
    if !path.is_file() {
        return Err(format!("licenses file not found: {}", path.display()));
    }
    use tauri_plugin_shell::ShellExt;
    // shell::open is deprecated in favor of the opener plugin, but the shell
    // plugin is already shipped and adding a second plugin crate for this one
    // call widens the dependency graph for no capability gain.
    #[allow(deprecated)]
    app.shell()
        .open(path.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())
}

// ── Ghostscript detection ────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GsInfo {
    pub path: String,
    pub version: String,
    pub product: String,
    pub vendor: String,
}

/// Query the bundled GS info (version from --version).
#[tauri::command]
pub async fn get_bundled_gs_info(app: AppHandle) -> Result<GsInfo, String> {
    let path = engine::get_gs_path(&app);
    let version = run_gs_version(&path)?;
    Ok(GsInfo {
        path,
        version,
        product: "GPL Ghostscript".to_string(),
        vendor: "Artifex Software".to_string(),
    })
}

/// Detect external Ghostscript from ARP registry. Returns None if not found.
#[tauri::command]
pub async fn detect_external_gs() -> Result<Option<GsInfo>, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let uninstall_paths = [
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for uninstall_path in &uninstall_paths {
        let Ok(key) = hklm.open_subkey_with_flags(uninstall_path, KEY_READ) else {
            continue;
        };
        for name in key.enum_keys().flatten() {
            if !name.to_lowercase().contains("ghostscript") {
                continue;
            }
            let Ok(subkey) = key.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            let display_name: String = subkey
                .get_value("DisplayName")
                .unwrap_or_default();
            let mut install_location: String = subkey
                .get_value("InstallLocation")
                .unwrap_or_default();
            let display_version: String = subkey
                .get_value("DisplayVersion")
                .unwrap_or_default();
            let publisher: String = subkey
                .get_value("Publisher")
                .unwrap_or_default();

            // Fallback: parse install dir from UninstallString if InstallLocation is empty
            if install_location.is_empty() {
                let uninstall_str: String = subkey
                    .get_value("UninstallString")
                    .unwrap_or_default();
                if !uninstall_str.is_empty() {
                    let clean = uninstall_str.trim_matches('"');
                    if let Some(parent) = std::path::Path::new(clean).parent() {
                        install_location = parent.to_string_lossy().to_string();
                    }
                }
            }

            if install_location.is_empty() {
                continue;
            }

            // Find the console exe
            let install_path = std::path::Path::new(&install_location);
            let exe = install_path.join("bin").join("gswin64c.exe");
            if !exe.exists() {
                // Try gswin32c.exe
                let exe32 = install_path.join("bin").join("gswin32c.exe");
                if !exe32.exists() {
                    continue;
                }
                let version = run_gs_version(&exe32.to_string_lossy()).unwrap_or(display_version);
                return Ok(Some(GsInfo {
                    path: exe32.to_string_lossy().to_string(),
                    version,
                    product: display_name,
                    vendor: if publisher.is_empty() { "Artifex Software".to_string() } else { publisher },
                }));
            }

            let version = run_gs_version(&exe.to_string_lossy()).unwrap_or(display_version);
            return Ok(Some(GsInfo {
                path: exe.to_string_lossy().to_string(),
                version,
                product: display_name,
                vendor: if publisher.is_empty() { "Artifex Software".to_string() } else { publisher },
            }));
        }
    }

    Ok(None)
}

fn run_gs_version(exe_path: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new(exe_path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run GS: {}", e))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        Err("Empty version output".to_string())
    } else {
        Ok(version)
    }
}

// ── Printers ─────────────────────────────────────────────────────────────

/// Installed Windows printers + the default — the Print dialog's picker.
#[tauri::command]
pub async fn list_printers() -> Result<crate::printers::PrinterList, String> {
    crate::printers::enumerate()
}

/// One printer's paper list / duplex / color capabilities — what gates the
/// Print dialog's option surface and resolves sheet sizes for the layout
/// modes. Read-only DeviceCapabilities; never opens a job.
#[tauri::command]
pub async fn printer_capabilities(
    name: String,
) -> Result<crate::printers::PrinterCapabilities, String> {
    crate::printers::capabilities(&name)
}

// ── System accent color ──────────────────────────────────────────────────

/// Windows accent color as "#RRGGBB".
///
/// Primary source is WinRT `UISettings` — the documented accent API, which
/// works in unpackaged Win32 processes and needs no user customization to
/// exist. The DWM registry value is kept as fallback; it is only written
/// once a profile customizes its colors, so it can be absent on stock
/// machines.
#[tauri::command]
pub async fn get_system_accent_color() -> Result<Option<String>, String> {
    Ok(accent_from_uisettings().or_else(accent_from_registry))
}

fn accent_from_uisettings() -> Option<String> {
    use windows::UI::ViewManagement::{UIColorType, UISettings};
    let ui = UISettings::new().ok()?;
    let c = ui.GetColorValue(UIColorType::Accent).ok()?;
    Some(format!("#{:02X}{:02X}{:02X}", c.R, c.G, c.B))
}

fn accent_from_registry() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags("SOFTWARE\\Microsoft\\Windows\\DWM", KEY_READ)
        .ok()?;
    let abgr: u32 = key.get_value("AccentColor").ok()?;
    // Registry stores ABGR, convert to RGB
    let r = abgr & 0xFF;
    let g = (abgr >> 8) & 0xFF;
    let b = (abgr >> 16) & 0xFF;
    Some(format!("#{:02X}{:02X}{:02X}", r, g, b))
}

// ── Window backdrop ──────────────────────────────────────────────────────

/// Which backdrop setup applied to the main window ("mica" or "none").
/// The renderer stamps this on <html data-backdrop> before first paint and
/// keys translucent shell styling on it.
#[tauri::command]
pub async fn get_window_backdrop(
    state: tauri::State<'_, crate::BackdropState>,
) -> Result<String, String> {
    Ok(state.0.to_string())
}

// ── Operation log ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn append_operation_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let app_data = app.path().app_data_dir().map_err(|e| format!("{}", e))?;
    fs::create_dir_all(&app_data).ok();
    let log_path = app_data.join("operations.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log: {}", e))?;
    writeln!(f, "{}", line).map_err(|e| format!("Failed to write log: {}", e))?;
    Ok(())
}

// ── Batch run logs ───────────────────────────────────────────────────────
//
// One log file per batch run, swept by age.
//
// The location is user-configurable and defaults to the app data folder. A
// scheduled run under an alternate account or an MSA
// resolves `app_data_dir()` inside THAT account's profile, so the audit trail
// for the runs nobody watched would land somewhere the person who set them up
// cannot see. A shared, explicitly chosen folder is the fix — and when a
// scheduled profile uses a non-interactive identity, setting one is REQUIRED,
// not optional (see 27-phase12 § Request 5).
//
// The FILE NAME is still never taken on trust: it is validated against the
// exact pattern this app writes (`batch-ocr-*.log`, no separators, no `..`)
// before being joined to anything. That is the guard that matters, because the
// directory is chosen by the user through a native folder picker — the same
// trust model as the batch destination folder — while a crafted *name* is how
// a write escapes the folder or lands on a settings file.

/// Resolve the batch-log directory: the caller's configured folder, or the
/// app-data default when unset. Created on demand.
fn batch_log_dir(app: &AppHandle, configured: Option<&str>) -> Result<std::path::PathBuf, String> {
    let dir = match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => std::path::PathBuf::from(custom),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("{}", e))?
            .join("batch-logs"),
    };
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the log folder {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// True only for names this app itself writes. Deliberately strict: the prune
/// below DELETES what this matches, and the standing rule after a session wiped
/// archived installers with a glob is that a delete names exactly what it takes.
/// Five exact prefixes: batch-OCR runs, guided-action folder runs (the
/// engine writes `action-run-*.log` into the same folder), disk-scope
/// Search & Redact sweeps, folder form-preparation sweeps and folder-scope
/// export sweeps. Retention must sweep all of them or the logs it does not
/// match accumulate forever.
fn is_batch_log_name(name: &str) -> bool {
    (name.starts_with("batch-ocr-")
        || name.starts_with("action-run-")
        || name.starts_with("search-redact-")
        || name.starts_with("form-prep-")
        || name.starts_with("folder-export-")
        || name.starts_with("create-pdf-folders-"))
        && name.ends_with(".log")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.len() <= 64
}

/// The resolved log directory (the caller's configured folder, or the
/// app-data default), created on demand — so a caller that hands the ENGINE
/// a log destination (guided-action folder runs) can pass a concrete path.
#[tauri::command]
pub async fn get_batch_log_dir(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    Ok(batch_log_dir(&app, dir.as_deref())?.to_string_lossy().to_string())
}

/// Write one run's log. Returns the full path so the UI can show it.
#[tauri::command]
pub async fn write_batch_log(
    app: AppHandle,
    name: String,
    contents: String,
    dir: Option<String>,
) -> Result<String, String> {
    if !is_batch_log_name(&name) {
        return Err(format!("not a batch log name: {name}"));
    }
    let path = batch_log_dir(&app, dir.as_deref())?.join(&name);
    fs::write(&path, contents).map_err(|e| format!("Failed to write log: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Delete batch logs older than `retention_days`. Returns how many went.
///
/// Scoped three ways on purpose — the log folder only, non-recursively, and
/// only regular files whose names match what we write. A retention sweep is a
/// delete loop running unattended; it gets the narrowest target that still does
/// the job. `retention_days == 0` means keep forever and is a no-op, not a
/// "delete everything" (the reading that would make a default value catastrophic).
#[tauri::command]
pub async fn prune_batch_logs(
    app: AppHandle,
    retention_days: u32,
    dir: Option<String>,
) -> Result<u32, String> {
    if retention_days == 0 {
        return Ok(0);
    }
    let dir = batch_log_dir(&app, dir.as_deref())?;
    let max_age = std::time::Duration::from_secs(u64::from(retention_days) * 24 * 60 * 60);
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        // No folder yet is not an error — nothing has been logged.
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_batch_log_name(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let modified = match meta.modified() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // A file dated in the FUTURE (clock skew, restored backup) is never
        // expired — elapsed() errors there, and skipping is the safe read.
        let age = match now.duration_since(modified) {
            Ok(a) => a,
            Err(_) => continue,
        };
        if age > max_age && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Open the batch log folder in the file manager.
///
/// Takes NO path argument, for the same reason `open_releases_page` takes no
/// URL: the destination is derived here, so the webview cannot turn a "show me
/// my logs" affordance into a general shell-open of an arbitrary path.
#[tauri::command]
pub async fn open_batch_log_folder(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    let dir = batch_log_dir(&app, dir.as_deref())?;
    // A DIRECTORY, never a file. The path is user-configured rather than
    // compiled in now, so the remaining guard that earns its keep is this one:
    // shell-opening a directory browses it, shell-opening a file RUNS whatever
    // the OS associates with it.
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", dir.display()));
    }
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell()
        .open(dir.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())
}

// ── Engine (Python sidecar) ───────────────────────────────────────────────

#[tauri::command]
pub async fn start_engine(app: AppHandle) -> Result<(), String> {
    engine::start(&app).await
}

#[tauri::command]
pub async fn send_to_engine(
    app: AppHandle,
    request: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut guard = state.child.lock().await;
    if let Some(ref mut child) = *guard {
        let msg = serde_json::to_string(&request)
            .map_err(|e| format!("Serialize error: {}", e))?;
        child
            .write((msg + "\n").as_bytes())
            .map_err(|e| format!("Failed to write to engine: {}", e))?;
        Ok(())
    } else {
        Err("Engine not running".to_string())
    }
}

// ── Window lifecycle ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn confirm_close(app: AppHandle) -> Result<(), String> {
    // Set the quitting flag so ExitRequested handler allows exit
    crate::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    Ok(())
}

// ── Startup config (Rust-readable settings for pre-window decisions) ─────

/// Write start-minimized preference to a JSON file that Rust reads before
/// showing the window. This avoids the flash caused by renderer-side hide.
#[tauri::command]
pub async fn set_start_minimized(app: AppHandle, enabled: bool) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("{}", e))?;
    fs::create_dir_all(&app_data).ok();
    let config_path = app_data.join("startup.json");
    let json = serde_json::json!({ "startMinimized": enabled });
    fs::write(&config_path, json.to_string())
        .map_err(|e| format!("Failed to write startup config: {}", e))?;
    Ok(())
}

/// Read start-minimized from the config file. Used by lib.rs setup().
pub fn read_start_minimized(app: &tauri::App) -> bool {
    let Ok(app_data) = app.path().app_data_dir() else {
        return false;
    };
    let config_path = app_data.join("startup.json");
    let Ok(contents) = fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    json.get("startMinimized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

// ── Enterprise policy ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_auto_update_disabled() -> Result<bool, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    match hklm.open_subkey("SOFTWARE\\Spectra PDF") {
        Ok(key) => {
            let value: Result<u32, _> = key.get_value("DisableAutoUpdate");
            Ok(value.unwrap_or(0) == 1)
        }
        Err(_) => Ok(false),
    }
}

// ── Startup (Start with Windows) ─────────────────────────────────────────

const STARTUP_REG_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_REG_VALUE: &str = "SpectraPDF";

/// Read the current state of the "Start with Windows" registry entry.
/// Returns (enabled, minimized) — minimized is true if the --minimized flag is present.
#[tauri::command]
pub async fn get_startup_enabled() -> Result<(bool, bool), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey_with_flags(STARTUP_REG_KEY, KEY_READ) else {
        return Ok((false, false));
    };
    let value: Result<String, _> = key.get_value(STARTUP_REG_VALUE);
    match value {
        Ok(val) => {
            let minimized = val.contains("--minimized");
            Ok((true, minimized))
        }
        Err(_) => Ok((false, false)),
    }
}

/// Set or remove the "Start with Windows" registry entry.
/// When start_minimized is true, appends --minimized to the command.
#[tauri::command]
pub async fn set_startup_enabled(
    enabled: bool,
    start_minimized: bool,
) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(STARTUP_REG_KEY, KEY_WRITE)
        .map_err(|e| format!("Failed to open Run key: {}", e))?;

    if enabled {
        // Get the current exe path
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?;
        let mut value = format!("\"{}\"", exe_path.to_string_lossy());
        if start_minimized {
            value.push_str(" --minimized");
        }
        key.set_value(STARTUP_REG_VALUE, &value)
            .map_err(|e| format!("Failed to set startup entry: {}", e))?;
    } else {
        // Remove the entry (ignore error if it doesn't exist)
        let _ = key.delete_value(STARTUP_REG_VALUE);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_batch_log_name, is_managed_member_path};
    use std::path::Path;

    #[test]
    fn log_retention_matches_every_prefix_this_app_writes_and_nothing_else() {
        for name in [
            "batch-ocr-2026-01-02_030405.log",
            "action-run-2026-01-02_030405.log",
            "search-redact-2026-01-02_030405.log",
            "form-prep-2026-01-02_030405.log",
            "folder-export-2026-01-02_030405.log",
            "create-pdf-folders-2026-01-02_030405.log",
        ] {
            assert!(is_batch_log_name(name), "{name} should be swept");
            // The predicate also gates the WRITE, so a name it rejects is a
            // run that produces no record at all — which is how the
            // one-PDF-per-folder prefix came to be missing here.
            assert!(name.len() <= 64, "{name} is longer than the write allows");
        }
        // The predicate scopes a DELETE, so anything it does not itself write
        // stays out — including a traversal wearing a known prefix.
        for name in [
            "notes.log",
            "batch-ocr-2026.txt",
            "../form-prep-2026-01-02_030405.log",
            r"sub\form-prep-2026-01-02_030405.log",
        ] {
            assert!(!is_batch_log_name(name), "{name} should not be swept");
        }
    }

    #[test]
    fn member_open_scope_is_the_managed_dir_only() {
        let base = Path::new(r"C:\Users\u\AppData\Roaming\app\portfolio-members");
        assert!(is_managed_member_path(
            base,
            Path::new(r"C:\Users\u\AppData\Roaming\app\portfolio-members\doc-abc\notes.txt")
        ));
        // The base itself, siblings, and traversal escapes are all refused.
        assert!(!is_managed_member_path(base, base));
        assert!(!is_managed_member_path(
            base,
            Path::new(r"C:\Users\u\AppData\Roaming\app\other\notes.txt")
        ));
        assert!(!is_managed_member_path(base, Path::new(r"C:\Windows\System32\cmd.exe")));
    }
}
