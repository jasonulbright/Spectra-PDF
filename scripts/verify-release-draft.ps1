# Verifies a DRAFT release against the build that produced it, from the bytes
# GitHub actually holds. Every asset is downloaded by its asset id into a
# scratch directory and hashed; the downloaded hash must equal the local
# build's, the downloaded SHA256SUMS.txt must name every checksummed asset with
# the hash of the downloaded bytes, and the downloaded installer signature must
# be the one latest.json carries. A size match proves nothing here: a
# same-length upload with different bytes is exactly the case that hashing
# exists to catch.
#
# Downloads go through curl.exe, never a PowerShell redirection: a redirected
# native command's stdout is decoded and re-encoded as text, which corrupts
# binary assets. The Authorization header is dropped on the cross-host redirect
# to the asset store (curl's default), which that store requires.
#
# -Offline <dir> skips the API and reads <dir>/release.json, <dir>/assets.json
# and the "downloaded" asset files from <dir>; the comparison is otherwise the
# same, which is what tests/test_ci_capability_setup.py drives. -Repo is still
# required: the manifest urls are compared against the exact asset url built
# from it.
[CmdletBinding()]
param(
    [string]$Repo,
    [string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Bundle = "src-tauri/target/release/bundle/nsis",
    [string]$Portable = "src-tauri/target/release/bundle/portable",
    [string]$Sources = "release-sources",
    [string]$Downloads = "",
    [string]$Offline = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-Sha256([string]$path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}

$version = $Tag -replace '^v', ''
# The manifest url is rebuilt from the repository, never pattern-matched.
if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Repo must be <owner>/<name>, got '$Repo'" }

# The platform set the updater manifest must carry for this build. Tauri emits
# one `windows-x86_64-<target>` entry per bundle target in tauri.conf.json
# (`bundle.targets` is `["nsis"]`) plus the bare `windows-x86_64` fallback, and
# the updater resolves the target-specific entry before the fallback; a
# manifest that validates only the fallback validates the entry nobody reads.
$expectedPlatforms = @("windows-x86_64-nsis", "windows-x86_64")

if ($Offline) {
    $Downloads = $Offline
    $release = Get-Content (Join-Path $Offline "release.json") -Raw | ConvertFrom-Json
    $assets = @(Get-Content (Join-Path $Offline "assets.json") -Raw | ConvertFrom-Json)
} else {
    if (-not $ReleaseId) { throw "-ReleaseId is required unless -Offline is given" }
    if (-not $env:GH_TOKEN) { throw "GH_TOKEN is not set" }
    if (-not $Downloads) { $Downloads = Join-Path $Bundle "draft-downloads" }
    if (Test-Path -LiteralPath $Downloads) { Remove-Item -LiteralPath $Downloads -Recurse -Force }
    New-Item -ItemType Directory -Path $Downloads | Out-Null
    $release = gh api "repos/$Repo/releases/$ReleaseId" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "failed to read release $ReleaseId" }
    $assets = @(gh api "repos/$Repo/releases/$ReleaseId/assets?per_page=100" | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw "failed to list the assets of release $ReleaseId" }
}

if (-not $release.draft) { throw "release $ReleaseId is already public before verification" }
if ($release.tag_name -ne $Tag) { throw "draft is for tag '$($release.tag_name)', expected '$Tag'" }

$installer = @(Get-ChildItem -LiteralPath $Bundle -Filter "*-setup.exe" -File)
if ($installer.Count -ne 1) { throw "expected one installer, found $($installer.Count)" }
$signature = Get-Item -LiteralPath (Join-Path $Bundle "$($installer[0].Name).sig")
$portableZip = @(Get-ChildItem -LiteralPath $Portable -Filter "*-portable.zip" -File)
if ($portableZip.Count -ne 1) { throw "expected one portable zip, found $($portableZip.Count)" }
$sourceFiles = @(Get-ChildItem -LiteralPath $Sources -File)
if (-not $sourceFiles) { throw "no corresponding-source archives in $Sources" }
$sums = Get-Item -LiteralPath (Join-Path $Bundle "SHA256SUMS.txt")
$local = @($installer) + @($signature) + @($portableZip) + @($sourceFiles) + @($sums)

$expected = @($local.Name) + @("latest.json") | Sort-Object
$actual = @($assets | ForEach-Object { $_.name }) | Sort-Object
if (($expected -join "`n") -ne ($actual -join "`n")) {
    throw "draft assets differ from the built set.`nexpected:`n$($expected -join "`n")`nactual:`n$($actual -join "`n")"
}

# Every asset the draft holds, fetched by id and hashed. latest.json is
# included: its bytes are what the updater will read.
$downloaded = @{}
foreach ($asset in $assets) {
    $target = Join-Path $Downloads $asset.name
    if (-not $Offline) {
        $url = "https://api.github.com/repos/$Repo/releases/assets/$($asset.id)"
        & curl.exe --fail --silent --show-error --location `
            -H "Authorization: Bearer $env:GH_TOKEN" `
            -H "Accept: application/octet-stream" `
            -o $target $url
        if ($LASTEXITCODE -ne 0) { throw "failed to download draft asset $($asset.name) (id $($asset.id))" }
    }
    if (-not (Test-Path -LiteralPath $target)) { throw "$($asset.name): no downloaded bytes at $target" }
    $length = (Get-Item -LiteralPath $target).Length
    if ($length -ne $asset.size) { throw "$($asset.name): downloaded $length bytes, the draft lists $($asset.size)" }
    $downloaded[$asset.name] = @{ path = $target; sha256 = (Get-Sha256 $target); id = $asset.id }
}

foreach ($file in $local) {
    $got = $downloaded[$file.Name]
    $want = Get-Sha256 $file.FullName
    if ($got.sha256 -ne $want) {
        throw "$($file.Name): uploaded bytes differ from the built file (uploaded sha256 $($got.sha256), built $want)"
    }
}

# The checksum file the public will verify against, read from the draft, must
# name exactly the checksummed assets and carry the hash of the uploaded bytes.
$checksummed = @($installer) + @($portableZip) + @($sourceFiles) | ForEach-Object { $_.Name } | Sort-Object
$named = @()
foreach ($line in Get-Content -LiteralPath $downloaded["SHA256SUMS.txt"].path) {
    if (-not $line.Trim()) { continue }
    $hash, $name = $line -split '  ', 2
    if (-not $downloaded.ContainsKey($name)) { throw "SHA256SUMS.txt names '$name', which is not an uploaded asset" }
    if ($downloaded[$name].sha256 -ne $hash.ToLowerInvariant()) {
        throw "SHA256SUMS.txt is wrong for $name (listed $hash, uploaded $($downloaded[$name].sha256))"
    }
    $named += $name
}
$named = @($named | Sort-Object)
if (($named -join "`n") -ne ($checksummed -join "`n")) {
    throw "SHA256SUMS.txt covers [$($named -join ', ')], expected [$($checksummed -join ', ')]"
}

$manifest = Get-Content -LiteralPath $downloaded["latest.json"].path -Raw | ConvertFrom-Json
if ($manifest.version -ne $version) { throw "latest.json version '$($manifest.version)' != tag version '$version'" }
$uploadedSig = (Get-Content -LiteralPath $downloaded[$signature.Name].path -Raw).Trim()
$localSig = (Get-Content -LiteralPath $signature.FullName -Raw).Trim()
if ($uploadedSig -ne $localSig) { throw "uploaded $($signature.Name) is not the built signature" }
$installerId = $downloaded[$installer[0].Name].id
$installerUrl = "https://api.github.com/repos/$Repo/releases/assets/$installerId"
$present = @($manifest.platforms.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
$wanted = @($expectedPlatforms | Sort-Object)
if (($present -join "`n") -ne ($wanted -join "`n")) {
    throw "latest.json platforms [$($present -join ', ')] != [$($wanted -join ', ')]"
}
foreach ($name in $expectedPlatforms) {
    $platform = $manifest.platforms.$name
    if (-not $platform.signature -or ([string]$platform.signature).Trim() -ne $uploadedSig) {
        throw "latest.json signature is not the uploaded installer's .sig (platform $name)"
    }
    if ([string]$platform.url -cne $installerUrl) {
        throw "latest.json url mismatch (platform $name): '$($platform.url)' != '$installerUrl'"
    }
}

Write-Host "draft $ReleaseId verified from downloaded bytes: $($actual.Count) assets hashed, latest.json at $version"
