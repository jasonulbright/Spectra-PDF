# Vendors a LibreOffice runtime into resources/libreoffice/ for the export
# feature (PDF -> Word/RTF/ODT/HTML). LibreOffice is invoked as a separate
# headless process (soffice --headless); it is unmodified upstream, redistributed
# under MPL-2.0 (see THIRD-PARTY-LICENSES.md section LibreOffice).
#
# Two sources, tried in order:
#   1. A local system install (C:\Program Files\LibreOffice) -- copied verbatim.
#      This is the fast path on a dev/packaging machine that already has it
#      (e.g. cutting a release locally: it just copies your installed copy).
#   2. The official upstream Windows .msi -- downloaded, CHECKSUM-VERIFIED, and
#      extracted headlessly. This is what makes a CI-tag release self-sufficient:
#      the GitHub windows-latest runner has no LibreOffice, so it falls to this
#      path -- and because a real version + hash are pinned below, it needs NO
#      repository variable and NO manual setup. Same model as bundle-ghostscript.ps1.
#
# NOTE on the "never pin a runtime version" rule: that rule targets BROWSER /
# WEBVIEW runtimes (WebView2, msedgedriver, Chrome) that auto-update on an
# external schedule. LibreOffice is a third-party vendored runtime like
# Ghostscript, which the repo DOES pin -- and the app still resolves whatever
# soffice.exe is present at RUN time (engine.rs / cli.rs), so this download pin
# only fixes what a fresh CI box fetches, never what the app requires.
#
# Run before packaging:
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-libreoffice.ps1

param(
    [string]$DestDir = "$PSScriptRoot\..\resources\libreoffice",
    # Pinned default so a fresh CI box (no system LibreOffice) vendors a known,
    # integrity-checked build with zero manual setup. Override -MsiUrl (and
    # -ExpectedSha256, or "" to skip the check) only to bump the version.
    [string]$Version = "26.2.5",
    [string]$MsiUrl = "",
    [string]$ExpectedSha256 = "F15BA07BFCB0186986CF3171063506F5D207C11F8CC051BA0D135209E9E915F9"
)

if (-not $MsiUrl) {
    $MsiUrl = "https://download.documentfoundation.org/libreoffice/stable/$Version/win/x86_64/LibreOffice_${Version}_Win_x86-64.msi"
}

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

# -- 1. Local system install -------------------------------------------------
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

# -- 2. Upstream .msi (pinned default; no manual setup needed) ----------------
$Work = Join-Path $env:TEMP "lo-vendor"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null
$Msi = Join-Path $Work "libreoffice.msi"
$Extract = Join-Path $Work "extract"

# RETRY, because the default host is a REDIRECTOR, not a server: it hands out
# a different volunteer mirror per request, and drawing a dead one fails the
# whole release. That is exactly what killed the v2.8.4 tag build ("Unable to
# connect to the remote server") two hours after the identical URL had served
# v2.8.3 fine. Retrying re-rolls the mirror, so a single bad draw costs seconds
# instead of a release. Safe to retry blindly: the SHA-256 check below runs on
# whatever any mirror served, so a corrupt or substituted file still fails.
Write-Host "No local LibreOffice; downloading $MsiUrl ..."
$Attempts = 4
for ($i = 1; $i -le $Attempts; $i++) {
    try {
        Invoke-WebRequest -Uri $MsiUrl -OutFile $Msi -UseBasicParsing
        break
    } catch {
        Remove-Item $Msi -Force -ErrorAction SilentlyContinue
        if ($i -eq $Attempts) {
            throw "LibreOffice download failed after $Attempts attempts: $($_.Exception.Message)"
        }
        $wait = 5 * $i
        Write-Host "  attempt $i/$Attempts failed ($($_.Exception.Message)); retrying in ${wait}s..."
        Start-Sleep -Seconds $wait
    }
}

# Verify the pinned checksum (skip only if explicitly cleared for a version bump).
if ($ExpectedSha256 -and $ExpectedSha256 -ne "" -and $ExpectedSha256 -ne "PLACEHOLDER_SHA256") {
    $actual = (Get-FileHash $Msi -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedSha256.ToUpper()) {
        Write-Error "Checksum mismatch for LibreOffice $Version msi.`n  expected: $ExpectedSha256`n  actual:   $actual"
        exit 1
    }
    Write-Host "Checksum verified."
} elseif ($ExpectedSha256 -eq "PLACEHOLDER_SHA256") {
    Write-Warning "No pinned SHA256 for this build -- download NOT integrity-checked. Set -ExpectedSha256."
}

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
