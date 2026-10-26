# Vendors the official, standalone GhostXPS Windows x64 interpreter.
# The upstream release ZIP is SHA-256 pinned; only its executable, DLL and
# GPL license text are copied. The release sample XPS is used for a real PDF
# conversion smoke test and is never shipped.

param(
    [string]$Version = "10.08.0",
    [string]$DestDir = "$PSScriptRoot\..\resources\ghostxps",
    [switch]$GateOnly,
    [string]$Notices = (Join-Path $PSScriptRoot "..\THIRD-PARTY-LICENSES.md")
)

$ErrorActionPreference = "Stop"
$ExpectedVersion = "10.08.0"
$ExpectedZipSha256 = "B842043D43B61C1BFACB294537EE4916A3C5D765828BF17CCFFE08D85B99D282"
$ExpectedFiles = [ordered]@{
    "gxpswin64.exe" = "082D9755D3631FF574E6D7FCB547262AFBCEA0F23D7BD36ECAD2BB46FF1D8EBF"
    "gxpsdll64.dll" = "A3CE6DB95E1E8913695868288B21258E8B7D6EA7D328AA713E1AC6A267E68A16"
    "LICENSE-GhostXPS.txt" = "0B383D5A63DA644F628D99C33976EA6487ED89AAA59F0B3257992DEAC1171E6B"
}
$Members = [ordered]@{
    "gxpswin64.exe" = "ghostxps-10.08.0-win64\gxpswin64.exe"
    "gxpsdll64.dll" = "ghostxps-10.08.0-win64\gxpsdll64.dll"
    "LICENSE-GhostXPS.txt" = "ghostxps-10.08.0-win64\COPYING"
}
$LicenseName = "LICENSE-GhostXPS.txt"

if ($Version -cne $ExpectedVersion) {
    throw "GhostXPS $Version is not pinned here. Update the upstream ZIP digest, file pins, source record and notice together."
}
$Tag = "gs" + ($Version -replace '\.', '')
$Url = "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/$Tag/ghostxps-$Version-win64.zip"

function Get-NoticeProblems {
    if (-not (Test-Path -LiteralPath $Notices -PathType Leaf)) { return @("the notice file is missing: $Notices") }
    $text = Get-Content -LiteralPath $Notices -Raw -Encoding UTF8
    $section = [regex]::Match($text, '(?ms)^## GhostXPS\s*$(.*?)(?=^## |\z)')
    if (-not $section.Success) { return @("THIRD-PARTY-LICENSES.md has no '## GhostXPS' section") }
    if (-not $section.Groups[1].Value.Contains("- **Version:** $Version ")) {
        return @("the GhostXPS notice does not give pinned version $Version")
    }
    return @()
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = $null
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $digest = $algorithm.ComputeHash($stream)
        return [BitConverter]::ToString($digest).Replace("-", "")
    } finally {
        $stream.Dispose()
        if ($algorithm) { $algorithm.Dispose() }
    }
}

function Get-TreeProblems {
    param([string]$Root)
    $problems = @()
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @("tree is missing: $Root") }
    $entries = @(Get-ChildItem -LiteralPath $Root -Force)
    $names = @($entries | ForEach-Object { $_.Name })
    foreach ($name in $ExpectedFiles.Keys) {
        if ($name -notin $names) { $problems += "missing pinned file: $name"; continue }
        $entry = $entries | Where-Object { $_.Name -ceq $name } | Select-Object -First 1
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $problems += "$name is not an ordinary file"
            continue
        }
        $actual = Get-Sha256 -Path $entry.FullName
        if ($actual -cne $ExpectedFiles[$name]) { $problems += "$name SHA-256 mismatch: $actual" }
    }
    foreach ($name in $names) {
        if ($name -cnotin $ExpectedFiles.Keys) { $problems += "unlisted file in GhostXPS tree: $name" }
    }
    return $problems
}

function Assert-Tree {
    param([string]$Root)
    $problems = @(Get-TreeProblems $Root)
    if ($problems) { throw ("GhostXPS tree gate FAILED:`n  " + ($problems -join "`n  ")) }
}

