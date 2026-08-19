# Stages the test-only SoftHSM2 runtime used by tests/test_pkcs11_sign.py.
# This directory is gitignored and never enters the application package.

param(
    [string]$DestDir = "$PSScriptRoot\..\tests\softhsm2"
)

$ErrorActionPreference = "Stop"

$Version = "2.5.0"
$Url = "https://github.com/disig/SoftHSM2-for-Windows/releases/download/v$Version/SoftHSM2-$Version-portable.zip"
$ArchiveSha256 = "85273bcc1a6b90e877f7bb4f7e90221d57103d8f5241d154a79dd730a135b910"
$ModuleSha256 = "1980a74f3088a7273d7efa502b6ceb8de6a5285d5bcd36d49512a8717bf89635"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$TestsRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot "tests"))
$DestFull = [IO.Path]::GetFullPath($DestDir)
$TestsPrefix = $TestsRoot.TrimEnd('\') + '\'
if (-not $DestFull.StartsWith($TestsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "SoftHSM test destination must stay under $TestsRoot (got $DestFull)"
}

$Module = Join-Path $DestFull "SoftHSM2\lib\softhsm2-x64.dll"
if (Test-Path -LiteralPath $Module) {
    $existing = (Get-FileHash -LiteralPath $Module -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existing -eq $ModuleSha256) {
        Write-Host "SoftHSM2 $Version test module already staged and verified."
        exit 0
    }
}

$Work = Join-Path $env:TEMP "spectrapdf-softhsm-test-$Version"
$Archive = Join-Path $Work "SoftHSM2-$Version-portable.zip"
$Extract = Join-Path $Work "extract"
if (Test-Path -LiteralPath $Work) {
    Remove-Item -LiteralPath $Work -Recurse -Force
}
New-Item -ItemType Directory -Path $Work -Force | Out-Null

try {
    Write-Host "Downloading test-only SoftHSM2 $Version ..."
    $Attempts = 4
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
            break
        } catch {
            Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
            if ($i -eq $Attempts) {
                throw "SoftHSM2 download failed after $Attempts attempts: $($_.Exception.Message)"
            }
            $wait = 5 * $i
            Write-Host "  attempt $i/$Attempts failed; retrying in ${wait}s..."
            Start-Sleep -Seconds $wait
        }
    }
    $actualArchive = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualArchive -ne $ArchiveSha256) {
        throw "SoftHSM2 archive checksum mismatch (expected $ArchiveSha256, got $actualArchive)"
    }

    Expand-Archive -LiteralPath $Archive -DestinationPath $Extract -Force
    $source = Join-Path $Extract "SoftHSM2"
    $sourceModule = Join-Path $source "lib\softhsm2-x64.dll"
    if (-not (Test-Path -LiteralPath $sourceModule)) {
        throw "SoftHSM2 archive did not contain SoftHSM2/lib/softhsm2-x64.dll"
    }
    $actualModule = (Get-FileHash -LiteralPath $sourceModule -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualModule -ne $ModuleSha256) {
        throw "SoftHSM2 module checksum mismatch (expected $ModuleSha256, got $actualModule)"
    }

    if (Test-Path -LiteralPath $DestFull) {
        Remove-Item -LiteralPath $DestFull -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DestFull -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $DestFull "SoftHSM2") -Recurse -Force
    Write-Host "Staged verified test-only SoftHSM2 $Version at $DestFull"
} finally {
    if (Test-Path -LiteralPath $Work) {
        Remove-Item -LiteralPath $Work -Recurse -Force
    }
}
