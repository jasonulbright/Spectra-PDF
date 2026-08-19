# Builds the JBIG-free libtiff-6.dll that bundle-tesseract.ps1 installs over the
# one shipped by the Tesseract installer.
#
# The vendored Tesseract build's libtiff-6.dll carries a static (non-delayed) PE
# import of libjbig-0.dll, so the tree cannot ship without that DLL: the process
# never starts. libjbig is JBIG-KIT, GPL-2.0-or-later, and the license-class gate
# in CLAUDE.md refuses GPL object code. Nothing in the product can reach JBIG --
# both Tesseract spawn sites are handed a PNG this program rendered -- so the
# compression is rebuilt out rather than the dependency reasoned around.
#
# This is a MAINTENANCE tool, like fetch-tesseract-licenses.ps1: it runs when the
# Tesseract pin moves, and its output is reviewed and committed. The build itself
# is the MSYS2 mingw-w64 libtiff recipe at the pinned version with --enable-jbig
# turned into --disable-jbig and nothing else changed, so the DLL that results is
# the shipped one minus one codec: same version, same soname, same CRT (msvcrt),
# same remaining imports.
#
# Requires an MSYS2 installation with the MINGW64 environment. Pass -Msys2Root or
# set MSYS2_ROOT; nothing is installed outside it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-libtiff-nojbig.ps1

param(
    [string]$Msys2Root = $(if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { "C:\msys64" }),
    [string]$Version = "4.6.0",
    [string]$OutDir = "$PSScriptRoot\tesseract-libtiff"
)

$ErrorActionPreference = "Stop"

# Pinned sources. The tarball hash is upstream's release artifact and is also the
# sha256sum recorded in the MSYS2 recipe for this version -- two independent
# publishers of the same number. The patch is that recipe's own, taken at the
# commit that carried $Version, and only installs headers.
$TarUrl = "https://download.osgeo.org/libtiff/tiff-$Version.tar.gz"
$TarSha256 = "88B3979E6D5C7E32B50D7EC72FB15AF724F6AB2CBF7E10880C360A77E4B5D99A"
$RecipeCommit = "3f3d7684e19dc172fb4d0819d5833c567d570d26"
$PatchUrl = "https://raw.githubusercontent.com/msys2/MINGW-packages/$RecipeCommit/mingw-w64-libtiff/0002-libtiff-install-headers.patch"
$PatchSha256 = "493742947C8667655B6B89F2D7D27E92E1438A490ED86F50811112394B432A12"
$RecipeUrl = "https://github.com/msys2/MINGW-packages/tree/$RecipeCommit/mingw-w64-libtiff"

$Bash = Join-Path $Msys2Root "usr\bin\bash.exe"
if (-not (Test-Path $Bash)) {
    Write-Error ("No MSYS2 at $Msys2Root (looked for usr\bin\bash.exe).`n" +
                 "Install MSYS2 or pass -Msys2Root / set MSYS2_ROOT. The build needs the`n" +
                 "MINGW64 environment; this script installs its own build dependencies`n" +
                 "inside that root and touches nothing else.")
    exit 1
}

$Work = Join-Path $env:TEMP "libtiff-nojbig-$Version"
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null

$Tar = Join-Path $Work "tiff-$Version.tar.gz"
$Patch = Join-Path $Work "install-headers.patch"
Write-Host "Downloading $TarUrl..."
Invoke-WebRequest -Uri $TarUrl -OutFile $Tar -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
Invoke-WebRequest -Uri $PatchUrl -OutFile $Patch -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

foreach ($pair in @(@($Tar, $TarSha256, "libtiff source"), @($Patch, $PatchSha256, "recipe patch"))) {
    $actual = (Get-FileHash $pair[0] -Algorithm SHA256).Hash
    if ($actual -ne $pair[1]) {
        Write-Error "Checksum mismatch for the $($pair[2]).`n  expected: $($pair[1])`n  actual:   $actual"
        exit 1
    }
}
Write-Host "Checksums verified."

