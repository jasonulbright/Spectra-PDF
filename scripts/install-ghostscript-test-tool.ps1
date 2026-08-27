# Installs Ghostscript on a CI runner as a TEST TOOL.
#
# Ghostscript is not vendored and not shipped: the product discovers a
# user-installed one and disables its dependent features when none is
# configured. The capability-PRESENT axis of the suites still needs a real
# Ghostscript on the machine, so CI installs one the way a user would.
#
# Primary path is the current Chocolatey package, unpinned, so the run keeps
# exercising what a Windows user actually gets today; the product's capability
# probe, not this script, enforces the minimum version.
#
# The package repository fails intermittently (observed: an access violation
# inside the vendor installer, and a bare non-zero exit out of
# ChocolateyInstall.ps1), which fails a job that has already spent most of an
# hour. Attempts are therefore retried, and a run that exhausts them falls back
# to the pinned installer from the upstream project's own release, verified by
# hash before it is executed. The fallback keeps the capability-present axis off
# a single flaky package repository; it is a second source for the same test
# tool, not a pin of what users are expected to have.

$ErrorActionPreference = 'Stop'

# Upstream release gs10071; sha256 as published for the release asset.
$FallbackVersion = '10.07.1'
$FallbackUrl = 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10071/gs10071w64.exe'
$FallbackSha256 = '3a4c28d0aac47aa7cccd35a5932c55110376e9dbd966898dde388b7faba444a4'

$installed = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    choco install ghostscript -y --no-progress
    $code = $LASTEXITCODE
    # 3010 is a successful install that requests a reboot; nothing here needs one.
    if ($code -eq 0 -or $code -eq 3010) { $installed = $true; break }
    Write-Host "::warning::choco install ghostscript failed (attempt $attempt, exit $code)"
    if ($attempt -lt 3) { Start-Sleep -Seconds (15 * $attempt) }
}

if (-not $installed) {
    Write-Host "::warning::falling back to the pinned upstream Ghostscript $FallbackVersion installer"
    $installer = Join-Path $env:RUNNER_TEMP 'ghostscript-fallback.exe'
    Invoke-WebRequest -Uri $FallbackUrl -OutFile $installer -UseBasicParsing
    $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $FallbackSha256) {
        throw "Ghostscript installer hash mismatch: expected $FallbackSha256, got $actual"
    }
    # NSIS silent install; lands in the same ProgramFiles\gs\gs<version> layout
    # the path export resolves against.
    $proc = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "Ghostscript fallback installer exited $($proc.ExitCode)"
    }
}

# A choco attempt can fail after laying down files, so more than one version
# directory can exist here; the newest is the one that finished installing.
$candidates = @(Get-ChildItem "${env:ProgramFiles}\gs\gs*\bin\gswin64c.exe" -File -ErrorAction SilentlyContinue)
if ($candidates.Count -eq 0) { throw 'No installed Ghostscript found after install' }
$selected = ($candidates | Sort-Object { [version]($_.Directory.Parent.Name -replace '^gs', '') } -Descending)[0]
Write-Host "Ghostscript test tool: $($selected.FullName)"
