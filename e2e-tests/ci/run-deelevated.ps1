# Runs a command NON-ELEVATED (Medium integrity) from an elevated CI step.
#
# Why this exists: CI runners execute jobs elevated, but WebView2's DevTools
# debugging endpoint is gated for elevated host processes on current runtimes
# (the v150 trusted-origin check — MicrosoftEdge/WebView2Feedback#5640), so
# WebDriver sessions against the app can only be created from a de-elevated
# process — which is also how end users actually run the app. Windows offers
# exactly one supported de-elevation primitive usable non-interactively: a
# scheduled task registered with -RunLevel Limited, which executes with the
# user's filtered (non-admin) token in the interactive session.
#
# The task does not inherit the step's environment, so PATH is baked into the
# generated inner script verbatim. Output is teed to a file and replayed into
# the step log; the inner exit code is propagated as this script's exit code.
param(
  [Parameter(Mandatory = $true)] [string]$Command,
  [Parameter(Mandatory = $true)] [string]$WorkingDirectory,
  [int]$TimeoutMinutes = 40
)

$ErrorActionPreference = 'Stop'
$stamp = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$taskName = "ci-deelev-$stamp"
$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$logFile = Join-Path $tmp "deelev-$stamp.log"
$rcFile = Join-Path $tmp "deelev-$stamp.rc"
$wd = (Resolve-Path $WorkingDirectory).Path
$pathLiteral = $env:Path -replace "'", "''"

$inner = @(
  "`$env:Path = '$pathLiteral'",
  "Set-Location '$wd'",
  "$Command *>&1 | Out-File -FilePath '$logFile' -Encoding utf8",
  "Set-Content -Path '$rcFile' -Value `$LASTEXITCODE"
) -join '; '
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

$action = New-ScheduledTaskAction -Execute 'pwsh.exe' `
  -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes)

Register-ScheduledTask -TaskName $taskName -Action $action `
  -Principal $principal -Settings $settings -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  do {
    Start-Sleep -Seconds 5
    $state = (Get-ScheduledTask -TaskName $taskName).State
  } while ($state -ne 'Ready' -and (Get-Date) -lt $deadline)

  if ($state -ne 'Ready') {
    Stop-ScheduledTask -TaskName $taskName
    Write-Host "##[error]de-elevated command timed out after $TimeoutMinutes minutes"
    if (Test-Path $logFile) { Get-Content $logFile }
    exit 124
  }

  if (Test-Path $logFile) { Get-Content $logFile }
  $rc = if (Test-Path $rcFile) { [int](Get-Content $rcFile -Raw).Trim() } else { 125 }
  Write-Host "de-elevated command exit code: $rc"
  exit $rc
}
finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
