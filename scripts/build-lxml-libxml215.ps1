# Builds the lxml wheel committed under vendor/wheels/ with libxml2 2.15.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-lxml-libxml215.ps1
#
# The index's Windows wheels of lxml link libxml2 2.11.9 statically: lxml's
# Windows build does not compile libxml2 but downloads prebuilt libraries from
# its libxml2-win-binaries project, whose build (the retired win32/configure.js)
# stops at 2.11. This builds the same lxml release from its pinned sdist against
# static libraries compiled here with MSVC from pinned release archives:
# libxml2 2.15.4, libxslt 1.1.45, zlib 1.3.2 and win-iconv 0.0.10. lxml's own
# `--static` path links them (setupinfo.py: libxslt_a, libexslt_a, libxml2_a,
# iconv_a, zlib); the pre-generated C in the sdist is compiled, not re-cythonized.
#
# iconv comes from win-iconv (public domain; conversion through the Windows
# code-page API) instead of the GNU libiconv the index wheel links statically.
# It is compiled without USE_LIBICONV_DLL, so no environment variable can make
# it load a DLL, and its one LoadLibrary (mlang.dll, for the ISO-2022 code
# pages) is restricted to System32.
#
# The wheel is versioned 6.1.2+libxml215.1: a local version label in the
# distribution metadata only. lxml.__version__ and lxml.etree.LXML_VERSION stay
# the source release's, because lxml parses that string into a tuple.
#
# This is a MAINTENANCE tool: it runs when a pin moves, and its output wheel is
# reviewed and committed together with scripts/vendored-wheels.tsv. It needs
# Visual Studio with the x64 C++ tools (cmake and ninja are the copies Visual
# Studio installs) and CPython 3.14 with headers and import libraries.

