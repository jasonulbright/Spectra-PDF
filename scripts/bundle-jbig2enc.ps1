# Vendors the official upstream jbig2enc binary into resources/jbig2enc/.
#
# The MRC pass writes its 1-bit text stencil as /JBIG2Decode, and
# nothing in the shipped stack can encode JBIG2: qpdf decodes only, Ghostscript
# has no JBIG2 encoder, Pillow has none, and the OCR runtime's libjbig-0.dll is
# JBIG*1* (T.85, for TIFF) which PDF does not accept. A pure-Python encoder is
# not an option either -- the MQ arithmetic coder is inherently sequential over
# ~8.4 million pixel contexts per page, which is minutes per page for a step
# that must be milliseconds.
#
# So the encoder is native, and it is VENDORED and invoked as a subprocess --
# byte-for-byte the Ghostscript pattern. jbig2enc 0.32 publishes official
# prebuilt Windows x64 MSVC release assets, so no compiler enters the packaging
# chain. Apache-2.0; the statically-linked components are enumerated below.
#
# Run before packaging: powershell -ExecutionPolicy Bypass -File scripts\bundle-jbig2enc.ps1

param(
    [string]$Version = "0.32",
    [string]$DestDir = "$PSScriptRoot\..\resources\jbig2enc",
    # Overridable so the notice gate can be exercised against a VARIANT
    # manifest without touching the real one. A gate nobody has seen refuse is
    # a gate nobody has tested.
    [string]$Manifest = (Join-Path $PSScriptRoot "jbig2enc-licenses.tsv"),
    [string]$LicenseSrc = (Join-Path $PSScriptRoot "jbig2enc-licenses")
)

$ErrorActionPreference = "Stop"

# Pinned release-asset checksum -- update deliberately alongside $Version, and
# re-run fetch-jbig2enc-licenses.ps1 when you do (the notices are pinned to the
# component versions frozen inside this exact binary).
$ExpectedSha256 = "64C3D913B84C849148B965531732AF1D7875E0E1448D98F106D7F8AA992C05E0"
$Asset = "jbig2enc-$Version-Windows-X64-MSVC.zip"
$Url = "https://github.com/agl/jbig2enc/releases/download/$Version/$Asset"

# ---------------------------------------------------------------------------
# Manifest reader. Returns component -> @{ version; notice } and, separately,
# the set of notice files every row names.
# ---------------------------------------------------------------------------
function Read-Manifest {
    param([string]$Path)
    $rows = @{}
    Get-Content $Path |
        Where-Object { $_ -and $_ -notmatch '^\s*#' } |
        Select-Object -Skip 1 |
        ForEach-Object {
            $c = $_ -split "`t"
            if ($c.Count -ge 6 -and $c[1]) {
                $rows[$c[1].Trim()] = @{ file = $c[0].Trim(); version = $c[2].Trim(); notice = $c[4].Trim() }
            }
        }
    return $rows
}

