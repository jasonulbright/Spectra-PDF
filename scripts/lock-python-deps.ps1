# Regenerate the hash-pinned Python lockfile (scripts/python-requirements.txt)
# from the top-level pins in scripts/python-requirements.in.
#
# Run this after editing python-requirements.in (e.g. bumping pikepdf/pyHanko).
# It resolves the FULL transitive tree + hashes using the exact target
# interpreter — the embedded CPython 3.14 in resources/python — so the lock
# matches what ships. pip is bootstrapped temporarily and removed again, so
# this leaves resources/python as it found it (no pip).
#
#   powershell -ExecutionPolicy Bypass -File scripts\lock-python-deps.ps1
#
# setup-python-embed.ps1 then installs from the lockfile with --require-hashes.

$ErrorActionPreference = "Stop"
$DestDir = "$PSScriptRoot\..\resources\python"
$InFile = "$PSScriptRoot\python-requirements.in"
$OutFile = "$PSScriptRoot\python-requirements.txt"
$Report = "$env:TEMP\pip-lock-report.json"

if (-not (Test-Path "$DestDir\python.exe")) {
    throw "Embedded runtime missing — run scripts\setup-python-embed.ps1 first."
}

$hadPip = $true
& $DestDir\python.exe -m pip --version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    $hadPip = $false
    Write-Host "Bootstrapping pip into the embedded runtime (temporary)..."
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile "$env:TEMP\get-pip.py"
    & $DestDir\python.exe "$env:TEMP\get-pip.py" --no-warn-script-location 2>&1 | Out-Null
}

Write-Host "Resolving the full dependency tree with hashes..."
# --dry-run --report resolves without installing; --ignore-installed forces a
# full resolution even if the runtime already has these packages.
& $DestDir\python.exe -m pip install --dry-run --ignore-installed --report $Report -r $InFile --no-warn-script-location 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "pip resolution failed" }

& $DestDir\python.exe "$PSScriptRoot\lockgen.py" $Report $OutFile
Remove-Item $Report -ErrorAction SilentlyContinue

if (-not $hadPip) {
    Write-Host "Removing the temporary pip..."
    & $DestDir\python.exe -m pip uninstall pip -y 2>&1 | Out-Null
}

Write-Host "Done. Review the diff to scripts\python-requirements.txt before committing."