param(
    [string]$WorkDir = (Join-Path $env:TEMP "lxml-libxml215"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\vendor\wheels"),
    [string]$PythonLauncherVersion = "3.14"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\download-retry.ps1"

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

$LxmlVersion = "6.1.2"
$LocalLabel = "libxml215.1"
$WheelVersion = "$LxmlVersion+$LocalLabel"
$Libxml2Version = "2.15.4"
$LibxsltVersion = "1.1.45"
$ZlibVersion = "1.3.2"
$WinIconvVersion = "0.0.10"

# libxml2 and libxslt hashes are the .sha256sum files GNOME publishes next to
# each archive; lxml's is the one PyPI lists for the sdist.
$Sources = @(
    [pscustomobject]@{
        Name = "lxml sdist"; File = "lxml-$LxmlVersion.tar.gz"; Dir = "lxml-$LxmlVersion"
        Sha256 = "1055241852f2b02068af4a625a5d32c087db193c12251928af2562ecd2239f18"
        Url = "https://files.pythonhosted.org/packages/ad/a9/970b8fa0ecc4fbf1dfaed0d89bbc1fc1421b25ec26a2038c91e872dc6c8e/lxml-$LxmlVersion.tar.gz"
        Committed = (Join-Path $Repo "vendor\wheels\lxml-$LxmlVersion.tar.gz")
    },
    [pscustomobject]@{
        Name = "libxml2"; File = "libxml2-$Libxml2Version.tar.xz"; Dir = "libxml2-$Libxml2Version"
        Sha256 = "98087fd181d9070724f3fbc65c7377db03038eb92bd882374daff44940138821"
        Url = "https://download.gnome.org/sources/libxml2/2.15/libxml2-$Libxml2Version.tar.xz"
        Committed = $null
    },
    [pscustomobject]@{
        Name = "libxslt"; File = "libxslt-$LibxsltVersion.tar.xz"; Dir = "libxslt-$LibxsltVersion"
        Sha256 = "9acfe68419c4d06a45c550321b3212762d92f41465062ca4ea19e632ee5d216e"
        Url = "https://download.gnome.org/sources/libxslt/1.1/libxslt-$LibxsltVersion.tar.xz"
        Committed = $null
    },
    [pscustomobject]@{
        Name = "zlib"; File = "zlib-$ZlibVersion.tar.gz"; Dir = "zlib-$ZlibVersion"
        Sha256 = "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"
        Url = "https://zlib.net/fossils/zlib-$ZlibVersion.tar.gz"
        Committed = $null
    },
    [pscustomobject]@{
        Name = "win-iconv"; File = "win-iconv-$WinIconvVersion.tar.gz"; Dir = "win-iconv-$WinIconvVersion"
        Sha256 = "58493387c7c9c70d61e711ec2feec5db0a59d164556642d2b427dde4ef756bc1"
        Url = "https://github.com/win-iconv/win-iconv/archive/refs/tags/v$WinIconvVersion.tar.gz"
        Committed = $null
    }
)

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

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

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
    $actual = Get-Sha256 $path
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
$MsvcInclude = $env:INCLUDE
$MsvcLib = $env:LIB
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
foreach ($d in @("include", "lib")) { New-Item -ItemType Directory -Force (Join-Path $Prefix $d) | Out-Null }
$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
$Dir = @{}
foreach ($s in $Sources) {
    Invoke-Checked "extracting $($s.Name)" { & $Tar -xf $Archive[$s.Name] -C $Src }
    $Dir[$s.Name] = Join-Path $Src $s.Dir
    if (-not (Test-Path $Dir[$s.Name])) { Fail "$($s.File) did not unpack to $($s.Dir)" }
}
$PrefixInc = Join-Path $Prefix "include"
$PrefixLib = Join-Path $Prefix "lib"

# /Brepro drops per-run fields from objects and archives, and /d1trimfile
# strips the work directory from __FILE__ (libexslt reports source locations),
# so the bytes do not depend on -WorkDir. Every library uses the DLL CRT (/MD),
# as the extension that links them does.
$env:CL = "/Brepro /d1trimfile:$Src\"
$env:LINK = "/Brepro"

# 4. zlib, static, with its own MSVC makefile.
Push-Location $Dir["zlib"]
try {
    Invoke-Checked "zlib build" { & nmake.exe /nologo -f win32\Makefile.msc zlib.lib }
} finally { Pop-Location }
Copy-Item (Join-Path $Dir["zlib"] "zlib.lib") $PrefixLib
foreach ($h in @("zlib.h", "zconf.h")) { Copy-Item (Join-Path $Dir["zlib"] $h) $PrefixInc }

# 5. win-iconv, static, one translation unit. The mlang.dll load is pinned to
# System32 before compiling; the anchor must exist exactly once.
$wic = Join-Path $Dir["win-iconv"] "win_iconv.c"
$text = [System.IO.File]::ReadAllText($wic)
$anchor = 'h = LoadLibrary(TEXT("mlang.dll"));'
if (([regex]::Matches($text, [regex]::Escape($anchor))).Count -ne 1) { Fail "win_iconv.c: the mlang.dll LoadLibrary call is not where it was" }
$text = $text.Replace($anchor, 'h = LoadLibraryExW(L"mlang.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);')
if ($text -match '(?m)^\s*#\s*define\s+USE_LIBICONV_DLL') {
    $live = $text -replace '(?s)#if 0.*?#endif', ''
    if ($live -match '(?m)^\s*#\s*define\s+USE_LIBICONV_DLL') { Fail "win_iconv.c defines USE_LIBICONV_DLL outside the disabled block" }
}
[System.IO.File]::WriteAllText($wic, $text)
$iconvObj = Join-Path $Build "win_iconv.obj"
Invoke-Checked "win-iconv compile" { & cl.exe /nologo /c /O2 /MD /W3 /D_CRT_SECURE_NO_WARNINGS "/Fo$iconvObj" $wic }
Invoke-Checked "win-iconv archive" { & lib.exe /nologo "/OUT:$(Join-Path $PrefixLib 'iconv_a.lib')" $iconvObj }
Copy-Item (Join-Path $Dir["win-iconv"] "iconv.h") $PrefixInc

$CommonCMake = @(
    "-GNinja", "-DCMAKE_MAKE_PROGRAM=$Ninja", "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_INSTALL_PREFIX=$Prefix", "-DCMAKE_PREFIX_PATH=$Prefix", "-DBUILD_SHARED_LIBS=OFF",
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL"
)

# 6. libxml2: the library only, static, with the index wheel's feature set
# where 2.15 still has it (HTTP and FTP were removed upstream in 2.14).
# No compiled-in default catalog. The default is "file://<sysconfdir>/xml/catalog";
# on Windows any such absolute path resolves on a drive where an unprivileged
# user can create it (the index wheel's "/etc/xml/catalog" is C:\etc\xml\catalog),
# and a catalog there would redirect entity and DTD resolution for every parse.
# XML_CATALOG_FILES still applies when the process environment sets it.
$cat = Join-Path $Dir["libxml2"] "catalog.c"
$text = [System.IO.File]::ReadAllText($cat)
$catAnchor = '#define XML_XML_DEFAULT_CATALOG "file://" XML_SYSCONFDIR "/xml/catalog"'
if (([regex]::Matches($text, [regex]::Escape($catAnchor))).Count -ne 1) { Fail "catalog.c: the default catalog definition is not where it was" }
$text = $text.Replace($catAnchor, '#define XML_XML_DEFAULT_CATALOG ""')
$text = $text.Replace('#define XML_SGML_DEFAULT_CATALOG "file://" XML_SYSCONFDIR "/sgml/catalog"', '#define XML_SGML_DEFAULT_CATALOG ""')
[System.IO.File]::WriteAllText($cat, $text)

# libxslt reads libxml2's exported config, which looks both dependencies up again.
$DepCMake = @(
    "-DIconv_INCLUDE_DIR=$PrefixInc", "-DIconv_LIBRARY=$(Join-Path $PrefixLib 'iconv_a.lib')",
    "-DZLIB_INCLUDE_DIR=$PrefixInc", "-DZLIB_LIBRARY=$(Join-Path $PrefixLib 'zlib.lib')"
)
$xmlBuild = Join-Path $Build "libxml2"
Invoke-Checked "libxml2 configure" {
    & $CMake -S $Dir["libxml2"] -B $xmlBuild @CommonCMake @DepCMake `
        -DLIBXML2_WITH_ICONV=ON -DLIBXML2_WITH_ZLIB=ON -DLIBXML2_WITH_ICU=OFF -DLIBXML2_WITH_LZMA=OFF `
        -DLIBXML2_WITH_SCHEMATRON=ON -DLIBXML2_WITH_MODULES=OFF -DLIBXML2_WITH_HTTP=OFF `
        -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_DOCS=OFF
}
$cache = Get-Content (Join-Path $xmlBuild "CMakeCache.txt")
foreach ($want in @("LIBXML2_WITH_ICONV:BOOL=ON", "LIBXML2_WITH_ZLIB:BOOL=ON", "LIBXML2_WITH_SCHEMATRON:BOOL=ON")) {
    if (-not ($cache -contains $want)) { Fail "libxml2 configure did not keep $want" }
}
Invoke-Checked "libxml2 build" { & $CMake --build $xmlBuild }
Invoke-Checked "libxml2 install" { & $CMake --install $xmlBuild }

# 7. libxslt against it: library only, static, no crypto and no modules, as
# the index wheel's libxslt was configured.
$xsltBuild = Join-Path $Build "libxslt"
Invoke-Checked "libxslt configure" {
    & $CMake -S $Dir["libxslt"] -B $xsltBuild @CommonCMake @DepCMake `
        -DLIBXSLT_WITH_CRYPTO=OFF -DLIBXSLT_WITH_MODULES=OFF -DLIBXSLT_WITH_PYTHON=OFF `
        -DLIBXSLT_WITH_PROGRAMS=OFF -DLIBXSLT_WITH_TESTS=OFF
}
Invoke-Checked "libxslt build" { & $CMake --build $xsltBuild }
Invoke-Checked "libxslt install" { & $CMake --install $xsltBuild }

# lxml links these names on Windows under --static.
$Rename = [ordered]@{ "libxml2s.lib" = "libxml2_a.lib"; "libxslts.lib" = "libxslt_a.lib"; "libexslts.lib" = "libexslt_a.lib" }
foreach ($k in $Rename.Keys) {
    $from = Join-Path $PrefixLib $k
    if (-not (Test-Path $from)) { Fail "the install produced no $k (have: $((Get-ChildItem $PrefixLib -Filter *.lib | ForEach-Object Name) -join ', '))" }
    Copy-Item $from (Join-Path $PrefixLib $Rename[$k]) -Force
}

# 8. The binding. A build venv carries only the pinned tooling.
$BuildVenv = Join-Path $WorkDir "venv-build"
if (Test-Path $BuildVenv) { Remove-Item $BuildVenv -Recurse -Force }
Invoke-Checked "build venv" { & $Python -m venv $BuildVenv }
$VPy = Join-Path $BuildVenv "Scripts\python.exe"
$reqFile = Join-Path $WorkDir "build-requirements.txt"
Set-Content -Path $reqFile -Value $BuildRequirements -Encoding ASCII
Invoke-Checked "build tooling install" {
    & $VPy -m pip install --disable-pip-version-check --require-hashes --no-deps -r $reqFile
}

$LxmlSrc = $Dir["lxml sdist"]
$env:STATIC = "true"
$env:WITHOUT_CYTHON = "true"
$env:INCLUDE = "$PrefixInc;$(Join-Path $PrefixInc 'libxml2');$MsvcInclude"
$env:LIBRARY = $PrefixLib
$env:LIB = "$PrefixLib;$MsvcLib"
$env:CFLAGS = "/DLIBXML_STATIC /DLIBXSLT_STATIC /DLIBEXSLT_STATIC"
# libxml2 seeds its hash randomization with BCryptGenRandom; lxml's static
# library list predates that and does not name bcrypt.
$env:LINK = "/Brepro bcrypt.lib"
$Unrepaired = Join-Path $WorkDir "unrepaired"
if (Test-Path $Unrepaired) { Remove-Item $Unrepaired -Recurse -Force }
Invoke-Checked "binding build" {
    & $VPy -m pip wheel --disable-pip-version-check --no-build-isolation --no-deps --no-index -v `
        -w $Unrepaired $LxmlSrc
}
foreach ($v in @("STATIC", "WITHOUT_CYTHON", "LIBRARY", "CFLAGS")) { Remove-Item "env:$v" -ErrorAction SilentlyContinue }
$env:INCLUDE = $MsvcInclude
$env:LIB = $MsvcLib
$env:LINK = "/Brepro"
$built = @(Get-ChildItem $Unrepaired -Filter "lxml-$LxmlVersion-cp314-cp314-win_amd64.whl")
if ($built.Count -ne 1) { Fail "expected one lxml-$LxmlVersion wheel in $Unrepaired" }

# 9. Relabel: the distribution version gets the local label; the package's
# own version string is left alone. RECORD is regenerated for the renamed
# dist-info and the archive is written with fixed timestamps and order.
$relabel = Join-Path $WorkDir "relabel.py"
Set-Content -Path $relabel -Encoding UTF8 -Value @"
import base64, hashlib, sys, zipfile
from pathlib import Path

src, dest_dir, public, local = sys.argv[1], Path(sys.argv[2]), sys.argv[3], sys.argv[4]
notices = sys.argv[5:]
old_di, new_di = f"lxml-{public}.dist-info/", f"lxml-{local}.dist-info/"
files = {}
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        if info.is_dir():
            continue
        name = info.filename
        data = z.read(info)
        if name.startswith(old_di):
            name = new_di + name[len(old_di):]
        elif ".dist-info/" in name:
            sys.exit(f"unexpected dist-info entry {name}")
        files[name] = data
for n in notices:
    name, _, path = n.partition("=")
    files[new_di + "licenses/" + name] = Path(path).read_bytes()
meta = new_di + "METADATA"
lines = files[meta].decode("utf-8").split("\n")
hits = [i for i, l in enumerate(lines) if l.rstrip(chr(13)) == f"Version: {public}"]
if len(hits) != 1:
    sys.exit("METADATA has no single Version line")
lines[hits[0]] = lines[hits[0]].replace(public, local)
last = max(i for i, l in enumerate(lines) if l.startswith("License-File: "))
eol = chr(13) if lines[last].endswith(chr(13)) else ""
for j, n in enumerate(notices):
    lines.insert(last + 1 + j, "License-File: " + n.partition("=")[0] + eol)
files[meta] = "\n".join(lines).encode("utf-8")
record = new_di + "RECORD"
files.pop(record, None)
rows = []
for name in sorted(files):
    digest = base64.urlsafe_b64encode(hashlib.sha256(files[name]).digest()).rstrip(b"=").decode()
    rows.append(f"{name},sha256={digest},{len(files[name])}")
rows.append(f"{record},,")
files[record] = ("\n".join(rows) + "\n").encode("utf-8")
out = dest_dir / Path(src).name.replace(f"lxml-{public}-", f"lxml-{local}-")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in sorted(files, key=lambda n: (n.startswith(new_di), n)):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, files[name])
print(out)
"@
$relabeled = Join-Path $WorkDir "relabeled"
if (Test-Path $relabeled) { Remove-Item $relabeled -Recurse -Force }
New-Item -ItemType Directory -Force $relabeled | Out-Null
# The statically linked libraries' notices travel in the wheel's dist-info
# licenses/, which setup-python-embed.ps1 keeps in the runtime.
$Notices = @(
    "COPYING.libxml2=$(Join-Path $Dir['libxml2'] 'Copyright')",
    "COPYING.libxslt=$(Join-Path $Dir['libxslt'] 'Copyright')",
    "LICENSE.zlib=$(Join-Path $Dir['zlib'] 'LICENSE')",
    "README.win-iconv=$(Join-Path $Dir['win-iconv'] 'readme.txt')"
)
Invoke-Checked "relabel" { & $VPy $relabel $built[0].FullName $relabeled $LxmlVersion $WheelVersion @Notices }
$wheelName = "lxml-$WheelVersion-cp314-cp314-win_amd64.whl"
$candidate = Join-Path $relabeled $wheelName
if (-not (Test-Path $candidate)) { Fail "relabel produced no $wheelName" }

# 10. delvewheel: every library is static, so the repair must find no DLL
# outside the Python runtime and the system to vendor.
$DelveWheel = Join-Path $BuildVenv "Scripts\delvewheel.exe"
$show = & $DelveWheel show $candidate 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "delvewheel show failed: $show" }
Write-Host $show
if ($show -notmatch 'will be copied into the wheel\.\s*\r?\n\s*None') { Fail "delvewheel would vendor a DLL into the wheel" }
Copy-Item $candidate (Join-Path $Dist $wheelName) -Force
$wheel = Get-Item (Join-Path $Dist $wheelName)

