# Vendors the official upstream Ghostscript binary into resources/ghostscript/.
#
# Ghostscript is downloaded from Artifex's official release channel, verified
# against a pinned SHA-256, extracted from the NSIS installer with 7-Zip, and
# the runtime files (gswin64c.exe, gsdll64.dll, lib/, Resource/) are copied in.
# Open PDF Studio invokes Ghostscript as a separate process; it is unmodified
# upstream Ghostscript, redistributed under AGPL-3.0 (see THIRD-PARTY-LICENSES.md).
#
# Run before packaging: powershell -ExecutionPolicy Bypass -File scripts\bundle-ghostscript.ps1

param(
    [string]$GsVersion = "10.07.1",
    [string]$DestDir = "$PSScriptRoot\..\resources\ghostscript"
)

# Pinned installer checksum — update deliberately alongside $GsVersion.
$ExpectedSha256 = "3A4C28D0AAC47AA7CCCD35A5932C55110376E9DBD966898DDE388B7FABA444A4"

$Tag = "gs" + ($GsVersion -replace '\.', '')
$Url = "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/$Tag/${Tag}w64.exe"

Write-Host "Vendoring Ghostscript $GsVersion (upstream, AGPL-3.0)..."

# Skip if the target version is already vendored.
$gsExe = Join-Path $DestDir "gswin64c.exe"
if (Test-Path $gsExe) {
    $current = (& $gsExe --version 2>$null | Select-Object -First 1)
    if ($current -eq $GsVersion) {
        Write-Host "Ghostscript $GsVersion already vendored at $DestDir"
        return
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

$Work = Join-Path $env:TEMP "gs-vendor-$Tag"
$Installer = Join-Path $Work "installer.exe"
$Extracted = Join-Path $Work "extracted"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null

# Download
Write-Host "Downloading $Url..."
Invoke-WebRequest -Uri $Url -OutFile $Installer

# Verify pinned checksum
$actual = (Get-FileHash $Installer -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256) {
    Write-Error "Checksum mismatch for $Tag installer.`n  expected: $ExpectedSha256`n  actual:   $actual"
    exit 1
}
Write-Host "Checksum verified ($ExpectedSha256)."

# Extract (NSIS installer -> file tree) without running it
& $SevenZip x $Installer "-o$Extracted" -y | Out-Null

# Copy runtime files into a clean destination
if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
New-Item -ItemType Directory -Force $DestDir | Out-Null

foreach ($bin in @("gswin64c.exe", "gsdll64.dll")) {
    $src = Join-Path $Extracted "bin\$bin"
    if (-not (Test-Path $src)) {
        Write-Error "Expected binary not found in installer: bin\$bin"
        exit 1
    }
    Copy-Item $src -Destination $DestDir -Force
    Write-Host "  Copied $bin"
}

foreach ($dir in @("lib", "Resource")) {
    $src = Join-Path $Extracted $dir
    if (Test-Path $src) {
        Copy-Item $src -Destination (Join-Path $DestDir $dir) -Recurse -Force
        Write-Host "  Copied $dir/"
    }
}

# Ship Ghostscript's own license text (AGPL-3.0) alongside the binary for
# redistribution compliance.
$license = Join-Path $Extracted "doc\COPYING"
if (Test-Path $license) {
    Copy-Item $license -Destination (Join-Path $DestDir "LICENSE-Ghostscript.txt") -Force
    Write-Host "  Copied LICENSE-Ghostscript.txt"
}

# Keep the directory tracked even when binaries are gitignored.
New-Item -ItemType File -Force (Join-Path $DestDir ".gitkeep") | Out-Null

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Vendored Ghostscript ${GsVersion}: ${sizeMB}MB"
