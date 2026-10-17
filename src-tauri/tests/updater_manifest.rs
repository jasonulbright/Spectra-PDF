//! `latest.json` is accepted by the update reader of earlier releases.
//!
//! Every copy released before automatic updates (up to 2026.1014.156) reads
//! the manifest with the updater plugin 2.10.1. A manifest the release
//! verifier accepts and that reader refuses breaks the launch update check on
//! every such install at once. The reader's rules are applied here: unknown
//! fields are ignored; `version` is a release number without leading zeros;
//! `notes` is a string; `pub_date` is an RFC 3339 date-time with seconds
//! and an offset, where a space may replace `T`; `platforms` maps each
//! platform to an absolute http or https `url` and a string `signature`.
//! This file is copied into the packages of earlier tags, so it uses no crate
//! beyond `serde_json`. What the reader accepts but leaves optional
//! (`notes`, `pub_date`) is required here, because the release always
//! carries both and the update notice shows them.
//!
//! With `SPECTRAPDF_UPDATER_MANIFEST` set (the release verifier's mode), the
//! named manifest is verified against the expectations in the sibling
//! variables; unset, that test returns and only the fixture tests run. A
//! platform named `linux-*` takes its url and signature from the `_LINUX_`
//! variables (the AppImage), `windows-x86_64-portable` from the `_PORTABLE_`
//! variables (the portable archive), every other platform from the
//! installer's.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

const MANIFEST_ENV: &str = "SPECTRAPDF_UPDATER_MANIFEST";
const VERSION_ENV: &str = "SPECTRAPDF_UPDATER_VERSION";
const NOTES_FILE_ENV: &str = "SPECTRAPDF_UPDATER_NOTES_FILE";
const PLATFORMS_ENV: &str = "SPECTRAPDF_UPDATER_PLATFORMS";
const URL_ENV: &str = "SPECTRAPDF_UPDATER_URL";
const SIGNATURE_FILE_ENV: &str = "SPECTRAPDF_UPDATER_SIGNATURE_FILE";
const LINUX_URL_ENV: &str = "SPECTRAPDF_UPDATER_LINUX_URL";
const LINUX_SIGNATURE_FILE_ENV: &str = "SPECTRAPDF_UPDATER_LINUX_SIGNATURE_FILE";
const PORTABLE_URL_ENV: &str = "SPECTRAPDF_UPDATER_PORTABLE_URL";
const PORTABLE_SIGNATURE_FILE_ENV: &str = "SPECTRAPDF_UPDATER_PORTABLE_SIGNATURE_FILE";
const PORTABLE_PLATFORM: &str = "windows-x86_64-portable";

/// What one platform entry must carry: the asset url, its signature, and the
/// artifact's name for the refusal message.
#[derive(Clone)]
struct Target {
    url: String,
    signature: String,
    artifact: &'static str,
}

struct Expected {
    version: String,
    notes: String,
    platforms: BTreeMap<String, Target>,
}

/// A release number as the earlier reader orders it: three decimal fields,
/// none with a leading zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ReleaseVersion([u64; 3]);

impl std::fmt::Display for ReleaseVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0[0], self.0[1], self.0[2])
    }
}

fn parse_version(text: &str) -> Result<ReleaseVersion, String> {
    let invalid = || format!("invalid version {text:?}");
    let mut fields = [0u64; 3];
    let mut parts = text.split('.');
    for field in fields.iter_mut() {
        let part = parts.next().ok_or_else(invalid)?;
        let numeric = !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        if !numeric || (part.len() > 1 && part.starts_with('0')) {
            return Err(invalid());
        }
        *field = part.parse().map_err(|_| invalid())?;
    }
    if parts.next().is_some() {
        return Err(invalid());
    }
    Ok(ReleaseVersion(fields))
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "sequence",
        Value::Object(_) => "map",
    }
}

fn expect_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .ok_or_else(|| format!("invalid type: {}, expected a string (`{field}`)", kind_of(value)))
}

