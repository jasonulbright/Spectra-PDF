# Builds the jbig2.exe that bundle-jbig2enc.ps1 installs, from the jbig2enc 0.32
# source tag, with upstream's own release recipe (.github/workflows/release.yaml:
# meson --vsenv, wrapdb subprojects, everything static) and three deviations:
#
#   1. leptonica is built without GIF support, and the giflib subproject is not
#      built at all (upstream force-resolves it in meson.build; that line goes).
#   2. zlib 1.3.2 replaces zlib-ng 2.3.3 in zlib-compat mode, whose compat
#      version string is 1.3.1.
#   3. libtiff 4.7.1 -> 4.7.2 and libjpeg-turbo 3.1.4.1 -> 3.2.0 (current releases).
#
# Every other subproject wrap is upstream's, byte for byte. The wraps live in
# scripts/jbig2enc-build/wraps/ and pin each source and patch archive by SHA-256;
# meson refuses a mismatch.
#
# MAINTENANCE TOOL, like build-libtiff-nojbig.ps1: it runs when a pin moves and
# its output is reviewed and committed to scripts/jbig2enc-build/. An MSVC build
# embeds its link time, so a rebuild does not reproduce the committed hash; the
# committed artifact is what ships, and PROVENANCE.txt records its inputs.
#
# Requires Visual Studio with the C++ x64 toolset (meson --vsenv finds it),
# Python 3 on PATH, and a POSIX sh (Git for Windows provides one; meson runs
# upstream's version.sh through it).
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-jbig2enc.ps1

param(
    [string]$Python = "python",
    [string]$OutDir = "$PSScriptRoot\jbig2enc-build",
    [string]$WorkDir = "$PSScriptRoot\..\jbig2enc-build.local\work"
)

$ErrorActionPreference = "Stop"

$Version = "0.32"
# The tag is an annotated tag object 23e5e92f... pointing at this commit.
$Commit = "309b2d55c7dfdcf0ab6afccb6d88834afc0bf2c0"
$TarUrl = "https://github.com/agl/jbig2enc/archive/refs/tags/$Version.tar.gz"
$TarSha256 = "5B3B1C48617E5B1608F916A78038EA867A2C9EB20C2FF34A78A48A243F655C2A"
$MesonBuildSha256 = "B738C6247D00163E9ECD27603207797695BEA3FD56EF674C4E9BB1F888E15E68"
$EditedMesonBuildSha256 = "A3A7A2AAF858812F73FEB1946C51A714DD8DA4F4195700700CC326BA2CB9E8F7"
$MesonVersion = "1.10.1"
$MesonWheelSha256 = "fe43d1cc2e6de146fbea78f3a062194bcc0e779efc8a0f0d7c35544dfb86731f"

$Wraps = Join-Path $OutDir "wraps"
if (-not (Test-Path (Join-Path $Wraps "zlib.wrap"))) {
    Write-Error "Pinned wraps missing: $Wraps"
    exit 1
}

if (-not (Get-Command sh -ErrorAction SilentlyContinue)) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    $gitSh = if ($git) { Join-Path (Split-Path (Split-Path $git.Source)) "usr\bin" } else { "" }
    if (-not ($gitSh -and (Test-Path (Join-Path $gitSh "sh.exe")))) {
        Write-Error "No POSIX sh on PATH (upstream's meson.build runs meson-support/version.sh)."
        exit 1
    }
    $env:PATH = "$gitSh;$env:PATH"
}

Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path

$Tar = Join-Path $WorkDir "jbig2enc-$Version.tar.gz"
Write-Host "Downloading $TarUrl..."
Invoke-WebRequest -Uri $TarUrl -OutFile $Tar -MaximumRedirection 5
$actual = (Get-FileHash $Tar -Algorithm SHA256).Hash
if ($actual -ne $TarSha256) {
    Write-Error "Checksum mismatch for the jbig2enc $Version source.`n  expected: $TarSha256`n  actual:   $actual"
    exit 1
}
# System32 bsdtar: the GNU tar that the sh lookup above may put first on PATH
# reads "C:" as a remote host.
& (Join-Path $env:SystemRoot "System32\tar.exe") -xzf $Tar -C $WorkDir
if ($LASTEXITCODE -ne 0) { Write-Error "tar failed ($LASTEXITCODE)"; exit 1 }
$Src = Join-Path $WorkDir "jbig2enc-$Version"

$MesonBuild = Join-Path $Src "meson.build"
if ((Get-FileHash $MesonBuild -Algorithm SHA256).Hash -ne $MesonBuildSha256) {
    Write-Error "meson.build in the archive is not the pinned file."
    exit 1
}

# Each anchor must match exactly once; a silent no-op edit would build giflib back in.
$text = [System.IO.File]::ReadAllText($MesonBuild) -replace "`r`n", "`n"
$edits = @(
    @("        'leptonica:libgif': 'enabled',`n", "        'leptonica:libgif': 'disabled',`n"),
    @("        'zlib-ng:default_library': 'static',`n        'zlib-ng:zlib-compat': true,`n        'zlib-ng:b_lto': false,`n", ""),
    @("        'zlib-ng:warning_level': '0',`n", "        'zlib:default_library': 'static',`n        'zlib:warning_level': '0',`n"),
    @("        'giflib:default_library': 'static',`n        'giflib:warning_level': '0',`n        'giflib:progs': 'disabled',`n        'giflib:tests': 'disabled',`n", ""),
    @("# Pre-resolve giflib with required:true so wrap fallback activates.`n# Leptonica uses required:false which skips wraps entirely.`ndependency('giflib')`n", "")
)
foreach ($e in $edits) {
    $count = ([regex]::Matches($text, [regex]::Escape($e[0]))).Count
    if ($count -ne 1) {
        Write-Error "meson.build anchor matched $count times:`n$($e[0])"
        exit 1
    }
    $text = $text.Replace($e[0], $e[1])
}
[System.IO.File]::WriteAllText($MesonBuild, $text, (New-Object System.Text.UTF8Encoding($false)))
$editedSha = (Get-FileHash $MesonBuild -Algorithm SHA256).Hash
if ($editedSha -ne $EditedMesonBuildSha256) {
    Write-Error "Edited meson.build hash $editedSha is not the pinned $EditedMesonBuildSha256."
    exit 1
}

