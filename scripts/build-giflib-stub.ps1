# Builds scripts/tesseract-giflib-stub/libgif-7.dll from libgif-stub.c beside it.
#
# The DLL replaces giflib 5.2.2 in the OCR runtime: libleptonica-6.dll imports
# eleven giflib symbols, so a DLL of that name must load, but no OCR path reads
# or writes GIF (both Tesseract spawn sites pass a PNG this program rendered).
# The stub exports exactly the imported names and contains no giflib code.
#
# MAINTENANCE TOOL: run when libgif-stub.c changes, then commit the DLL and pin
# its hash in bundle-tesseract.ps1 ($ExpectedGifStubSha256). /Brepro makes the
# link deterministic, so a rebuild reproduces the committed bytes.
#
# Requires Visual Studio with the C++ x64 toolset.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-giflib-stub.ps1

param(
    [string]$OutDir = "$PSScriptRoot\tesseract-giflib-stub"
)

$ErrorActionPreference = "Stop"

# The import set of libleptonica-6.dll from libgif-7.dll. The build refuses a
# DLL whose export table differs from it.
$Exports = @(
    "DGifCloseFile", "DGifOpen", "DGifSlurp",
    "EGifCloseFile", "EGifOpen", "EGifPutComment", "EGifPutImageDesc", "EGifPutLine", "EGifPutScreenDesc",
    "GifFreeMapObject", "GifMakeMapObject"
)

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { Write-Error "No Visual Studio with the x64 C++ toolset."; exit 1 }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
$env:PATH = "$(Split-Path $vswhere);$env:PATH"

$src = Join-Path $OutDir "libgif-stub.c"
$work = Join-Path $env:TEMP "giflib-stub-build"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null

$cmd = "`"$vcvars`" >nul && cd /d `"$work`" && cl /nologo /c /O1 /GS- /Zl /W4 /WX `"$src`" /Fo:libgif-stub.obj && " +
       "link /nologo /DLL /NOENTRY /NODEFAULTLIB /MACHINE:X64 /Brepro /OUT:libgif-7.dll libgif-stub.obj"
& cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { Write-Error "Stub build failed ($LASTEXITCODE)."; exit 1 }

$dll = Join-Path $work "libgif-7.dll"
$py = Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
$probe = "import sys, json; sys.path.insert(0, sys.argv[1]); import pe_imports; from pathlib import Path; " +
         "p = Path(sys.argv[2]); print(json.dumps({'exports': sorted(pe_imports.exports(p)), 'imports': pe_imports.imports(p)}))"
$json = & $py -c $probe $PSScriptRoot $dll
if ($LASTEXITCODE -ne 0) { Write-Error "Export probe failed."; exit 1 }
$table = $json | ConvertFrom-Json
$got = @($table.exports) -join ","
$want = @($Exports | Sort-Object) -join ","
if ($got -ne $want) { Write-Error "Export table differs.`n  want: $want`n  got:  $got"; exit 1 }
if (@($table.imports.PSObject.Properties).Count -ne 0) { Write-Error "The stub imports a DLL."; exit 1 }

Copy-Item $dll -Destination (Join-Path $OutDir "libgif-7.dll") -Force
$sha = (Get-FileHash (Join-Path $OutDir "libgif-7.dll") -Algorithm SHA256).Hash
$srcSha = (Get-FileHash $src -Algorithm SHA256).Hash
$provenance = @"
libgif-7.dll -- export stub in place of giflib 5.2.2 in the OCR runtime. No giflib code.

Built by scripts/build-giflib-stub.ps1 from:
  source  scripts/tesseract-giflib-stub/libgif-stub.c
          SHA-256 $srcSha
  flags   cl /O1 /GS- /Zl /W4 /WX; link /DLL /NOENTRY /NODEFAULTLIB /MACHINE:X64 /Brepro

Exports (the import set of libleptonica-6.dll from libgif-7.dll):
  $($Exports -join ", ")
Imports: none.

SHA-256 of the DLL as committed: $sha
"@
[System.IO.File]::WriteAllText((Join-Path $OutDir "PROVENANCE.txt"), $provenance, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $(Join-Path $OutDir 'libgif-7.dll')"
Write-Host "SHA-256 $sha"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
