# Downloads and configures the embedded Python runtime for Spectra PDF.
# Run once before packaging: powershell -ExecutionPolicy Bypass -File scripts\setup-python-embed.ps1

. (Join-Path $PSScriptRoot "download-retry.ps1")
# The one Python pin: every setup-python step in the workflows reads the same
# file, so CI tests on the runtime this script ships.
$PinFile = Join-Path $PSScriptRoot "..\.python-version"
$PythonVersion = (Get-Content -LiteralPath $PinFile -TotalCount 1).Trim()
if ($PythonVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "$PinFile must hold one exact version (major.minor.patch), not '$PythonVersion'"
}
# The SHA-256 python.org publishes for the embeddable package of that pin. A
# pin changed without this value refuses at the download, never ships.
$ExpectedSha256 = "d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15"
$Url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$ZipPath = "$env:TEMP\python-embed.zip"
$DestDir = "$PSScriptRoot\..\resources\python"

# The runtime's own version gates the download: every python3XY.dll of one
# minor has the same name, so a file marker keeps a stale patch release.
function Get-EmbeddedVersion {
    $exe = Join-Path $DestDir "python.exe"
    if (-not (Test-Path -LiteralPath $exe)) { return "" }
    $reported = & $exe -B -S -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
    if ($LASTEXITCODE -ne 0) { return "" }
    return ([string]$reported).Trim()
}

Write-Host "Setting up Python $PythonVersion embedded runtime..."

$Installed = Get-EmbeddedVersion
if ($Installed -ne $PythonVersion) {
    if ($Installed) { Write-Host "Replacing embedded Python $Installed" }
    Write-Host "Downloading $Url..."
    Invoke-DownloadWithRetry -Description "Python $PythonVersion" -OutFile $ZipPath -Download {
        Invoke-WebRequest -Uri $Url -OutFile $ZipPath -TimeoutSec $DownloadRetryTimeoutSeconds
    }
    $ActualSha256 = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $ExpectedSha256) {
        throw "python-$PythonVersion-embed-amd64.zip has SHA-256 $ActualSha256; python.org publishes $ExpectedSha256"
    }
    Write-Host "Extracting to $DestDir..."
    Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $ZipPath -DestinationPath $DestDir -Force
} else {
    Write-Host "Python already present at $DestDir"
}

# Enable site-packages
$pthFile = Get-ChildItem $DestDir -Filter "python*._pth" | Select-Object -First 1
if ($pthFile) {
    @(
        ($pthFile.BaseName -replace '\._pth$','') + ".zip"
        "."
        "Lib\site-packages"
        "import site"
    ) | Set-Content $pthFile.FullName -Encoding ASCII
    Write-Host "Enabled site-packages in $($pthFile.Name)"
}

# Install pip
Write-Host "Installing pip..."
Invoke-DownloadWithRetry -Description "get-pip.py" -OutFile "$env:TEMP\get-pip.py" -Download {
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile "$env:TEMP\get-pip.py" `
        -TimeoutSec $DownloadRetryTimeoutSeconds
}
& $DestDir\python.exe "$env:TEMP\get-pip.py" --no-warn-script-location 2>&1 | Out-Null

# Install the hash-pinned dependency tree. Every package -- top-level AND
# transitive (cryptography, lxml, ...) -- is version- and hash-verified via
# --require-hashes, so a build is reproducible and can't silently pull a
# different transitive version. Top-level pins live in python-requirements.in;
# the full locked tree in python-requirements.txt is regenerated deliberately
# with lock-python-deps.ps1 (never floated automatically). pyHanko (for
# signature verification) pulls cryptography/asn1crypto/certvalidator.
$LockFile = "$PSScriptRoot\python-requirements.txt"
Write-Host "Installing hash-pinned dependencies from python-requirements.txt..."
& $DestDir\python.exe -m pip install --require-hashes -r $LockFile --no-warn-script-location 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Hash-verified dependency install failed" }

# Remove anything installed that the SHIPPED set no longer names. A
# re-provision over an existing tree skips the download (the version marker is
# present) and installs only what the manifests list -- so a package dropped
# from them survives, and the runtime keeps shipping it together with any
# native libraries it bundled, including ones a replacement exists to remove.
# The shipped set is exactly the two manifests, so this is derived from them
# rather than from a hand-kept list that could go stale the same way. It runs
# BEFORE the vendored install, whose gate refuses a surviving pi_heif
# distribution.
$Shipped = @{}
foreach ($line in (Get-Content $LockFile)) {
    if ($line -match '^([A-Za-z0-9._-]+)\s*==') {
        $Shipped[$Matches[1].ToLowerInvariant().Replace('_', '-').Replace('.', '-')] = $true
    }
}
foreach ($line in (Get-Content "$PSScriptRoot\vendored-wheels.tsv" -Encoding UTF8)) {
    if ($line -match '^#' -or $line -match '^package\t' -or -not $line.Trim()) { continue }
    $name = ($line -split "`t")[0].Trim()
    if ($name) { $Shipped[$name.ToLowerInvariant().Replace('_', '-').Replace('.', '-')] = $true }
}
# pip and its install-time companions are removed wholesale by the cleanup
# below; uninstalling them here would take pip out from under that step.
foreach ($tool in @('pip', 'setuptools', 'wheel')) { $Shipped[$tool] = $true }