$sub = Join-Path $Src "subprojects"
Get-ChildItem $sub -Filter *.wrap | Remove-Item -Force
Copy-Item (Join-Path $Wraps "*.wrap") -Destination $sub -Force

$venv = Join-Path $WorkDir "venv"
& $Python -m venv $venv
if ($LASTEXITCODE -ne 0) { Write-Error "venv creation failed"; exit 1 }
$req = Join-Path $WorkDir "requirements.txt"
Set-Content -Path $req -Encoding ASCII -Value "meson==$MesonVersion --hash=sha256:$MesonWheelSha256"
& (Join-Path $venv "Scripts\python.exe") -m pip install --quiet --require-hashes --only-binary=:all: -r $req
if ($LASTEXITCODE -ne 0) { Write-Error "meson install failed"; exit 1 }
$meson = Join-Path $venv "Scripts\meson.exe"

$prefix = Join-Path $WorkDir "artifact"
Push-Location $Src
try {
    & $meson setup --vsenv --pkgconfig.relocatable --buildtype release --prefix $prefix --licensedir . build
    if ($LASTEXITCODE -ne 0) { throw "meson setup failed ($LASTEXITCODE)" }
    & $meson compile -C build
    if ($LASTEXITCODE -ne 0) { throw "meson compile failed ($LASTEXITCODE)" }
    & $meson test -C build --print-errorlogs "jbig2enc:"
    if ($LASTEXITCODE -ne 0) { throw "meson test failed ($LASTEXITCODE)" }
    & $meson install -C build
    if ($LASTEXITCODE -ne 0) { throw "meson install failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

$exe = Join-Path $prefix "bin\jbig2.exe"
$ErrorActionPreference = "Continue"
$report = (@(& $exe --version 2>&1) | ForEach-Object { "$_" }) -join "`n"
$ErrorActionPreference = "Stop"
Write-Host $report
if ($report -notmatch "(?m)^jbig2enc $([regex]::Escape($Version))$" -or $report -match "libgif" -or
    $report -notmatch ": zlib 1\.3\.2 :") {
    Write-Error "The built jbig2.exe reports an unexpected component set."
    exit 1
}
$bytes = [System.IO.File]::ReadAllBytes($exe)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
foreach ($marker in @("DGifOpen", "EGifOpen", "GIF89a", "zlib-ng")) {
    if ($ascii.Contains($marker)) {
        Write-Error "The built jbig2.exe still contains '$marker'."
        exit 1
    }
}
$depmf = Get-Content (Join-Path $prefix "depmf.json") -Raw | ConvertFrom-Json
foreach ($gone in @("giflib", "zlib-ng")) {
    if ($depmf.projects.PSObject.Properties.Name -contains $gone) {
        Write-Error "depmf.json still names $gone."
        exit 1
    }
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
Copy-Item $exe -Destination (Join-Path $OutDir "jbig2.exe") -Force
Copy-Item (Join-Path $prefix "depmf.json") -Destination (Join-Path $OutDir "depmf.json") -Force
Copy-Item (Join-Path $prefix "COPYING") -Destination (Join-Path $OutDir "COPYING") -Force
Copy-Item (Join-Path $prefix "share\doc\jbig2enc\PATENTS") -Destination (Join-Path $OutDir "PATENTS") -Force

$exeSha = (Get-FileHash (Join-Path $OutDir "jbig2.exe") -Algorithm SHA256).Hash
$depmfSha = (Get-FileHash (Join-Path $OutDir "depmf.json") -Algorithm SHA256).Hash
$wrapLines = (Get-ChildItem $Wraps -Filter *.wrap | Sort-Object Name | ForEach-Object {
    "  {0,-20} SHA-256 {1}" -f $_.Name, (Get-FileHash $_.FullName -Algorithm SHA256).Hash
}) -join "`r`n"
$versionLines = ($report -split "`n" | ForEach-Object { "  $_" }) -join "`r`n"

$provenance = @"
jbig2.exe -- jbig2enc $Version built from source without giflib and on zlib 1.3.2.

Built by scripts/build-jbig2enc.ps1 from:
  source  $TarUrl
          SHA-256 $TarSha256
          tag $Version -> commit $Commit
  recipe  upstream .github/workflows/release.yaml at that commit (meson $MesonVersion,
          --vsenv --buildtype release, all subprojects static), with meson.build
          edited to disable leptonica GIF support, drop the giflib subproject and
          use zlib in place of zlib-ng (edited meson.build SHA-256 $EditedMesonBuildSha256)
  wraps   scripts/jbig2enc-build/wraps/ (each pins its source and patch archive)
$wrapLines

jbig2.exe --version:
$versionLines

SHA-256 of jbig2.exe as committed:  $exeSha
SHA-256 of depmf.json as committed: $depmfSha
"@
[System.IO.File]::WriteAllText((Join-Path $OutDir "PROVENANCE.txt"), $provenance, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Wrote $OutDir"
Write-Host "jbig2.exe  SHA-256 $exeSha"
Write-Host "depmf.json SHA-256 $depmfSha"
Write-Host "Pin both in scripts/bundle-jbig2enc.ps1."
