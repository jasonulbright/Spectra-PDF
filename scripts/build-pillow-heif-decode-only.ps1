# Builds the decode-only pillow_heif wheel committed under vendor/wheels/.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-pillow-heif-decode-only.ps1
#
# The index wheel of pillow_heif links libheif against x265, a GPL-2.0 HEVC
# encoder, and GPL object code is never shipped. Its libheif DLL statically
# imports x265 symbols, so the encoder DLL cannot be deleted from the wheel,
# and a stub is unsafe: naming the encoders (libheif_info() does) dereferences
# the x265 API struct. The encoder is therefore compiled out: libheif and
# libde265 are built from their pinned release archives with MSVC and the
# static CRT, libheif with WITH_X265=OFF and every other codec off, and the
# binding is built from the pinned pillow_heif sdist against that prefix and
# repaired with delvewheel the way upstream repairs its Windows wheels.
#
# The wheel is versioned 1.8.0+decode.1: a local version label, because the
# bytes are not upstream's and must never carry upstream's filename. The label
# is written into pillow_heif/_version.py of the extracted build tree only;
# nothing else in the sdist is edited.
#
# This is a MAINTENANCE tool: it runs when a pin moves, and its output wheel is
# reviewed and committed together with scripts/vendored-wheels.tsv. It needs
# Visual Studio with the x64 C++ tools (cmake and ninja are the copies Visual
# Studio installs) and CPython 3.14 with headers and import libraries.
# Downloads and build trees live in -WorkDir; nothing is installed elsewhere.