# ---------------------------------------------------------------------------
# The notice gate, in two halves, run against a candidate tree.
#
#   (a) every shipped binary resolves to at least one manifest row whose
#       notice file is actually present -- the tesseract-licenses precedent;
#   (b) every project named in UPSTREAM'S OWN depmf.json has a row, at the
#       version depmf reports. Half (b) is the one that cannot rot: the
#       component list is enumerated from the artifact rather than hand-kept,
#       so a pin bump that swaps a dependency stops the build instead of
#       shipping it unnotified.
#
# A function because it runs twice: against an already-vendored tree before
# skipping (so an incomplete tree is repaired, not skipped past) and at the end
# of a fresh vendoring.
# ---------------------------------------------------------------------------
function Get-NoticeProblems {
    param([string]$Root)
    if (-not (Test-Path $Manifest)) { return @("  notice manifest missing: $Manifest") }

    $rows = Read-Manifest $Manifest
    if ($rows.Count -eq 0) { return @("  notice manifest has no rows: $Manifest") }

    $problems = @()
    $licenseDir = Join-Path $Root "licenses"

    $bins = @(Get-ChildItem $Root -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Extension -in @(".dll", ".exe") })
    if ($bins.Count -eq 0) { return @("  no binaries found in $Root") }

    # (a) shipped binaries
    foreach ($bin in $bins) {
        $covering = @($rows.Values | Where-Object { $_.file -eq $bin.Name })
        if ($covering.Count -eq 0) {
            $problems += "  $($bin.Name): shipped but has NO ROW in jbig2enc-licenses.tsv"
        }
    }

    # every row's notice must exist. jbig2enc's own text comes from the zip and
    # ships at the top level; the fetched component texts live in licenses/.
    foreach ($component in $rows.Keys) {
        $notice = $rows[$component].notice
        $path = if ($component -eq "jbig2enc") {
            Join-Path $Root $notice
        } else {
            Join-Path $licenseDir $notice
        }
        if (-not (Test-Path $path)) {
            $problems += "  $component`: manifest names '$notice' but that notice is not present"
        }
    }

    # (b) upstream's dependency manifest
    $depmf = Join-Path $Root "depmf.json"
    if (-not (Test-Path $depmf)) {
        $problems += "  depmf.json missing -- upstream's own component list is what the manifest is checked against"
    } else {
        $dep = Get-Content $depmf -Raw | ConvertFrom-Json
        foreach ($name in $dep.projects.PSObject.Properties.Name) {
            $declared = $dep.projects.$name.version
            if (-not $rows.ContainsKey($name)) {
                $problems += "  $name $declared`: linked into jbig2.exe but has NO ROW in jbig2enc-licenses.tsv"
            } elseif ($rows[$name].version -ne $declared) {
                $problems += "  $name`: manifest says $($rows[$name].version), the shipped binary carries $declared"
            }
        }
    }

    if (-not (Test-Path (Join-Path $Root "PATENTS-jbig2enc.txt"))) {
        # JBIG2 is a patented process and upstream ships a note saying so. It
        # is not a licence, but redistributing the encoder without it drops
        # information the user is entitled to have.
        $problems += "  PATENTS-jbig2enc.txt missing (the release zip supplies it)"
    }
    return $problems
}

# jbig2enc prints --version to STDERR, and `$ErrorActionPreference = "Stop"`
# turns a native command's stderr into a TERMINATING error -- so an unguarded
# `& $exe --version` kills the script on a SUCCESSFUL probe, and redirecting to
# $null throws the answer away instead. `2>&1` merges stderr into the success
# stream, which is both the fix and the only way to read the line at all.
# (Same trap documented in lock-python-deps.ps1.)
function Get-Jbig2Version {
    param([string]$Exe)
    # Function-local assignment: PowerShell scoping restores the caller's
    # "Stop" on return, so this relaxation cannot leak into the gates below.
    # try/catch is NOT enough here -- the error record is raised before the
    # pipeline yields, so the catch swallows the version line with it.
    $ErrorActionPreference = "Continue"
    $out = @(& $Exe --version 2>&1)
    if ($out.Count -eq 0) { return "" }
    return ("" + $out[0]).Trim()
}

$exe = Join-Path $DestDir "jbig2.exe"
if (Test-Path $exe) {
    # Presence is not enough: an interrupted run leaves a correct binary beside
    # an incomplete notice tree, and a presence-only check would skip forever.
    $current = Get-Jbig2Version $exe
    $noticeProblems = @(Get-NoticeProblems -Root $DestDir)
    if ($current -eq "jbig2enc $Version" -and $noticeProblems.Count -eq 0) {
        Write-Host "jbig2enc $Version already vendored at $DestDir (notices complete)"
        return
    }
    Write-Host "Re-vendoring: existing tree is incomplete (version='$current' notices=$($noticeProblems.Count -eq 0))"
    $noticeProblems | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
}

if (-not (Test-Path $LicenseSrc)) {
    Write-Error "Licence store missing: $LicenseSrc -- run fetch-jbig2enc-licenses.ps1 and commit the result."
    exit 1
}

