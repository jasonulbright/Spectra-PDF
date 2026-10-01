//! The verb labels, read from the shipped UI catalogs at build time. Mounted
//! by `build.rs` and by the crate's tests, so the rule that fails the build is
//! the rule the tests exercise.

use std::path::Path;

pub const KEYS: [&str; 2] = ["shell.verb.convert", "shell.verb.combine"];
pub const PLACEHOLDER: &str = "{{app}}";

#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    pub locale: String,
    pub labels: [String; 2],
}

/// Every `<locale>/chrome.json` under `dir`, sorted by locale. A locale
/// folder without a catalog, a catalog without a verb key, and a label
/// without the product-name placeholder each refuse.
pub fn read_catalogs(dir: &Path) -> Result<Vec<Entry>, String> {
    let listing = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut entries = Vec::new();
    for item in listing {
        let item = item.map_err(|e| e.to_string())?;
        if !item.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let locale = item.file_name().to_string_lossy().into_owned();
        let path = item.path().join("chrome.json");
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let catalog: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let label = |key: &str| -> Result<String, String> {
            let value = catalog
                .get(key)
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("{}: no \"{key}\" label", path.display()))?;
            if !value.contains(PLACEHOLDER) {
                return Err(format!("{}: \"{key}\" lacks {PLACEHOLDER}", path.display()));
            }
            Ok(value.to_string())
        };
        entries.push(Entry {
            labels: [label(KEYS[0])?, label(KEYS[1])?],
            locale,
        });
    }
    entries.sort_by(|a, b| a.locale.cmp(&b.locale));
    if !entries.iter().any(|e| e.locale == "en") {
        return Err(format!("{}: no en catalog", dir.display()));
    }
    Ok(entries)
}

/// Rust source for the table the handler embeds.
pub fn render(entries: &[Entry]) -> String {
    let mut out = String::from("pub static LABELS: &[(&str, [&str; 2])] = &[\n");
    for entry in entries {
        out.push_str(&format!(
            "    ({:?}, [{:?}, {:?}]),\n",
            entry.locale, entry.labels[0], entry.labels[1]
        ));
    }
    out.push_str("];\n");
    out
}
