# Builds the pyexpat.pyd that setup-python-embed.ps1 installs over the one in
# the python.org embeddable package.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-pyexpat-expat285.ps1
#
# CPython links Expat statically into pyexpat.pyd, so the Expat release in the
# runtime is fixed by the CPython release. This builds pyexpat.pyd from the
# released CPython source of the pinned version with Modules/expat/ replaced by
# the released Expat source, prepared the way CPython's own
# Modules/expat/refresh.sh prepares it. The prepared tree must equal, file for
# file, Modules/expat/ of the CPython maintenance-branch commit that made the
# same substitution; Modules/pyexpat.c and every other file stay as released.
# _elementtree.pyd needs no rebuild: it reaches Expat only through the
# pyexpat.expat_CAPI capsule and links no Expat code of its own (it carries no
# "expat_" version string and none of Expat's error strings).
#
# The compile and link options are PCbuild/pyproject.props for a Release x64
# pyd, except /Brepro and no PDB, so a rebuild of unchanged inputs yields the
# same bytes. The import library is the one installed with CPython of the same
# version; every symbol the result takes from python314.dll and vcruntime140.dll
# is checked against the export tables of the embedded runtime's copies.
#
# This is a MAINTENANCE tool: it runs when the Python or Expat pin moves, and
# its output is reviewed and committed together with the hash pinned in
# setup-python-embed.ps1. It needs Visual Studio with the x64 C++ tools and
# CPython of the pinned version installed with headers and import libraries.

