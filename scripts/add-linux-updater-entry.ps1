# Adds the `linux-x86_64` entry to a DRAFT release's latest.json and replaces
# the asset. The entry's url is the API url of the uploaded AppImage asset
# (the form the Windows entries use) and its signature is the AppImage's
# updater .sig from the build. The updater on every Linux install -- AppImage,
# .deb and .rpm -- resolves `linux-x86_64-<bundle>` first and falls back to
# this key, and a newer version with no matching key is an update-check error,
# so a release that ships Linux packages carries it.
#
# The manifest is edited as a JSON tree, never round-tripped through
# ConvertFrom-Json, which turns `pub_date` into a DateTime and re-renders it.
# Every other value is kept; an existing `linux-x86_64` entry (a re-run job)
# is replaced. The file is written as UTF-8 without BOM with LF line endings.
#
# -Offline <dir> reads <dir>/assets.json and <dir>/latest.json and writes the
# result back to <dir>/latest.json (and its size into assets.json), the
# layout scripts/verify-release-draft.ps1 -Offline reads.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$LinuxDir,
    [string]$Offline = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "download-retry.ps1")
. (Join-Path $PSScriptRoot "linux-release-assets.ps1")

if ($Tag -cnotmatch '^v[0-9]') { throw "-Tag must be a lowercase 'v' tag, got '$Tag'" }
$version = $Tag.Substring(1)
if ($Repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Repo must be <owner>/<name>, got '$Repo'" }
$linux = Get-LinuxReleaseAssets -Directory $LinuxDir -Version $version
$signature = (Get-Content -LiteralPath $linux.Sig.FullName -Raw).Trim()
if (-not $signature) { throw "$($linux.Sig.Name) is empty" }

if ($Offline) {
    $assetsPath = Join-Path $Offline "assets.json"
    $assets = @(Get-Content -LiteralPath $assetsPath -Raw | ConvertFrom-Json)
    $manifestPath = Join-Path $Offline "latest.json"
} else {
    if (-not $ReleaseId) { throw "-ReleaseId is required unless -Offline is given" }
    if (-not $env:GH_TOKEN) { throw "GH_TOKEN is not set" }
    $assetsJson = @(& gh api "repos/$Repo/releases/$ReleaseId/assets?per_page=100")
    if ($LASTEXITCODE -ne 0) { throw "failed to list the assets of release $ReleaseId" }
    $assets = @(($assetsJson -join "`n") | ConvertFrom-Json)
    $manifestPath = Join-Path ([System.IO.Path]::GetTempPath()) "latest.$ReleaseId.json"
}

function Get-OneAsset([string]$name) {
    $found = @($assets | Where-Object { [string]::Equals([string]$_.name, $name, [System.StringComparison]::Ordinal) })
    if ($found.Count -ne 1) { throw "the draft holds $($found.Count) assets named '$name', expected 1" }
    return $found[0]
}

$manifestAsset = Get-OneAsset "latest.json"
$appImageAsset = Get-OneAsset $linux.AppImage.Name

if (-not $Offline) {
    $manifestUrl = "https://api.github.com/repos/$Repo/releases/assets/$($manifestAsset.id)"
    Get-GitHubCurlConfig -Uri $manifestUrl |
        & curl.exe --fail --silent --show-error --location @(Get-CurlRetryArguments) `
            -K - -H "Accept: application/octet-stream" -o $manifestPath $manifestUrl
    if ($LASTEXITCODE -ne 0) { throw "failed to download latest.json (id $($manifestAsset.id))" }
}

$root = [System.Text.Json.Nodes.JsonNode]::Parse([System.IO.File]::ReadAllText($manifestPath))
if ($null -eq $root -or $root -isnot [System.Text.Json.Nodes.JsonObject]) { throw "latest.json is not a JSON object" }
$manifestVersion = $root["version"]
if ($null -eq $manifestVersion -or $manifestVersion.ToString() -cne $version) {
    throw "latest.json version is not the tag version '$version'"
}
$platforms = $root["platforms"]
if ($null -eq $platforms -or $platforms -isnot [System.Text.Json.Nodes.JsonObject]) { throw "latest.json carries no platforms map" }
$entry = [System.Text.Json.Nodes.JsonObject]::new()
$entry["signature"] = [System.Text.Json.Nodes.JsonValue]::Create($signature)
$entry["url"] = [System.Text.Json.Nodes.JsonValue]::Create("https://api.github.com/repos/$Repo/releases/assets/$($appImageAsset.id)")
[void]$platforms.Remove("linux-x86_64")
$platforms["linux-x86_64"] = $entry

$options = [System.Text.Json.JsonSerializerOptions]::new()
$options.WriteIndented = $true
$options.Encoder = [System.Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
$text = $root.ToJsonString($options).Replace("`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText($manifestPath, $text, [System.Text.UTF8Encoding]::new($false))
Write-Host "latest.json: linux-x86_64 -> asset $($appImageAsset.id) ($($linux.AppImage.Name))"

if ($Offline) {
    $manifestAsset.size = (Get-Item -LiteralPath $manifestPath).Length
    Set-Content -LiteralPath $assetsPath -Value (ConvertTo-Json -InputObject $assets -Depth 5) -Encoding utf8NoBOM
    return
}

gh api --method DELETE "repos/$Repo/releases/assets/$($manifestAsset.id)"
if ($LASTEXITCODE -ne 0) { throw "failed to remove the draft's latest.json" }
gh api --method POST -H "Content-Type: application/octet-stream" "https://uploads.github.com/repos/$Repo/releases/$ReleaseId/assets?name=latest.json" --input $manifestPath > $null
if ($LASTEXITCODE -ne 0) { throw "failed to upload latest.json" }
