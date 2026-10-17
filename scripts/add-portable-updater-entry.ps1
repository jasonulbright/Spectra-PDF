# Adds the `windows-x86_64-portable` entry to a DRAFT release's latest.json and
# replaces the asset. The entry's url is the API url of the uploaded portable
# zip (the form the other entries use) and its signature is the zip's updater
# .sig, written beside the zip by `tauri signer sign`. The .sig is never an
# asset. Every other key and value of the manifest is kept unchanged: a
# version that reads only `windows-x86_64` reads exactly what it read before.
#
# The manifest is edited as a JSON tree, never round-tripped through
# ConvertFrom-Json, which turns `pub_date` into a DateTime and re-renders it.
# An existing `windows-x86_64-portable` entry (a re-run job) is replaced. The
# file is written as UTF-8 without BOM with LF line endings.
#
# -Offline <dir> reads <dir>/assets.json and <dir>/latest.json and writes the
# result back to <dir>/latest.json (and its size into assets.json), the
# layout scripts/verify-release-draft.ps1 -Offline reads.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Portable = "src-tauri/target/release/bundle/portable",
    [string]$Offline = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "download-retry.ps1")
. (Join-Path $PSScriptRoot "github-asset-name.ps1")

$PortableKey = "windows-x86_64-portable"

if ($Tag -cnotmatch '^v[0-9]') { throw "-Tag must be a lowercase 'v' tag, got '$Tag'" }
$version = $Tag.Substring(1)
if ($Repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Repo must be <owner>/<name>, got '$Repo'" }
$zips = @(Get-ChildItem -LiteralPath $Portable -Filter "*-portable.zip" -File)
if ($zips.Count -ne 1) { throw "expected one portable zip in $Portable, found $($zips.Count)" }
$zip = $zips[0]
$sigPath = Join-Path $Portable "$($zip.Name).sig"
if (-not (Test-Path -LiteralPath $sigPath -PathType Leaf)) { throw "no updater signature at $sigPath" }
$signature = (Get-Content -LiteralPath $sigPath -Raw).Trim()
if (-not $signature) { throw "$($zip.Name).sig is empty" }

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
    $manifestPath = Join-Path ([System.IO.Path]::GetTempPath()) "latest.portable.$ReleaseId.json"
}

function Get-OneAsset([string]$name) {
    $found = @($assets | Where-Object { [string]::Equals([string]$_.name, $name, [System.StringComparison]::Ordinal) })
    if ($found.Count -ne 1) { throw "the draft holds $($found.Count) assets named '$name', expected 1" }
    return $found[0]
}

$manifestAsset = Get-OneAsset "latest.json"
$zipAsset = Get-OneAsset (Get-GitHubAssetName $zip.Name)

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
$entry["url"] = [System.Text.Json.Nodes.JsonValue]::Create("https://api.github.com/repos/$Repo/releases/assets/$($zipAsset.id)")
[void]$platforms.Remove($PortableKey)
$platforms[$PortableKey] = $entry

$options = [System.Text.Json.JsonSerializerOptions]::new()
$options.WriteIndented = $true
$options.Encoder = [System.Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
$text = $root.ToJsonString($options).Replace("`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText($manifestPath, $text, [System.Text.UTF8Encoding]::new($false))
Write-Host "latest.json: $PortableKey -> asset $($zipAsset.id) ($($zip.Name))"

if ($Offline) {
    $manifestAsset.size = (Get-Item -LiteralPath $manifestPath).Length
    Set-Content -LiteralPath $assetsPath -Value (ConvertTo-Json -InputObject $assets -Depth 5) -Encoding utf8NoBOM
    return
}

gh api --method DELETE "repos/$Repo/releases/assets/$($manifestAsset.id)"
if ($LASTEXITCODE -ne 0) { throw "failed to remove the draft's latest.json" }
gh api --method POST -H "Content-Type: application/octet-stream" "https://uploads.github.com/repos/$Repo/releases/$ReleaseId/assets?name=latest.json" --input $manifestPath > $null
if ($LASTEXITCODE -ne 0) { throw "failed to upload latest.json" }
