# Vendors native Tesseract OCR into resources/tesseract/.
#
# Upstream ships no Windows binary and points Windows users at
# the UB Mannheim build, so that is the source: downloaded, verified against a
# pinned SHA-256, and extracted from the NSIS installer with 7-Zip WITHOUT
# running it.
#
# Tesseract is Apache-2.0 and Leptonica (its imaging dependency) is BSD-2-Clause.
# tesseract.exe is invoked as a separate process, unmodified upstream (see
# THIRD-PARTY-LICENSES.md).
#
# ONE binary of that installer is not shipped as it came: its libtiff-6.dll
# statically imports libjbig-0.dll (JBIG-KIT, GPL-2.0-or-later), which the
# license-class gate refuses as object code. The replacement is built by
# scripts/build-libtiff-nojbig.ps1 -- the same libtiff version from the same
# recipe with JBIG disabled -- and is installed over the installer's copy here,
# after which libjbig-0.dll is dropped. Nothing in the product can reach JBIG:
# both Tesseract spawn sites receive a PNG this program rendered.
#
# libgif-7.dll is replaced the same way, by an export stub built by
# scripts/build-giflib-stub.ps1: libleptonica-6.dll imports eleven giflib
# symbols, so the DLL must load, and every stub entry point returns giflib's
# documented failure value. No GIF is decoded or encoded on any OCR path, for
# the same PNG-only reason.
#
# The LANGUAGE MODELS are NOT staged here -- scripts/sync-ocr-assets.mjs owns
# them, because the offered-language list is parsed out of the app's own
# languages.ts and must stay a single source of truth.
#
# Run before packaging: powershell -ExecutionPolicy Bypass -File scripts\bundle-tesseract.ps1

param(
    [string]$TessVersion = "5.4.0.20240606",
    [string]$DestDir = "$PSScriptRoot\..\resources\tesseract",
    [switch]$DownloadOnly
)

# Pinned installer checksum -- update deliberately alongside $TessVersion.
# Verified against the served 50,175,248-byte installer.
# The mirrored bytes were fetched from the upstream origin
# https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-$TessVersion.exe
$ExpectedSha256 = "C885FFF6998E0608BA4BB8AB51436E1C6775C2BAFC2559A19B423E18678B60C9"

# The checked-in JBIG-free libtiff, and the hash it must have. Update both
# deliberately, from what build-libtiff-nojbig.ps1 prints.
$LibTiffSrc = Join-Path $PSScriptRoot "tesseract-libtiff\libtiff-6.dll"
. (Join-Path $PSScriptRoot "download-retry.ps1")
$ExpectedLibTiffSha256 = "5FA8372AA46CE25CEA6035C1201F00D55A9C9E2A49FD69AE202A403D6D1F4010"

# The checked-in giflib export stub, and the hash it must have. Update both
# deliberately, from what build-giflib-stub.ps1 prints.
$GifStubSrc = Join-Path $PSScriptRoot "tesseract-giflib-stub\libgif-7.dll"
$ExpectedGifStubSha256 = "24207DD19034DC7C53673355240536E4D51E4CD28F4ECC9D4BAFCE9AB810FC2A"

