# Vendors the official upstream Ghostscript into resources/ghostscript/.
#
# The vendor's Windows x64 installer is downloaded from the vendor's GitHub
# release, verified against a pinned SHA-256, and unpacked with 7-Zip. The
# installer is never run: it writes no registry keys and installs nothing.
# The tree is flat because engine.rs and cli.rs look for
# ghostscript\gswin64c.exe:
#
#   gswin64c.exe, gsdll64.dll    from bin\
#   LICENSE-Ghostscript.txt      the vendor's doc\COPYING
#
# Left out: gswin64.exe (the windowed build waits for its window to close and
# never exits under a probe), gsdll64.lib, lib\, Resource\ and iccprofiles\
# (the DLL carries the same files in its compiled-in %rom% file system, and
# its search path names no directory beside the executable), doc\ except the
# licence file, examples\, the vendor's VC++ redistributable installer, the
# uninstaller and $PLUGINSDIR.
#
# Run before packaging:
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-ghostscript.ps1
# Check an existing tree only (no download):
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-ghostscript.ps1 -GateOnly

param(
    [string]$GsVersion = "10.08.0",
    [string]$DestDir = "$PSScriptRoot\..\resources\ghostscript",
    [switch]$GateOnly,
    # Overridable so the notice gate can be run against a variant notice file.
    [string]$Notices = (Join-Path $PSScriptRoot "..\THIRD-PARTY-LICENSES.md")
)

$ErrorActionPreference = "Stop"

# Pinned installer checksum -- update deliberately alongside $GsVersion.
# Source: the GitHub release API `digest` of gs10080w64.exe; the downloaded
# bytes also match the release's own SHA512SUMS entry for that file.
$ExpectedSha256 = "52A91B8BF09298788D7A57B9206127026C23EACD75405F0A131E26DC381DCE50"

$Tag = "gs" + ($GsVersion -replace '\.', '')
$Url = "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/$Tag/${Tag}w64.exe"

$ShippedBinaries = @("gswin64c.exe", "gsdll64.dll")
$LicenseName = "LICENSE-Ghostscript.txt"

function Get-RowProblems {
    if (-not (Test-Path $Notices)) { return @("  notice file missing: $Notices") }
    $text = Get-Content $Notices -Raw -Encoding UTF8
    $section = [regex]::Match($text, '(?ms)^## Ghostscript\s*$(.*?)(?=^## |\z)')
    if (-not $section.Success) {
        return @("  THIRD-PARTY-LICENSES.md has no '## Ghostscript' section")
    }
    if (-not $section.Groups[1].Value.Contains("- **Version:** $GsVersion ")) {
        return @("  the '## Ghostscript' section in THIRD-PARTY-LICENSES.md does not give Version $GsVersion")
    }
    return @()
}

function Get-NoticeProblems {
    param([string]$Root)
    $problems = @()
    if (-not (Test-Path (Join-Path $Root $LicenseName))) {
        $problems += "  $LicenseName missing from $Root"
    }
    foreach ($name in $ShippedBinaries) {
        if (-not (Test-Path (Join-Path $Root $name))) {
            $problems += "  $name missing from $Root"
        }
    }
    $shipped = @($ShippedBinaries + $LicenseName)
    foreach ($entry in @(Get-ChildItem $Root -Force -ErrorAction SilentlyContinue)) {
        if ($entry.PSIsContainer -or $entry.Name -notin $shipped) {
            $problems += "  $($entry.FullName): not a file this script ships"
        }
    }
    $exe = Join-Path $Root "gswin64c.exe"
    if (Test-Path $exe) {
        $reported = Get-GsVersion $exe
        if ($reported -ne $GsVersion) {
            $problems += "  $exe reports '$reported', expected '$GsVersion'"
        }
    }
    return @($problems + @(Get-RowProblems))
}

function Assert-Notices {
    param([string]$Root)
    $problems = @(Get-NoticeProblems -Root $Root)
    if ($problems) {
        Write-Error ("Ghostscript notice gate FAILED -- refusing to ship:`n" + ($problems -join "`n"))
        exit 1
    }
    Write-Host "  Notice gate: gswin64c.exe reports $GsVersion; $($ShippedBinaries -join ', ') and $LicenseName present; notice row names $GsVersion."
}

# Every run of the bundled program here matches how Spectra runs it: GS_LIB
# names the compiled-in ROM only. Ghostscript reads GS_LIB from the
# environment and falls back to the registry value of the same name only when
# the variable is absent ("General Windows configuration",
# https://ghostscript.readthedocs.io/en/gs10.08.0/Install.html; search order
# in "How Ghostscript finds files",
# https://ghostscript.readthedocs.io/en/gs10.08.0/Use.html). Without it, a
# separately installed Ghostscript of the same version puts its own lib and
# fonts directories ahead of the ROM. A native command's stderr under "Stop"
# is a terminating error, so the call relaxes it locally.
$BundledGsLib = "%rom%Resource/Init/;%rom%lib/"

function Invoke-BundledGs {
    param([string]$Exe, [string[]]$Arguments)
    $ErrorActionPreference = "Continue"
    $saved = $env:GS_LIB
    $env:GS_LIB = $BundledGsLib
    try {
        $out = @(& $Exe @Arguments 2>&1)
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out }
    } finally {
        $env:GS_LIB = $saved
    }
}

