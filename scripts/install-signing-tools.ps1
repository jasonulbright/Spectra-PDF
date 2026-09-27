# Install the Artifact Signing client dlib on a build runner, plus the signtool
# build that can load it. Build tooling, not a shipped runtime.
#
# The dlib runs inside signtool in the release job, so it comes from exactly one
# pinned NuGet package and is refused unless the .nupkg bytes match the SHA-256
# below; nothing is extracted before that check. The pin was cross-checked
# against the SHA-512 packageHash nuget.org publishes in the package's catalog
# entry. A pre-existing or package-manager install is never used: either could
# be any version. The script exports SPECTRAPDF_SIGN_DLIB, which the resolver in
# windows-signing.ps1 takes ahead of any installed copy.

param(
    [string]$ExtractRoot = "",
    # Accepted and ignored: release-redo passes one argument list to every
    # tag's copy of this script, and older copies take this switch.
    [switch]$SkipWinget
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "windows-signing.ps1")
. (Join-Path $PSScriptRoot "download-retry.ps1")

$SigningClientPackage = "microsoft.artifactsigning.client"
$SigningClientVersion = "1.0.128"
$SigningClientSha256 = "74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b"
$SigningClientUrl = "https://api.nuget.org/v3-flatcontainer/$SigningClientPackage/$SigningClientVersion/$SigningClientPackage.$SigningClientVersion.nupkg"

function Get-SigningClientSha256([string]$Path) {
    # Use .NET directly: the isolated Windows PowerShell image may not expose
    # Microsoft.PowerShell.Utility's optional Get-FileHash command.
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = $null
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        $digest = $algorithm.ComputeHash($stream)
        return [System.BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant()
    } finally {
        $stream.Dispose()
        if ($algorithm) { $algorithm.Dispose() }
    }
}

function Install-PinnedSigningClient {
    param([Parameter(Mandatory)][string]$Root)
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
    New-Item -ItemType Directory -Path $Root | Out-Null

    $nupkg = Join-Path $Root "$SigningClientPackage.$SigningClientVersion.nupkg"
    Write-Host "install-signing-tools: fetching $SigningClientPackage $SigningClientVersion"
    Invoke-DownloadWithRetry -Description "$SigningClientPackage $SigningClientVersion" -OutFile $nupkg -Download {
        Invoke-WebRequest -Uri $SigningClientUrl -OutFile $nupkg -UseBasicParsing -TimeoutSec $DownloadRetryTimeoutSeconds
    }
    $actual = Get-SigningClientSha256 -Path $nupkg
    if ($actual -ne $SigningClientSha256) {
        Remove-Item -LiteralPath $nupkg -Force -ErrorAction SilentlyContinue
        throw "$SigningClientPackage $SigningClientVersion has SHA-256 $actual; the pin is $SigningClientSha256"
    }

    $extracted = Join-Path $Root "package"
    # Expand-Archive refuses any extension but .zip; the zip reader does not care.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $extracted)
    $dlibs = @(Get-ChildItem -LiteralPath $extracted -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -File)
    $x64 = @($dlibs | Where-Object { $_.FullName -like "*\x64\*" })
    if ($x64.Count -gt 0) { $dlibs = $x64 }
    if ($dlibs.Count -eq 0) { throw "install-signing-tools: $SigningClientPackage $SigningClientVersion carries no Azure.CodeSigning.Dlib.dll" }
    return $dlibs[0].FullName
}

if ($MyInvocation.InvocationName -ne ".") {
    if (-not $ExtractRoot) {
        $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
        $ExtractRoot = Join-Path $tempRoot "artifact-signing-client"
    }
    $dlib = Install-PinnedSigningClient -Root $ExtractRoot
    $env:SPECTRAPDF_SIGN_DLIB = $dlib
    if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value "SPECTRAPDF_SIGN_DLIB=$dlib" }
    Write-Host "install-signing-tools: using the pinned payload at $dlib"

    # The dlib is only half of it: signtool must be a build new enough to load it.
    Get-SignToolPath | ForEach-Object { Write-Host "install-signing-tools: signtool $_" }
}