# The build deps are the recipe's own makedepends plus the codec libraries it
# links. python-sphinx is omitted: it builds documentation this does not ship.
$deps = @(
    "mingw-w64-x86_64-cc", "mingw-w64-x86_64-autotools", "mingw-w64-x86_64-libjpeg-turbo",
    "mingw-w64-x86_64-zlib", "mingw-w64-x86_64-libdeflate", "mingw-w64-x86_64-xz",
    "mingw-w64-x86_64-zstd", "mingw-w64-x86_64-libwebp", "mingw-w64-x86_64-lerc",
    "make", "patch"
) -join " "

function ToMsysPath([string]$p) {
    $full = (Resolve-Path $p -ErrorAction SilentlyContinue)
    if (-not $full) { $full = $p }
    $s = "$full" -replace "\\", "/"
    if ($s -match "^([A-Za-z]):/(.*)$") { return "/" + $Matches[1].ToLower() + "/" + $Matches[2] }
    return $s
}

$mWork = ToMsysPath $Work
# --disable-jbig is the ONE deviation from the recipe's configure line. Every
# other codec stays enabled so the DLL keeps the capability set the shipped one
# had; a narrower build would be a different library, not the same one minus GPL.
$script = @"
set -euo pipefail
pacman -S --noconfirm --needed $deps
cd '$mWork'
mkdir -p src build
tar -xzf tiff-$Version.tar.gz -C src
cd src/tiff-$Version
patch -p1 -i '$mWork/install-headers.patch'
autoreconf -fiv
cd '$mWork/build'
export CFLAGS="-fno-strict-aliasing"
export CXXFLAGS="-fno-strict-aliasing"
'$mWork'/src/tiff-$Version/configure \
  --prefix=/mingw64 --build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32 \
  --target=x86_64-w64-mingw32 --disable-static --enable-shared --enable-cxx \
  --disable-jbig --enable-lerc --enable-libdeflate --enable-webp
make -j`$(nproc)
"@
$scriptPath = Join-Path $Work "build.sh"
Set-Content -Path $scriptPath -Value $script -Encoding UTF8 -NoNewline

Write-Host "Building libtiff $Version without JBIG in MSYS2 MINGW64..."
$env:MSYSTEM = "MINGW64"
$env:MSYS2_PATH_TYPE = "strict"
$env:CHERE_INVOKING = "1"
& $Bash -lc "bash '$mWork/build.sh'"
if ($LASTEXITCODE -ne 0) {
    Write-Error "libtiff build failed (exit $LASTEXITCODE)."
    exit 1
}

$built = Join-Path $Work "build\libtiff\.libs\libtiff-6.dll"
if (-not (Test-Path $built)) {
    Write-Error "The build produced no libtiff-6.dll at $built."
    exit 1
}

# Refuse to publish a DLL that still names libjbig. The import name is stored as
# a literal ASCII string in the import directory, so its absence from the whole
# file is a stronger check than reading the directory and a cheaper one.
$bytes = [System.IO.File]::ReadAllBytes($built)
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
if ($text.Contains("libjbig")) {
    Write-Error "The built libtiff still references libjbig -- refusing to publish it."
    exit 1
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$dest = Join-Path $OutDir "libtiff-6.dll"
Copy-Item $built -Destination $dest -Force
$sha = (Get-FileHash $dest -Algorithm SHA256).Hash

Set-Content -Path (Join-Path $OutDir "PROVENANCE.txt") -Encoding UTF8 -Value @"
libtiff-6.dll -- libtiff $Version built without JBIG support.

Built by scripts/build-libtiff-nojbig.ps1 from:
  source  $TarUrl
          SHA-256 $TarSha256
  patch   $PatchUrl
          SHA-256 $PatchSha256
  recipe  $RecipeUrl
          (MSYS2 mingw-w64-libtiff at version $Version; the configure line is
          that recipe's shared build with --enable-jbig replaced by
          --disable-jbig, no other change)

SHA-256 of the DLL as committed: $sha

libtiff is MIT-licensed; its notice ships as resources/tesseract/licenses/LICENSE-libtiff.txt.
"@

Write-Host "Wrote $dest"
Write-Host "SHA-256 $sha"
Write-Host "Pin this hash in scripts/bundle-tesseract.ps1 (`$ExpectedLibTiffSha256)."
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
