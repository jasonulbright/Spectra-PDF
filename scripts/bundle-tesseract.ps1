# Vendors native Tesseract OCR into resources/tesseract/.
#
# Phase 12 step 3. Upstream ships no Windows binary and points Windows users at
# the UB Mannheim build, so that is the source: downloaded, verified against a
# pinned SHA-256, and extracted from the NSIS installer with 7-Zip WITHOUT
# running it -- byte-for-byte the technique bundle-ghostscript.ps1 already uses.
#
# Tesseract is Apache-2.0 and Leptonica (its imaging dependency) is BSD-2-Clause;
# both are friendlier than the AGPL Ghostscript already shipping here. Open PDF
# Studio invokes tesseract.exe as a separate process, unmodified upstream (see
# THIRD-PARTY-LICENSES.md).
#
# The LANGUAGE MODELS are NOT staged here -- scripts/sync-ocr-assets.mjs owns
# them, because the offered-language list is parsed out of the app's own
# languages.ts and must stay a single source of truth.
#
# Run before packaging: powershell -ExecutionPolicy Bypass -File scripts\bundle-tesseract.ps1

param(
    [string]$TessVersion = "5.4.0.20240606",
    [string]$DestDir = "$PSScriptRoot\..\resources\tesseract"
)

# Pinned installer checksum -- update deliberately alongside $TessVersion.
# Verified against the served 50,175,248-byte installer.
$ExpectedSha256 = "C885FFF6998E0608BA4BB8AB51436E1C6775C2BAFC2559A19B423E18678B60C9"

$Url = "https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-$TessVersion.exe"

Write-Host "Vendoring Tesseract $TessVersion (UB Mannheim build, Apache-2.0)..."

# Skip only if this exact version is vendored AND the tree is actually usable.
# Checking the exe alone is not enough: a run interrupted (or a script bug)
# leaves a correct-versioned tesseract.exe beside an incomplete tessdata, and a
# presence-only check would then skip forever and never repair it. Verify the
# pieces recognition genuinely needs -- the TSV config and at least one model.
# ---------------------------------------------------------------------------
# The notice gate. A function because it runs on both paths: at the end of a
# fresh vendoring, and against an already-vendored tree before skipping, so an
# incomplete tree is repaired rather than skipped past. Returns a list of
# problems; callers decide whether that means "re-vendor" or "fail the build".
# ---------------------------------------------------------------------------
function Get-NoticeProblems {
    param([string]$Root)
    $manifest = Join-Path $PSScriptRoot "tesseract-licenses.tsv"
    if (-not (Test-Path $manifest)) { return @("  notice manifest missing: $manifest") }

    $rows = @{}
    Get-Content $manifest |
        Where-Object { $_ -and $_ -notmatch '^\s*#' } |
        Select-Object -Skip 1 |
        ForEach-Object {
            $c = $_ -split "`t"
            if ($c.Count -ge 4 -and $c[0]) { $rows[$c[0].Trim()] = $c[3].Trim() }
        }

    $licenseDir = Join-Path $Root "licenses"
    $problems = @()
    $bins = @(Get-ChildItem $Root -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Extension -in @(".dll", ".exe") })
    if ($bins.Count -eq 0) { return @("  no binaries found in $Root") }

    foreach ($bin in $bins) {
        if (-not $rows.ContainsKey($bin.Name)) {
            $problems += "  $($bin.Name): shipped but has NO ROW in tesseract-licenses.tsv"
            continue
        }
        $notice = $rows[$bin.Name]
        $noticePath = if ($notice -eq "LICENSE-Tesseract.txt") {
            Join-Path $Root $notice
        } else {
            Join-Path $licenseDir $notice
        }
        if (-not (Test-Path $noticePath)) {
            $problems += "  $($bin.Name): manifest names '$notice' but that notice is not present"
        }
    }
    if (-not (Test-Path (Join-Path $Root "AUTHORS-Tesseract.txt"))) {
        $problems += "  AUTHORS-Tesseract.txt missing (the installer supplies it)"
    }
    return $problems
}

$tessExe = Join-Path $DestDir "tesseract.exe"
if (Test-Path $tessExe) {
    $current = (& $tessExe --version 2>$null | Select-Object -First 1)
    $hasTsv = Test-Path (Join-Path $DestDir "tessdata\configs\tsv")
    $hasModel = @(Get-ChildItem (Join-Path $DestDir "tessdata\*.traineddata") -File -ErrorAction SilentlyContinue).Count -gt 0
    # Notices are a piece the tree needs, like tsv and the models. Run the full
    # gate rather than a presence check: a missing individual notice must
    # trigger a re-vendor, not a silent skip past the gate below.
    $noticeProblems = @(Get-NoticeProblems -Root $DestDir)
    $hasNotices = $noticeProblems.Count -eq 0
    if ($current -eq "tesseract v$TessVersion" -and $hasTsv -and $hasModel -and $hasNotices) {
        Write-Host "Tesseract $TessVersion already vendored at $DestDir (notices complete)"
        return
    }
    Write-Host "Re-vendoring: existing tree is incomplete (tsv=$hasTsv models=$hasModel notices=$hasNotices)"
    if (-not $hasNotices) {
        $noticeProblems | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
    }
}

