use std::env;
use std::fs;
use std::path::PathBuf;

#[path = "src/catalog.rs"]
mod catalog;

fn main() {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));

    let locales = crate_dir.join("..").join("..").join("src").join("renderer").join("locales");
    println!("cargo:rerun-if-changed={}", locales.display());
    if let Ok(listing) = fs::read_dir(&locales) {
        for item in listing.flatten() {
            println!("cargo:rerun-if-changed={}", item.path().join("chrome.json").display());
        }
    }
    let entries = catalog::read_catalogs(&locales)
        .unwrap_or_else(|e| panic!("the File Explorer verb labels cannot be built: {e}"));
    fs::write(out_dir.join("labels.rs"), catalog::render(&entries)).expect("write labels.rs");

    let conf_path = crate_dir.join("..").join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf_path.display());
    let conf: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&conf_path).expect("read tauri.conf.json"),
    )
    .expect("parse tauri.conf.json");
    let text = |pointer: &str| {
        conf.pointer(pointer)
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("tauri.conf.json has no {pointer}"))
            .to_string()
    };
    let version = text("/version");
    let product = text("/productName");
    let publisher = text("/bundle/publisher");
    let copyright = text("/bundle/copyright");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let numbers: Vec<u32> = version
        .split('.')
        .map(|part| part.parse().unwrap_or_else(|_| panic!("version {version} is not numeric")))
        .collect();
    assert!(
        numbers.len() == 3 && numbers.iter().all(|n| *n < 65536),
        "version {version} does not fit a Windows version resource"
    );
    let quad = format!("{},{},{},0", numbers[0], numbers[1], numbers[2]);
    let rc = format!(
        r#"1 VERSIONINFO
FILEVERSION {quad}
PRODUCTVERSION {quad}
FILEOS 0x40004
FILETYPE 0x2
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName", "{publisher}"
      VALUE "FileDescription", "{product} File Explorer commands"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "spectrapdf_shell"
      VALUE "LegalCopyright", "{copyright}"
      VALUE "OriginalFilename", "spectrapdf_shell.dll"
      VALUE "ProductName", "{product}"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let rc_path = out_dir.join("version.rc");
    fs::write(&rc_path, rc).expect("write version.rc");
    embed_resource::compile_for_everything(&rc_path, embed_resource::NONE)
        .manifest_required()
        .expect("compile the version resource");
}
