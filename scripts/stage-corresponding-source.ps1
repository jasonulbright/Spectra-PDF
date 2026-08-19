# Stages the exact source archives that accompany the release's HEIF decoder.
# Remote bytes are version-pinned and SHA-256-pinned; the binding source is the
# already-reviewed sdist committed under vendor/wheels. The release workflow
# uploads every staged file and includes it in SHA256SUMS.txt.

param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$Manifest = ""
)

$ErrorActionPreference = "Stop"

$Manifest = if ($Manifest) {
    [IO.Path]::GetFullPath($Manifest)
} else {
    Join-Path $PSScriptRoot "corresponding-source.tsv"
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$output = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}

$rows = @()
$seenHeader = $false
foreach ($line in (Get-Content -LiteralPath $Manifest -Encoding UTF8)) {
    if ($line.StartsWith("#") -or -not $line.Trim()) { continue }
    $cells = $line -split "`t"
    if (-not $seenHeader) {
        if (($cells -join "`t") -ne "component`tversion`tfile`tsha256`tsource") {
            throw "unexpected corresponding-source manifest header: $line"
        }
        $seenHeader = $true
        continue
    }
    if ($cells.Count -ne 5) { throw "malformed corresponding-source row: $line" }
    $rows += [pscustomobject]@{
        component = $cells[0].Trim()
        version   = $cells[1].Trim()
        file      = $cells[2].Trim()
        sha256    = $cells[3].Trim().ToLowerInvariant()
        source    = $cells[4].Trim()
    }
}
if (-not $seenHeader) { throw "manifest $Manifest has no header row" }
if (-not $rows) { throw "manifest $Manifest has no source rows" }

$bad = @()
$names = @{}
foreach ($row in $rows) {
    if (-not $row.component) { $bad += "a row has no component" }
    if (-not $row.version) { $bad += "$($row.component): no version" }
    if ($row.file -ne [IO.Path]::GetFileName($row.file)) {
        $bad += "$($row.component): file must be a basename"
    }
    if ($row.sha256 -notmatch '^[0-9a-f]{64}$') {
        $bad += "$($row.component): malformed sha256"
    }
    if (-not $row.source) { $bad += "$($row.component): no source" }
    if ($names.ContainsKey($row.file)) { $bad += "$($row.file): duplicate filename" }
    $names[$row.file] = $true
}
if ($bad) { throw "corresponding-source gate refused:`n  " + ($bad -join "`n  ") }

New-Item -ItemType Directory -Path $output -Force | Out-Null

foreach ($row in $rows) {
    $destination = Join-Path $output $row.file
    $part = "$destination.part"
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue

    if ($row.source -match '^https://') {
        Write-Host "Downloading $($row.component) $($row.version) source..."
        Invoke-WebRequest -Uri $row.source -OutFile $part
    } else {
        $source = [IO.Path]::GetFullPath((Join-Path $repoRoot $row.source))
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "$($row.component): repository source is missing at $source"
        }
        Copy-Item -LiteralPath $source -Destination $part -Force
    }

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash.ToLowerInvariant()
    if ($actual -ne $row.sha256) {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        throw "$($row.file): sha256 $actual does not match the pinned $($row.sha256)"
    }
    Move-Item -LiteralPath $part -Destination $destination -Force
    Write-Host "$($row.file): $actual"
}

$unexpected = @(Get-ChildItem -LiteralPath $output -File | Where-Object { -not $names.ContainsKey($_.Name) })
if ($unexpected) {
    throw "corresponding-source output contains unexpected files: $($unexpected.Name -join ', ')"
}

Write-Host "Staged $($rows.Count) corresponding-source archive(s) in $output."