param(
    [string]$WorkDir = (Join-Path $env:TEMP "pillow-heif-decode-only"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\vendor\wheels"),
    [string]$PythonLauncherVersion = "3.14"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\download-retry.ps1"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

$BindingVersion = "1.8.0"
$LocalLabel = "decode.1"
$WheelVersion = "$BindingVersion+$LocalLabel"
$LibheifVersion = "1.23.4"
$Libde265Version = "1.1.3"

# libheif and libde265 are the versions upstream's own Windows wheel of this
# release bundles; the libheif archive hash equals the one pinned in the
# sdist's libheif/windows/mingw-w64-libheif/PKGBUILD.
$Sources = @(
    [pscustomobject]@{
        Name = "pillow_heif sdist"; File = "pillow_heif-$BindingVersion.tar.gz"
        Sha256 = "e47c27432c6fd3d66c22f0de9f27fd379383b646c947520bc485854ce72060d0"
        Url = "https://files.pythonhosted.org/packages/bb/4c/d5319a1f276c70528ff97893afc42a300ff28029e27ca8de89bb3b271680/pillow_heif-$BindingVersion.tar.gz"
        Committed = (Join-Path $Repo "vendor\wheels\pillow_heif-$BindingVersion.tar.gz")
    },
    [pscustomobject]@{
        Name = "libheif"; File = "libheif-$LibheifVersion.tar.gz"
        Sha256 = "d0c02b4b0e978f34a1974b6f3eea7975a537bf7a9195ffeea38e7242ff316fdd"
        Url = "https://github.com/strukturag/libheif/releases/download/v$LibheifVersion/libheif-$LibheifVersion.tar.gz"
        Committed = $null
    },
    [pscustomobject]@{
        Name = "libde265"; File = "libde265-$Libde265Version.tar.gz"
        Sha256 = "554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905"
        Url = "https://github.com/strukturag/libde265/releases/download/v$Libde265Version/libde265-$Libde265Version.tar.gz"
        Committed = $null
    }
)

# Build tooling for the binding, hash-pinned. setuptools carries bdist_wheel
# itself, so the separate `wheel` distribution the sdist lists is not needed
# under --no-build-isolation.
$BuildRequirements = @"
setuptools==84.0.0 --hash=sha256:51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670
delvewheel==1.13.1 --hash=sha256:1b3bc696193a57e322b8bfd644de240be6e003066aae44cc3d5aef8cbee22ca3
pefile==2024.8.26 --hash=sha256:76f8b485dcd3b1bb8166f1128d395fa3d87af26360c2358fb75b80019b957c6f
"@

function Fail([string]$Message) {
    Write-Host "REFUSED: $Message" -ForegroundColor Red
    exit 1
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit $LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force $WorkDir | Out-Null
$Downloads = Join-Path $WorkDir "downloads"
New-Item -ItemType Directory -Force $Downloads | Out-Null

# 1. Sources, verified by SHA-256 whether committed, cached or fetched.
$Archive = @{}
foreach ($s in $Sources) {
    $path = if ($s.Committed -and (Test-Path $s.Committed)) { $s.Committed } else { Join-Path $Downloads $s.File }
    if (-not (Test-Path $path)) {
        Write-Host "Downloading $($s.Url)"
        Invoke-DownloadWithRetry -Description $s.File -OutFile $path -Download {
            Invoke-WebRequest -Uri $s.Url -OutFile $path -TimeoutSec $DownloadRetryTimeoutSeconds
        }
    }
    $actual = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
    if ($actual -ne $s.Sha256) { Fail "$($s.Name): sha256 $actual does not match the pinned $($s.Sha256) ($path)" }
    Write-Host "Verified $($s.Name): $path"
    $Archive[$s.Name] = $path
}

# 2. Toolchain: the MSVC x64 environment, cmake and ninja from Visual Studio.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { Fail "vswhere.exe not found; Visual Studio with the C++ tools is required" }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { Fail "no Visual Studio installation with the x64 C++ tools" }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
$CMake = Join-Path $vs "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$Ninja = Join-Path $vs "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
foreach ($t in @($vcvars, $CMake, $Ninja)) { if (-not (Test-Path $t)) { Fail "missing $t" } }
foreach ($line in (cmd /c "`"$vcvars`" >nul 2>&1 && set")) {
    if ($line -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { Fail "vcvars64.bat did not put cl.exe on PATH" }
# /Brepro drops the link timestamp and other per-run fields from the objects
# and images, so a rebuild of unchanged inputs yields the same DLL bytes and
# therefore the same delvewheel content-hash names.
$env:CL = "/Brepro"
$env:LINK = "/Brepro"
$env:SOURCE_DATE_EPOCH = "1767225600"

$Python = (& py "-$PythonLauncherVersion" -c "import sys; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Python)) { Fail "CPython $PythonLauncherVersion not found through the py launcher" }

# 3. Fresh build trees every run; the download cache survives.
$Src = Join-Path $WorkDir "src"
$Build = Join-Path $WorkDir "build"
$Prefix = Join-Path $WorkDir "prefix"
$Dist = Join-Path $WorkDir "dist"
foreach ($d in @($Src, $Build, $Prefix, $Dist)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Force $d | Out-Null
}
# The Windows tar, by path: a POSIX tar earlier on PATH reads "C:" as a host.
$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
foreach ($name in $Archive.Keys) {
    Invoke-Checked "extracting $name" { & $Tar -xzf $Archive[$name] -C $Src }
}
$Libde265Src = Join-Path $Src "libde265-$Libde265Version"
$LibheifSrc = Join-Path $Src "libheif-$LibheifVersion"
$BindingSrc = Join-Path $Src "pillow_heif-$BindingVersion"

$CommonCMake = @(
    "-GNinja", "-DCMAKE_MAKE_PROGRAM=$Ninja", "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_INSTALL_PREFIX=$Prefix", "-DBUILD_SHARED_LIBS=ON",
    # Static CRT: the runtime ships vcruntime140 through CPython but no
    # msvcp140, and no Microsoft runtime is ever vendored. Every allocation
    # crossing a DLL boundary is released by the DLL that made it.
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
)

# 4. libde265, decoder only.
$de265Build = Join-Path $Build "libde265"
Invoke-Checked "libde265 configure" {
    & $CMake -S $Libde265Src -B $de265Build @CommonCMake `
        -DENABLE_SDL=OFF -DENABLE_DECODER=ON -DENABLE_ENCODER=OFF `
        -DENABLE_SHERLOCK265=OFF -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF
}
Invoke-Checked "libde265 build" { & $CMake --build $de265Build }
Invoke-Checked "libde265 install" { & $CMake --install $de265Build }

# 5. libheif: upstream's PKGBUILD option set with the x265 encoder removed and
# every other codec, plugin loader and example off.
$heifBuild = Join-Path $Build "libheif"
$heifLog = Join-Path $WorkDir "libheif-configure.log"
# Windows PowerShell turns a native stderr line into a terminating error under
# "Stop" once streams are merged; the exit code is the verdict here.
$ErrorActionPreference = "Continue"
& $CMake -S $LibheifSrc -B $heifBuild @CommonCMake "-DCMAKE_PREFIX_PATH=$Prefix" `
    -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF `
    -DWITH_X265=OFF -DWITH_X265_PLUGIN=OFF `
    -DWITH_X264=OFF -DWITH_X264_PLUGIN=OFF `
    -DWITH_KVAZAAR=OFF -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF `
    -DWITH_OpenH264_DECODER=OFF -DWITH_OpenH264_ENCODER=OFF `
    -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_DAV1D=OFF -DWITH_RAV1E=OFF -DWITH_SvtEnc=OFF `
    -DWITH_FFMPEG_DECODER=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF `
    -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF `
    -DWITH_OPENJPH_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF `
    -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_HEADER_COMPRESSION=OFF -DWITH_WEBCODECS=OFF `
    -DENABLE_PLUGIN_LOADING=OFF -DWITH_LIBSHARPYUV=OFF -DWITH_GDK_PIXBUF=OFF `
    -DWITH_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF -DWITH_FUZZERS=OFF *>&1 |
    ForEach-Object { "$_" } | Tee-Object -FilePath $heifLog
$configureExit = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($configureExit -ne 0) { Fail "libheif configure failed (log: $heifLog)" }
$cache = Get-Content (Join-Path $heifBuild "CMakeCache.txt")
if (-not ($cache | Select-String -SimpleMatch "LIBDE265_LIBRARY:" | Where-Object { $_ -notmatch "NOTFOUND" })) {
    Fail "libheif configure did not find libde265 (log: $heifLog)"
}
if ($cache | Select-String -Pattern "^X265_LIBRARY:[^=]*=(?!.*NOTFOUND)." ) {
    Fail "libheif configure found an x265 library (log: $heifLog)"
}
Invoke-Checked "libheif build" { & $CMake --build $heifBuild }
Invoke-Checked "libheif install" { & $CMake --install $heifBuild }

# setup.py links `libheif` and reads headers from <prefix>\include\libheif.
$heifLib = Join-Path $Prefix "lib\heif.lib"
if (-not (Test-Path $heifLib)) { Fail "libheif install produced no $heifLib" }
Copy-Item $heifLib (Join-Path $Prefix "lib\libheif.lib") -Force
if (-not (Test-Path (Join-Path $Prefix "include\libheif\heif.h"))) { Fail "libheif install produced no headers" }

# 6. The binding. A build venv carries only the pinned tooling.
$BuildVenv = Join-Path $WorkDir "venv-build"
if (Test-Path $BuildVenv) { Remove-Item $BuildVenv -Recurse -Force }
Invoke-Checked "build venv" { & $Python -m venv $BuildVenv }
$VPy = Join-Path $BuildVenv "Scripts\python.exe"
$reqFile = Join-Path $WorkDir "build-requirements.txt"
Set-Content -Path $reqFile -Value $BuildRequirements -Encoding ASCII
Invoke-Checked "build tooling install" {
    & $VPy -m pip install --disable-pip-version-check --require-hashes --no-deps -r $reqFile
}

Set-Content -Path (Join-Path $BindingSrc "pillow_heif\_version.py") -Encoding ASCII -Value @"
"""Version of pillow_heif."""

__version__ = "$WheelVersion"
"@
# Each COPYING carries the LGPL-3.0 text followed by the GPL-3.0 text it
# incorporates. setuptools' default license-file patterns match COPYING*, so
# these copies land in the wheel's dist-info licenses/ with no edit to the
# sdist's metadata.
Copy-Item (Join-Path $LibheifSrc "COPYING") (Join-Path $BindingSrc "COPYING.libheif")
Copy-Item (Join-Path $Libde265Src "COPYING") (Join-Path $BindingSrc "COPYING.libde265")
$env:MSYS2_PREFIX = $Prefix
$Unrepaired = Join-Path $WorkDir "unrepaired"
if (Test-Path $Unrepaired) { Remove-Item $Unrepaired -Recurse -Force }
Invoke-Checked "binding build" {
    & $VPy -m pip wheel --disable-pip-version-check --no-build-isolation --no-deps --no-index `
        -w $Unrepaired $BindingSrc
}
$built = @(Get-ChildItem $Unrepaired -Filter "pillow_heif-$WheelVersion-cp314-cp314-win_amd64.whl")
if ($built.Count -ne 1) { Fail "expected one pillow_heif-$WheelVersion wheel in $Unrepaired" }

# 7. Repair: vendor libheif and libde265 next to the extension under
# content-hash names, as upstream's wheels are repaired.
$DelveWheel = Join-Path $BuildVenv "Scripts\delvewheel.exe"
Invoke-Checked "delvewheel repair" {
    & $DelveWheel repair -v -w $Dist --add-path (Join-Path $Prefix "bin") $built[0].FullName
}
$wheel = Get-Item (Join-Path $Dist $built[0].Name)

# 8. Verification. Every check is a refusal; nothing is written to -OutDir
# until all of them pass.
$Inspect = Join-Path $WorkDir "inspect"
if (Test-Path $Inspect) { Remove-Item $Inspect -Recurse -Force }
Invoke-Checked "wheel extraction" { & $VPy -m zipfile -e $wheel.FullName $Inspect }
$files = Get-ChildItem $Inspect -Recurse -File
$bad = @($files | Where-Object {
    $_.Name -match 'x265|msvcp140|vcruntime140|libgcc|libstdc\+\+|libwinpthread'
})
if ($bad) { Fail "forbidden files in the wheel: $(($bad | ForEach-Object Name) -join ', ')" }

$report = & $VPy (Join-Path $PSScriptRoot "pe_imports.py") $Inspect | Out-String | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { Fail "import inventory failed" }
$Forbidden = 'x265|^msvcp140|^vcruntime140|libgcc|libstdc\+\+|libwinpthread'
foreach ($p in $report.PSObject.Properties) {
    $name = Split-Path $p.Name -Leaf
    $dlls = @($p.Value.imports) + @($p.Value.delay_imports)
    Write-Host "  $name -> $($dlls -join ', ')"
    foreach ($dll in $dlls) {
        $allowed = $name -like "_pillow_heif*.pyd" -and $dll -match '^vcruntime140\.dll$'
        if ($dll -match $Forbidden -and -not $allowed) { Fail "$name imports $dll" }
    }
}

$licenses = Join-Path $Inspect "pillow_heif-$WheelVersion.dist-info\licenses"
foreach ($pair in @(@("COPYING.libheif", $LibheifSrc), @("COPYING.libde265", $Libde265Src))) {
    $shipped = Join-Path $licenses $pair[0]
    if (-not (Test-Path $shipped)) { Fail "the wheel's dist-info carries no $($pair[0])" }
    $want = (Get-FileHash -Algorithm SHA256 (Join-Path $pair[1] "COPYING")).Hash
    if ((Get-FileHash -Algorithm SHA256 $shipped).Hash -ne $want) { Fail "$($pair[0]) differs from the pinned archive's COPYING" }
}

$TestVenv = Join-Path $WorkDir "venv-test"
if (Test-Path $TestVenv) { Remove-Item $TestVenv -Recurse -Force }
Invoke-Checked "test venv" { & $Python -m venv $TestVenv }
$TPy = Join-Path $TestVenv "Scripts\python.exe"
$pillowReq = Get-Content (Join-Path $PSScriptRoot "python-requirements.txt") -Raw
if ($pillowReq -notmatch '(?m)^(pillow==\S+(?:\s+--hash=\S+)+)') { Fail "no pillow pin in python-requirements.txt" }
$pillowPin = Join-Path $WorkDir "pillow-requirement.txt"
Set-Content -Path $pillowPin -Value $Matches[1] -Encoding ASCII
Invoke-Checked "pillow install" { & $TPy -m pip install --disable-pip-version-check --require-hashes --no-deps -r $pillowPin }
Invoke-Checked "wheel install" { & $TPy -m pip install --disable-pip-version-check --no-index --no-deps $wheel.FullName }

$probe = Join-Path $WorkDir "verify.py"
Set-Content -Path $probe -Encoding UTF8 -Value @"
import hashlib, json, sys
from pathlib import Path
from PIL import Image
import pillow_heif

info = pillow_heif.libheif_info()
print(json.dumps(info))
problems = []
if info["libheif"] != "$LibheifVersion":
    problems.append(f"libheif reports {info['libheif']}")
if set(info["decoders"]) != {"libde265"} or "$Libde265Version" not in info["decoders"]["libde265"]:
    problems.append(f"decoders {info['decoders']}")
if not set(info["encoders"]) <= {"mask"} or info["HEIF"] != "":
    problems.append(f"an encoder is present: {info['encoders']} HEIF={info['HEIF']!r}")
if pillow_heif.__version__ != "$WheelVersion":
    problems.append(f"version {pillow_heif.__version__}")

pillow_heif.register_heif_opener()
expected = json.loads(Path(sys.argv[2]).read_text())
corpus = Path(sys.argv[1])
for name, digest in sorted(expected.items()):
    with Image.open(corpus / name) as im:
        im.load()
        got = hashlib.sha256(im.tobytes()).hexdigest()[:16]
    print(f"  {name} {got}")
    if got != digest:
        problems.append(f"{name} decodes to {got}, pinned {digest}")
if problems:
    print("\n".join(problems))
    sys.exit(1)
"@
# Decode fingerprints of the fixture corpus as decoded by upstream's wheels
# and the previously shipped decoder: sha256 of Image.tobytes() after load(),
# first 16 hex digits.
$Fingerprints = [ordered]@{
    "exif-orient6.heic" = "9ae26a4b26faf718"; "gray10.heic" = "671a4128bda48047"
    "gray8.heic" = "60aa437f83f25d8d"; "grid-tiled.heic" = "1f2f241555ac57e0"
    "lossless.heic" = "54695dc28869eb48"; "multi-3.heic" = "b4c672fdd60047b5"
    "multi-primary1.heic" = "60ca2a3cda1b3345"; "odd-dims.heic" = "9cc61e10f6466e62"
    "rgb10.heic" = "a112bdfad93707e0"; "rgb8-chroma444.heic" = "ab544251974b7187"
    "rgb8.heic" = "b4c672fdd60047b5"; "rgba8.heic" = "676d1e23565b0958"
    "thumbnail.heic" = "71d13a4bcdd2c9c2"
}
$fpFile = Join-Path $WorkDir "fingerprints.json"
Set-Content -Path $fpFile -Value ($Fingerprints | ConvertTo-Json) -Encoding ASCII
& $TPy $probe (Join-Path $Repo "tests\fixtures\heif") $fpFile
if ($LASTEXITCODE -ne 0) { Fail "the built wheel failed runtime verification" }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$dest = Join-Path $OutDir $wheel.Name
Copy-Item $wheel.FullName $dest -Force
$sha = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLowerInvariant()
Write-Host ""
Write-Host "Wrote $dest"
Write-Host "  size   $((Get-Item $dest).Length) bytes"
Write-Host "  sha256 $sha"
Write-Host "Pin this hash in scripts/vendored-wheels.tsv."
