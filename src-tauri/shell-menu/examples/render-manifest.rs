//! Writes one architecture's `AppxManifest.xml` and the identity file the app
//! reads back:
//!
//! render-manifest --version <app version> --publisher <subject> --arch <x64|arm64>
//!                 --manifest <file> --identity <file>

use spectrapdf_shell::manifest;

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut version, mut publisher, mut arch, mut out, mut identity) =
        (None, None, None, None, None);
    while let Some(flag) = args.next() {
        let value = args.next();
        match flag.as_str() {
            "--version" => version = value,
            "--publisher" => publisher = value,
            "--arch" => arch = value,
            "--manifest" => out = value,
            "--identity" => identity = value,
            other => fail(&format!("unknown argument {other}")),
        }
    }
    let need = |v: Option<String>, name: &str| v.unwrap_or_else(|| fail(&format!("--{name} is required")));
    let (version, publisher, arch, out, identity) = (
        need(version, "version"),
        need(publisher, "publisher"),
        need(arch, "arch"),
        need(out, "manifest"),
        need(identity, "identity"),
    );
    let xml = manifest::render(&publisher, &version, &arch).unwrap_or_else(|e| fail(&e));
    std::fs::write(&out, xml).unwrap_or_else(|e| fail(&format!("{out}: {e}")));
    let json = manifest::identity_json(&publisher, &version).unwrap_or_else(|e| fail(&e));
    std::fs::write(&identity, json).unwrap_or_else(|e| fail(&format!("{identity}: {e}")));
}

fn fail(message: &str) -> ! {
    eprintln!("error: {message}");
    std::process::exit(1);
}