function Quote-Argument {
    param([string]$Value)
    $text = '"'
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') {
            $text += ('\' * (2 * $slashes + 1)) + '"'
        } else {
            $text += ('\' * $slashes) + $ch
        }
        $slashes = 0
    }
    return $text + ('\' * (2 * $slashes)) + '"'
}

function Invoke-Gxps {
    param([string]$Exe, [string]$Directory, [string[]]$Arguments, [string]$TempDirectory)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Exe
    $start.WorkingDirectory = $Directory
    $start.Arguments = (@($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear()
    if ($env:SystemRoot) { $start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot }
    $start.EnvironmentVariables['TEMP'] = $TempDirectory
    $start.EnvironmentVariables['TMP'] = $TempDirectory
    $start.EnvironmentVariables['GS_LIB'] = '%rom%Resource/Init/;%rom%lib/'
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(120000)) {
        try { $process.Kill() } catch { }
        throw 'GhostXPS smoke test exceeded two minutes.'
    }
    $process.WaitForExit()
    return [pscustomobject]@{ Code = $process.ExitCode; Output = $stdout.Result; Errors = $stderr.Result }
}

function Invoke-XpsSmoke {
    param([string]$Root, [string]$Sample)
    $temp = Join-Path $env:TEMP ("gxps-smoke-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    try {
        $exe = Join-Path $Root 'gxpswin64.exe'
        $help = Invoke-Gxps $exe $Root @('-h') $temp
        $versionText = $help.Output + $help.Errors
        if ($help.Code -ne 0 -or $versionText -notmatch "Version: $([regex]::Escape($Version))") {
            return "version probe failed (exit $($help.Code)): $($help.Errors) $($help.Output)"
        }
        $pdf = Join-Path $temp 'probe.pdf'
        $run = Invoke-Gxps $exe $Root @('-dBATCH','-dNOPAUSE','-dSAFER','-dPDFSETTINGS=/printer','-sDEVICE=pdfwrite',"-sOutputFile=$pdf",$Sample) $temp
        if ($run.Code -ne 0) { return "XPS conversion failed (exit $($run.Code)): $($run.Errors)" }
        if (-not (Test-Path -LiteralPath $pdf -PathType Leaf)) { return 'XPS conversion produced no PDF' }
        $bytes = [IO.File]::ReadAllBytes($pdf)
        if ($bytes.Length -lt 8 -or [Text.Encoding]::ASCII.GetString($bytes,0,5) -cne '%PDF-' -or
            [Text.Encoding]::ASCII.GetString($bytes,[Math]::Max(0,$bytes.Length-4096),[Math]::Min(4096,$bytes.Length)).IndexOf('%%EOF',[StringComparison]::Ordinal) -lt 0) {
            return 'XPS conversion did not produce a complete PDF'
        }
        return ''
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($GateOnly) {
    $noticeProblems = @(Get-NoticeProblems)
    if ($noticeProblems) { throw ("GhostXPS notice gate FAILED:`n  " + ($noticeProblems -join "`n  ")) }
    if (-not (Test-Path -LiteralPath $DestDir -PathType Container)) {
        Write-Host "Notice gate: GhostXPS $Version is recorded; no Windows bundle tree exists at $DestDir."
        exit 0
    }
    Assert-Tree $DestDir
    $temp = Join-Path $env:TEMP ("gxps-version-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    try {
        $help = Invoke-Gxps (Join-Path $DestDir 'gxpswin64.exe') $DestDir @('-h') $temp
        $versionText = $help.Output + $help.Errors
        if ($help.Code -ne 0 -or $versionText -notmatch "Version: $([regex]::Escape($Version))") {
            throw "bundled GhostXPS does not report version $Version (exit $($help.Code))"
        }
    } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host "GhostXPS $Version tree and notices are pinned and pass the interpreter version probe."
    exit 0
}

Write-Host "Vendoring GhostXPS $Version (official Windows x64 build, SHA-256 pinned)..."
$existingProblems = @(Get-TreeProblems $DestDir)
if ($existingProblems.Count -eq 0 -and (Get-NoticeProblems).Count -eq 0) {
    Write-Host "GhostXPS $Version already vendored at $DestDir (pins and notices pass)"
    exit 0
}

$work = Join-Path $env:TEMP ("gxps-vendor-" + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $work "ghostxps-$Version-win64.zip"
$extract = Join-Path $work 'extracted'
$vendored = $false
try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    . (Join-Path $PSScriptRoot "download-retry.ps1")
    Write-Host "Downloading $Url..."
    Invoke-DownloadWithRetry -Uri $Url -Description "GhostXPS $Version" -OutFile $archive
    Remove-GitHubTokenFromEnvironment
    $actualArchive = Get-Sha256 -Path $archive
    if ($actualArchive -cne $ExpectedZipSha256) { throw "GhostXPS ZIP SHA-256 mismatch: $actualArchive" }
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    foreach ($name in $Members.Keys) {
        $source = Join-Path $extract $Members[$name]
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "The official ZIP no longer contains $($Members[$name])." }
        $digest = Get-Sha256 -Path $source
        if ($digest -cne $ExpectedFiles[$name]) { throw "Extracted $name SHA-256 mismatch: $digest" }
    }
    $noticeProblems = @(Get-NoticeProblems)
    if ($noticeProblems) { throw ("GhostXPS notice gate FAILED:`n  " + ($noticeProblems -join "`n  ")) }
    if (Test-Path -LiteralPath $DestDir) { Remove-Item -LiteralPath $DestDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    foreach ($name in $Members.Keys) { Copy-Item -LiteralPath (Join-Path $extract $Members[$name]) -Destination (Join-Path $DestDir $name) -Force }
    Assert-Tree $DestDir
    $smoke = Invoke-XpsSmoke $DestDir (Join-Path $extract 'ghostxps-10.08.0-win64\tiger.xps')
    if ($smoke) { throw "GhostXPS $Version failed its sample XPS-to-PDF smoke test: $smoke" }
    $vendored = $true
} finally {
    if (-not $vendored -and (Test-Path -LiteralPath $DestDir)) { Remove-Item -LiteralPath $DestDir -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
$sizeMB = [math]::Round(((Get-ChildItem -LiteralPath $DestDir -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Vendored GhostXPS $Version`: $sizeMB MB"
