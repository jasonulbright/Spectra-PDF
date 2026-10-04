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
# The gate's boundary: it proves that the three files that ran are the pinned
# upstream bytes, read and executed from one real directory held open for the
# whole check. A process that can write into that real directory while the
# handles are held can only add files, which the post-run enumeration reports.
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

$LicenseName = "LICENSE-Ghostscript.txt"

# Pinned SHA-256 of each shipped file -- update alongside $ExpectedSha256.
# Derived once by extracting the installer pinned above with 7-Zip and hashing
# bin\gswin64c.exe, bin\gsdll64.dll and doc\COPYING as extracted, unmodified.
# scripts/ghostscript.tsv carries the same pins. The gate checks these on every
# tree, so a reused or released tree is held to the upstream bytes, not to the
# version string a changed executable can still print.
$ShippedSha256 = [ordered]@{
    "gswin64c.exe"            = "9B29D3B5128C6D53BB4E9EEE77E3919D05038CDFDD8E07697AF4D9C319F9D5AD"
    "gsdll64.dll"             = "A134ED0D3AF749BDAB93C66029180E676D36D9CC624C192EA287F73C891FB0AF"
    "LICENSE-Ghostscript.txt" = "57C8FF33C9C0CFC3EF00E650A1CC910D7EE479A8BC509F6C9209A7C2A11399D6"
}

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