# ---------------------------------------------------------------------------
# The library overlay. tesseract.exe stays the pinned 5.4.0 build; the
# libraries it loads are replaced with released MSYS2 packages that close
# published advisories against the installer's 2024 copies. Each package is
# pinned by the SHA-256 that MSYS2's mingw64.db publishes (%SHA256SUM%), and
# each extracted DLL by its own SHA-256, so a re-vendor reproduces the same
# bytes. Same DLL names, same msvcrt CRT; every imported symbol resolves
# against the runtime DLLs already in the tree (checked when the table
# changes). libtiff is not here: it is the checked-in JBIG-free rebuild above.
# ---------------------------------------------------------------------------
$Msys2Repo = "https://repo.msys2.org/mingw/mingw64"
$Overlay = @(
    @{ Dll = "libarchive-13.dll"; Pkg = "mingw-w64-x86_64-libarchive-3.8.9-6-any.pkg.tar.zst"; PkgSha = "591e1e7fb90adc7503bf0edb59e1f6c98d9ffce76b9568a554ccdfe1ed0e4380"; DllSha = "e4fcffb9e10cac802d01831b5a978b6dc662d576fa03351efdfc72ba8c99d6e4" }
    @{ Dll = "libexpat-1.dll";    Pkg = "mingw-w64-x86_64-expat-2.8.5-1-any.pkg.tar.zst";      PkgSha = "254d05d2e89acbbb998636dd478fc1d640ce3ec4e63326f17398958d2b68dfeb"; DllSha = "a79b7025c3fdccb6fe38fb560f3b6cfa75c26750052cf6de307816fb7c22faa0" }
    @{ Dll = "libpng16-16.dll";   Pkg = "mingw-w64-x86_64-libpng-1.6.58-1-any.pkg.tar.zst";     PkgSha = "d8ae6066f99b3a04b83b8013b554a26a205d7e68580b80823c173ed045ba76a5"; DllSha = "3737838ee8d6b893df7bdabf7439775371a57dce7e17ee6b35586023c64bd9ab" }
    @{ Dll = "libopenjp2-7.dll";  Pkg = "mingw-w64-x86_64-openjpeg2-2.5.4-2-any.pkg.tar.zst";   PkgSha = "32f8f5dc7df9f1f2d57157717136fbba431e15bc000420c953c00ffdf76ecde4"; DllSha = "123587086cb1a25d2a338fb9b7c1d6bda10bf9062625b4f08c6a92b3d9cafe47" }
    @{ Dll = "zlib1.dll";         Pkg = "mingw-w64-x86_64-zlib-1.3.2-2-any.pkg.tar.zst";         PkgSha = "9e75842a070ba648e986e12424e1c92c9d7d77200e85f6a34eeb600819f2e694"; DllSha = "93e9243a44c29200eeacaf9658efe2558581770e4b11ca4b500e18e424a6e3b5" }
    @{ Dll = "liblzma-5.dll";     Pkg = "mingw-w64-x86_64-xz-5.8.4-1-any.pkg.tar.zst";           PkgSha = "2de0f26da60b7ff7aa192a226330d7de6b1099cb9b9f9de4145affb80146bbc8"; DllSha = "ccb6a179acf35e704b2ffd7f232677982c4856bd1dda1341713a27518cf97ce1" }
    @{ Dll = "libzstd.dll";       Pkg = "mingw-w64-x86_64-zstd-1.5.7-2-any.pkg.tar.zst";         PkgSha = "1add6705b344664f6aca108c85f79ab5bdd9e1162662bb06a4cf40a34f6e0907"; DllSha = "b95c223a9548a9ecf51377c962e0bc8f0c51eb0c6f67a296dbc885996f0dd40d" }
    @{ Dll = "liblz4.dll";        Pkg = "mingw-w64-x86_64-lz4-1.10.0-1-any.pkg.tar.zst";         PkgSha = "a4c5a3bcd26111554c87591275b8a681bfa4473d1607647e24c22ef6213c055c"; DllSha = "35f917274bca8f19677ba66f1b3cc3c83568c3249fc43215fc16e76439c8e856" }
    @{ Dll = "libbz2-1.dll";      Pkg = "mingw-w64-x86_64-bzip2-1.0.8-4-any.pkg.tar.zst";        PkgSha = "123768f30ae14ba654a6feb70f8526146a331bc85f831a91a549ffb3f6cbffc7"; DllSha = "a4fbb97c26662d2b8a80bf4597ed3effb69b12048b0cb1eef2c3f211e2e66673" }
    @{ Dll = "libb2-1.dll";       Pkg = "mingw-w64-x86_64-libb2-0.98.1-3-any.pkg.tar.zst";       PkgSha = "3c898f08c5f19e25dc6d7e39aa36b6f323141f0e62c5c50f089cd3f89711854c"; DllSha = "77bab532b5421d6cdddb96c3ae9a4bde144eb481ccaf243336c9f8c690a50987" }
    @{ Dll = "libiconv-2.dll";    Pkg = "mingw-w64-x86_64-libiconv-1.19-1-any.pkg.tar.zst";      PkgSha = "21e334d0911f25de75d3e18e0697648bcecfa9658256d600cad0827d719c2f35"; DllSha = "7a282a854e01be726c6cccfe46f548c716aa45b3014818468253aaa4efbcd067" }
)

# Ordered installer sources, tried in turn. The project-hosted mirror carries the
# same bytes as the upstream build and is the only source: the upstream host is
# geo-blocked for GitHub-hosted runners, so it cannot serve a workflow. The list
# shape stays so a second mirror can be added. Whichever source answers, the
# SHA-256 pin above decides the bytes.
$InstallerSources = @(
    "https://github.com/jasonulbright/Spectra-PDF/releases/download/vendor-cache/tesseract-ocr-w64-setup-$TessVersion.exe"
)

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

