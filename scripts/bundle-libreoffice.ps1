# Vendors a LibreOffice runtime into resources/libreoffice/ for the O1 export
# feature (PDF -> Word/RTF/ODT/HTML). LibreOffice is invoked as a separate
# headless process (soffice --headless); it is unmodified upstream, redistributed
# under MPL-2.0 (see THIRD-PARTY-LICENSES.md § LibreOffice).
#
# Two sources, tried in order:
#   1. A local system install (C:\Program Files\LibreOffice) — copied verbatim.
#      This is the fast path on a dev/packaging machine that already has it.
#   2. The official upstream Windows .msi, downloaded and extracted headlessly.
#
# Deliberately NOT version-pinned. LibreOffice releases on its own cadence; the
# app resolves whatever soffice.exe is vendored at run time (engine.rs /
# cli.rs), so a pinned copy would only go stale. (Same principle as the
# never-pin-a-webview-runtime rule — resolve, don't hardcode.)
#
# Run before packaging:
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-libreoffice.ps1

param(
    [string]$DestDir = "$PSScriptRoot\..\resources\libreoffice",
    # Optional explicit installer URL (else the latest-stable download page's
    # msi is used). Kept a parameter so a packaging pipeline can pin per-release
    # without editing the script.
    [string]$MsiUrl = ""
)

$ErrorActionPreference = "Stop"

function Copy-Install([string]$root) {
    $soffice = Join-Path $root "program\soffice.exe"
    if (-not (Test-Path $soffice)) { return $false }
    Write-Host "Copying LibreOffice from $root ..."
    if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
    New-Item -ItemType Directory -Force $DestDir | Out-Null
    # The whole install tree is needed: program/ (soffice + libs), share/
    # (filters, registry), presets/. A partial copy yields a runtime that
    # imports PDFs but fails to write Office formats.
    Copy-Item (Join-Path $root "program") (Join-Path $DestDir "program") -Recurse -Force
    foreach ($sub in @("share", "presets")) {
        $p = Join-Path $root $sub
        if (Test-Path $p) { Copy-Item $p (Join-Path $DestDir $sub) -Recurse -Force }
    }
    # Ship the license text alongside (THIRD-PARTY-LICENSES.md points at it).
    foreach ($lic in @("LICENSE", "license.txt", "LICENSE.html")) {
        $p = Join-Path $root $lic
        if (Test-Path $p) { Copy-Item $p (Join-Path $DestDir "LICENSE") -Force; break }
    }
    return $true
}

# ── 1. Local system install ─────────────────────────────────────────────────
$roots = @(
    "$env:ProgramFiles\LibreOffice",
    "${env:ProgramFiles(x86)}\LibreOffice"
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($r in $roots) {
    if (Copy-Install $r) {
        $ver = (& (Join-Path $DestDir "program\soffice.exe") --version 2>$null | Select-Object -First 1)
        Write-Host "Vendored LibreOffice ($ver) into $DestDir"
        exit 0
    }
}

# ── 2. Upstream .msi ────────────────────────────────────────────────────────
if (-not $MsiUrl) {
    Write-Error @"
No local LibreOffice install found and no -MsiUrl given.
Either install LibreOffice (https://www.libreoffice.org/download/) and re-run,
or pass the official Windows x86-64 .msi URL:
  scripts\bundle-libreoffice.ps1 -MsiUrl https://download.documentfoundation.org/libreoffice/stable/<ver>/win/x86_64/LibreOffice_<ver>_Win_x86-64.msi
"@
    exit 1
}

$Work = Join-Path $env:TEMP "lo-vendor"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null
$Msi = Join-Path $Work "libreoffice.msi"
$Extract = Join-Path $Work "extract"

Write-Host "Downloading $MsiUrl ..."
Invoke-WebRequest -Uri $MsiUrl -OutFile $Msi

# Administrative install extracts the payload without touching the system.
Write-Host "Extracting (msiexec /a) ..."
Start-Process msiexec.exe -ArgumentList "/a `"$Msi`" /qn TARGETDIR=`"$Extract`"" -Wait

$installed = Get-ChildItem -Path $Extract -Recurse -Filter "soffice.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $installed) { Write-Error "soffice.exe not found in the extracted MSI."; exit 1 }
$root = Split-Path (Split-Path $installed.FullName -Parent) -Parent
if (Copy-Install $root) {
    Write-Host "Vendored LibreOffice into $DestDir"
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}
Write-Error "Extraction produced no usable LibreOffice tree."
exit 1
