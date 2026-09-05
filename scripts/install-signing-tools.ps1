# Install the Artifact Signing client tools on a build runner: the signtool
# build that can load the signing dlib, plus the dlib itself. Build tooling, not
# a shipped runtime.
#
# Two sources, in order. winget is the documented one but needs a package
# manager that is not guaranteed to be reachable from an unattended service
# account; the NuGet payload is the same files in a zip and needs nothing but
# a download. The fallback exports SPECTRAPDF_SIGN_DLIB so the resolver in
# windows-signing.ps1 takes the extracted copy rather than searching for an
# install that never happened.

param(
    [string]$NuGetPackage = "Microsoft.ArtifactSigning.Client",
    [string]$ExtractRoot = "$env:RUNNER_TEMP\artifact-signing-client",
    # Exercises the NuGet branch on a machine that already carries an install.
    [switch]$SkipWinget
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "windows-signing.ps1")

function Test-ToolsPresent {
    try {
        $dlib = Get-ArtifactSigningDlibPath
        Write-Host "artifact signing dlib: $dlib"
        return $true
    } catch {
        return $false
    }
}

# Everything ahead of the NuGet fetch is opportunistic: a probe or a diagnostic
# that throws must not cost the release the fallback, which is the only branch
# that is verified to produce the dlib. The fetch itself is the sole fatal path.
try {
    if (-not $SkipWinget -and (Test-ToolsPresent)) {
        Write-Host "install-signing-tools: the client tools are already present"
        exit 0
    }

    $winget = if ($SkipWinget) { $null } else { Get-Command winget.exe -ErrorAction SilentlyContinue }
    if ($winget) {
        Write-Host "install-signing-tools: trying winget"
        & $winget.Source install -e --id Microsoft.Azure.ArtifactSigningClientTools `
            --accept-package-agreements --accept-source-agreements --disable-interactivity
        Write-Host "install-signing-tools: winget exited $LASTEXITCODE"
        if (Test-ToolsPresent) { exit 0 }
        # A winget install that reports success but leaves nothing the resolver
        # can find is only diagnosable from the uninstall entries it did write.
        $registered = @(Get-ArtifactSigningInstallHits)
        if ($registered.Count -eq 0) {
            Write-Host "install-signing-tools: no signing-client uninstall entry is registered"
        } else {
            foreach ($hit in $registered) {
                Write-Host "install-signing-tools: registered '$($hit.DisplayName)' at '$($hit.InstallLocation)'"
            }
        }
    } elseif ($SkipWinget) {
        Write-Host "install-signing-tools: skipping winget"
    } else {
        Write-Host "install-signing-tools: winget is not on PATH"
    }
} catch {
    Write-Host "install-signing-tools: pre-fallback step failed, continuing to the NuGet payload: $($_.Exception.Message)"
}

# NuGet fallback: a .nupkg is a zip, so no NuGet client is required.
if (-not $ExtractRoot) { $ExtractRoot = Join-Path ([System.IO.Path]::GetTempPath()) "artifact-signing-client" }
if (Test-Path -LiteralPath $ExtractRoot) { Remove-Item -LiteralPath $ExtractRoot -Recurse -Force }
New-Item -ItemType Directory -Path $ExtractRoot | Out-Null

$index = Invoke-RestMethod -Uri "https://api.nuget.org/v3-flatcontainer/$($NuGetPackage.ToLowerInvariant())/index.json"
$version = @($index.versions)[-1]
$nupkg = Join-Path $ExtractRoot "$NuGetPackage.$version.nupkg"
Write-Host "install-signing-tools: fetching $NuGetPackage $version from nuget.org"
& curl.exe --fail --silent --show-error --location `
    -o $nupkg "https://api.nuget.org/v3-flatcontainer/$($NuGetPackage.ToLowerInvariant())/$version/$($NuGetPackage.ToLowerInvariant()).$version.nupkg"
if ($LASTEXITCODE -ne 0) { throw "install-signing-tools: could not download $NuGetPackage $version" }

$extracted = Join-Path $ExtractRoot "package"
# Expand-Archive refuses any extension but .zip; the zip reader does not care.
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $extracted)
$dlibs = @(Get-ChildItem -LiteralPath $extracted -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -File)
$x64 = @($dlibs | Where-Object { $_.FullName -like "*\x64\*" })
if ($x64.Count -gt 0) { $dlibs = $x64 }
if ($dlibs.Count -eq 0) { throw "install-signing-tools: $NuGetPackage $version carries no Azure.CodeSigning.Dlib.dll" }
$dlib = $dlibs[0].FullName

$env:SPECTRAPDF_SIGN_DLIB = $dlib
if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value "SPECTRAPDF_SIGN_DLIB=$dlib" }
Write-Host "install-signing-tools: using the NuGet payload at $dlib"

# The dlib is only half of it: signtool must be a build new enough to load it.
Get-SignToolPath | ForEach-Object { Write-Host "install-signing-tools: signtool $_" }
