# Verifies a DRAFT release against the build that produced it, from the bytes
# GitHub actually holds. Every asset is downloaded by its asset id into a
# scratch directory and hashed; the downloaded hash must equal the local
# build's, the downloaded SHA256SUMS.txt must name every checksummed asset with
# the hash of the downloaded bytes, and the downloaded installer signature must
# be the one latest.json carries. A size match proves nothing here: a
# same-length upload with different bytes is exactly the case that hashing
# exists to catch.
#
# Every identity comparison in this file is ORDINAL. PowerShell's default
# operators (-eq/-ne/-replace/-match), hashtables, and PSObject property
# lookups are case-insensitive, while every consumer of these identities is
# not: the updater resolves platform keys and requests `latest.json` by exact
# name, an asset name is exact on GitHub, a base64 signature differing in one
# letter's case is a different signature, and `sha256sum -c` matches filenames
# exactly. A case-only difference therefore has to fail here, so lookups go
# through ordinal dictionaries, sets through ordinal HashSets, and scalars
# through -ceq/-cne or [string]::Equals(..., Ordinal).
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

function New-OrdinalMap {
    return [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
}

function Test-OrdinalEqual([string]$a, [string]$b) {
    return [string]::Equals($a, $b, [System.StringComparison]::Ordinal)
}

# Exact set equality: same members under ordinal comparison, and no member
# repeated (two names differing only by case are two members of `actual`
# and can never match one `expected` name). The sets are built inline: a
# HashSet returned from a function is enumerated by the pipeline.
function Assert-SameOrdinalSet([string[]]$expected, [string[]]$actual, [scriptblock]$message) {
    $expectedSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$expected, [System.StringComparer]::Ordinal)
    $actualSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$actual, [System.StringComparer]::Ordinal)
    if ($expectedSet.Count -ne $expected.Count -or $actualSet.Count -ne $actual.Count -or
        -not $expectedSet.SetEquals($actualSet)) {
        throw (& $message)
    }
}

# Ordinal sort for messages: Sort-Object is culture- and case-insensitive.
function Sort-Ordinal([string[]]$items) {
    return @([System.Linq.Enumerable]::OrderBy([string[]]$items, [Func[string, string]] { param($s) $s },
        [System.StringComparer]::Ordinal))
}

