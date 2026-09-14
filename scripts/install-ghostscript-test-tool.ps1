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
# The package repository fails intermittently (an access violation inside the
# vendor installer, a bare non-zero exit out of ChocolateyInstall.ps1, or a
# vendor installer that never exits), which fails a job that has already spent
# most of an hour. Attempts are therefore bounded and retried, and a run that
# exhausts them falls back to the pinned installer from the upstream project's
# own release, verified by hash before it is executed. The fallback keeps the
# capability-present axis off a single flaky package repository; it is a
# second source for the same test tool, not a pin of what users are expected
# to have.
#
# The fallback fetch is itself retried on a transient answer, because a 504
# from the release asset store fails this step while the same URL serves a
# minute later. The retry is bounded and the hash still runs on the bytes of
# whichever attempt returned.
#
# Worst case, every bound exhausted:
#   ChocoAttempts * (ChocoTimeoutSeconds + TerminationWaitSeconds)
#   + choco retry sleeps
#   + FallbackDownloadAttempts * FallbackDownloadTimeoutSeconds
#   + fallback download retry sleeps
#   + FallbackTimeoutSeconds + TerminationWaitSeconds
# The workflow step's timeout-minutes sits above that sum. Every constant
# below is part of it: raising one without the others crossing back under the
# deadline is what the bound test refuses.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot "download-retry.ps1")

$ChocoAttempts = 2
$ChocoTimeoutSeconds = 300
$RetrySleepSeconds = 15
$TerminationWaitSeconds = 30
$FallbackDownloadAttempts = 3
$FallbackDownloadTimeoutSeconds = 90
$FallbackDownloadRetrySleepSeconds = 5
# A silent NSIS install of this package completes in well under a minute; this
# bounds a hang, and the hang it bounds once ran for six hours.
$FallbackTimeoutSeconds = 420

# Upstream release gs10071; sha256 as published for the release asset.
$FallbackVersion = '10.07.1'
$FallbackUrl = 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10071/gs10071w64.exe'
$FallbackSha256 = '3a4c28d0aac47aa7cccd35a5932c55110376e9dbd966898dde388b7faba444a4'

$installer = Join-Path $env:RUNNER_TEMP 'ghostscript-fallback.exe'

function Get-GhostscriptInstallerProcess {
    $chocoRoot = if ($env:ChocolateyInstall) { $env:ChocolateyInstall } else { 'C:\ProgramData\chocolatey' }
    $packageDirs = @(
        (Join-Path $chocoRoot 'lib\Ghostscript.app'),
        (Join-Path $chocoRoot 'lib-bad\Ghostscript.app')
    ) | ForEach-Object { $_.TrimEnd('\') + '\' }
    $fallbackPath = [System.IO.Path]::GetFullPath($installer)
    @(Get-CimInstance -ClassName Win32_Process | Where-Object {
        $path = $_.ExecutablePath
        if ($_.ProcessId -eq $PID) { return $false }
        # gs<version>w64.exe is the vendor installer's file name; gswin64c.exe
        # (the installed interpreter) does not match it.
        if ($_.Name -match '^gs\d+w64\.exe$') { return $true }
        if (-not $path) { return $false }
        if ($path -ieq $fallbackPath) { return $true }
        foreach ($dir in $packageDirs) {
            if ($path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    })
}

# A timed-out Chocolatey run leaves its installer alive holding the package's
# tools\gs*w64.exe open, so the next attempt fails on a locked file and the
# fallback collides with a live installer.
function Stop-GhostscriptInstallerProcess {
    $leftovers = Get-GhostscriptInstallerProcess
    if ($leftovers.Count -eq 0) { return }
    foreach ($p in $leftovers) {
        Write-Host "::warning::terminating leftover Ghostscript installer pid $($p.ProcessId): $($p.ExecutablePath)"
        & taskkill.exe /PID $p.ProcessId /T /F | Out-Host
    }
    $deadline = (Get-Date).AddSeconds($TerminationWaitSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-GhostscriptInstallerProcess).Count -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    $alive = (Get-GhostscriptInstallerProcess | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }) -join '; '
    throw "Ghostscript installer processes still running $TerminationWaitSeconds s after termination: $alive"
}

$installed = $false
for ($attempt = 1; $attempt -le $ChocoAttempts; $attempt++) {
    choco install ghostscript -y --no-progress --execution-timeout=$ChocoTimeoutSeconds
    $code = $LASTEXITCODE
    # 3010 is a successful install that requests a reboot; nothing here needs one.
    if ($code -eq 0 -or $code -eq 3010) { $installed = $true; break }
    Write-Host "::warning::choco install ghostscript failed (attempt $attempt, exit $code)"
    Stop-GhostscriptInstallerProcess
    if ($attempt -lt $ChocoAttempts) { Start-Sleep -Seconds ($RetrySleepSeconds * $attempt) }
}

if (-not $installed) {
    Write-Host "::warning::falling back to the pinned upstream Ghostscript $FallbackVersion installer"
    Invoke-DownloadWithRetry -Description "Ghostscript $FallbackVersion installer" `
        -OutFile $installer -Attempts $FallbackDownloadAttempts `
        -BaseDelaySeconds $FallbackDownloadRetrySleepSeconds -Download {
        Invoke-WebRequest -Uri $FallbackUrl -OutFile $installer -UseBasicParsing -TimeoutSec $FallbackDownloadTimeoutSeconds
    }
    $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $FallbackSha256) {
        throw "Ghostscript installer hash mismatch: expected $FallbackSha256, got $actual"
    }
    # NSIS silent install; lands in the same ProgramFiles\gs\gs<version> layout
    # the path export resolves against. Start-Process -Wait also waits on every
    # descendant, so a lingering child blocks it after the installer exits;
    # the wait is on the installer process object alone.
    $proc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru
    # ExitCode reads as null for a process whose handle was never opened
    # before it exited.
    $null = $proc.Handle
    if (-not $proc.WaitForExit($FallbackTimeoutSeconds * 1000)) {
        & taskkill.exe /PID $proc.Id /T /F | Out-Host
        try { Stop-GhostscriptInstallerProcess } catch { Write-Host "::warning::$_" }
        throw "Ghostscript fallback installer did not exit within $FallbackTimeoutSeconds s; terminated"
    }
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