$sitePackages = Join-Path $DestDir "Lib\site-packages"
$stale = @()
foreach ($di in (Get-ChildItem $sitePackages -Directory -Filter "*.dist-info" -ErrorAction SilentlyContinue)) {
    # <name>-<version>.dist-info, per the installed-project layout.
    $dist = ($di.Name -replace '\.dist-info$','') -replace '-[^-]+$',''
    $key = $dist.ToLowerInvariant().Replace('_', '-').Replace('.', '-')
    if (-not $Shipped.ContainsKey($key)) { $stale += $dist }
}
if ($stale) {
    Write-Host "Removing $($stale.Count) package(s) no longer in the shipped set: $($stale -join ', ')"
    foreach ($s in $stale) {
        # pip's own message is carried into the throw: a failed uninstall here
        # means the runtime would ship the package, and "it failed" without the
        # reason costs a second run to learn anything.
        $log = & $DestDir\python.exe -m pip uninstall $s -y 2>&1
        if ($LASTEXITCODE -ne 0) { throw "could not uninstall the stale package ${s}:`n$($log -join "`n")" }
    }
    # Proven gone rather than assumed: a pip uninstall that reports success but
    # leaves the dist-info behind would ship the package anyway.
    $left = @(Get-ChildItem $sitePackages -Directory -Filter "*.dist-info" | Where-Object {
        $d = ($_.Name -replace '\.dist-info$','') -replace '-[^-]+$',''
        -not $Shipped.ContainsKey($d.ToLowerInvariant().Replace('_', '-').Replace('.', '-'))
    })
    if ($left) { throw "stale packages survived the uninstall: $(($left | ForEach-Object Name) -join ', ')" }
}

# The wheels committed under vendor/wheels/ (HEIF decode). Installed from the
# repository with --no-index, so a package withdrawn from the index cannot
# break a build. Runs after the stale-package pruning above and BEFORE the
# cleanup below, which removes pip.
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\install-vendored-wheels.ps1" -Python "$DestDir\python.exe"
if ($LASTEXITCODE -ne 0) { throw "Vendored wheel install failed" }

# Cleanup -- remove pip, caches, install bookkeeping. dist-info dirs are
# PRUNED, not deleted: each wheel's METADATA (name/version/license fields)
# and license texts (licenses/, LICENSE*, COPYING*, NOTICE*, AUTHORS*) must
# ship with the runtime -- MIT/BSD-family licenses require their notice to
# accompany redistributed copies, and these files are the only copy the
# bundled runtime carries; deleting them would ship packages without notices.
Write-Host "Cleaning up..."
& $DestDir\python.exe -m pip uninstall pip -y 2>&1 | Out-Null
Get-ChildItem $DestDir -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
# RECORD is not a licence file but pip requires it to uninstall or upgrade a
# package. Without it, dependency upgrades fail with uninstall-no-record-file
# and the runtime must be rebuilt from scratch.
#
# LICEN[CS]E covers both spellings: openpyxl and et_xmlfile declare their MIT
# text as `LICENCE.rst`/`LICENCE.python`, and a LICENSE-only pattern shipped
# both packages with no licence text at all.
#
# DELVEWHEEL records the content-hash filename mangling delvewheel applied to a
# wheel's bundled DLLs. For the LGPL libraries in the HEIF wheel that file is
# the instruction a recipient needs to exercise the replacement right: a
# rebuilt library must be installed under the mangled name.
$Keep = '^(METADATA|RECORD|DELVEWHEEL|LICEN[CS]E.*|COPYING.*|COPYRIGHT.*|NOTICE.*|AUTHORS.*|LEGAL.*)$'
foreach ($di in (Get-ChildItem $DestDir -Recurse -Directory -Filter "*.dist-info")) {
    foreach ($f in (Get-ChildItem $di.FullName -File)) {
        if ($f.Name -notmatch $Keep) { Remove-Item $f.FullName -Force }
    }
    foreach ($sub in (Get-ChildItem $di.FullName -Directory)) {
        if ($sub.Name -ne 'licenses') { Remove-Item $sub.FullName -Recurse -Force }
    }
}
Get-ChildItem $DestDir -Recurse -Directory -Filter "tests" | Remove-Item -Recurse -Force
Remove-Item "$DestDir\Scripts" -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Embedded Python: ${sizeMB}MB"