fn number_at(text: &[u8], range: std::ops::Range<usize>, max: u32) -> bool {
    match text.get(range) {
        Some(d) if d.iter().all(u8::is_ascii_digit) => std::str::from_utf8(d)
            .ok()
            .and_then(|d| d.parse::<u32>().ok())
            .is_some_and(|n| n <= max),
        _ => false,
    }
}

/// RFC 3339 date-time: `YYYY-MM-DD`, then `T`, `t` or a space, `HH:MM:SS`, an
/// optional fraction, then `Z`, `z`, or `+HH:MM` / `-HH:MM`.
fn is_rfc3339(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 20 || !number_at(b, 0..4, 9999) || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !number_at(b, 5..7, 12) || &b[5..7] == b"00" || !number_at(b, 8..10, 31) || &b[8..10] == b"00" {
        return false;
    }
    if !matches!(b[10], b'T' | b't' | b' ') {
        return false;
    }
    if !number_at(b, 11..13, 23) || b[13] != b':' || !number_at(b, 14..16, 59) || b[16] != b':' {
        return false;
    }
    if !number_at(b, 17..19, 60) {
        return false;
    }
    let mut i = 19;
    if b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    match b.get(i) {
        Some(b'Z' | b'z') => i + 1 == b.len(),
        Some(b'+' | b'-') => {
            b.len() == i + 6
                && number_at(b, i + 1..i + 3, 23)
                && b[i + 3] == b':'
                && number_at(b, i + 4..i + 6, 59)
        }
        _ => false,
    }
}

fn is_absolute_web_url(text: &str) -> bool {
    let rest = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://"));
    match rest {
        Some(rest) => {
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            !host.is_empty() && !text.chars().any(char::is_whitespace)
        }
        None => false,
    }
}

struct Platform {
    url: String,
    signature: String,
}

enum ReleaseData {
    Static { platforms: BTreeMap<String, Platform> },
    Dynamic,
}

struct Release {
    version: ReleaseVersion,
    notes: Option<String>,
    pub_date: Option<String>,
    data: ReleaseData,
}

fn required<'a>(object: &'a serde_json::Map<String, Value>, field: &str) -> Result<&'a Value, String> {
    object.get(field).ok_or_else(|| format!("missing field `{field}`"))
}

fn optional_string(object: &serde_json::Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => expect_string(value, field).map(|s| Some(s.to_string())),
    }
}

/// The earlier reader's acceptance of one manifest.
fn read_release(manifest: &str) -> Result<Release, String> {
    let value: Value = serde_json::from_str(manifest).map_err(|e| e.to_string())?;
    let object = value.as_object().ok_or("invalid type: expected a map")?;
    let version = parse_version(expect_string(required(object, "version")?, "version")?)?;
    let notes = optional_string(object, "notes")?;
    let pub_date = optional_string(object, "pub_date")?;
    if let Some(date) = pub_date.as_deref() {
        if !is_rfc3339(date) {
            return Err(format!("invalid value for `pub_date`: {date:?}"));
        }
    }
    let data = match object.get("platforms") {
        Some(platforms) => {
            let platforms = platforms
                .as_object()
                .ok_or("invalid type for `platforms`: expected a map")?;
            let mut read = BTreeMap::new();
            for (name, entry) in platforms {
                let entry = entry
                    .as_object()
                    .ok_or_else(|| format!("invalid type for platform {name}: expected a map"))?;
                let url = expect_string(required(entry, "url")?, "url")?;
                if !is_absolute_web_url(url) {
                    return Err(format!("invalid url {url:?} (platform {name})"));
                }
                let signature = expect_string(required(entry, "signature")?, "signature")?;
                read.insert(
                    name.clone(),
                    Platform {
                        url: url.to_string(),
                        signature: signature.to_string(),
                    },
                );
            }
            ReleaseData::Static { platforms: read }
        }
        None => {
            let url = expect_string(required(object, "url")?, "url")?;
            if !is_absolute_web_url(url) {
                return Err(format!("invalid url {url:?}"));
            }
            expect_string(required(object, "signature")?, "signature")?;
            ReleaseData::Dynamic
        }
    };
    Ok(Release {
        version,
        notes,
        pub_date,
        data,
    })
}

