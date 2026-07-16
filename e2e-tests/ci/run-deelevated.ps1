# Runs a command NON-ELEVATED (Medium integrity) from an elevated CI step.
#
# Why this exists: CI runners execute jobs elevated, but WebView2's DevTools
# debugging endpoint is gated for elevated host processes on current runtimes
# (the v150 trusted-origin check — MicrosoftEdge/WebView2Feedback#5640), so
# WebDriver sessions against the app can only be created from a de-elevated
# process — which is also how end users actually run the app.
#
# Mechanism: a SAFER "Basic User" restricted token via `runas /trustlevel`
# (Secondary Logon). A scheduled task with -RunLevel Limited was tried first
# and did NOT de-elevate on the runner image — consistent with the image
# running UAC-disabled, where an admin user has no filtered token and
# "Limited" is a no-op. SAFER tokens drop the Administrators group and set
# Medium IL regardless of UAC state. The child prints its own token's
# integrity level into the log (TOKEN-IL line) so every run PROVES the level
# it executed at instead of assuming it.
#
# The child does not reliably inherit the step's environment, so PATH is
# baked into a generated inner script; output is written to a file and
# replayed into the step log; the inner exit code is propagated.
param(
  [Parameter(Mandatory = $true)] [string]$Command,
  [Parameter(Mandatory = $true)] [string]$WorkingDirectory,
  [int]$TimeoutMinutes = 40
)

$ErrorActionPreference = 'Stop'
$stamp = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$logFile = Join-Path $tmp "deelev-$stamp.log"
$rcFile = Join-Path $tmp "deelev-$stamp.rc"
$innerFile = Join-Path $tmp "deelev-$stamp.ps1"
$wd = (Resolve-Path $WorkingDirectory).Path
$pathLiteral = $env:Path -replace "'", "''"

@"
`$ErrorActionPreference = 'Continue'
"TOKEN-IL: " + ((whoami /groups | Select-String 'Mandatory Label').Line.Trim() -replace '\s+', ' ') |
  Out-File -FilePath '$logFile' -Encoding utf8
`$env:Path = '$pathLiteral'
Set-Location '$wd'
$Command *>&1 | Out-File -FilePath '$logFile' -Encoding utf8 -Append
Set-Content -Path '$rcFile' -Value `$LASTEXITCODE
"@ | Set-Content -Path $innerFile -Encoding utf8

# SAFER needs the Secondary Logon service; runner images leave it manual-start.
try { Start-Service seclogon -ErrorAction Stop } catch { Write-Host "seclogon: $($_.Exception.Message)" }

$runasCmd = "pwsh.exe -NoProfile -NonInteractive -File `"$innerFile`""
Write-Host "launching de-elevated (SAFER Basic User): $Command"
$runasOut = & runas /trustlevel:0x20000 $runasCmd 2>&1
if ($runasOut) { Write-Host ($runasOut | Out-String).Trim() }

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$launchDeadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path $rcFile) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  if (-not (Test-Path $logFile) -and (Get-Date) -gt $launchDeadline) {
    Write-Host "##[error]de-elevated child never started (no log after 3 minutes) — runas/seclogon problem above?"
    exit 126
  }
}

if (Test-Path $logFile) { Get-Content $logFile }
if (-not (Test-Path $rcFile)) {
  Write-Host "##[error]de-elevated command timed out after $TimeoutMinutes minutes"
  Get-Process -Name openpdfstudio, msedgedriver, 'tauri-driver' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  exit 124
}
$rc = [int](Get-Content $rcFile -Raw).Trim()
Write-Host "de-elevated command exit code: $rc"
exit $rc