# Locate 7-Zip (preinstalled on GitHub windows-latest runners).
$SevenZip = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $SevenZip) {
    $SevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source
}
if (-not $SevenZip) {
    Write-Error "7-Zip not found. Install it (e.g. 'choco install 7zip') and retry."
    exit 1
}

$Work = Join-Path $env:TEMP "tesseract-vendor-$TessVersion"
$Installer = Join-Path $Work "installer.exe"
$Extracted = Join-Path $Work "extracted"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null

Write-Host "Downloading $Url..."
# A User-Agent is REQUIRED: this host answers PowerShell's default UA with
# 403 Forbidden while the same URL serves successfully to curl. Do
# not "simplify" this away; the failure is a Forbidden that reads like the file
# having moved.
try {
    Invoke-WebRequest -Uri $Url -OutFile $Installer -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -MaximumRedirection 5
} catch {
    Write-Error "Download failed: $($_.Exception.Message)"
    exit 1
}
if (-not (Test-Path $Installer)) {
    Write-Error "Download produced no file at $Installer"
    exit 1
}

$actual = (Get-FileHash $Installer -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256) {
    Write-Error "Checksum mismatch for the Tesseract installer.`n  expected: $ExpectedSha256`n  actual:   $actual"
    exit 1
}
Write-Host "Checksum verified ($ExpectedSha256)."

& $SevenZip x $Installer "-o$Extracted" -y | Out-Null

# Rebuild the destination, but PRESERVE tessdata: the language models are
# staged there by sync-ocr-assets.mjs and re-vendoring the binary must not
# silently throw away 99MB of models the build then can't find.
$TessData = Join-Path $DestDir "tessdata"
$StashedData = $null
if (Test-Path $TessData) {
    $StashedData = Join-Path $Work "tessdata-stash"
    Move-Item $TessData $StashedData
    Write-Host "  Preserved existing tessdata/"
}
if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
New-Item -ItemType Directory -Force $DestDir | Out-Null

# tesseract.exe plus every DLL beside it. The DLL set is the installer's own
# (leptonica, libtiff, libpng, ICU, ...) and is enumerated rather than listed by
# name on purpose: a hand-written list silently rots when the upstream build
# changes its dependencies, and the failure mode is a binary that will not start.
$exeSrc = Join-Path $Extracted "tesseract.exe"
if (-not (Test-Path $exeSrc)) {
    Write-Error "tesseract.exe not found in the installer -- the layout changed."
    exit 1
}
Copy-Item $exeSrc -Destination $DestDir -Force
Write-Host "  Copied tesseract.exe"

$dlls = Get-ChildItem (Join-Path $Extracted "*.dll") -File
if ($dlls.Count -lt 10) {
    Write-Error "Only $($dlls.Count) DLLs found beside tesseract.exe -- the layout changed; refusing to ship a binary that will not start."
    exit 1
}
foreach ($dll in $dlls) { Copy-Item $dll.FullName -Destination $DestDir -Force }
Write-Host "  Copied $($dlls.Count) DLLs"

# tessdata: restore what was staged, else seed with the installer's own eng/osd
# so a freshly vendored tree is usable before sync-ocr-assets.mjs runs. `osd`
# (orientation & script detection) has no npm package and ONLY comes from here.
New-Item -ItemType Directory -Force $TessData | Out-Null
$installerData = Join-Path $Extracted "tessdata"

# configs/ and tessconfigs/ are NOT optional extras: they define the OUTPUT
# MODES, and `tsv` -- the one the engine parses word boxes out of -- is a file
# in configs/. Without them tesseract still recognises and still exits 0, but
# prints plain text and logs "read_params_file: Can't open tsv", so the parser
# gets no boxes. Caught by running the VENDORED tree rather than the extraction.
foreach ($support in @("configs", "tessconfigs")) {
    $src = Join-Path $installerData $support
    if (Test-Path $src) {
        Copy-Item $src -Destination (Join-Path $TessData $support) -Recurse -Force
        Write-Host "  Copied tessdata/$support/"
    }
}
$tsvConfig = Join-Path $TessData "configs\tsv"
if (-not (Test-Path $tsvConfig)) {
    Write-Error "tessdata/configs/tsv missing -- TSV output is how word boxes are read; refusing to ship an OCR engine that cannot produce them."
    exit 1
}