# 11. Verification. Every check is a refusal; nothing is written to -OutDir
# until all of them pass.
$Inspect = Join-Path $WorkDir "inspect"
if (Test-Path $Inspect) { Remove-Item $Inspect -Recurse -Force }
Invoke-Checked "wheel extraction" { & $VPy -m zipfile -e $wheel.FullName $Inspect }
$dlls = @(Get-ChildItem $Inspect -Recurse -File -Filter *.dll)
if ($dlls) { Fail "the wheel carries DLLs: $(($dlls | ForEach-Object Name) -join ', ')" }
foreach ($n in $Notices) {
    $name, $from = $n -split '=', 2
    $shipped = Join-Path $Inspect "lxml-$WheelVersion.dist-info\licenses\$name"
    if (-not (Test-Path $shipped) -or (Get-Sha256 $shipped) -ne (Get-Sha256 $from)) { Fail "the wheel's dist-info does not carry $name as released" }
}
$report = & $VPy (Join-Path $PSScriptRoot "pe_imports.py") $Inspect | Out-String | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { Fail "import inventory failed" }
foreach ($p in $report.PSObject.Properties) {
    $name = Split-Path $p.Name -Leaf
    $imports = @($p.Value.imports) + @($p.Value.delay_imports)
    Write-Host "  $name -> $($imports -join ', ')"
    foreach ($dll in $imports) {
        if ($dll -notmatch '^(python314|vcruntime140|kernel32|advapi32|ws2_32|bcrypt|api-ms-win-crt-[a-z0-9-]+)\.dll$') {
            Fail "$name imports $dll"
        }
    }
}
foreach ($pyd in (Get-ChildItem $Inspect -Recurse -File -Filter *.pyd)) {
    $ascii = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($pyd.FullName))
    # GNU libiconv's alias table; win-iconv has neither name.
    if ($ascii -match 'BIG5-HKSCS:2008|MACCENTRALEUROPE') { Fail "$($pyd.Name) still carries GNU libiconv" }
    if ($ascii.Contains("xml/catalog")) { Fail "$($pyd.Name) carries a compiled-in default catalog path" }
    $root = [regex]::Escape(($WorkDir -replace '\\', '/').ToLowerInvariant())
    if (($ascii.ToLowerInvariant() -replace '\\', '/') -match $root) { Fail "$($pyd.Name) names the work directory" }
}

