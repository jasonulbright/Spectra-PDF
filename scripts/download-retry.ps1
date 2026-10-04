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

# The hosts that receive the GitHub credential, over HTTPS on port 443 only.
# Redirects are followed explicitly: same-origin hops retain authorization;
# leaving that origin removes it for the rest of the redirect chain.
$GitHubHosts = @(
    'api.github.com',
    'github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'codeload.github.com',
    'release-assets.githubusercontent.com'
)
$GitHubTokenTimeoutMilliseconds = 15000

function Test-GitHubUri {
    param([Parameter(Mandatory)][string]$Uri)
    $parsed = $null
    if (-not [Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$parsed)) { return $false }
    return ($parsed.Scheme -eq 'https' -and $parsed.Port -eq 443 -and
        $GitHubHosts -contains $parsed.Host.ToLowerInvariant())
}

function Get-GitHubTokenFromGh {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { return '' }
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $gh.Source
        $start.Arguments = 'auth token'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($start)
        $process.StandardInput.Close()
        $read = $process.StandardOutput.ReadToEndAsync()
        $null = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($GitHubTokenTimeoutMilliseconds)) {
            try { $process.Kill() } catch { }
            return ''
        }
        if ($process.ExitCode -ne 0) { return '' }
        $words = @($read.Result.Split([char[]]" `t`r`n", [StringSplitOptions]::RemoveEmptyEntries))
        if ($words.Count -ne 1) { return '' }
        return $words[0]
    } catch {
        return ''
    }
}

function Get-GitHubTokenFromEnvironment {
    foreach ($name in @('GH_TOKEN', 'GITHUB_TOKEN')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value -and $value.Trim()) { return $value.Trim() }
    }
    return ''
}

function Get-GitHubToken {
    <#
    .SYNOPSIS
    The GitHub credential: GH_TOKEN, then GITHUB_TOKEN, then `gh auth token`;
    '' when none resolves. Resolved once per session. A value holding any
    character outside [A-Za-z0-9_] counts as none: a header the request layer
    refuses is quoted in its error text.
    #>
    $cached = Get-Variable -Name GitHubTokenResolved -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $cached) { return $cached }
    $found = [string](Get-Variable -Name GitHubTokenKept -Scope Script -ValueOnly -ErrorAction SilentlyContinue)
    if (-not $found) { $found = Get-GitHubTokenFromEnvironment }
    if (-not $found) { $found = Get-GitHubTokenFromGh }
    if ($found -cnotmatch '^[A-Za-z0-9_]+$') { $found = '' }
    Set-Variable -Name GitHubTokenResolved -Scope Script -Value ([string]$found)
    return [string]$found
}

function Get-RequiredGitHubToken {
    <#
    .SYNOPSIS
    The GitHub credential for a request to a GitHub host; throws, before any
    request, when none resolves.
    #>
    param([Parameter(Mandatory)][string]$Uri)
    $token = Get-GitHubToken
    if (-not $token) {
        throw ("no GitHub credential for $(([Uri]$Uri).Host): set GH_TOKEN or GITHUB_TOKEN " +
               "to a GitHub token, or sign in with ``gh auth login``")
    }
    return $token
}