function Get-GsVersion {
    param([string]$Exe)
    $run = Invoke-BundledGs $Exe @("--version")
    $lines = @($run.Output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    if ($run.Code -ne 0 -or $lines.Count -eq 0) { return "" }
    return ("" + $lines[0]).Trim()
}

# The capability probe's own render (gs.rs `smoke`, gs_capability._smoke).
function Invoke-GsSmoke {
    param([string]$Exe)
    $work = Join-Path $env:TEMP ("gs-vendor-smoke-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $work | Out-Null
    try {
        $png = Join-Path $work "probe.png"
        $run = Invoke-BundledGs $Exe @("-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m",
            "-g16x16", "-r72", "-sOutputFile=$png", "-c",
            "0 0 moveto 16 16 lineto 0.5 setlinewidth stroke showpage")
        if ($run.Code -ne 0) { return "exit $($run.Code)`: $($run.Output -join ' ')" }
        if (-not (Test-Path $png) -or (Get-Item $png).Length -eq 0) {
            return "the probe render produced no output"
        }
        return ""
    } finally {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($GateOnly) {
    # A checkout that has not vendored the tree still has its notice row
    # checked. The release job vendors before this gate, so there the tree is
    # always present and fully checked.
    if (-not (Test-Path $DestDir)) {
        $rowProblems = @(Get-RowProblems)
        if ($rowProblems) {
            Write-Error ("Ghostscript notice gate FAILED:`n" + ($rowProblems -join "`n"))
            exit 1
        }
        Write-Host "  Notice gate: notice row names $GsVersion; not vendored here ($DestDir is absent), so no tree was checked."
        exit 0
    }
    Assert-Notices $DestDir
    exit 0
}

Write-Host "Vendoring Ghostscript $GsVersion (unmodified upstream, SHA-256 pinned)..."

$gsExe = Join-Path $DestDir "gswin64c.exe"
if (Test-Path $gsExe) {
    $noticeProblems = @(Get-NoticeProblems -Root $DestDir)
    if ($noticeProblems.Count -eq 0) {
        Write-Host "Ghostscript $GsVersion already vendored at $DestDir (notices complete)"
        return
    }
    Write-Host "Re-vendoring: the existing tree does not pass the gate"
    $noticeProblems | Select-Object -First 5 | ForEach-Object { Write-Host $_ }
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
    Write-Error "7-Zip not found. Install it (e.g. 'winget install 7zip.7zip') and retry."
    exit 1
}

$Work = Join-Path $env:TEMP "gs-vendor-$Tag"
$Installer = Join-Path $Work "${Tag}w64.exe"
$Extracted = Join-Path $Work "extracted"
$vendored = $false
try {
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $Work | Out-Null

    . (Join-Path $PSScriptRoot "download-retry.ps1")
    Write-Host "Downloading $Url..."
    try {
        Invoke-DownloadWithRetry -Description "Ghostscript $GsVersion" -OutFile $Installer -Download {
            Invoke-WebRequest -Uri $Url -OutFile $Installer -MaximumRedirection 5 `
                -TimeoutSec $DownloadRetryTimeoutSeconds
        }
    } catch {
        Write-Error "Download failed: $($_.Exception.Message)"
        exit 1
    }

    $actual = (Get-FileHash $Installer -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedSha256) {
        Write-Error "Checksum mismatch for ${Tag}w64.exe.`n  expected: $ExpectedSha256`n  actual:   $actual"
        exit 1
    }
    Write-Host "Checksum verified ($ExpectedSha256)."

    & $SevenZip x $Installer "-o$Extracted" -y | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "7-Zip could not unpack ${Tag}w64.exe (exit $LASTEXITCODE)."
        exit 1
    }

    $sources = @{
        "gswin64c.exe" = Join-Path $Extracted "bin\gswin64c.exe"
        "gsdll64.dll"  = Join-Path $Extracted "bin\gsdll64.dll"
        $LicenseName   = Join-Path $Extracted "doc\COPYING"
    }
    foreach ($name in $sources.Keys) {
        if (-not (Test-Path $sources[$name])) {
            Write-Error "The installer no longer carries $($sources[$name].Substring($Extracted.Length + 1)) -- the vendor layout changed."
            exit 1
        }
    }

    # From here a failure removes the tree: a tree whose version check or
    # smoke failed would otherwise pass the next run's skip check.
    if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
    New-Item -ItemType Directory -Force $DestDir | Out-Null
    foreach ($name in $sources.Keys) {
        Copy-Item $sources[$name] -Destination (Join-Path $DestDir $name) -Force
        Write-Host "  Copied $name"
    }

    $reported = Get-GsVersion $gsExe
    if ($reported -ne $GsVersion) {
        Write-Error "The vendored binary reports '$reported', expected '$GsVersion'."
        exit 1
    }
    $smoke = Invoke-GsSmoke $gsExe
    if ($smoke) {
        Write-Error "The vendored Ghostscript failed its 16x16 render: $smoke"
        exit 1
    }
    Write-Host "  Smoke: $reported renders a 16x16 png16m page from its ROM search path."

    Assert-Notices $DestDir
    $vendored = $true
} finally {
    if (-not $vendored -and (Test-Path $DestDir)) {
        Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Vendored Ghostscript ${GsVersion}: ${sizeMB}MB"
