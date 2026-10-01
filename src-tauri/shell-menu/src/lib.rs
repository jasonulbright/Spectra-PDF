//! `spectrapdf_shell.dll`: the File Explorer commands Convert to PDF and
//! Combine into one PDF, as two `IExplorerCommand` classes.
//!
//! The same classes serve the sparse package (activated in a `dllhost.exe`
//! surrogate) and the classic `ExplorerCommandHandler` verbs (loaded into
//! `explorer.exe` itself). The handler holds no app logic: it collects the
//! selection's file-system paths, writes them to one handoff file, and starts
//! `spectrapdf.exe --shell-action <file>` once. Every COM entry point runs
//! under `catch_unwind`: in the classic path a panic would otherwise unwind
//! into Explorer.

pub mod ids;
#[path = "../../src/create_pdf_sources.rs"]
pub mod create_pdf_sources;
pub mod manifest;
#[cfg(test)]
mod catalog;

mod labels {
    include!(concat!(env!("OUT_DIR"), "/labels.rs"));
}

#[cfg(windows)]
mod com;

use ids::Verb;
use std::path::{Path, PathBuf};

/// Explorer asks a verb's state with at most this many items of the selection.
pub const INSPECTED_ITEMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerbState {
    Enabled,
    Hidden,
}

/// Whether a verb is offered for a selection of `count` items whose first
/// items' names are `inspected`. `None` is an item whose name could not be
/// read; it hides the verb, since nothing can be said about its type.
pub fn verb_state(verb: Verb, inspected: &[Option<String>], count: usize) -> VerbState {
    if count < verb.min_items() || inspected.is_empty() {
        return VerbState::Hidden;
    }
    let accepted = inspected.iter().all(|name| {
        name.as_deref()
            .and_then(|n| Path::new(n).extension())
            .and_then(|e| e.to_str())
            .is_some_and(|e| verb.accepts_extension(e))
    });
    if accepted {
        VerbState::Enabled
    } else {
        VerbState::Hidden
    }
}

/// Whether Invoke passes this path on. Items with no file-system path never
/// reach here; they are counted as skipped by the caller.
pub fn invoke_accepts(verb: Verb, path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| verb.accepts_extension(e))
}

/// The handoff file's content, in the schema `shell_action::read_handoff`
/// accepts.
pub fn handoff_json(verb: Verb, paths: &[String], skipped: u32) -> String {
    serde_json::json!({
        "version": 1,
        "action": verb.action(),
        "paths": paths,
        "skipped": skipped,
    })
    .to_string()
}

pub fn handoff_name(id: u128) -> String {
    format!("{id:032x}.json")
}

/// The handoff folder under the user's Local AppData known folder, the same
/// path `shell_action::handoff_dir_in` accepts. Not TMP or TEMP: the running
/// instance that reads the handoff may have been started with another TMP.
pub fn handoff_dir_in(local_app_data: &Path) -> PathBuf {
    local_app_data
        .join("Temp")
        .join("spectrapdf")
        .join("shell-handoff")
}

/// `<root>\shell\<arch>\spectrapdf_shell.dll` → `<root>\spectrapdf.exe`. The
/// executable is found from the handler's own location only, never from the
/// registry, `PATH` or the handoff.
pub fn exe_from_module(dll: &Path) -> Option<PathBuf> {
    let name = dll.file_name()?.to_str()?;
    if !name.eq_ignore_ascii_case("spectrapdf_shell.dll") {
        return None;
    }
    let arch_dir = dll.parent()?;
    let arch = arch_dir.file_name()?.to_str()?;
    if !manifest::ARCHES.iter().any(|a| a.eq_ignore_ascii_case(arch)) {
        return None;
    }
    let shell_dir = arch_dir.parent()?;
    if !shell_dir.file_name()?.to_str()?.eq_ignore_ascii_case("shell") {
        return None;
    }
    Some(shell_dir.parent()?.join("spectrapdf.exe"))
}

pub fn shipped_locales() -> Vec<&'static str> {
    labels::LABELS.iter().map(|(locale, _)| *locale).collect()
}

/// The label for `verb` in `locale`, English when the locale is not shipped.
pub fn label(verb: Verb, locale: &str) -> String {
    let index = match verb {
        Verb::Convert => 0,
        Verb::Combine => 1,
    };
    let row = labels::LABELS
        .iter()
        .find(|(l, _)| *l == locale)
        .or_else(|| labels::LABELS.iter().find(|(l, _)| *l == "en"))
        .map(|(_, row)| row[index])
        .unwrap_or_else(|| verb.english_label());
    row.replace("{{app}}", ids::APP_NAME)
}