function Get-GitHubCurlConfig {
    <#
    .SYNOPSIS
    A curl config line carrying the GitHub credential, for `curl.exe -K -` on
    stdin: an argument would show the token in the process list. Throws for a
    host outside the GitHub list or when no token resolves.
    #>
    param([Parameter(Mandatory)][string]$Uri)
    if (-not (Test-GitHubUri $Uri)) { throw "not a GitHub URL: $Uri" }
    $token = Get-RequiredGitHubToken -Uri $Uri
    return "header = `"Authorization: Bearer $token`""
}

function Get-GitHubAuthHeader {
    <#
    .SYNOPSIS
    The -Headers table for one request: Authorization for a GitHub host,
    otherwise empty. Throws for a GitHub host when no token resolves.
    #>
    param([Parameter(Mandatory)][string]$Uri)
    $headers = @{}
    if (Test-GitHubUri $Uri) {
        $headers['Authorization'] = "Bearer $(Get-RequiredGitHubToken -Uri $Uri)"
    }
    return $headers
}

function Remove-GitHubTokenFromEnvironment {
    <#
    .SYNOPSIS
    Keeps the GH_TOKEN or GITHUB_TOKEN value for this session's own requests
    and removes both variables from the process environment, so a program
    started afterwards never inherits them. Starts no program itself: with
    neither variable set, a later request still resolves through `gh`.
    #>
    $kept = [string](Get-Variable -Name GitHubTokenKept -Scope Script -ValueOnly -ErrorAction SilentlyContinue)
    if (-not $kept) {
        Set-Variable -Name GitHubTokenKept -Scope Script -Value ([string](Get-GitHubTokenFromEnvironment))
    }
    # [Environment]::SetEnvironmentVariable($name, $null) receives '' from
    # PowerShell, which PowerShell 7 keeps as an empty variable.
    Remove-Item -Path Env:GH_TOKEN, Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
}

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

function Invoke-ScopedDownload {
    param([string]$Uri, [string]$OutFile, [int]$TimeoutSec, [hashtable]$Headers, [string]$UserAgent)
    $current = [Uri]$Uri
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    for ($hop = 0; ; $hop++) {
        $remaining = $TimeoutSec - [int][Math]::Floor($watch.Elapsed.TotalSeconds)
        if ($remaining -le 0) { throw 'download timed out while following redirects' }
        $request = @{
            Uri = $current.AbsoluteUri; OutFile = $OutFile; Headers = $Headers
            UseBasicParsing = $true; PassThru = $true; MaximumRedirection = 0
            TimeoutSec = $remaining; ErrorAction = 'SilentlyContinue'; ErrorVariable = 'hopErrors'
        }
        if ($UserAgent) { $request['UserAgent'] = $UserAgent }
        try {
            $hopErrors = @()
            $response = Invoke-WebRequest @request
            # Windows PowerShell returns the redirect response and writes a
            # nonterminating maximum-redirection error. Retain that response;
            # other failures still reach the retry policy with their status.
            if (-not $response -and $hopErrors.Count) { throw $hopErrors[0] }
        } catch {
            $response = $_.Exception.Response
            if (-not $response -or [int]$response.StatusCode -notin @(301, 302, 303, 307, 308)) { throw }
        }
        if ([int]$response.StatusCode -notin @(301, 302, 303, 307, 308)) { return }
        if ($hop -ge 5) { throw 'download exceeded five redirects' }
        $location = [string]$response.Headers.Location
        if (-not $location) { throw 'download redirect has no Location header' }
        $next = [Uri]::new($current, $location)
        if ($next.Scheme -notin @('https', 'http')) { throw 'download redirect is not HTTP or HTTPS' }
        if ($next.Scheme -ne $current.Scheme -or $next.Host -ne $current.Host -or $next.Port -ne $current.Port) {
            $Headers = @{}
        }
        $current = $next
    }
}

function Invoke-DownloadWithRetry {
    <#
    .SYNOPSIS
    Run one download, retrying only transient upstream failures.
    .PARAMETER Uri
    The URL to save to -OutFile. The request carries the GitHub credential
    when the host is a GitHub host (Get-GitHubAuthHeader).
    .PARAMETER Download
    A custom fetch, instead of -Uri. It must carry its own per-attempt timeout
    and receives no credential.
    .PARAMETER OutFile
    Removed before each attempt, so a partial body never reaches a hash check.
    #>
    param(
        [string]$Uri,
        [scriptblock]$Download,
        [Parameter(Mandatory)][string]$Description,
        [string]$OutFile,
        [int]$TimeoutSec = $DownloadRetryTimeoutSeconds,
        [string]$UserAgent,
        [int]$Attempts = $DownloadRetryAttempts,
        [int]$BaseDelaySeconds = $DownloadRetryBaseDelaySeconds
    )
    if ([bool]$Uri -eq [bool]$Download) { throw "download retry needs exactly one of -Uri and -Download" }
    if ($Uri) {
        if (-not $OutFile) { throw "download retry with -Uri needs -OutFile" }
        $request = @{
            Uri = $Uri
            OutFile = $OutFile
            TimeoutSec = $TimeoutSec
            Headers = (Get-GitHubAuthHeader -Uri $Uri)
        }
        if ($UserAgent) { $request['UserAgent'] = $UserAgent }
        $Download = { Invoke-ScopedDownload @request }
    }
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