$Work = Join-Path $env:TEMP "jbig2enc-vendor-$Version"
$Zip = Join-Path $Work $Asset
$Extracted = Join-Path $Work "extracted"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null

Write-Host "Vendoring jbig2enc $Version (upstream prebuilt, Apache-2.0)..."
Write-Host "Downloading $Url..."
try {
    Invoke-WebRequest -Uri $Url -OutFile $Zip -MaximumRedirection 5
} catch {
    Write-Error "Download failed: $($_.Exception.Message)"
    exit 1
}

$actual = (Get-FileHash $Zip -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256) {
    Write-Error "Checksum mismatch for $Asset.`n  expected: $ExpectedSha256`n  actual:   $actual"
    exit 1
}
Write-Host "Checksum verified ($ExpectedSha256)."

# A plain zip -- no NSIS, so no 7-Zip dependency (unlike Ghostscript/Tesseract).
Expand-Archive -Path $Zip -DestinationPath $Extracted -Force

if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
New-Item -ItemType Directory -Force $DestDir | Out-Null

# The zip also carries include/ and lib/ (static libraries and headers for
# BUILDING against jbig2enc) and bin/jbig2topdf.py, a helper that wraps output
# into a PDF. None of that ships: the engine drives the executable directly and
# does its own PDF surgery, and 90 MB of .a archives are not a runtime.
$exeSrc = Join-Path $Extracted "bin\jbig2.exe"
if (-not (Test-Path $exeSrc)) {
    Write-Error "bin\jbig2.exe not found in the release asset -- the layout changed."
    exit 1
}
Copy-Item $exeSrc -Destination $DestDir -Force
Write-Host "  Copied jbig2.exe"

# Keep the directory tracked even when binaries are gitignored. Written here
# rather than at the end so an interrupted run still leaves the tree shaped
# the way the other vendoring scripts leave theirs.
New-Item -ItemType File -Force (Join-Path $DestDir ".gitkeep") | Out-Null

# Upstream's own notices, straight from the pinned zip.
Copy-Item (Join-Path $Extracted "COPYING") -Destination (Join-Path $DestDir "LICENSE-jbig2enc.txt") -Force
Copy-Item (Join-Path $Extracted "share\doc\jbig2enc\PATENTS") -Destination (Join-Path $DestDir "PATENTS-jbig2enc.txt") -Force
# depmf.json is upstream's dependency manifest. It SHIPS (provenance for the
# statically-linked set) and it is what the notice gate checks the manifest
# against, so it must land before Get-NoticeProblems runs.
Copy-Item (Join-Path $Extracted "depmf.json") -Destination $DestDir -Force
Write-Host "  Copied LICENSE-jbig2enc.txt, PATENTS-jbig2enc.txt, depmf.json"

$LicenseDir = Join-Path $DestDir "licenses"
New-Item -ItemType Directory -Force $LicenseDir | Out-Null
Copy-Item (Join-Path $LicenseSrc "*.txt") -Destination $LicenseDir -Force
$copied = @(Get-ChildItem $LicenseDir -Filter *.txt -File).Count
Write-Host "  Copied $copied component licence texts (offline, from the checked-in store)"

# Run the thing before declaring it vendored: a static build that will not
# start is the failure this catches, and --version also prints the component
# versions the manifest is pinned to.
$reported = Get-Jbig2Version $exe
if ($reported -ne "jbig2enc $Version") {
    Write-Error "The vendored binary reports '$reported', expected 'jbig2enc $Version'."
    exit 1
}
Write-Host "  Smoke: $reported"

$problems = @(Get-NoticeProblems -Root $DestDir)
if ($problems) {
    Write-Error ("Redistribution-notice gate FAILED -- refusing to ship:`n" +
                 ($problems -join "`n") +
                 "`n`nAdd the component to scripts/jbig2enc-licenses.tsv (and a source URL to" +
                 "`nfetch-jbig2enc-licenses.ps1) before shipping this build.")
    exit 1
}
Write-Host "  Notice gate: every shipped binary and every statically-linked component resolves to a present notice."

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Vendored jbig2enc ${Version}: ${sizeMB}MB"
