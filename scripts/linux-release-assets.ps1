# The Linux release files for one version, by exact name. Dot-source it:
# . "$PSScriptRoot/linux-release-assets.ps1"
#
# The Linux builds (scripts/linux-release-build.sh for the .deb and .rpm,
# scripts/build-appimage.sh for the AppImage, its .zsync and its updater .sig)
# write exactly five files between them. The names
# carry only [A-Za-z0-9._-], so GitHub serves each asset under the same name;
# the AppImage's embedded update information and the .zsync both depend on
# that. A missing, extra, or differently named file is refused: it is not this
# build's output.

function Get-LinuxReleaseAssets {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Version
    )
    if ($Version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "Linux assets: '$Version' is not a release version" }
    $names = [ordered]@{
        AppImage = "spectrapdf_${Version}_amd64.AppImage"
        Zsync    = "spectrapdf_${Version}_amd64.AppImage.zsync"
        Sig      = "spectrapdf_${Version}_amd64.AppImage.sig"
        Deb      = "spectrapdf_${Version}_amd64.deb"
        Rpm      = "spectrapdf-${Version}-1.x86_64.rpm"
    }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw "Linux assets: no directory $Directory" }
    $present = @(Get-ChildItem -LiteralPath $Directory -File | ForEach-Object { $_.Name })
    $wanted = [System.Collections.Generic.HashSet[string]]::new([string[]]@($names.Values), [System.StringComparer]::Ordinal)
    $found = [System.Collections.Generic.HashSet[string]]::new([string[]]$present, [System.StringComparer]::Ordinal)
    if (-not $wanted.SetEquals($found) -or $found.Count -ne $present.Count) {
        throw "Linux assets in $Directory are [$(($present | Sort-Object) -join ', ')], expected [$(@($names.Values) -join ', ')]"
    }
    $files = [ordered]@{}
    foreach ($key in $names.Keys) {
        $file = Get-Item -LiteralPath (Join-Path $Directory $names[$key])
        if ($file.Length -le 0) { throw "Linux assets: $($file.Name) is empty" }
        $files[$key] = $file
    }
    return [pscustomobject]@{
        AppImage    = $files.AppImage
        Zsync       = $files.Zsync
        Sig         = $files.Sig
        Deb         = $files.Deb
        Rpm         = $files.Rpm
        Uploaded    = @($files.AppImage, $files.Zsync, $files.Deb, $files.Rpm)
        Checksummed = @($files.AppImage, $files.Deb, $files.Rpm)
    }
}
