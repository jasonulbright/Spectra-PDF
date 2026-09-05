# Authenticode sign one file. Invoked by the bundler for every binary it
# produces (`bundle.windows.signCommand` in src-tauri/tauri.conf.json), so the
# app executable is signed before NSIS packs it and the installer is signed
# after -- the portable zip copies the same already-signed executable the
# installer stages.
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

param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -cne "true" -or $env:SPECTRAPDF_SIGN -cne "1") {
    Write-Host "sign-windows: not signing '$Path' (local build; signing runs only in the release pipeline)"
    exit 0
}

. (Join-Path $PSScriptRoot "windows-signing.ps1")

if (-not (Test-Path -LiteralPath $Path)) { throw "sign-windows: nothing to sign at '$Path'" }

foreach ($name in @("SPECTRAPDF_SIGN_ENDPOINT", "SPECTRAPDF_SIGN_ACCOUNT", "SPECTRAPDF_SIGN_PROFILE")) {
    if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue)) {
        throw "sign-windows: $name is not set; the signing job must supply the account coordinates"
    }
}

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

$signtool = Get-SignToolPath
$dlib = Get-ArtifactSigningDlibPath
Write-Host "sign-windows: signtool=$signtool dlib=$dlib target=$Path"

$signArgs = @(
    "sign", "/v", "/debug", "/fd", "SHA256",
    "/tr", "http://timestamp.acs.microsoft.com", "/td", "SHA256",
    "/dlib", "`"$dlib`"", "/dmdf", "`"$metadataPath`"", "`"$Path`""
)
$stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) "spectrapdf-signtool-out.log"
$stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "spectrapdf-signtool-err.log"

$proc = Start-Process -FilePath $signtool -ArgumentList $signArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait:$false

function Write-SignToolLogs {
    foreach ($log in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | Write-Host }
    }
}

if (-not $proc.WaitForExit(600000)) {
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
    Write-SignToolLogs
    throw "sign-windows: signtool did not finish within 10 minutes for '$Path'"
}
Write-SignToolLogs

$LASTEXITCODE = $proc.ExitCode
if ($LASTEXITCODE -ne 0) { throw "sign-windows: signtool sign failed for '$Path' (exit $LASTEXITCODE)" }
