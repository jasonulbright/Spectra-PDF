# Shared Authenticode helpers for the release pipeline: locating the signing
# tools on a runner, and asserting that a produced file carries the signature
# the release is gated on.
#
# Tool locations are DISCOVERED, never pinned. signtool ships in every Windows
# SDK build directory and again with the Artifact Signing client tools, and the
# client tools' install root differs between the winget package and the NuGet
# payload; a hard-coded path goes stale on the next runner image. Both
# resolvers take an explicit override from the environment for the case where
# discovery is wrong.

Set-StrictMode -Version Latest

function Get-NewestByVersionThenTime([object[]]$files) {
    # Windows SDK bin directories sort wrong as strings (10.0.22621 vs
    # 10.0.9). Version-sort the containing directory where it parses; fall
    # back to write time.
    return @($files | Sort-Object -Property @{ Expression = {
        $parsed = [version]"0.0"
        $name = Split-Path (Split-Path $_.FullName -Parent) -Leaf
        if ([version]::TryParse($name, [ref]$parsed)) { $parsed } else { [version]"0.0" }
    } }, LastWriteTime -Descending)
}

function Get-SignToolPath {
    if ($env:SPECTRAPDF_SIGNTOOL) {
        if (-not (Test-Path -LiteralPath $env:SPECTRAPDF_SIGNTOOL)) {
            throw "SPECTRAPDF_SIGNTOOL is set to '$env:SPECTRAPDF_SIGNTOOL', which does not exist"
        }
        return (Resolve-Path -LiteralPath $env:SPECTRAPDF_SIGNTOOL).Path
    }
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin",
        "${env:LOCALAPPDATA}\Microsoft\MicrosoftTrustedSigningClientTools",
        "${env:LOCALAPPDATA}\Microsoft\AzureArtifactSigningClientTools",
        "${env:ProgramFiles}\Microsoft\Azure Artifact Signing Client Tools"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    foreach ($root in $roots) {
        $hits = @(Get-ChildItem -LiteralPath $root -Recurse -Filter "signtool.exe" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like "*\x64\*" })
        if ($hits.Count -gt 0) { return (Get-NewestByVersionThenTime $hits)[0].FullName }
    }
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "signtool.exe (x64) was not found. Searched: $($roots -join '; ')"
}

function Get-ArtifactSigningDlibPath {
    if ($env:SPECTRAPDF_SIGN_DLIB) {
        if (-not (Test-Path -LiteralPath $env:SPECTRAPDF_SIGN_DLIB)) {
            throw "SPECTRAPDF_SIGN_DLIB is set to '$env:SPECTRAPDF_SIGN_DLIB', which does not exist"
        }
        return (Resolve-Path -LiteralPath $env:SPECTRAPDF_SIGN_DLIB).Path
    }
    $roots = @(
        "${env:LOCALAPPDATA}\Microsoft\MicrosoftTrustedSigningClientTools",
        "${env:LOCALAPPDATA}\Microsoft\AzureArtifactSigningClientTools",
        "${env:ProgramFiles}\Microsoft\Azure Artifact Signing Client Tools",
        "${env:ProgramFiles}\Microsoft",
        "${env:LOCALAPPDATA}\Microsoft\WinGet\Packages"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    foreach ($root in $roots) {
        $hits = @(Get-ChildItem -LiteralPath $root -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -File -ErrorAction SilentlyContinue)
        # The x64 payload is the one that pairs with the x64 signtool; a
        # bitness mismatch fails inside signtool with an opaque load error.
        $x64 = @($hits | Where-Object { $_.FullName -like "*\x64\*" })
        if ($x64.Count -gt 0) { return ($x64 | Sort-Object LastWriteTime -Descending)[0].FullName }
        if ($hits.Count -gt 0) { return ($hits | Sort-Object LastWriteTime -Descending)[0].FullName }
    }
    throw "Azure.CodeSigning.Dlib.dll was not found. Searched: $($roots -join '; ')"
}

# The publish gate. A file that reaches this and is not chain-valid, not signed
# by the expected subject, or not timestamped stops the release: an untimestamped
# signature stops verifying the day the daily-rotated certificate expires.
function Assert-AuthenticodeSigned {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSubjectCommonName
    )
    if (-not (Test-Path -LiteralPath $Path)) { throw "cannot verify signature: no file at $Path" }
    $signtool = Get-SignToolPath
    $output = & $signtool verify /pa /v $Path 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "signtool verify /pa failed for $Path (exit $code):`n$($output -join "`n")"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ([string]$signature.Status -cne "Valid") {
        throw "$Path is not validly signed (status $($signature.Status): $($signature.StatusMessage))"
    }
    if (-not $signature.SignerCertificate) { throw "$Path carries no signer certificate" }
    $subject = [string]$signature.SignerCertificate.Subject
    $cn = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ([string]$cn -cne $ExpectedSubjectCommonName) {
        throw "$Path is signed by '$cn', expected '$ExpectedSubjectCommonName' (subject: $subject)"
    }
    if (-not $signature.TimeStamperCertificate) {
        throw "$Path is signed but not timestamped; the signature dies with the signing certificate"
    }
    Write-Host "signature ok: $Path (CN=$cn, timestamped by $($signature.TimeStamperCertificate.Subject))"
}