fn verify(manifest: &str, expected: &Expected) -> Result<(), String> {
    let release = read_release(manifest)
        .map_err(|e| format!("the updater's deserializer refuses latest.json: {e}"))?;

    let version = release.version.to_string();
    if version != expected.version {
        return Err(format!(
            "latest.json version '{version}' != expected '{}'",
            expected.version
        ));
    }
    match &release.notes {
        None => return Err("latest.json carries no `notes`".to_string()),
        Some(notes) if *notes != expected.notes => {
            return Err(format!(
                "latest.json notes differ from the release body.\nnotes: {notes:?}\nbody:  {:?}",
                expected.notes
            ));
        }
        Some(_) => {}
    }
    if release.pub_date.is_none() {
        return Err("latest.json carries no `pub_date`".to_string());
    }
    let platforms = match &release.data {
        ReleaseData::Static { platforms } => platforms,
        ReleaseData::Dynamic => {
            return Err(
                "latest.json is the single-platform shape; the `platforms` map is expected"
                    .to_string(),
            );
        }
    };
    let present: BTreeSet<String> = platforms.keys().cloned().collect();
    let wanted: BTreeSet<String> = expected.platforms.keys().cloned().collect();
    if present != wanted {
        return Err(format!(
            "latest.json platforms [{}] != [{}]",
            join(&present),
            join(&wanted)
        ));
    }
    for (name, platform) in platforms {
        let target = &expected.platforms[name];
        if platform.url.as_str() != target.url {
            return Err(format!(
                "latest.json url mismatch (platform {name}): '{}' != '{}'",
                platform.url, target.url
            ));
        }
        if platform.signature.trim() != target.signature {
            return Err(format!(
                "latest.json signature is not the {}'s .sig (platform {name})",
                target.artifact
            ));
        }
    }
    Ok(())
}

fn join(set: &BTreeSet<String>) -> String {
    set.iter().cloned().collect::<Vec<_>>().join(", ")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{MANIFEST_ENV} is set but {name} is not"))
}

#[test]
fn verifies_the_manifest_named_by_the_environment() {
    let Some(manifest) = std::env::var_os(MANIFEST_ENV) else {
        eprintln!("skipped: {MANIFEST_ENV} is not set");
        return;
    };
    let installer = Target {
        url: env(URL_ENV),
        signature: read(Path::new(&env(SIGNATURE_FILE_ENV))).trim().to_string(),
        artifact: "installer",
    };
    let mut platforms = BTreeMap::new();
    for name in env(PLATFORMS_ENV).split(',') {
        let target = if name == PORTABLE_PLATFORM {
            Target {
                url: env(PORTABLE_URL_ENV),
                signature: read(Path::new(&env(PORTABLE_SIGNATURE_FILE_ENV))).trim().to_string(),
                artifact: "portable archive",
            }
        } else if name.starts_with("linux-") {
            Target {
                url: env(LINUX_URL_ENV),
                signature: read(Path::new(&env(LINUX_SIGNATURE_FILE_ENV))).trim().to_string(),
                artifact: "AppImage",
            }
        } else {
            installer.clone()
        };
        platforms.insert(name.to_string(), target);
    }
    let expected = Expected {
        version: env(VERSION_ENV),
        notes: read(Path::new(&env(NOTES_FILE_ENV))),
        platforms,
    };
    let manifest = PathBuf::from(manifest);
    if let Err(message) = verify(&read(&manifest), &expected) {
        panic!("{}: {message}", manifest.display());
    }
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("updater-manifest")
}

fn fixture() -> (String, Expected) {
    let dir = fixture_dir();
    let installer = Target {
        url: "https://api.github.com/repos/jasonulbright/Spectra-PDF/releases/assets/538527808"
            .to_string(),
        signature: read(&dir.join("installer.sig")).trim().to_string(),
        artifact: "installer",
    };
    let expected = Expected {
        version: "1.1.20".to_string(),
        notes: read(&dir.join("notes.txt")),
        platforms: ["windows-x86_64-nsis", "windows-x86_64"]
            .iter()
            .map(|s| (s.to_string(), installer.clone()))
            .collect(),
    };
    (read(&dir.join("latest.json")), expected)
}