/// The language the verb labels use, first match wins: the app's own UI
/// language as it recorded it, then the user's Windows UI languages in order,
/// then English. Each candidate is matched on its full tag, then its script
/// (Traditional and Simplified Chinese), then its primary language.
pub fn pick_language(app: Option<&str>, preferred: &[String], shipped: &[&str]) -> String {
    let candidates = app.into_iter().map(str::to_string).chain(preferred.iter().cloned());
    for candidate in candidates {
        if let Some(found) = match_tag(&candidate, shipped) {
            return found;
        }
    }
    "en".to_string()
}

fn match_tag(tag: &str, shipped: &[&str]) -> Option<String> {
    let tag = tag.trim().replace('_', "-");
    if tag.is_empty() {
        return None;
    }
    let lower = tag.to_ascii_lowercase();
    let find = |want: &str| {
        shipped
            .iter()
            .find(|s| s.eq_ignore_ascii_case(want))
            .map(|s| s.to_string())
    };
    if let Some(found) = find(&lower) {
        return Some(found);
    }
    let parts: Vec<&str> = lower.split('-').collect();
    let primary = parts[0];
    if primary == "zh" {
        let traditional = parts
            .iter()
            .skip(1)
            .any(|p| matches!(*p, "hant" | "tw" | "hk" | "mo"));
        return find(if traditional { "zh-TW" } else { "zh-CN" });
    }
    let primary = match primary {
        "no" | "nn" => "nb",
        other => other,
    };
    find(primary).or_else(|| {
        shipped
            .iter()
            .find(|s| s.to_ascii_lowercase().split('-').next() == Some(primary))
            .map(|s| s.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(names: &[&str]) -> Vec<Option<String>> {
        names.iter().map(|n| Some(n.to_string())).collect()
    }

    #[test]
    fn the_verb_table_follows_count_and_type() {
        use VerbState::*;
        assert_eq!(verb_state(Verb::Convert, &some(&["a.png"]), 1), Enabled);
        assert_eq!(verb_state(Verb::Combine, &some(&["a.png"]), 1), Hidden);
        assert_eq!(verb_state(Verb::Combine, &some(&["a.pdf", "b.JPG"]), 2), Enabled);
        assert_eq!(verb_state(Verb::Convert, &some(&["a.pdf", "b.png"]), 2), Hidden);
        assert_eq!(verb_state(Verb::Convert, &some(&["a.DOCX", "b.TIFF"]), 2), Enabled);
        assert_eq!(verb_state(Verb::Combine, &some(&["a.pdf", "b.zip"]), 2), Hidden);
        assert_eq!(verb_state(Verb::Convert, &some(&["a.eps"]), 1), Hidden);
        assert_eq!(verb_state(Verb::Convert, &some(&["noextension"]), 1), Hidden);
        assert_eq!(verb_state(Verb::Convert, &[None], 1), Hidden);
        assert_eq!(verb_state(Verb::Convert, &[], 1), Hidden);
        // Explorer shows at most 16 items while the menu is built; the count
        // is what decides Combine's minimum.
        assert_eq!(verb_state(Verb::Combine, &some(&["a.pdf"]), 200), Enabled);
    }

    #[test]
    fn invoke_passes_only_accepted_paths() {
        assert!(invoke_accepts(Verb::Combine, r"C:\a\b.PDF"));
        assert!(!invoke_accepts(Verb::Convert, r"C:\a\b.pdf"));
        assert!(!invoke_accepts(Verb::Convert, r"C:\a\b.ps"));
        assert!(invoke_accepts(Verb::Convert, r"C:\a\b.heic"));
    }

    #[test]
    fn the_handoff_matches_the_app_side_schema() {
        let json = handoff_json(Verb::Combine, &[r"C:\a\b.pdf".to_string(), r"C:\a\c.png".to_string()], 2);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"version": 1, "action": "combine", "paths": [r"C:\a\b.pdf", r"C:\a\c.png"], "skipped": 2})
        );
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 4);
        let name = handoff_name(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        assert_eq!(name, "0123456789abcdef0123456789abcdef.json");
        assert_eq!(handoff_name(1).len(), 37);
    }

    #[test]
    fn the_executable_is_found_beside_the_shell_folder_only() {
        let root = Path::new(r"C:\Program Files\Spectra PDF");
        let dll = root.join("shell").join("x64").join("spectrapdf_shell.dll");
        assert_eq!(exe_from_module(&dll), Some(root.join("spectrapdf.exe")));
        let arm = root.join("shell").join("ARM64").join("SPECTRAPDF_SHELL.DLL");
        assert_eq!(exe_from_module(&arm), Some(root.join("spectrapdf.exe")));
        for wrong in [
            root.join("spectrapdf_shell.dll"),
            root.join("shell").join("spectrapdf_shell.dll"),
            root.join("shell").join("x86").join("spectrapdf_shell.dll"),
            root.join("other").join("x64").join("spectrapdf_shell.dll"),
            root.join("shell").join("x64").join("renamed.dll"),
        ] {
            assert_eq!(exe_from_module(&wrong), None, "{}", wrong.display());
        }
    }

    #[test]
    fn the_language_follows_the_app_then_windows_then_english() {
        let shipped = ["de", "en", "nb", "pt-BR", "zh-CN", "zh-TW"];
        let langs = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(pick_language(Some("de"), &langs(&["fr-FR"]), &shipped), "de");
        assert_eq!(pick_language(Some("pt-br"), &[], &shipped), "pt-BR");
        assert_eq!(pick_language(None, &langs(&["zh-Hant-TW"]), &shipped), "zh-TW");
        assert_eq!(pick_language(None, &langs(&["zh-Hans-CN"]), &shipped), "zh-CN");
        assert_eq!(pick_language(None, &langs(&["zh-HK"]), &shipped), "zh-TW");
        assert_eq!(pick_language(None, &langs(&["no"]), &shipped), "nb");
        assert_eq!(pick_language(None, &langs(&["nn-NO"]), &shipped), "nb");
        assert_eq!(pick_language(None, &langs(&["de-AT"]), &shipped), "de");
        assert_eq!(pick_language(None, &langs(&["pt-PT"]), &shipped), "pt-BR");
        assert_eq!(pick_language(None, &langs(&["fr-FR", "de-CH"]), &shipped), "de");
        assert_eq!(pick_language(Some("xx"), &langs(&["yy"]), &shipped), "en");
        assert_eq!(pick_language(Some(""), &[], &shipped), "en");
    }

    #[test]
    fn every_shipped_locale_has_both_labels_with_the_product_name() {
        let locales = shipped_locales();
        assert!(locales.len() >= 28, "{locales:?}");
        for locale in locales {
            for verb in Verb::ALL {
                let text = label(verb, locale);
                assert!(text.contains(ids::APP_NAME), "{locale}: {text}");
                assert!(!text.contains("{{"), "{locale}: {text}");
            }
        }
        assert_eq!(label(Verb::Convert, "en"), Verb::Convert.english_label());
        assert_eq!(label(Verb::Combine, "en"), Verb::Combine.english_label());
        assert_eq!(label(Verb::Combine, "xx"), Verb::Combine.english_label());
    }

    #[test]
    fn a_catalog_missing_a_verb_label_fails_the_build() {
        let dir = tempfile::tempdir().unwrap();
        let write = |locale: &str, body: &str| {
            std::fs::create_dir_all(dir.path().join(locale)).unwrap();
            std::fs::write(dir.path().join(locale).join("chrome.json"), body).unwrap();
        };
        let full = r#"{"shell.verb.convert":"Convert with {{app}}","shell.verb.combine":"Combine with {{app}}"}"#;
        write("en", full);
        assert_eq!(catalog::read_catalogs(dir.path()).unwrap().len(), 1);
        write("de", r#"{"shell.verb.convert":"Konvertieren mit {{app}}"}"#);
        let error = catalog::read_catalogs(dir.path()).unwrap_err();
        assert!(error.contains("shell.verb.combine"), "{error}");
        write("de", r#"{"shell.verb.convert":"Konvertieren","shell.verb.combine":"Kombinieren mit {{app}}"}"#);
        let error = catalog::read_catalogs(dir.path()).unwrap_err();
        assert!(error.contains("{{app}}"), "{error}");
        write("de", full);
        std::fs::create_dir_all(dir.path().join("fr")).unwrap();
        assert!(catalog::read_catalogs(dir.path()).is_err());
        let rendered = catalog::render(&[catalog::Entry {
            locale: "en".into(),
            labels: ["A \"q\" {{app}}".into(), "B {{app}}".into()],
        }]);
        assert!(rendered.contains(r#"("en", ["A \"q\" {{app}}", "B {{app}}"])"#), "{rendered}");
    }
}
