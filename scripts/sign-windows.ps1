# Authenticode sign one file. Invoked by the bundler for every binary it
# produces or stages (`bundle.windows.signCommand` in
# src-tauri/tauri.conf.json), which is a wider set than the three artifacts
# this project signs: the app executable, the installer, and the uninstaller.
# Test-SignedArtifact holds that set, so the app executable is signed before
# NSIS packs it and the installer after -- the portable zip copies the same
# already-signed executable the installer stages -- while NSIS plugins and
# vendored third-party binaries pass through untouched.
#
# Signing happens ONLY in the release pipeline: outside it the script prints one
# line and exits 0. A developer build has no Azure credential and no client
# tools, and a signing step that failed there would make `npm run tauri build`
# unusable without changing anything about what ships.
#
# The credential comes from the Azure login the job performs before the build.
# The dlib resolves it through DefaultAzureCredential, whose other sources do not
# fail fast on an Azure-hosted runner -- a managed-identity probe there blocks
# rather than erroring -- so only the CLI credential is allowed to be tried.
# signtool runs under a hard timeout: a credential that never returns would
# otherwise hold the job open for its entire limit.
#
# The bundler spawns this script with piped stdio and DISCARDS both streams,
# reporting only "failed to run powershell", so every line and every terminating
# error is also appended to a file under <RUNNER_TEMP>\sign-windows. The
# directory name is fixed because the workflow prints its contents after the
# build step regardless of outcome.
#
# Nothing here may depend on module autoloading: the bundler's parent process
# can hand down a PSModulePath that leaves Microsoft.PowerShell.Security
# unloadable, which turns a cmdlet call into a terminating error before any
# signing is attempted. Signature state is read through signtool, which is a
# process, not a module.

param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Path
)

$ErrorActionPreference = "Stop"

if ($env:GITHUB_ACTIONS -cne "true" -or $env:SPECTRAPDF_SIGN -cne "1") {
    Write-Host "sign-windows: not signing '$Path' (local build; signing runs only in the release pipeline)"
    exit 0
}

$logRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$logDir = Join-Path $logRoot "sign-windows"
$logLeaf = "unknown"
try { $logLeaf = [System.IO.Path]::GetFileName(($Path -replace '/', '\')) } catch { }
if (-not $logLeaf) { $logLeaf = "unknown" }
$logFile = Join-Path $logDir ("{0}-{1}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), $logLeaf)
try { $null = New-Item -ItemType Directory -Force -Path $logDir } catch { }

function Write-SignLog {
    param([string]$Message)
    Write-Host $Message
    # A log that cannot be written must not become the failure the log exists
    # to explain.
    try { [System.IO.File]::AppendAllText($logFile, $Message + [System.Environment]::NewLine) } catch { }
}

try {
    Write-SignLog "sign-windows: target=$Path"
    Write-SignLog "sign-windows: cwd=$((Get-Location).Path)"
    Write-SignLog "sign-windows: psversion=$($PSVersionTable.PSVersion)"
    Write-SignLog "sign-windows: psmodulepath=$env:PSModulePath"
    Write-SignLog "sign-windows: userinteractive=$([Environment]::UserInteractive) outputredirected=$([Console]::IsOutputRedirected)"

    . (Join-Path $PSScriptRoot "windows-signing.ps1")

    if (-not (Test-SignedArtifact $Path)) {
        Write-SignLog "sign-windows: not signing '$Path' (outside the signed set: app executable, installer, uninstaller)"
        exit 0
    }

    if (-not (Test-Path -LiteralPath $Path)) { throw "sign-windows: nothing to sign at '$Path'" }

    foreach ($name in @("SPECTRAPDF_SIGN_ENDPOINT", "SPECTRAPDF_SIGN_ACCOUNT", "SPECTRAPDF_SIGN_PROFILE")) {
        if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue)) {
            throw "sign-windows: $name is not set; the signing job must supply the account coordinates"
        }
    }

    $signtool = Get-SignToolPath
    $dlib = Get-ArtifactSigningDlibPath
    Write-SignLog "sign-windows: signtool=$signtool dlib=$dlib"

    # A file that already verifies is not re-signed: a second signature would
    # replace an existing attribution, and the bundler stages files it did not
    # produce. signtool's own verify answers this without loading a module.
    $verifyOutput = & $signtool verify /pa /q $Path 2>&1
    $verifyCode = $LASTEXITCODE
    if ($verifyCode -eq 0) {
        Write-SignLog "sign-windows: not signing '$Path' (already carries a valid signature)"
        exit 0
    }
    Write-SignLog "sign-windows: verify /pa exit $verifyCode (unsigned or not yet valid): $($verifyOutput -join ' ')"

    $metadata = [ordered]@{
        Endpoint               = $env:SPECTRAPDF_SIGN_ENDPOINT
        CodeSigningAccountName = $env:SPECTRAPDF_SIGN_ACCOUNT
        CertificateProfileName = $env:SPECTRAPDF_SIGN_PROFILE
        ExcludeCredentials     = @(
            "EnvironmentCredential",
            "WorkloadIdentityCredential",
            "ManagedIdentityCredential",
            "SharedTokenCacheCredential",
            "VisualStudioCredential",
            "VisualStudioCodeCredential",
            "AzurePowerShellCredential",
            "AzureDeveloperCliCredential",
            "InteractiveBrowserCredential"
        )
    }
    $metadataPath = Join-Path ([System.IO.Path]::GetTempPath()) "spectrapdf-signing-metadata.json"
    [System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 3), [System.Text.UTF8Encoding]::new($false))

    $signArgs = @(
        "sign", "/v", "/debug", "/fd", "SHA256",
        "/tr", "http://timestamp.acs.microsoft.com", "/td", "SHA256",
        "/dlib", "`"$dlib`"", "/dmdf", "`"$metadataPath`"", "`"$Path`""
    )
    $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) "spectrapdf-signtool-out.log"
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "spectrapdf-signtool-err.log"

    $proc = Start-Process -FilePath $signtool -ArgumentList $signArgs -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait:$false
    # ExitCode is unavailable unless the process handle is cached before the process exits.
    $null = $proc.Handle

    function Write-SignToolLogs {
        foreach ($log in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $log) {
                foreach ($line in (Get-Content -LiteralPath $log)) { Write-SignLog $line }
            }
        }
    }

    if (-not $proc.WaitForExit(600000)) {
        & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
        Write-SignToolLogs
        throw "sign-windows: signtool did not finish within 10 minutes for '$Path'"
    }
    Write-SignToolLogs

    $exitCode = $proc.ExitCode
    if ($null -eq $exitCode) { throw "sign-windows: signtool exit code unavailable" }
    $LASTEXITCODE = $exitCode
    if ($LASTEXITCODE -ne 0) { throw "sign-windows: signtool sign failed for '$Path' (exit $LASTEXITCODE)" }
} catch {
    $detail = ($_ | Out-String) + [System.Environment]::NewLine + ($_.ScriptStackTrace | Out-String)
    Write-SignLog $detail
    # The caller's stderr is discarded by the bundler but read by every other
    # invoker, so the failure travels on both channels.
    [Console]::Error.Write($detail)
    exit 1
} finally {
    Write-Host "sign-windows: log at $logFile"
}
