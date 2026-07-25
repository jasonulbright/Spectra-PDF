# Regenerates src-tauri/THIRD-PARTY-LICENSES-RUST.html -- the per-crate
# license and notice listing for every Rust crate compiled into the app
# binary, produced by cargo-about from the exact Cargo.lock graph and shipped
# as a bundle resource (tauri.conf.json maps it into the app's resources).
# Run after any dependency change in src-tauri; commit the regenerated file.
#
# cargo-about is a BUILD-TIME tool (installed into ~/.cargo/bin), never
# vendored into the product. about.toml holds the accepted-license list; a
# crate under a license outside that list fails generation LOUDLY so it gets
# reviewed instead of shipped without notices.
#
# ASCII ONLY in this file: Windows PowerShell 5.1 reads BOM-less UTF-8 as
# ANSI and a multi-byte character can mangle into a parser-breaking byte.

$ErrorActionPreference = 'Stop'

$SrcTauri = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri'

if (-not (Get-Command 'cargo-about' -ErrorAction SilentlyContinue)) {
    Write-Host "cargo-about not found; installing (build-time tool)..."
    cargo install cargo-about --locked --features cli
    if ($LASTEXITCODE -ne 0) { throw "cargo-about install failed ($LASTEXITCODE)" }
}

Push-Location $SrcTauri
try {
    cargo about generate about.hbs -o THIRD-PARTY-LICENSES-RUST.html
    if ($LASTEXITCODE -ne 0) { throw "cargo about generate failed ($LASTEXITCODE)" }
    $size = (Get-Item 'THIRD-PARTY-LICENSES-RUST.html').Length
    Write-Host "Generated THIRD-PARTY-LICENSES-RUST.html ($size bytes)"
} finally {
    Pop-Location
}