# ---------------------------------------------------------------------------
# The JBIG gate. Same shape and the same both-paths rule as the notice gate: a
# tree that already carries the GPL DLL is re-vendored rather than skipped past.
# The check is a byte scan for the import name over every shipped binary, not a
# presence check on the file: an import survives deleting the DLL and turns into
# a process that will not start, so what must be proven absent is the reference.
# ---------------------------------------------------------------------------
function Get-JbigProblems {
    param([string]$Root)
    $problems = @()
    if (Test-Path (Join-Path $Root "libjbig-0.dll")) {
        $problems += "  libjbig-0.dll is present (JBIG-KIT, GPL-2.0-or-later)"
    }
    foreach ($bin in @(Get-ChildItem $Root -File -ErrorAction SilentlyContinue |
                       Where-Object { $_.Extension -in @(".dll", ".exe") })) {
        $bytes = [System.IO.File]::ReadAllBytes($bin.FullName)
        if ([System.Text.Encoding]::ASCII.GetString($bytes).Contains("libjbig")) {
            $problems += "  $($bin.Name): references libjbig"
        }
    }
    return $problems
}

# ---------------------------------------------------------------------------
# The load gate. The installer carries the training tools' dependencies (GLib,
# Pango, Cairo, ICU, HarfBuzz, ...) beside tesseract.exe; the recognizer never
# loads them. Only the import closure of tesseract.exe ships: a DLL outside it
# is a scanner-visible version with no caller. Same both-paths rule as the
# gates above. Runs scripts/pe_imports.py under the embedded runtime, which
# setup-python-embed.ps1 provisions before this script.
# ---------------------------------------------------------------------------
$EmbeddedPython = Join-Path $PSScriptRoot "..\resources\python\python.exe"
function Get-UnreachedDlls {
    param([string]$Root)
    if (-not (Test-Path $EmbeddedPython)) {
        throw "Embedded runtime missing at $EmbeddedPython -- run setup-python-embed.ps1 first."
    }
    $json = & $EmbeddedPython (Join-Path $PSScriptRoot "pe_imports.py") --unreached $Root "tesseract.exe"
    if ($LASTEXITCODE -ne 0) { throw "import closure of $Root failed" }
    # Windows PowerShell emits a JSON array as ONE object; the ForEach unrolls it.
    return @((($json | Out-String) | ConvertFrom-Json) | ForEach-Object { $_ })
}

