# Builds the libxml2.dll that bundle-libreoffice.ps1 installs over the one in
# the pinned LibreOffice release.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-lo-libxml2.ps1
#
# LibreOffice ships libxml2 as its own DLL (program/libxml2.dll, 2.14.6), loaded
# by the import filters, libxslt, libexslt, xmlsec and raptor2 through ordinary
# imports. 2.15 keeps the 2.14 ABI (the soname stays libxml2.so.16; 2.15 removes
# the HTTP client but keeps its symbols as stubs under LIBXML2_WITH_HTTP), so the
# fixed release replaces the DLL without rebuilding its consumers. The build is
# libxml2 2.15.4 from the GNOME release archive, as a DLL with the configuration
# the shipped one has: ICU for encodings (against the tree's own icuuc78.dll,
# through an import library generated from its export table and the ICU 78.3
# release headers), no iconv, no zlib, HTTP stubs, modules, threads.
#
# One change from upstream: no compiled-in default catalog. The default is
# "file://<sysconfdir>/xml/catalog"; the shipped DLL carries /etc/xml/catalog,
# which on Windows is C:\etc\xml\catalog, a path any local user can create, and
# a catalog there would redirect entity and DTD resolution in every import.
# XML_CATALOG_FILES still applies when the process environment sets it.
#
# Refusals: every symbol any binary of the tree imports from libxml2.dll must be
# exported; the DLL may import only the system, the CRT, bcrypt, ws2_32/wsock32
# and icuuc78.dll; each icuuc78 import must be exported by the tree's copy.
#
# MAINTENANCE tool: it runs when the LibreOffice or libxml2 pin moves; its
# output is reviewed and committed with the hash pinned in bundle-libreoffice.ps1.

param(
    [string]$WorkDir = (Join-Path $env:TEMP "lo-libxml2"),
    [string]$OutDir = (Join-Path $PSScriptRoot "libreoffice-libxml2"),
    [string]$LibreOfficeTree = (Join-Path $PSScriptRoot "..\resources\libreoffice")
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\download-retry.ps1"

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$LibreOfficeTree = [System.IO.Path]::GetFullPath($LibreOfficeTree)
$Libxml2Version = "2.15.4"
$IcuDll = "icuuc78.dll"

# libxml2: GNOME's published .sha256sum. ICU: the digest GitHub records for the
# release asset, which SHASUM512.txt of the same release also covers.
$Sources = @(
    [pscustomobject]@{
        Name = "libxml2"; File = "libxml2-$Libxml2Version.tar.xz"; Dir = "libxml2-$Libxml2Version"
        Sha256 = "98087fd181d9070724f3fbc65c7377db03038eb92bd882374daff44940138821"
        Url = "https://download.gnome.org/sources/libxml2/2.15/libxml2-$Libxml2Version.tar.xz"
    },
    [pscustomobject]@{
        Name = "ICU"; File = "icu4c-78.3-sources.tgz"; Dir = "icu"
        Sha256 = "3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0"
        Url = "https://github.com/unicode-org/icu/releases/download/release-78.3/icu4c-78.3-sources.tgz"
    }
)

function Fail([string]$Message) {
    Write-Host "REFUSED: $Message" -ForegroundColor Red
    exit 1
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit $LASTEXITCODE)" }
}

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

$Program = Join-Path $LibreOfficeTree "program"
foreach ($f in @("libxml2.dll", $IcuDll)) {
    if (-not (Test-Path (Join-Path $Program $f))) { Fail "no $f in $Program; run bundle-libreoffice.ps1 first" }
}

