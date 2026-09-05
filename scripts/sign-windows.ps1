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
# The credential comes from the Azure login the job performs before the build;
# the dlib resolves it through DefaultAzureCredential.

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
}
$metadataPath = Join-Path ([System.IO.Path]::GetTempPath()) "spectrapdf-signing-metadata.json"
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 3), [System.Text.UTF8Encoding]::new($false))

$signtool = Get-SignToolPath
$dlib = Get-ArtifactSigningDlibPath
Write-Host "sign-windows: signtool=$signtool dlib=$dlib target=$Path"

& $signtool sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
    /dlib $dlib /dmdf $metadataPath $Path
if ($LASTEXITCODE -ne 0) { throw "sign-windows: signtool sign failed for '$Path' (exit $LASTEXITCODE)" }