const PORTABLE_URL: &str =
    "https://api.github.com/repos/jasonulbright/Spectra-PDF/releases/assets/538528111";
const PORTABLE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHBvcnRhYmxl";

/// The fixture with the portable archive's entry: its own asset url and
/// signature beside the installer's.
fn portable_fixture() -> (String, Expected) {
    let (manifest, mut expected) = fixture();
    let manifest = mutated(&manifest, |m| {
        m["platforms"].as_object_mut().unwrap().insert(
            PORTABLE_PLATFORM.to_string(),
            serde_json::json!({ "url": PORTABLE_URL, "signature": PORTABLE_SIGNATURE }),
        );
    });
    expected.platforms.insert(
        PORTABLE_PLATFORM.to_string(),
        Target {
            url: PORTABLE_URL.to_string(),
            signature: PORTABLE_SIGNATURE.to_string(),
            artifact: "portable archive",
        },
    );
    (manifest, expected)
}

#[test]
fn accepts_the_portable_entry_beside_the_installer_entries() {
    let (manifest, expected) = portable_fixture();
    verify(&manifest, &expected).unwrap();
}

#[test]
fn refuses_a_portable_entry_without_a_url() {
    let (manifest, expected) = portable_fixture();
    let wrong = mutated(&manifest, |m| {
        m["platforms"][PORTABLE_PLATFORM].as_object_mut().unwrap().remove("url");
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("the updater's deserializer refuses latest.json"), "{message}");
}

#[test]
fn refuses_a_portable_entry_carrying_the_installer_signature() {
    let (manifest, expected) = portable_fixture();
    let wrong = mutated(&manifest, |m| {
        let installer = m["platforms"]["windows-x86_64"]["signature"].clone();
        m["platforms"][PORTABLE_PLATFORM]["signature"] = installer;
    });
    assert_eq!(
        refusal(&wrong, &expected),
        "latest.json signature is not the portable archive's .sig (platform windows-x86_64-portable)"
    );
}

const APPIMAGE_URL: &str =
    "https://api.github.com/repos/jasonulbright/Spectra-PDF/releases/assets/538527999";
const APPIMAGE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IGFwcGltYWdl";

/// The fixture with the `linux-x86_64` entry a Linux release adds: the
/// AppImage's asset url and its own signature.
fn linux_fixture() -> (String, Expected) {
    let (manifest, mut expected) = fixture();
    let manifest = mutated(&manifest, |m| {
        m["platforms"].as_object_mut().unwrap().insert(
            "linux-x86_64".to_string(),
            serde_json::json!({ "url": APPIMAGE_URL, "signature": APPIMAGE_SIGNATURE }),
        );
    });
    expected.platforms.insert(
        "linux-x86_64".to_string(),
        Target {
            url: APPIMAGE_URL.to_string(),
            signature: APPIMAGE_SIGNATURE.to_string(),
            artifact: "AppImage",
        },
    );
    (manifest, expected)
}

/// The release an installed copy reads from the fixture carrying `version`.
fn release_at(manifest: &str, version: &str) -> Release {
    let text = mutated(manifest, |m| {
        m.insert("version".to_string(), Value::from(version));
    });
    read_release(&text).unwrap_or_else(|e| panic!("version {version:?} must parse: {e}"))
}

fn mutated(manifest: &str, mutate: impl FnOnce(&mut serde_json::Map<String, Value>)) -> String {
    let mut value: Value = serde_json::from_str(manifest).expect("fixture parses");
    mutate(value.as_object_mut().expect("fixture is an object"));
    value.to_string()
}

fn refusal(manifest: &str, expected: &Expected) -> String {
    verify(manifest, expected).expect_err("the manifest must be refused")
}

#[test]
fn accepts_the_faithful_manifest() {
    let (manifest, expected) = fixture();
    verify(&manifest, &expected).unwrap();
}

#[test]
fn accepts_an_unknown_top_level_field() {
    // The plugin's deserializer ignores fields it does not model, so an
    // extra key changes nothing an installed copy reads.
    let (manifest, expected) = fixture();
    let extra = mutated(&manifest, |m| {
        m.insert("unmodelled".to_string(), Value::from("ignored"));
    });
    verify(&extra, &expected).unwrap();
}

#[test]
fn refuses_notes_that_are_not_a_string() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.insert("notes".to_string(), serde_json::json!({ "not": "a string" }));
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("the updater's deserializer refuses latest.json"), "{message}");
    assert!(message.contains("invalid type: map, expected a string"), "{message}");
}

