# Installs the wheels committed under vendor/wheels/ into one interpreter.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-vendored-wheels.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-vendored-wheels.ps1 -Python resources\python\python.exe
#
# Runs with --no-index: these packages are installed from the bytes in this
# repository and never from an index, so the build survives a package being
# withdrawn. --no-deps because the dependency tree is already satisfied by
# scripts/python-requirements.txt, which must be installed FIRST.
#
# Every row is sha256-verified against scripts/vendored-wheels.tsv before pip
# sees it, and a wheel with no matching sdist row refuses: a frozen artifact we
# cannot rebuild is not a maintained pin.

param(
    [string]$Python = "python",
    [string]$Manifest = (Join-Path $PSScriptRoot "vendored-wheels.tsv"),
    [string]$VendorDir = (Join-Path $PSScriptRoot "..\vendor\wheels")
)

$ErrorActionPreference = "Stop"

$rows = @()
$seenHeader = $false
foreach ($line in (Get-Content $Manifest -Encoding UTF8)) {
    if (-not $seenHeader) {
        if ($line -match '^package\t') { $seenHeader = $true }
        continue
    }
    if (-not $line.Trim()) { continue }
    $c = $line -split "`t"
    if ($c.Count -lt 7) { throw "malformed manifest row: $line" }
    $rows += [pscustomobject]@{
        package  = $c[0].Trim()
        version  = $c[1].Trim()
        role     = $c[2].Trim()
        file     = $c[3].Trim()
        sha256   = $c[4].Trim()
        spdx     = $c[5].Trim()
        upstream = $c[6].Trim()
    }
}
if (-not $seenHeader) { throw "manifest $Manifest has no header row" }

# The ownership gate, checked before anything is installed.
$bad = @()
foreach ($r in $rows) {
    if ($r.role -notin @('wheel', 'sdist')) { $bad += "$($r.file): unknown role '$($r.role)'" }
    if (-not $r.sha256)   { $bad += "$($r.file): no sha256" }
    if (-not $r.spdx)     { $bad += "$($r.file): no SPDX expression" }
    if (-not $r.upstream) { $bad += "$($r.file): no upstream URL" }
}
foreach ($w in ($rows | Where-Object { $_.role -eq 'wheel' })) {
    $src = $rows | Where-Object { $_.role -eq 'sdist' -and $_.package -eq $w.package -and $_.version -eq $w.version }
    if (-not $src) { $bad += "$($w.package) $($w.version): a wheel row with no sdist row" }
}
if ($bad) { throw "vendored-wheel gate refused:`n  " + ($bad -join "`n  ") }

foreach ($r in $rows) {
    $path = Join-Path $VendorDir $r.file
    if (-not (Test-Path $path)) { throw "$($r.file): not present in $VendorDir" }
    $sha = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
    if ($sha -ne $r.sha256) { throw "$($r.file): sha256 $sha does not match the pinned $($r.sha256)" }
}

$wheels = @($rows | Where-Object { $_.role -eq 'wheel' } | ForEach-Object { Join-Path $VendorDir $_.file })
Write-Host "Installing $($wheels.Count) vendored wheel(s) into $Python..."
& $Python -m pip install --no-index --no-deps --force-reinstall @wheels --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "vendored wheel install failed" }
Write-Host "Done. Vendored wheels installed."