$TestVenv = Join-Path $WorkDir "venv-test"
if (Test-Path $TestVenv) { Remove-Item $TestVenv -Recurse -Force }
Invoke-Checked "test venv" { & $Python -m venv $TestVenv }
$TPy = Join-Path $TestVenv "Scripts\python.exe"
Invoke-Checked "wheel install" { & $TPy -m pip install --disable-pip-version-check --no-index --no-deps $wheel.FullName }

$probe = Join-Path $WorkDir "verify.py"
Set-Content -Path $probe -Encoding UTF8 -Value @"
import sys
from importlib.metadata import version
from lxml import etree, objectify

problems = []
want = tuple(int(p) for p in "$Libxml2Version".split("."))
if etree.LIBXML_VERSION != want or etree.LIBXML_COMPILED_VERSION != want:
    problems.append(f"libxml2 {etree.LIBXML_VERSION} compiled {etree.LIBXML_COMPILED_VERSION}")
xslt = tuple(int(p) for p in "$LibxsltVersion".split("."))
if etree.LIBXSLT_VERSION != xslt or etree.LIBXSLT_COMPILED_VERSION != xslt:
    problems.append(f"libxslt {etree.LIBXSLT_VERSION}")
if etree.LXML_VERSION[:3] != tuple(int(p) for p in "$LxmlVersion".split(".")):
    problems.append(f"LXML_VERSION {etree.LXML_VERSION}")