#[test]
fn refuses_notes_that_differ_from_the_release_body() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.insert("notes".to_string(), Value::from("See CHANGELOG.md for details."));
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("notes differ from the release body"), "{message}");
}

#[test]
fn refuses_notes_that_differ_only_by_case() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        let notes = m["notes"].as_str().unwrap().replacen("See", "SEE", 1);
        m.insert("notes".to_string(), Value::from(notes));
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("notes differ from the release body"), "{message}");
}

#[test]
fn refuses_a_manifest_without_notes() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.remove("notes");
    });
    assert_eq!(refusal(&wrong, &expected), "latest.json carries no `notes`");
}

#[test]
fn refuses_pub_date_that_is_not_rfc3339() {
    let (manifest, expected) = fixture();
    for date in ["not-rfc3339", "2026-09-02", "2026-09-02T15:00:00", "2026-09-02T15:00:00+0000"] {
        let wrong = mutated(&manifest, |m| {
            m.insert("pub_date".to_string(), Value::from(date));
        });
        let message = verify(&wrong, &expected)
            .expect_err(&format!("pub_date {date:?} must be refused"));
        assert!(message.contains("invalid value for `pub_date`"), "{date}: {message}");
    }
}

#[test]
fn accepts_pub_date_with_a_space_separator() {
    // The plugin's `time` parse takes the RFC 3339 section 5.6 note's space in
    // place of `T`; the gate accepts exactly what the installed reader does.
    let (manifest, expected) = fixture();
    let spaced = mutated(&manifest, |m| {
        m.insert("pub_date".to_string(), Value::from("2026-09-02 15:00:00Z"));
    });
    verify(&spaced, &expected).unwrap();
}

#[test]
fn refuses_pub_date_that_is_not_a_string() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.insert("pub_date".to_string(), Value::from(1788210400));
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("the updater's deserializer refuses latest.json"), "{message}");
}

#[test]
fn refuses_a_manifest_without_pub_date() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.remove("pub_date");
    });
    assert_eq!(refusal(&wrong, &expected), "latest.json carries no `pub_date`");
}

#[test]
fn refuses_a_manifest_without_version() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.remove("version");
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("the updater's deserializer refuses latest.json"), "{message}");
}

#[test]
fn refuses_a_wrong_version() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m.insert("version".to_string(), Value::from("1.1.21"));
    });
    assert_eq!(
        refusal(&wrong, &expected),
        "latest.json version '1.1.21' != expected '1.1.20'"
    );
}

#[test]
fn refuses_a_missing_platform() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m["platforms"].as_object_mut().unwrap().remove("windows-x86_64-nsis");
    });
    assert_eq!(
        refusal(&wrong, &expected),
        "latest.json platforms [windows-x86_64] != [windows-x86_64, windows-x86_64-nsis]"
    );
}

#[test]
fn refuses_an_extra_platform() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        let entry = m["platforms"]["windows-x86_64"].clone();
        m["platforms"].as_object_mut().unwrap().insert("linux-x86_64".to_string(), entry);
    });
    let message = refusal(&wrong, &expected);
    assert!(message.starts_with("latest.json platforms [linux-x86_64, "), "{message}");
}