param(
    [string]$WorkDir = (Join-Path $env:TEMP "pyexpat-expat285"),
    [string]$OutDir = (Join-Path $PSScriptRoot "python-pyexpat"),
    [string]$EmbeddedRuntime = (Join-Path $PSScriptRoot "..\resources\python")
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\download-retry.ps1"

$PythonVersion = "3.14.7"
$ExpatVersion = "2.8.5"
# The CPython 3.14 branch commit that updated the bundled Expat to 2.8.5.
$BranchCommit = "5659aee18f2b5c7e06ba1363e2fa3529d6a025d9"
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$EmbeddedRuntime = [System.IO.Path]::GetFullPath($EmbeddedRuntime)

# The CPython hash is the one python.org lists for the release, and the digest
# of its sigstore bundle (identity hugo@python.org). The Expat hash is the one
# CPython's refresh.sh pins at $BranchCommit.
$Sources = @(
    [pscustomobject]@{
        Name = "CPython"; File = "Python-$PythonVersion.tgz"
        Sha256 = "62859805f6fdf25e2bcbf3fa3217801e1996887ca33e6a2af80674bdfa2dbe07"
        Url = "https://www.python.org/ftp/python/$PythonVersion/Python-$PythonVersion.tgz"
    },
    [pscustomobject]@{
        Name = "Expat"; File = "expat-$ExpatVersion.tar.gz"
        Sha256 = "920dde485e15eda0cce8d2310b41d492c534e5e3d89ad407a0b4176dd2ff88fe"
        Url = "https://github.com/libexpat/libexpat/releases/download/R_2_8_5/expat-$ExpatVersion.tar.gz"
    }
)

# Modules/expat/ at $BranchCommit. The prepared tree must match every entry and
# hold no other file.
$BranchTree = [ordered]@{
    "COPYING" = "31b15de82aa19a845156169a17a5488bf597e561b2c318d159ed583139b25e87"
    "ascii.h" = "5ce49460794894b78f97060f634c129d13f2e9cc9b8dacd829f4be2dbc6e0649"
    "asciitab.h" = "5792cb56f285c8876b988d875a70d49019bc7e6d5ebcd0f8224b24e695301832"
    "expat.h" = "17cd1fc3b4c61d00de96091ceed0a3721d5bac9755c6d04e89d9f8a79d037c12"
    "expat_config.h" = "fc918070c65fa23613e4ba5a44b3407e5eb2a503ec42fbfeebee19d9e5eb5649"
    "expat_external.h" = "ec35498736485b2321610a750e5b2534399fed87dc44bc4ace529eeb5a280a53"
    "fallthrough.h" = "5e42477487bca7e7caac6b832ab940f39a1a20b8765c945374e4f6c2670f55b6"
    "hash_table.h" = "ad93851f86df1f4e8f85488dbac53cab3539e59d701ad747c7beea354d69e0dc"
    "iasciitab.h" = "a9cd6f2cf5199ae3c29d22ee4913736fcd984f62132146a0352c88549700e83f"
    "internal.h" = "0123d00963768b5779544cc54dcccad311824b192a38d3489c4fb1fbbfa33b17"
    "latin1tab.h" = "b0daf8a75c690e895421f765ddb2ae2fbc1ba14694e06a3215dba84f1ff3427d"
    "memory_sanitizer.h" = "377ca054fdc531360f42a5cb7c522bcbf88b6c67aebc2e29544c37d14e836bde"
    "nametab.h" = "8f78e64f11e2b23df8b32cb5528cfeda6215acd6abf6bcf1ad59fdc7b1ffd105"
    "pyexpatns.h" = "c95154ba28b798023705319cd52711367ff5236b6b4b03c4cf8f1bd6ab350885"
    "siphash.h" = "12ecc9915bccb793ea8bb543cc7d002e226f4e4d6b97ec9839dca41cbe4e2e27"
    "utf8tab.h" = "3fa349a3a19143366e80a58d9aa950152ef9cd7903f557f971051410b47f335c"
    "winconfig.h" = "0ab6446eb98abc492ae341ef7607b535e44dedf52633fdc7c6e1a1361aec3922"
    "xcsinc.c" = "1210979a688301412f46e058d0497fa3c1c63c296c2e015834cda0f0b314875d"
    "xmlparse.c" = "9a4969bb0ac497803866705f3fa233cc4b487e7685800d9222bd0ab38d1b8a20"
    "xmlrole.c" = "b1ad87cc3c0d4722358a7dfb1642df7f62066d1613a0a56dc9289e7112fb3f0c"
    "xmlrole.h" = "8a0b61cd6efcd7427acbc86759e9013e7a61755097a1f82cbb2a79c011af5ee5"
    "xmltok.c" = "47ffd58f56f61284fd84cecd94ddad4c79cde922f57994c1525f8df1eb9272eb"
    "xmltok.h" = "623dea24bc27712e2e205a0c0517c79e211234f8d1051fe46d780839f754cf9e"
    "xmltok_impl.c" = "4dcd7ae88dd90bbc89d0e41ba6affb46a107ee28df3b49cb84cdf228b7cc7981"
    "xmltok_impl.h" = "a5053c69219d12788088de9bd670537e1c784302766c331afe6b253460d0417d"
    "xmltok_ns.c" = "ea723a3470d3eed5c4a4e873bec2f996c605326fad25709b45452664261c5465"
}
# Files CPython keeps in Modules/expat/ that do not come from the Expat archive.
$CPythonOwned = @("expat_config.h", "pyexpatns.h", "refresh.sh")

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

# 1. Sources, verified by SHA-256 whether cached or fetched.
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

# 2. Toolchain and the installed CPython that supplies python314.lib.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { Fail "vswhere.exe not found; Visual Studio with the C++ tools is required" }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { Fail "no Visual Studio installation with the x64 C++ tools" }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { Fail "missing $vcvars" }
foreach ($line in (cmd /c "`"$vcvars`" >nul 2>&1 && set")) {
    if ($line -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
}
foreach ($tool in @("cl.exe", "link.exe", "rc.exe")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "vcvars64.bat did not put $tool on PATH" }
}

$Python = (& py "-$($PythonVersion -replace '\.\d+$','')" -c "import sys; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Python)) { Fail "CPython $PythonVersion not found through the py launcher" }
$reported = (& $Python -I -c "import platform; print(platform.python_version())").Trim()
if ($reported -ne $PythonVersion) { Fail "the installed CPython is $reported; the import library must come from $PythonVersion" }
$PyLibs = Join-Path (Split-Path $Python) "libs"
if (-not (Test-Path (Join-Path $PyLibs "python314.lib"))) { Fail "no python314.lib under $PyLibs" }
$EmbeddedDll = Join-Path $EmbeddedRuntime "python314.dll"
if (-not (Test-Path $EmbeddedDll)) { Fail "no embedded runtime at $EmbeddedRuntime; run setup-python-embed.ps1 first" }

# 3. Fresh source tree every run; the download cache survives.
$Src = Join-Path $WorkDir "src"
$Obj = Join-Path $WorkDir "obj"
foreach ($d in @($Src, $Obj)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Force $d | Out-Null
}
# The Windows tar, by path: a POSIX tar earlier on PATH reads "C:" as a host.
$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
foreach ($name in $Archive.Keys) {
    Invoke-Checked "extracting $name" { & $Tar -xzf $Archive[$name] -C $Src }
}
$CPy = Join-Path $Src "Python-$PythonVersion"
$ExpatSrc = Join-Path $Src "expat-$ExpatVersion"
$ExpatDir = Join-Path $CPy "Modules\expat"

# 4. Substitute Expat as refresh.sh does: take the library files and COPYING
# from the archive, add the pyexpatns.h include to expat_external.h, and gate
# the rand_s entropy path in xmlparse.c on XML_POOR_ENTROPY.
foreach ($f in Get-ChildItem $ExpatDir -File) {
    if ($CPythonOwned -notcontains $f.Name) { Remove-Item $f.FullName -Force }
}
Copy-Item (Join-Path $ExpatSrc "COPYING") $ExpatDir
foreach ($name in $BranchTree.Keys) {
    if ($CPythonOwned -contains $name -or $name -eq "COPYING") { continue }
    Copy-Item (Join-Path $ExpatSrc "lib\$name") $ExpatDir
}
Remove-Item (Join-Path $ExpatDir "refresh.sh") -Force

$lf = "`n"
$ext = Join-Path $ExpatDir "expat_external.h"
$text = [System.IO.File]::ReadAllText($ext)
$anchor = "#  define Expat_External_INCLUDED 1"
if (-not $text.Contains($anchor)) { Fail "expat_external.h has no '$anchor' line" }
$text = $text.Replace($anchor, $anchor + $lf + "/* Namespace external symbols to allow multiple libexpat version to" + $lf +
    "   co-exist. */" + $lf + "#include `"pyexpatns.h`"")
[System.IO.File]::WriteAllText($ext, $text)

$xp = Join-Path $ExpatDir "xmlparse.c"
$text = [System.IO.File]::ReadAllText($xp)
$gate = @(
    @("#if defined(_WIN32)$lf#  include `"random_rand_s.h`"$lf#endif /* defined(_WIN32) */",
      "#if defined(_WIN32) && ! defined(XML_POOR_ENTROPY)$lf#  include `"random_rand_s.h`"$lf#endif /* defined(_WIN32) && ! defined(XML_POOR_ENTROPY) */"),
    @("#  ifdef _WIN32$lf  if (writeRandomBytes_rand_s",
      "#  if defined(_WIN32) && ! defined(XML_POOR_ENTROPY)$lf  if (writeRandomBytes_rand_s")
)
foreach ($pair in $gate) {
    if (-not $text.Contains($pair[0])) { Fail "xmlparse.c no longer carries the rand_s block refresh.sh rewrites" }
    $text = $text.Replace($pair[0], $pair[1])
}
[System.IO.File]::WriteAllText($xp, $text)

$present = @(Get-ChildItem $ExpatDir -File | ForEach-Object Name)
$extra = @($present | Where-Object { -not $BranchTree.Contains($_) })
if ($extra) { Fail "Modules/expat holds files the branch commit does not: $($extra -join ', ')" }
foreach ($name in $BranchTree.Keys) {
    $p = Join-Path $ExpatDir $name
    if (-not (Test-Path $p)) { Fail "Modules/expat/$name is missing" }
    $h = Get-Sha256 $p
    if ($h -ne $BranchTree[$name]) { Fail "Modules/expat/$name is $h; the branch commit $BranchCommit has $($BranchTree[$name])" }
}
Write-Host "Modules/expat equals CPython $BranchCommit (Expat $ExpatVersion)"

# 5. Compile and link.
$Defines = @("WIN32", "_WIN64", "_M_X64", "NDEBUG", "PyStats",
             "_CRT_SECURE_NO_WARNINGS", "PYEXPAT_EXPORTS", "XML_STATIC") | ForEach-Object { "/D$_" }
$Includes = @("Include", "Include\internal", "Include\internal\mimalloc", "PC", "Modules\expat") |
    ForEach-Object { "/I$_" }
# Relative source paths from inside the tree: __FILE__ is spelled as given, so
# the work directory never lands in the image and the bytes do not depend on it.
$Units = @("Modules\pyexpat.c", "Modules\expat\xmlparse.c", "Modules\expat\xmlrole.c", "Modules\expat\xmltok.c")
Push-Location $CPy
try {
    Invoke-Checked "compile" {
        & cl.exe /nologo /c /O2 /Oi /GF /Gy /MD /W3 /GL /utf-8 /Brepro @Defines @Includes "/Fo$Obj\" @Units
    }
} finally { Pop-Location }

# FIELD3 as PCbuild/python.props computes it for a final release.
$Field3 = [int]($PythonVersion.Split(".")[2]) * 1000 + 150
$Res = Join-Path $Obj "pyexpat.res"
Invoke-Checked "resource compile" {
    & rc.exe /nologo /l 0x0409 '/DORIGINAL_FILENAME=\"pyexpat.pyd\"' "/DFIELD3=$Field3" /DNDEBUG `
        "/i$(Join-Path $CPy 'PC')" "/i$(Join-Path $CPy 'Include')" "/fo$Res" (Join-Path $CPy "PC\python_nt.rc")
}

$Built = Join-Path $WorkDir "pyexpat.pyd"
if (Test-Path $Built) { Remove-Item $Built -Force }
$Objs = @(Get-ChildItem $Obj -Filter *.obj | ForEach-Object FullName)
Invoke-Checked "link" {
    & link.exe /nologo /DLL /LTCG /OPT:REF,NOICF /Brepro /DYNAMICBASE /NXCOMPAT /MACHINE:X64 /SUBSYSTEM:WINDOWS `
        /NODEFAULTLIB:LIBC "/LIBPATH:$PyLibs" "/OUT:$Built" @Objs $Res `
        python314.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib
}
foreach ($leftover in @("pyexpat.lib", "pyexpat.exp")) {
    $p = Join-Path $WorkDir $leftover
    if (Test-Path $p) { Remove-Item $p -Force }
}

# 6. Verification. Every check is a refusal; nothing is written to -OutDir
# until all of them pass.
$bytes = [System.IO.File]::ReadAllBytes($Built)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
if (-not $ascii.Contains("expat_$ExpatVersion")) { Fail "the built pyd carries no expat_$ExpatVersion string" }
$stale = [regex]::Matches($ascii, "expat_\d+\.\d+\.\d+") | ForEach-Object Value | Where-Object { $_ -ne "expat_$ExpatVersion" }
if ($stale) { Fail "the built pyd names another Expat: $($stale -join ', ')" }

$peCheck = Join-Path $WorkDir "pe-check.py"
Set-Content -Path $peCheck -Encoding UTF8 -Value @"
import sys
sys.path.insert(0, sys.argv[1])
import pe_imports

built, runtime = sys.argv[2], sys.argv[3]
problems = []
imports = {k.lower(): v for k, v in pe_imports.imports(built).items()}
allowed = {"kernel32.dll", "python314.dll", "vcruntime140.dll"}
for dll in imports:
    if dll not in allowed and not dll.startswith("api-ms-win-crt-"):
        problems.append(f"imports {dll}")
if pe_imports.delay_imports(built):
    problems.append("has delay imports")
for dll in ("python314.dll", "vcruntime140.dll"):
    provided = set(pe_imports.exports(f"{runtime}/{dll}"))
    missing = sorted(set(imports.get(dll, [])) - provided)
    if missing:
        problems.append(f"{dll} of the embedded runtime does not export {missing}")
if pe_imports.exports(built) != ["PyInit_pyexpat"]:
    problems.append(f"exports {pe_imports.exports(built)}")
print({k: len(v) for k, v in imports.items()})
if problems:
    print("\n".join(problems))
    sys.exit(1)
"@
Invoke-Checked "import and export check" { & $Python -I $peCheck $PSScriptRoot $Built $EmbeddedRuntime }

# A copy of the embedded runtime without site-packages, with the new pyd.
$Trial = Join-Path $WorkDir "runtime"
if (Test-Path $Trial) { Remove-Item $Trial -Recurse -Force }
New-Item -ItemType Directory -Force $Trial | Out-Null
Get-ChildItem $EmbeddedRuntime -File | Copy-Item -Destination $Trial
Copy-Item $Built (Join-Path $Trial "pyexpat.pyd") -Force
$probe = Join-Path $WorkDir "verify.py"
Set-Content -Path $probe -Encoding UTF8 -Value @"
import io, plistlib, sys
import pyexpat
import xml.dom.minidom
import xml.etree.ElementTree as ET
import xml.sax
from xml.parsers import expat

problems = []
if pyexpat.version_info != tuple(int(p) for p in "$ExpatVersion".split(".")):
    problems.append(f"pyexpat.version_info {pyexpat.version_info}")
if pyexpat.EXPAT_VERSION != "expat_$ExpatVersion":
    problems.append(f"pyexpat.EXPAT_VERSION {pyexpat.EXPAT_VERSION}")
if not pyexpat.__file__.lower().startswith(sys.prefix.lower()):
    problems.append(f"pyexpat loaded from {pyexpat.__file__}")

doc = ('<?xml version="1.0" encoding="UTF-16"?><r a="1"><c>t' + chr(233) + '</c><c/></r>').encode("utf-16")
root = ET.fromstring(doc)
if root.tag != "r" or root.get("a") != "1" or root[0].text != "t" + chr(233) or len(root) != 2:
    problems.append("ElementTree UTF-16 parse")
if xml.dom.minidom.parseString(b"<a><b x='y'/></a>").documentElement.firstChild.getAttribute("x") != "y":
    problems.append("minidom parse")
seen = []
class H(xml.sax.ContentHandler):
    def startElement(self, name, attrs): seen.append(name)
xml.sax.parseString(b"<a><b/><c/></a>", H())
if seen != ["a", "b", "c"]:
    problems.append(f"sax parse {seen}")
data = {"k": [1, 2.5, "s", b"\x00", True], "n": {"x": 0}}
if plistlib.loads(plistlib.dumps(data)) != data:
    problems.append("plistlib round trip")
p = expat.ParserCreate()
p.SetReparseDeferralEnabled(False)
if p.GetReparseDeferralEnabled() is not False:
    problems.append("reparse deferral switch")
bomb = b'<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa">' + b"".join(
    b'<!ENTITY %c "%s">' % (ord("b") + i, (b"&%c;" % (ord("a") + i)) * 10) for i in range(8)) + b']><r>&i;</r>'
try:
    ET.fromstring(bomb)
    problems.append("entity amplification was not refused")
except ET.ParseError:
    pass
try:
    ET.fromstring(b"<a><b></a>")
    problems.append("malformed input was accepted")
except ET.ParseError:
    pass
print(pyexpat.EXPAT_VERSION, sorted(pyexpat.features))
if problems:
    print("\n".join(problems))
    sys.exit(1)
"@
Invoke-Checked "runtime verification" { & (Join-Path $Trial "python.exe") -I $probe }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$dest = Join-Path $OutDir "pyexpat.pyd"
Copy-Item $Built $dest -Force
$sha = Get-Sha256 $dest
[System.IO.File]::WriteAllText((Join-Path $OutDir "PROVENANCE.txt"), @"
pyexpat.pyd -- CPython $PythonVersion pyexpat with Expat $ExpatVersion.

Built by scripts/build-pyexpat-expat285.ps1 from:
  CPython  $($Sources[0].Url)
           SHA-256 $($Sources[0].Sha256)
  Expat    $($Sources[1].Url)
           SHA-256 $($Sources[1].Sha256)
  Modules/expat/ prepared as CPython's refresh.sh prepares it and equal, file
  for file, to Modules/expat/ at python/cpython $BranchCommit (3.14 branch).
  No other source file is changed.

SHA-256 of the pyd as committed: $sha

Expat is MIT-licensed; its COPYING is unchanged from the one CPython $PythonVersion
bundles, and the notice ships in the runtime's LICENSE.txt.
"@)
Write-Host ""
Write-Host "Wrote $dest"
Write-Host "  sha256 $sha"
Write-Host "Pin this hash in scripts/setup-python-embed.ps1 (pyexpat overlay)."