if version("lxml") != "$WheelVersion":
    problems.append(f"distribution version {version('lxml')}")
need = {"xpath", "iconv", "zlib", "regexp", "html", "catalog", "xmlschema", "schematron"}
if not need <= set(etree.LIBXML_FEATURES):
    problems.append(f"features {sorted(etree.LIBXML_FEATURES)} lack {sorted(need - set(etree.LIBXML_FEATURES))}")
for enc, codec in [("shift_jis", "shift_jis"), ("euc-jp", "euc_jp"), ("big5", "big5"), ("windows-1255", "cp1255"),
                   ("koi8-r", "koi8_r"), ("iso-2022-jp", "iso2022_jp"), ("utf-32", "utf-32"), ("iso-8859-7", "iso8859_7")]:
    text = chr(0x65e5) + chr(0x672c) if enc in ("shift_jis", "euc-jp", "iso-2022-jp") else (chr(0x4e2d) if enc == "big5" else "ab")
    if enc == "windows-1255":
        text = chr(0x5d0)
    if enc == "koi8-r":
        text = chr(0x416)
    if enc == "iso-8859-7":
        text = chr(0x3a9)
    doc = f'<?xml version="1.0" encoding="{enc}"?><a>{text}</a>'.encode(codec)
    try:
        got = etree.fromstring(doc).text
        if got != text:
            problems.append(f"{enc}: decoded {got!r}")
    except Exception as exc:
        problems.append(f"{enc}: {exc}")