$tessExe = Join-Path $DestDir "tesseract.exe"
if ((-not $DownloadOnly) -and (Test-Path $tessExe)) {
    $current = (& $tessExe --version 2>$null | Select-Object -First 1)
    $hasTsv = Test-Path (Join-Path $DestDir "tessdata\configs\tsv")
    $hasModel = @(Get-ChildItem (Join-Path $DestDir "tessdata\*.traineddata") -File -ErrorAction SilentlyContinue).Count -gt 0
    # Notices are a piece the tree needs, like tsv and the models. Run the full
    # gate rather than a presence check: a missing individual notice must
    # trigger a re-vendor, not a silent skip past the gate below.
    $noticeProblems = @(Get-NoticeProblems -Root $DestDir)
    $hasNotices = $noticeProblems.Count -eq 0
    $jbigProblems = @(Get-JbigProblems -Root $DestDir)
    $noJbig = $jbigProblems.Count -eq 0
    $unreachedDlls = @(Get-UnreachedDlls -Root $DestDir)
    $closed = $unreachedDlls.Count -eq 0
    $stale = @($Overlay | Where-Object {
        $f = Join-Path $DestDir $_.Dll
        -not (Test-Path $f) -or (Get-FileHash $f -Algorithm SHA256).Hash.ToLowerInvariant() -ne $_.DllSha
    })
    $tiff = Join-Path $DestDir "libtiff-6.dll"
    $gif = Join-Path $DestDir "libgif-7.dll"
    $overlaid = ($stale.Count -eq 0) -and (Test-Path $tiff) -and
        ((Get-FileHash $tiff -Algorithm SHA256).Hash -eq $ExpectedLibTiffSha256) -and
        (Test-Path $gif) -and ((Get-FileHash $gif -Algorithm SHA256).Hash -eq $ExpectedGifStubSha256)
    if ($current -eq "tesseract v$TessVersion" -and $hasTsv -and $hasModel -and $hasNotices -and $noJbig -and $closed -and $overlaid) {
        Write-Host "Tesseract $TessVersion already vendored at $DestDir (notices complete, JBIG-free)"
        return
    }
    Write-Host "Re-vendoring: existing tree is incomplete (tsv=$hasTsv models=$hasModel notices=$hasNotices nojbig=$noJbig closed=$closed overlaid=$overlaid)"
    if (-not $hasNotices) {
        $noticeProblems | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
    }
    if (-not $noJbig) {
        $jbigProblems | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
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
if (-not $SevenZip -and -not $DownloadOnly) {
    Write-Error "7-Zip not found. Install it (e.g. 'choco install 7zip') and retry."
    exit 1
}

$Work = Join-Path $env:TEMP "tesseract-vendor-$TessVersion"
$Installer = Join-Path $Work "installer.exe"
$Extracted = Join-Path $Work "extracted"
# A run that failed after stashing tessdata left the staged models in $Work;
# clearing $Work first would delete them.
$OrphanStash = Join-Path $Work "tessdata-stash"
if ((Test-Path $OrphanStash) -and -not (Test-Path (Join-Path $DestDir "tessdata"))) {
    New-Item -ItemType Directory -Force $DestDir | Out-Null
    Move-Item $OrphanStash (Join-Path $DestDir "tessdata")
    Write-Host "  Restored tessdata/ stashed by an interrupted run"
}
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null

# A local installer supplied by the environment replaces the download entirely.
# It is hash-checked below like any downloaded copy -- the override selects the
# source, never the acceptance criterion.
$Override = $env:SPECTRAPDF_TESSERACT_INSTALLER
if ($Override -and (Test-Path $Override)) {
    Copy-Item $Override -Destination $Installer -Force
    Write-Host "Using local installer from SPECTRAPDF_TESSERACT_INSTALLER: $Override"
} else {
    # A User-Agent is REQUIRED: some hosts answer PowerShell's default UA with
    # 403 Forbidden while the same URL serves successfully to curl. Do not
    # "simplify" this away; the failure is a Forbidden that reads like the file
    # having moved.
    $downloaded = $false
    foreach ($src in $InstallerSources) {
        Write-Host "Downloading $src..."
        try {
            Invoke-DownloadWithRetry -Description $src -OutFile $Installer -Download {
                Invoke-WebRequest -Uri $src -OutFile $Installer `
                    -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -MaximumRedirection 5 `
                    -TimeoutSec $DownloadRetryTimeoutSeconds
            }
        } catch {
            Write-Host "  Source failed: $src -- $($_.Exception.Message)"
            Remove-Item $Installer -Force -ErrorAction SilentlyContinue
            continue
        }
        if (-not (Test-Path $Installer)) {
            Write-Host "  Source produced no file: $src"
            continue
        }
        $downloaded = $true
        break
    }
    if (-not $downloaded) {
        Write-Error ("Download failed from every source:`n" +
                     (($InstallerSources | ForEach-Object { "  $_" }) -join "`n"))
        exit 1
    }
}

$actual = (Get-FileHash $Installer -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256) {
    Write-Error "Checksum mismatch for the Tesseract installer.`n  expected: $ExpectedSha256`n  actual:   $actual"
    exit 1
}
Write-Host "Checksum verified ($ExpectedSha256)."

if ($DownloadOnly) {
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

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

# The JBIG swap. Order matters: the installer's libtiff-6.dll is overwritten
# first, so the tree is never left with a libtiff that imports a DLL that is
# already gone. Both steps refuse rather than warn -- a tree that keeps the GPL
# binary and a tree whose Tesseract cannot start are both unshippable.
if (-not (Test-Path $LibTiffSrc)) {
    Write-Error ("JBIG-free libtiff missing: $LibTiffSrc`n" +
                 "Run scripts\build-libtiff-nojbig.ps1 and commit the result.")
    exit 1
}
$libTiffSha = (Get-FileHash $LibTiffSrc -Algorithm SHA256).Hash
if ($libTiffSha -ne $ExpectedLibTiffSha256) {
    Write-Error ("Checksum mismatch for the checked-in libtiff-6.dll.`n" +
                 "  expected: $ExpectedLibTiffSha256`n  actual:   $libTiffSha")
    exit 1
}
Copy-Item $LibTiffSrc -Destination (Join-Path $DestDir "libtiff-6.dll") -Force
Write-Host "  Installed the JBIG-free libtiff-6.dll ($ExpectedLibTiffSha256)"
Remove-Item (Join-Path $DestDir "libjbig-0.dll") -Force -ErrorAction SilentlyContinue
$PkgCache = Join-Path $env:TEMP "spectrapdf-msys2-packages"
New-Item -ItemType Directory -Force $PkgCache | Out-Null
foreach ($o in $Overlay) {
    $archive = Join-Path $PkgCache $o.Pkg
    $cached = (Test-Path $archive) -and ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $o.PkgSha)
    if (-not $cached) {
        $url = "$Msys2Repo/$($o.Pkg)"
        Invoke-DownloadWithRetry -Description $url -OutFile $archive -Download {
            Invoke-WebRequest -Uri $url -OutFile $archive -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" `
                -TimeoutSec $DownloadRetryTimeoutSeconds
        }
    }
    $target = Join-Path $DestDir $o.Dll
    & $EmbeddedPython (Join-Path $PSScriptRoot "msys2_package.py") $archive $o.PkgSha "mingw64/bin/$($o.Dll)" $target
    if ($LASTEXITCODE -ne 0) { Write-Error "Overlay of $($o.Dll) from $($o.Pkg) failed."; exit 1 }
    $got = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $o.DllSha) { Write-Error "$($o.Dll) from $($o.Pkg) has SHA-256 $got; pinned $($o.DllSha)"; exit 1 }
}
Write-Host "  Overlaid $($Overlay.Count) libraries from pinned MSYS2 packages"
if (-not (Test-Path $GifStubSrc)) {
    Write-Error ("giflib stub missing: $GifStubSrc`n" +
                 "Run scripts\build-giflib-stub.ps1 and commit the result.")
    exit 1
}
$gifStubSha = (Get-FileHash $GifStubSrc -Algorithm SHA256).Hash
if ($gifStubSha -ne $ExpectedGifStubSha256) {
    Write-Error ("Checksum mismatch for the checked-in libgif-7.dll stub.`n" +
                 "  expected: $ExpectedGifStubSha256`n  actual:   $gifStubSha")
    exit 1
}
Copy-Item $GifStubSrc -Destination (Join-Path $DestDir "libgif-7.dll") -Force
Write-Host "  Installed the giflib export stub libgif-7.dll ($ExpectedGifStubSha256)"
& (Join-Path $DestDir "tesseract.exe") --version *> $null
if ($LASTEXITCODE -ne 0) { Write-Error "tesseract.exe does not start with the overlaid libraries."; exit 1 }

$dropped = @(Get-UnreachedDlls -Root $DestDir)
foreach ($name in $dropped) { Remove-Item (Join-Path $DestDir $name) -Force }
Write-Host "  Dropped $($dropped.Count) DLLs outside the import closure of tesseract.exe"
if (@(Get-UnreachedDlls -Root $DestDir).Count -ne 0) {
    Write-Error "Load gate FAILED -- a DLL outside the import closure of tesseract.exe survived."
    exit 1
}
& (Join-Path $DestDir "tesseract.exe") --version *> $null
if ($LASTEXITCODE -ne 0) { Write-Error "tesseract.exe does not start after the closure prune."; exit 1 }
$jbigProblems = @(Get-JbigProblems -Root $DestDir)
if ($jbigProblems) {
    Write-Error ("JBIG gate FAILED -- refusing to ship:`n" + ($jbigProblems -join "`n"))
    exit 1
}
Write-Host "  JBIG gate: no shipped binary references libjbig."

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
# Only the notices a shipped binary's manifest row names: the store also holds
# texts for installer DLLs outside the import closure, which do not ship.
$named = @(Get-Content (Join-Path $PSScriptRoot "tesseract-licenses.tsv") |
    Where-Object { $_ -and $_ -notmatch '^\s*#' } | Select-Object -Skip 1 |
    ForEach-Object { ($_ -split "`t")[3].Trim() } |
    Where-Object { $_ -and $_ -ne "LICENSE-Tesseract.txt" } | Sort-Object -Unique)
foreach ($notice in $named) {
    $src = Join-Path $LicenseSrc $notice
    if (-not (Test-Path $src)) { Write-Error "Licence store lacks $notice"; exit 1 }
    Copy-Item $src -Destination $LicenseDir -Force
}
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
$problems = @(Get-NoticeProblems -Root $DestDir) + @(Get-JbigProblems -Root $DestDir)
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
