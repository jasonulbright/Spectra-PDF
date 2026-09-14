# One bounded retry policy for every vendored-resource download a CI or
# release job performs. Dot-source it: . "$PSScriptRoot/download-retry.ps1"
#
# A transient upstream failure is not a build failure: a 504 from a release
# asset store that serves the same URL a minute later has failed the job
# repeatedly. Only transient conditions are retried -- HTTP 408, 429 and 5xx,
# plus connect/timeout/reset transport failures. Every other 4xx is a real
# answer about the request and is raised on the first attempt.
#
# Retrying never relaxes acceptance: the caller's hash verification runs on
# the bytes of whatever attempt succeeded, unchanged.

$DownloadRetryAttempts = 4
$DownloadRetryBaseDelaySeconds = 3
$DownloadRetryTimeoutSeconds = 900

function Get-DownloadRetryBounds {
    return [ordered]@{
        Attempts = $DownloadRetryAttempts
        BaseDelaySeconds = $DownloadRetryBaseDelaySeconds
        TimeoutSeconds = $DownloadRetryTimeoutSeconds
    }
}

function Get-DownloadErrorStatus {
    param($ErrorRecord)
    # Windows PowerShell reports the status on WebException.Response; PowerShell
    # 7 on HttpResponseException. Both are read, innermost exception included.
    $exception = $ErrorRecord.Exception
    while ($exception) {
        foreach ($name in @('StatusCode', 'Response')) {
            $property = $exception.PSObject.Properties[$name]
            if (-not $property -or $null -eq $property.Value) { continue }
            $value = $property.Value
            if ($name -eq 'Response') {
                $status = $value.PSObject.Properties['StatusCode']
                if (-not $status -or $null -eq $status.Value) { continue }
                $value = $status.Value
            }
            try { return [int]$value } catch { }
        }
        $exception = $exception.InnerException
    }
    return 0
}

function Test-TransientDownloadError {
    param($ErrorRecord)
    $status = Get-DownloadErrorStatus $ErrorRecord
    if ($status -ge 400) {
        return ($status -eq 408 -or $status -eq 429 -or $status -ge 500)
    }
    $text = @()
    $exception = $ErrorRecord.Exception
    while ($exception) {
        $text += $exception.GetType().FullName
        $text += [string]$exception.Message
        $exception = $exception.InnerException
    }
    return (($text -join ' ') -match
        'timed out|timeout|TaskCanceled|reset|aborted|forcibly closed|closed by the remote|' +
        'connection was closed|unexpectedly closed|' +
        'unreachable|refused|remote name could not be resolved|No such host|' +
        'connection attempt failed|OperationCanceled')
}

function Invoke-DownloadWithRetry {
    <#
    .SYNOPSIS
    Run one download, retrying only transient upstream failures.
    .PARAMETER Download
    The single fetch to perform. It must carry its own per-attempt timeout.
    .PARAMETER OutFile
    Removed before each attempt, so a partial body never reaches a hash check.
    #>
    param(
        [Parameter(Mandatory)][scriptblock]$Download,
        [Parameter(Mandatory)][string]$Description,
        [string]$OutFile,
        [int]$Attempts = $DownloadRetryAttempts,
        [int]$BaseDelaySeconds = $DownloadRetryBaseDelaySeconds
    )
    if ($Attempts -lt 1) { throw "download retry needs at least one attempt" }
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if ($OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
        try {
            return & $Download
        } catch {
            $record = $_
            $status = Get-DownloadErrorStatus $record
            $label = if ($status -ge 400) { "HTTP $status" } else { $record.Exception.Message }
            if (-not (Test-TransientDownloadError $record)) { throw }
            if ($attempt -eq $Attempts) {
                throw "${Description}: transient download failure after $Attempts attempts ($label)"
            }
            $wait = $BaseDelaySeconds * $attempt
            Write-Host "  ${Description}: attempt $attempt/$Attempts failed ($label); retrying in ${wait}s..."
            Start-Sleep -Seconds $wait
        }
    }
}

function Get-CurlRetryArguments {
    # curl's own bounded retry covers the same conditions and nothing else:
    # without --retry-all-errors it retries timeouts, 408, 429, 5xx and
    # connection failures, and answers any other 4xx immediately.
    return @(
        '--retry', [string]($DownloadRetryAttempts - 1),
        '--retry-delay', [string]$DownloadRetryBaseDelaySeconds,
        '--retry-max-time', [string]($DownloadRetryTimeoutSeconds / 2),
        '--retry-connrefused',
        '--connect-timeout', '30',
        '--max-time', [string]$DownloadRetryTimeoutSeconds
    )
}