# Handles the gate holds while it checks and runs the tree. A directory opened
# without delete sharing cannot be renamed, deleted or replaced while held,
# and Windows refuses to rename any directory above a held file, so the final
# path read from a held handle names the held object for as long as it is held.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class SpectraHeldTree {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);

    public static SafeFileHandle OpenDirectory(string path) {
        // FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, shared for
        // read and write but never delete, opened through any reparse point.
        SafeFileHandle handle = CreateFileW(path, 0x0001 | 0x0080 | 0x00100000, 0x1 | 0x2, IntPtr.Zero,
            3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        }
        return handle;
    }

    public static string FinalPath(SafeFileHandle handle) {
        StringBuilder path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        string text = path.ToString();
        if (text.StartsWith(@"\\?\UNC\")) { return @"\\" + text.Substring(8); }
        if (text.StartsWith(@"\\?\")) { return text.Substring(4); }
        return text;
    }
}
"@

# Entries in the real directory other than the pinned files: a folder, an
# unpinned file, or a pinned name that is itself a reparse point.
function Get-EntryProblems {
    param([string]$Directory)
    $problems = @()
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        if ($entry.PSIsContainer -or -not $ShippedSha256.Contains($entry.Name)) {
            $problems += "  $($entry.FullName): not a file this script ships"
        } elseif ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $problems += "  $($entry.FullName): a link, not the shipped file"
        }
    }
    return $problems
}

# The integrity check every execution depends on. It runs no program. It
# resolves the tree once to its real directory through a held handle,
# enumerates that directory (refusing a missing, extra or nested entry) and
# hashes each pinned file through a handle that denies writers and deleters,
# opened inside that directory. It returns the problems and, when there are
# none, the real directory and those open handles.
function Open-VerifiedTree {
    param([string]$Root)
    $none = [pscustomobject]@{ Problems = @(); Handles = @(); Directory = ""; Exe = $null }
    try {
        $directoryHandle = [SpectraHeldTree]::OpenDirectory($Root)
    } catch {
        $none.Problems = @("  no tree at ${Root}: $($_.Exception.Message)")
        return $none
    }
    $handles = @($directoryHandle)
    $problems = @()
    $exeStream = $null
    try {
        $real = [SpectraHeldTree]::FinalPath($directoryHandle)
        $problems += @(Get-EntryProblems $real)
        foreach ($name in $ShippedSha256.Keys) {
            if (-not (Test-Path -LiteralPath (Join-Path $real $name) -PathType Leaf)) {
                $problems += "  $name missing from $real"
            }
        }
        if (-not $problems) {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                foreach ($name in $ShippedSha256.Keys) {
                    $expected = Join-Path $real $name
                    $stream = [System.IO.File]::Open($expected, [System.IO.FileMode]::Open,
                        [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                    $handles += $stream
                    $opened = [SpectraHeldTree]::FinalPath($stream.SafeFileHandle)
                    if ($opened -ne $expected) {
                        $problems += "  ${name}: opened as $opened, outside the verified directory $real"
                        continue
                    }
                    $actual = ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '')
                    if ($actual -ne $ShippedSha256[$name]) {
                        $problems += "  ${name}: SHA-256 $actual is not the pinned upstream $($ShippedSha256[$name])"
                    }
                    if ($name -eq "gswin64c.exe") { $exeStream = $stream }
                }
            } finally {
                $sha.Dispose()
            }
        }
    } catch {
        $problems += "  ${Root}: $($_.Exception.Message)"
    }
    if ($problems) {
        foreach ($handle in $handles) { $handle.Dispose() }
        $none.Problems = $problems
        return $none
    }
    return [pscustomobject]@{ Problems = @(); Handles = $handles; Directory = $real; Exe = $exeStream }
}

function Get-TreeProblems {
    param([string]$Root)
    $verified = Open-VerifiedTree $Root
    foreach ($handle in $verified.Handles) { $handle.Dispose() }
    return @($verified.Problems)
}

function Get-NoticeProblems {
    param([string]$Root)
    $problems = @(Get-TreeProblems $Root)
    # The version run is the only execution here, and it happens only for a
    # tree whose every file just matched its pin.
    if (-not $problems) {
        try {
            $reported = Get-GsVersion $Root
            if ($reported -ne $GsVersion) {
                $problems += "  $(Join-Path $Root 'gswin64c.exe') reports '$reported', expected '$GsVersion'"
            }
        } catch {
            $problems += "  $($_.Exception.Message)"
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
    Write-Host "  Notice gate: every file matches its SHA-256 pin; gswin64c.exe reports $GsVersion; notice row names $GsVersion."
}

# Every run of the bundled program here matches how Spectra runs it: GS_LIB
# names the compiled-in ROM only. Ghostscript reads GS_LIB from the
# environment and falls back to the registry value of the same name only when
# the variable is absent ("General Windows configuration",
# https://ghostscript.readthedocs.io/en/gs10.08.0/Install.html; search order
# in "How Ghostscript finds files",
# https://ghostscript.readthedocs.io/en/gs10.08.0/Use.html). Without it, a
# separately installed Ghostscript of the same version puts its own lib and
# fonts directories ahead of the ROM.
$BundledGsLib = "%rom%Resource/Init/;%rom%lib/"

# One argument as the C runtime's command-line parser reads it back.
function ConvertTo-CommandLineArgument {
    param([string]$Argument)
    if ($Argument -ne "" -and $Argument -notmatch '[\s"]') { return $Argument }
    $text = '"'
    $slashes = 0
    foreach ($ch in $Argument.ToCharArray()) {
        if ($ch -eq '\') {
            $slashes++
        } elseif ($ch -eq '"') {
            $text += ('\' * (2 * $slashes + 1)) + '"'
            $slashes = 0
        } else {
            $text += ('\' * $slashes) + $ch
            $slashes = 0
        }
    }
    return $text + ('\' * (2 * $slashes)) + '"'
}

# Starts the program at the real path read from its held handle, in its own
# directory. gswin64c.exe imports no Ghostscript DLL; it loads gsdll64.dll
# from its own directory first ("General Windows configuration",
# https://ghostscript.readthedocs.io/en/gs10.08.0/Install.html), and GS_DLL,
# the only other place it names, is removed from the child's environment.
# For the DLLs gsdll64.dll imports, the directory the application loaded from
# comes before the system directories, the working directory and PATH
# ("Search order for unpackaged apps",
# https://learn.microsoft.com/windows/win32/dlls/dynamic-link-library-search-order);
# that directory holds only the pinned files, and the working directory is
# that same directory. A `.local` redirection file would be an unpinned entry,
# which the enumeration refuses. The child's environment carries no GH_TOKEN
# or GITHUB_TOKEN on any path, whether or not the script has scrubbed its own.
function Start-HeldProgram {
    param([string]$Exe, [string]$Directory, [string[]]$Arguments)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Exe
    $start.WorkingDirectory = $Directory
    $start.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables["GS_LIB"] = $BundledGsLib
    $start.EnvironmentVariables.Remove("GS_DLL")
    $start.EnvironmentVariables.Remove("GH_TOKEN")
    $start.EnvironmentVariables.Remove("GITHUB_TOKEN")
    $process = [System.Diagnostics.Process]::Start($start)
    $stderr = $process.StandardError.ReadToEndAsync()
    $stdout = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{
        Code   = $process.ExitCode
        Output = @($stdout -split "`r?`n" | Where-Object { $_ -ne "" })
        Errors = @($stderr.Result -split "`r?`n" | Where-Object { $_ -ne "" })
    }
}

# The only way this script runs the bundled program. It takes the tree, not
# an executable path, verifies the whole tree immediately before the run,
# starts the executable by the real path of the handle it verified, holds
# every verified handle until the program exits, and then enumerates the real
# directory again: a file that appeared beside the pinned ones during the run
# is reported, never ignored.
function Invoke-BundledGs {
    param([string]$Root, [string[]]$Arguments)
    $verified = Open-VerifiedTree $Root
    if ($verified.Problems) {
        throw ("refusing to run Ghostscript from an unverified tree:`n" + ($verified.Problems -join "`n"))
    }
    try {
        $exe = [SpectraHeldTree]::FinalPath($verified.Exe.SafeFileHandle)
        $run = Start-HeldProgram $exe $verified.Directory $Arguments
        $added = @(Get-EntryProblems $verified.Directory)
        if ($added) {
            throw ("the verified Ghostscript directory changed while the program ran:`n" + ($added -join "`n"))
        }
        return $run
    } finally {
        foreach ($handle in $verified.Handles) { $handle.Dispose() }
    }
}

function Get-GsVersion {
    param([string]$Root)
    $run = Invoke-BundledGs $Root @("--version")
    $lines = @($run.Output)
    if ($run.Code -ne 0 -or $lines.Count -eq 0) { return "" }
    return ("" + $lines[0]).Trim()
}

# The capability probe's own render (gs.rs `smoke`, gs_capability._smoke).
function Invoke-GsSmoke {
    param([string]$Root)
    $work = Join-Path $env:TEMP ("gs-vendor-smoke-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $work | Out-Null
    try {
        $png = Join-Path $work "probe.png"
        $run = Invoke-BundledGs $Root @("-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m",
            "-g16x16", "-r72", "-sOutputFile=$png", "-c",
            "0 0 moveto 16 16 lineto 0.5 setlinewidth stroke showpage")
        if ($run.Code -ne 0) { return "exit $($run.Code)`: $(@($run.Output + $run.Errors) -join ' ')" }
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
        Invoke-DownloadWithRetry -Uri $Url -Description "Ghostscript $GsVersion" -OutFile $Installer
    } catch {
        Write-Error "Download failed: $($_.Exception.Message)"
        exit 1
    }
    Remove-GitHubTokenFromEnvironment

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

    $reported = Get-GsVersion $DestDir
    if ($reported -ne $GsVersion) {
        Write-Error "The vendored binary reports '$reported', expected '$GsVersion'."
        exit 1
    }
    $smoke = Invoke-GsSmoke $DestDir
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