New-Item -ItemType Directory -Force $WorkDir | Out-Null
$Downloads = Join-Path $WorkDir "downloads"
New-Item -ItemType Directory -Force $Downloads | Out-Null
$Archive = @{}
foreach ($s in $Sources) {
    $path = Join-Path $Downloads $s.File
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
$Python = Join-Path $LibreOfficeTree "..\python\python.exe"
if (-not (Test-Path $Python)) { Fail "no embedded runtime at $Python; run setup-python-embed.ps1 first" }

$Src = Join-Path $WorkDir "src"
$Build = Join-Path $WorkDir "build"
$Prefix = Join-Path $WorkDir "prefix"
foreach ($d in @($Src, $Build, $Prefix)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Force $d | Out-Null
}
$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
foreach ($s in $Sources) { Invoke-Checked "extracting $($s.Name)" { & $Tar -xf $Archive[$s.Name] -C $Src } }
$XmlSrc = Join-Path $Src "libxml2-$Libxml2Version"
$IcuInc = Join-Path $Src "icu\source\common"
if (-not (Test-Path (Join-Path $IcuInc "unicode\ucnv.h"))) { Fail "the ICU archive has no source/common/unicode/ucnv.h" }

# Import library for the tree's ICU, from its own export table.
$peTool = Join-Path $WorkDir "pe.py"
Set-Content -Path $peTool -Encoding UTF8 -Value @"
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import pe_imports as p

mode = sys.argv[2]
if mode == "def":
    names = p.exports(sys.argv[3])
    Path(sys.argv[4]).write_text("LIBRARY " + Path(sys.argv[3]).name + "\nEXPORTS\n" + "".join(f"    {n}\n" for n in names if not n.startswith("#")))
elif mode == "check":
    tree, built, icu = Path(sys.argv[3]), sys.argv[4], sys.argv[5]
    needed = {}
    for f in list(tree.rglob("*.dll")) + list(tree.rglob("*.exe")):
        if f.name.lower() == "libxml2.dll":
            continue
        try:
            tables = [p.imports(f), p.delay_imports(f)]
        except Exception:
            continue
        for t in tables:
            for dll, syms in t.items():
                if dll.lower() == "libxml2.dll":
                    for s in syms:
                        needed.setdefault(s, set()).add(f.name)
    provided = set(p.exports(built))
    problems = [f"{s} (imported by {', '.join(sorted(needed[s]))}) is not exported" for s in sorted(set(needed) - provided)]
    allowed = ("kernel32.dll", "bcrypt.dll", "ws2_32.dll", "wsock32.dll", "vcruntime140.dll", "icuuc78.dll")
    imports = {k.lower(): v for k, v in p.imports(built).items()}
    for dll in imports:
        if dll not in allowed and not dll.startswith("api-ms-win-crt-"):
            problems.append(f"imports {dll}")
    missing = set(imports.get("icuuc78.dll", [])) - set(p.exports(icu))
    if missing:
        problems.append(f"{icu} does not export {sorted(missing)}")
    print(json.dumps({"needed": len(needed), "exported": len(provided), "imports": sorted(imports)}))
    if problems:
        print("\n".join(problems))
        sys.exit(1)
"@
$IcuLib = Join-Path $Prefix "icuuc.lib"
$IcuDef = Join-Path $WorkDir "icuuc78.def"
Invoke-Checked "ICU export table" { & $Python -I $peTool $PSScriptRoot def (Join-Path $Program $IcuDll) $IcuDef }
Invoke-Checked "ICU import library" { & lib.exe /nologo /MACHINE:X64 "/DEF:$IcuDef" "/OUT:$IcuLib" }

$cat = Join-Path $XmlSrc "catalog.c"
$text = [System.IO.File]::ReadAllText($cat)
$catAnchor = '#define XML_XML_DEFAULT_CATALOG "file://" XML_SYSCONFDIR "/xml/catalog"'
if (([regex]::Matches($text, [regex]::Escape($catAnchor))).Count -ne 1) { Fail "catalog.c: the default catalog definition is not where it was" }
$text = $text.Replace($catAnchor, '#define XML_XML_DEFAULT_CATALOG ""')
$text = $text.Replace('#define XML_SGML_DEFAULT_CATALOG "file://" XML_SYSCONFDIR "/sgml/catalog"', '#define XML_SGML_DEFAULT_CATALOG ""')
[System.IO.File]::WriteAllText($cat, $text)

$env:CL = "/Brepro /d1trimfile:$Src\"
$env:LINK = "/Brepro"
$xmlBuild = Join-Path $Build "libxml2"
Invoke-Checked "libxml2 configure" {
    & $CMake -S $XmlSrc -B $xmlBuild -GNinja "-DCMAKE_MAKE_PROGRAM=$Ninja" -DCMAKE_BUILD_TYPE=Release `
        "-DCMAKE_INSTALL_PREFIX=$Prefix" -DBUILD_SHARED_LIBS=ON `
        -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL `
        "-DICU_INCLUDE_DIR=$IcuInc" "-DICU_UC_LIBRARY_RELEASE=$IcuLib" `
        -DLIBXML2_WITH_ICU=ON -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_LZMA=OFF `
        -DLIBXML2_WITH_HTTP=ON -DLIBXML2_WITH_MODULES=ON -DLIBXML2_WITH_SCHEMATRON=ON `
        -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_DOCS=OFF
}
Invoke-Checked "libxml2 build" { & $CMake --build $xmlBuild }
$Built = Join-Path $xmlBuild "libxml2.dll"
if (-not (Test-Path $Built)) { Fail "the build produced no libxml2.dll" }

Invoke-Checked "export and import check" { & $Python -I $peTool $PSScriptRoot check $LibreOfficeTree $Built (Join-Path $Program $IcuDll) }
$ascii = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($Built))
if ($ascii.Contains("xml/catalog")) { Fail "the DLL carries a compiled-in default catalog path" }
if ($ascii.ToLowerInvariant().Contains(($WorkDir -replace '\\', '/').ToLowerInvariant()) -or
    $ascii.ToLowerInvariant().Contains($WorkDir.ToLowerInvariant())) { Fail "the DLL names the work directory" }
$vi = & $Python -I -c "import sys; sys.path.insert(0, r'$PSScriptRoot'); import pe_imports as p; print(p.version_info(r'$Built')['ProductVersion'])"
if ("$vi".Trim() -ne $Libxml2Version) { Fail "version resource reports '$vi'" }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$dest = Join-Path $OutDir "libxml2.dll"
Copy-Item $Built $dest -Force
$sha = Get-Sha256 $dest
[System.IO.File]::WriteAllText((Join-Path $OutDir "PROVENANCE.txt"), @"
libxml2.dll -- libxml2 $Libxml2Version for the vendored LibreOffice tree.

Built by scripts/build-lo-libxml2.ps1 from:
  libxml2  $($Sources[0].Url)
           SHA-256 $($Sources[0].Sha256)
  ICU      $($Sources[1].Url) (headers only)
           SHA-256 $($Sources[1].Sha256)
  CMake, shared, ICU on, iconv/zlib/LZMA off, HTTP stubs on, modules on.
  catalog.c: no compiled-in default catalog (XML_XML_DEFAULT_CATALOG "").

SHA-256 of the DLL as committed: $sha

libxml2 is MIT-licensed; its notice is covered by the LibreOffice tree's
license files and THIRD-PARTY-LICENSES.md.
"@)
Write-Host "Wrote $dest"
Write-Host "  sha256 $sha"
Write-Host "Pin this hash in scripts/bundle-libreoffice.ps1 (libxml2 overlay)."