root = etree.fromstring(b"<r xmlns:x='u'><x:a n='1'>t</x:a></r>")
if root.xpath("string(//x:a/@n)", namespaces={"x": "u"}) != "1":
    problems.append("xpath")
xsl = etree.XSLT(etree.XML(b'<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><o><xsl:value-of select="count(//*)"/></o></xsl:template></xsl:stylesheet>'))
if str(xsl(root)).strip().endswith("<o>2</o>") is False:
    problems.append(f"xslt {str(xsl(root))!r}")
bomb = b'<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa">' + b"".join(
    b'<!ENTITY %c "%s">' % (ord("b") + i, (b"&%c;" % (ord("a") + i)) * 10) for i in range(8)) + b']><r>&i;</r>'
try:
    etree.fromstring(bomb, etree.XMLParser(resolve_entities=True, huge_tree=False))
    problems.append("entity amplification was not refused")
except etree.XMLSyntaxError:
    pass
if objectify.fromstring(b"<a><b>3</b></a>").b + 1 != 4:
    problems.append("objectify")
print(etree.LIBXML_VERSION, etree.LIBXSLT_VERSION, sorted(etree.LIBXML_FEATURES))
if problems:
    print("\n".join(problems))
    sys.exit(1)
"@
Invoke-Checked "runtime verification" { & $TPy -I $probe }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$dest = Join-Path $OutDir $wheel.Name
Copy-Item $wheel.FullName $dest -Force
$sdistDest = Join-Path $OutDir "lxml-$LxmlVersion.tar.gz"
if (-not (Test-Path $sdistDest)) { Copy-Item $Archive["lxml sdist"] $sdistDest }
$sha = Get-Sha256 $dest
Write-Host ""
Write-Host "Wrote $dest"
Write-Host "  size   $((Get-Item $dest).Length) bytes"
Write-Host "  sha256 $sha"
Write-Host "Pin this hash in scripts/vendored-wheels.tsv."