#[test]
fn refuses_the_single_platform_shape() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        let entry = m["platforms"]["windows-x86_64-nsis"].clone();
        m.remove("platforms");
        m.insert("url".to_string(), entry["url"].clone());
        m.insert("signature".to_string(), entry["signature"].clone());
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("single-platform shape"), "{message}");
}

#[test]
fn refuses_a_foreign_url() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m["platforms"]["windows-x86_64-nsis"]["url"] =
            Value::from("https://evil.example/releases/assets/538527808");
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("url mismatch (platform windows-x86_64-nsis)"), "{message}");
}

#[test]
fn refuses_a_url_the_updater_cannot_parse() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m["platforms"]["windows-x86_64"]["url"] = Value::from("not a URL");
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("the updater's deserializer refuses latest.json"), "{message}");
}

#[test]
fn refuses_a_foreign_signature() {
    let (manifest, expected) = fixture();
    let wrong = mutated(&manifest, |m| {
        m["platforms"]["windows-x86_64"]["signature"] = Value::from("c29tZW9uZSBlbHNl");
    });
    assert_eq!(
        refusal(&wrong, &expected),
        "latest.json signature is not the installer's .sig (platform windows-x86_64)"
    );
}

#[test]
fn accepts_the_linux_entry_beside_the_windows_entries() {
    let (manifest, expected) = linux_fixture();
    verify(&manifest, &expected).unwrap();
}

#[test]
fn refuses_a_missing_linux_entry() {
    let (_, expected) = linux_fixture();
    let (manifest, _) = fixture();
    assert_eq!(
        refusal(&manifest, &expected),
        "latest.json platforms [windows-x86_64, windows-x86_64-nsis] \
         != [linux-x86_64, windows-x86_64, windows-x86_64-nsis]"
    );
}

#[test]
fn refuses_a_linux_entry_naming_the_installer() {
    let (manifest, expected) = linux_fixture();
    let wrong = mutated(&manifest, |m| {
        let installer = m["platforms"]["windows-x86_64"]["url"].clone();
        m["platforms"]["linux-x86_64"]["url"] = installer;
    });
    let message = refusal(&wrong, &expected);
    assert!(message.contains("url mismatch (platform linux-x86_64)"), "{message}");
}

#[test]
fn refuses_a_linux_entry_carrying_the_installer_signature() {
    let (manifest, expected) = linux_fixture();
    let wrong = mutated(&manifest, |m| {
        let installer = m["platforms"]["windows-x86_64"]["signature"].clone();
        m["platforms"]["linux-x86_64"]["signature"] = installer;
    });
    assert_eq!(
        refusal(&wrong, &expected),
        "latest.json signature is not the AppImage's .sig (platform linux-x86_64)"
    );
}

#[test]
fn orders_date_versions_after_the_legacy_versions() {
    // An installed copy offers the update when the manifest's version is
    // greater than its own, in the plugin's semver order.
    let (manifest, _) = fixture();
    let sequence = [
        "1.1.20",
        "1.2.8",
        "2026.930.150",
        "2026.1004.151",
        "2026.1004.152",
        "2026.1231.160",
        "2027.101.161",
        "2027.1231.65535",
    ];
    for pair in sequence.windows(2) {
        let (older, newer) = (release_at(&manifest, pair[0]), release_at(&manifest, pair[1]));
        assert!(newer.version > older.version, "{} must order after {}", pair[1], pair[0]);
        assert_eq!(newer.version.to_string(), pair[1]);
    }
}

#[test]
fn refuses_a_version_with_a_leading_zero() {
    let (manifest, expected) = fixture();
    for version in ["2026.0930.150", "2026.930.0150", "02026.930.150"] {
        let wrong = mutated(&manifest, |m| {
            m.insert("version".to_string(), Value::from(version));
        });
        let message =
            verify(&wrong, &expected).expect_err(&format!("version {version:?} must be refused"));
        assert!(
            message.contains("the updater's deserializer refuses latest.json"),
            "{version}: {message}"
        );
    }
}