if ($Tag -cnotmatch '^v[0-9]') { throw "-Tag must be a lowercase 'v' tag, got '$Tag'" }
$version = $Tag.Substring(1)
# The manifest url is rebuilt from the repository, never pattern-matched.
if ($Repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Repo must be <owner>/<name>, got '$Repo'" }

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
if ([string]$release.tag_name -cne $Tag) { throw "draft is for tag '$($release.tag_name)', expected '$Tag'" }

$installer = @(Get-ChildItem -LiteralPath $Bundle -Filter "*-setup.exe" -File)
if ($installer.Count -ne 1) { throw "expected one installer, found $($installer.Count)" }
$signature = Get-Item -LiteralPath (Join-Path $Bundle "$($installer[0].Name).sig")
$portableZip = @(Get-ChildItem -LiteralPath $Portable -Filter "*-portable.zip" -File)
if ($portableZip.Count -ne 1) { throw "expected one portable zip, found $($portableZip.Count)" }
$sourceFiles = @(Get-ChildItem -LiteralPath $Sources -File)
if (-not $sourceFiles) { throw "no corresponding-source archives in $Sources" }
$sums = Get-Item -LiteralPath (Join-Path $Bundle "SHA256SUMS.txt")
$local = @($installer) + @($signature) + @($portableZip) + @($sourceFiles) + @($sums)

$expected = Sort-Ordinal (@($local.Name) + @("latest.json"))
$actual = Sort-Ordinal @($assets | ForEach-Object { [string]$_.name })
Assert-SameOrdinalSet $expected $actual {
    "draft assets differ from the built set.`nexpected:`n$($expected -join "`n")`nactual:`n$($actual -join "`n")"
}

# Every asset the draft holds, fetched by id and hashed. latest.json is
# included: its bytes are what the updater will read.
$downloaded = New-OrdinalMap
foreach ($asset in $assets) {
    $assetName = [string]$asset.name
    if ($downloaded.ContainsKey($assetName)) { throw "the draft lists '$assetName' twice" }
    $target = Join-Path $Downloads $assetName
    if (-not $Offline) {
        $url = "https://api.github.com/repos/$Repo/releases/assets/$($asset.id)"
        & curl.exe --fail --silent --show-error --location `
            -H "Authorization: Bearer $env:GH_TOKEN" `
            -H "Accept: application/octet-stream" `
            -o $target $url
        if ($LASTEXITCODE -ne 0) { throw "failed to download draft asset $assetName (id $($asset.id))" }
    }
    if (-not (Test-Path -LiteralPath $target)) { throw "${assetName}: no downloaded bytes at $target" }
    $length = (Get-Item -LiteralPath $target).Length
    if ($length -ne $asset.size) { throw "${assetName}: downloaded $length bytes, the draft lists $($asset.size)" }
    $downloaded[$assetName] = @{ path = $target; sha256 = (Get-Sha256 $target); id = [string]$asset.id }
}

function Get-Downloaded([string]$name) {
    if (-not $downloaded.ContainsKey($name)) { throw "'$name' is not an uploaded asset (exact name)" }
    return $downloaded[$name]
}

foreach ($file in $local) {
    $got = Get-Downloaded $file.Name
    $want = Get-Sha256 $file.FullName
    if (-not (Test-OrdinalEqual $got.sha256 $want)) {
        throw "$($file.Name): uploaded bytes differ from the built file (uploaded sha256 $($got.sha256), built $want)"
    }
}

# The checksum file the public will verify against, read from the draft, must
# name exactly the checksummed assets and carry the hash of the uploaded bytes.
# Entries are lowercase hex by construction (the workflow writes them so) and
# are compared as written: an uppercase digest is not this workflow's output.
$checksummed = Sort-Ordinal @(@($installer) + @($portableZip) + @($sourceFiles) | ForEach-Object { $_.Name })
$named = @()
foreach ($line in Get-Content -LiteralPath (Get-Downloaded "SHA256SUMS.txt").path) {
    if (-not $line.Trim()) { continue }
    $hash, $name = $line -split '  ', 2
    if ($hash -cnotmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS.txt carries a digest that is not lowercase sha256 hex: '$hash'" }
    if (-not $downloaded.ContainsKey($name)) { throw "SHA256SUMS.txt names '$name', which is not an uploaded asset" }
    if ($downloaded[$name].sha256 -cne $hash) {
        throw "SHA256SUMS.txt is wrong for $name (listed $hash, uploaded $($downloaded[$name].sha256))"
    }
    $named += $name
}
$named = Sort-Ordinal $named
Assert-SameOrdinalSet $checksummed $named {
    "SHA256SUMS.txt covers [$($named -join ', ')], expected [$($checksummed -join ', ')]"
}

$manifest = Get-Content -LiteralPath (Get-Downloaded "latest.json").path -Raw | ConvertFrom-Json
if ([string]$manifest.version -cne $version) { throw "latest.json version '$($manifest.version)' != tag version '$version'" }
$uploadedSig = (Get-Content -LiteralPath (Get-Downloaded $signature.Name).path -Raw).Trim()
$localSig = (Get-Content -LiteralPath $signature.FullName -Raw).Trim()
if ($uploadedSig -cne $localSig) { throw "uploaded $($signature.Name) is not the built signature" }
$installerId = (Get-Downloaded $installer[0].Name).id
$installerUrl = "https://api.github.com/repos/$Repo/releases/assets/$installerId"
# Platform entries are re-keyed into an ordinal map: `$manifest.platforms.$name`
# resolves a property case-insensitively, which would let `Windows-x86_64-NSIS`
# stand in for the key the updater actually looks up.
$platforms = New-OrdinalMap
foreach ($property in $manifest.platforms.PSObject.Properties) {
    if ($platforms.ContainsKey($property.Name)) { throw "latest.json lists platform '$($property.Name)' twice" }
    $platforms[$property.Name] = $property.Value
}
$present = Sort-Ordinal @($platforms.Keys)
$wanted = Sort-Ordinal $expectedPlatforms
Assert-SameOrdinalSet $wanted $present {
    "latest.json platforms [$($present -join ', ')] != [$($wanted -join ', ')]"
}
foreach ($name in $expectedPlatforms) {
    $platform = $platforms[$name]
    if (-not $platform.signature -or ([string]$platform.signature).Trim() -cne $uploadedSig) {
        throw "latest.json signature is not the uploaded installer's .sig (platform $name)"
    }
    if ([string]$platform.url -cne $installerUrl) {
        throw "latest.json url mismatch (platform $name): '$($platform.url)' != '$installerUrl'"
    }
}

Write-Host "draft $ReleaseId verified from downloaded bytes: $($actual.Count) assets hashed, latest.json at $version"
