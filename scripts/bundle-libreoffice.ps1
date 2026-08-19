# Vendors a LibreOffice runtime into resources/libreoffice/ for the export
# feature (PDF -> Word/RTF/ODT/HTML). LibreOffice is invoked as a separate
# headless process (soffice --headless); it is unmodified upstream.
#
# The tree is MPL-2.0 EXCEPT for its PDF-import helper: program/xpdfimport.exe
# statically links poppler (GPL-2.0-or-later) and reads the encoding tables
# under share/xpdfimport/poppler_data. Both are required by the PDF -> Office
# export targets, so both ship, with their notices. scripts/libreoffice-notices.tsv
# is the manifest; the notice gate below refuses to leave a tree that is missing
# any file it names. See THIRD-PARTY-LICENSES.md section LibreOffice.
#
# Two sources, tried in order:
#   1. A local system install (C:\Program Files\LibreOffice) -- copied verbatim
#      ONLY when its three-part release version matches the pinned version below.
#      This is the fast path on a dev/packaging machine that already has the
#      exact release build; an older/newer install cannot change shipped bytes.
#   2. The official upstream Windows .msi -- downloaded, CHECKSUM-VERIFIED, and
#      extracted headlessly. This is what makes a CI-tag release self-sufficient:
#      the GitHub windows-latest runner has no LibreOffice, so it falls to this
#      path -- and because a real version + hash are pinned below, it needs NO
#      repository variable and NO manual setup. Same model as bundle-tesseract.ps1.
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
    [string]$ExpectedSha256 = "F15BA07BFCB0186986CF3171063506F5D207C11F8CC051BA0D135209E9E915F9",
    # Run only the notice gate against -DestDir and exit with its verdict.
    # Nothing is downloaded, copied or removed.
    [switch]$GateOnly
)

if (-not $MsiUrl) {
    $MsiUrl = "https://download.documentfoundation.org/libreoffice/stable/$Version/win/x86_64/LibreOffice_${Version}_Win_x86-64.msi"
}

$ErrorActionPreference = "Stop"

$Manifest = "$PSScriptRoot\libreoffice-notices.tsv"

function Read-NoticeManifest([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "notice manifest not found: $path" }
    $rows = @()
    $seenHeader = $false
    foreach ($line in Get-Content -LiteralPath $path) {
        if ($line.StartsWith("#") -or -not $line.Trim()) { continue }
        $c = $line -split "`t"
        if (-not $seenHeader) { $seenHeader = $true; continue }
        if ($c.Count -lt 7) { throw "notice manifest row has $($c.Count) columns: $line" }
        $rows += [pscustomobject]@{
            file = $c[0].Trim(); component = $c[1].Trim(); role = $c[2].Trim()
            sha256 = $c[3].Trim(); spdx = $c[4].Trim(); notice = $c[5].Trim()
            source = $c[6].Trim()
        }
    }
    if (-not $seenHeader) { throw "notice manifest $path has no header row" }
    return $rows
}

# The notice gate. Half one checks the manifest is self-consistent; half two
# checks the tree that was actually written. A trimmed tree — one where the GPL
# poppler pieces were dropped to make the licensing question go away — fails
# here rather than shipping exports that lose their text.
function Assert-Notices([string]$tree) {
    $rows = Read-NoticeManifest $Manifest
    $noticeNames = @($rows | Where-Object { $_.role -eq 'notice' } |
        ForEach-Object { Split-Path $_.file -Leaf })
    $bad = @()
    foreach ($r in $rows) {
        if (-not $r.file) { $bad += "a row names no file" ; continue }
        if (-not $r.component) { $bad += "$($r.file): no component" }
        if (-not $r.source)    { $bad += "$($r.file): no source" }
        if ($r.role -notin @('binary', 'data', 'notice')) {
            $bad += "$($r.file): unknown role '$($r.role)'"
        }
        if ($r.role -ne 'notice') {
            if (-not $r.spdx -or $r.spdx -eq '-') { $bad += "$($r.file): no SPDX expression" }
            if (-not $r.notice -or $r.notice -eq '-') {
                $bad += "$($r.file): names no notice file"
            } elseif ($noticeNames -notcontains $r.notice) {
                $bad += "$($r.file): names notice '$($r.notice)', which no notice row ships"
            }
        }
        if ($r.sha256 -ne '-' -and $r.sha256 -notmatch '^[0-9a-f]{64}$') {
            $bad += "$($r.file): sha256 is neither '-' nor 64 hex characters"
        }
        $path = Join-Path $tree ($r.file -replace '/', '\')
        if (-not (Test-Path -LiteralPath $path)) {
            $bad += "$($r.file): the vendored tree does not carry it"
        } elseif ($r.sha256 -ne '-') {
            $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
            if ($actual -ne $r.sha256) {
                $bad += "$($r.file): sha256 $actual, manifest pins $($r.sha256)"
            }
        }
    }
    if (-not ($rows | Where-Object { $_.role -eq 'binary' })) {
        $bad += "the manifest names no binary"
    }
    if ($bad) { throw "LibreOffice notice gate refused:`n  " + ($bad -join "`n  ") }
    Write-Host "Notice gate: $($rows.Count) manifest rows verified against $tree"
}

function Get-InstallReleaseVersion([string]$root) {
    $soffice = Join-Path $root "program\soffice.exe"
    if (-not (Test-Path -LiteralPath $soffice)) { return $null }
    $productVersion = (Get-Item -LiteralPath $soffice).VersionInfo.ProductVersion
    if ($productVersion -match '^(\d+\.\d+\.\d+)(?:\.\d+)?') {
        return $Matches[1]
    }
    return $null
}

if ($GateOnly) {
    Assert-Notices $DestDir
    exit 0
}

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
    $localVersion = Get-InstallReleaseVersion $r
    if ($localVersion -ne $Version) {
        $shownVersion = if ($localVersion) { $localVersion } else { "unknown" }
        Write-Host "Skipping local LibreOffice $shownVersion at $r; release pin is $Version."
        continue
    }
    if (Copy-Install $r) {
        Assert-Notices $DestDir
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
$extractedVersion = Get-InstallReleaseVersion $root
if ($extractedVersion -ne $Version) {
    Write-Error "Extracted LibreOffice version '$extractedVersion' does not match release pin '$Version'."
    exit 1
}
if (Copy-Install $root) {
    Assert-Notices $DestDir
    Write-Host "Vendored LibreOffice into $DestDir"
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}
Write-Error "Extraction produced no usable LibreOffice tree."
exit 1