foreach ($seed in @("osd.traineddata", "eng.traineddata")) {
    $src = Join-Path $installerData $seed
    if (Test-Path $src) {
        Copy-Item $src -Destination $TessData -Force
        Write-Host "  Copied $seed (from the installer)"
    }
}
if ($StashedData) {
    Get-ChildItem $StashedData -Filter *.traineddata -File | ForEach-Object {
        Copy-Item $_.FullName -Destination $TessData -Force
    }
    Write-Host "  Restored staged language models"
}

# Ship Tesseract's own licence text alongside the binary for redistribution.
foreach ($cand in @("LICENSE", "doc\LICENSE", "LICENSE.txt")) {
    $license = Join-Path $Extracted $cand
    if (Test-Path $license) {
        Copy-Item $license -Destination (Join-Path $DestDir "LICENSE-Tesseract.txt") -Force
        Write-Host "  Copied LICENSE-Tesseract.txt"
        break
    }
}
# AUTHORS is the other notice the installer supplies; the loop above breaks on
# the first LICENSE hit and would not reach it. These two are the complete set
# upstream provides for the 52 binaries we redistribute; the rest come from the
# checked-in store.
foreach ($cand in @("AUTHORS", "doc\AUTHORS")) {
    $authors = Join-Path $Extracted $cand
    if (Test-Path $authors) {
        Copy-Item $authors -Destination (Join-Path $DestDir "AUTHORS-Tesseract.txt") -Force
        Write-Host "  Copied AUTHORS-Tesseract.txt"
        break
    }
}

# ---------------------------------------------------------------------------
# Redistribution notices for the ~50 third-party DLLs shipped beside
# tesseract.exe. Upstream supplies NOTHING for these (verified by sweeping the
# extracted installer), so they are fetched from their canonical upstreams and
# pinned by SHA-256.
# ---------------------------------------------------------------------------
$LicenseDir = Join-Path $DestDir "licenses"
$LicenseSrc = Join-Path $PSScriptRoot "tesseract-licenses"
# COPY from the checked-in store; do NOT fetch. The Tesseract build is
# SHA-256-pinned, so the licences that apply are the ones for the library
# versions frozen inside that binary -- they cannot change, because the binary
# cannot change. Re-downloading on every build was worse than unnecessary:
# upstream HEAD can carry the licence for a DIFFERENT version than the one we
# redistribute, so a refresh could replace a correct notice with an
# inapplicable one, and it made every build depend on ~38 external hosts.
# fetch-tesseract-licenses.ps1 is the maintenance tool, run only when the pin
# moves; its output is reviewed and committed.
if (-not (Test-Path $LicenseSrc)) {
    Write-Error "Licence store missing: $LicenseSrc -- run fetch-tesseract-licenses.ps1 and commit the result."
    exit 1
}
New-Item -ItemType Directory -Force $LicenseDir | Out-Null
Copy-Item (Join-Path $LicenseSrc "*.txt") -Destination $LicenseDir -Force
$copied = @(Get-ChildItem $LicenseDir -Filter *.txt -File).Count
Write-Host "  Copied $copied third-party licence texts (offline, from the checked-in store)"

# ---------------------------------------------------------------------------
# The gate. Every shipped binary must resolve to a manifest row and a notice
# file that exists -- the same refusal shape as the configs/tsv and <10-DLLs
# checks above. The copy set is enumerated rather than hand-listed, so an
# upstream build that adds a DLL lands it in the shipped tree automatically;
# without this, it would ship unnotified.
# ---------------------------------------------------------------------------
$shipped = @(Get-ChildItem $DestDir -File | Where-Object { $_.Extension -in @(".dll", ".exe") })
$problems = @(Get-NoticeProblems -Root $DestDir)
if ($problems) {
    Write-Error ("Redistribution-notice gate FAILED -- refusing to ship:`n" +
                 ($problems -join "`n") +
                 "`n`nAdd the component to scripts/tesseract-licenses.tsv (and a source URL to" +
                 "`nfetch-tesseract-licenses.ps1) before shipping this build.")
    exit 1
}
Write-Host "  Notice gate: all $($shipped.Count) shipped binaries resolve to a present notice."

# Keep the directory tracked even when binaries are gitignored.
New-Item -ItemType File -Force (Join-Path $DestDir ".gitkeep") | Out-Null

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Vendored Tesseract ${TessVersion}: ${sizeMB}MB"
