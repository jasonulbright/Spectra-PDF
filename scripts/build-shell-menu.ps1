# Builds the File Explorer command handler and its sparse packages into
# resources/shell/, the payload directory both containers ship:
#
#   resources/shell/x64/spectrapdf_shell.dll
#   resources/shell/arm64/spectrapdf_shell.dll
#   resources/shell/SpectraPDF.ExplorerCommands_x64.msix
#   resources/shell/SpectraPDF.ExplorerCommands_arm64.msix
#   resources/shell/package-identity.json
#   resources/shell/Square150x150Logo.png, Square44x44Logo.png, StoreLogo.png
#
# Both architectures are always built: Windows on ARM runs the x64 app under
# emulation, but its Explorer is native ARM64 and loads only an ARM64 handler.
#
# SIGNING. Each DLL is signed at its cargo output path and each package at its
# stage path, before the copy: Test-SignedArtifact refuses anything under
# `resources`, which is vendored third-party territory. In the release
# pipeline the package's Publisher must equal the subject of the certificate
# that signs it, all RDNs in order, or Windows refuses the package; the subject
# is committed in scripts/shell-menu-publisher.txt and compared with the
# certificate that actually signed the DLLs, and a mismatch fails the build.
# Outside the pipeline nothing is signed and the packages carry the
# development publisher; -DevSigningThumbprint signs them with a certificate
# from Cert:\CurrentUser\My whose subject is that publisher (trust it through
# Cert:\CurrentUser\TrustedPeople to register the package locally).
#
# Runs as `npm run build:shell-menu`, which `build.beforeBundleCommand` calls
# inside `tauri build`: the release job's signing token is valid only inside
# that step. -CompileOnly builds the DLLs and creates resources/shell without
# signing or packing, so the slow part runs before the signing window opens
# and the app compiles against an existing resource directory. -Prepare only
# creates resources/shell, which `npm run prepackage` needs for a development
# build: Tauri refuses to compile while a declared resource directory is
# missing. -Check is the local CI-parity mirror (scripts/ci-parity-gates.sh):
# it compiles each handler whose Rust target is installed, renders both
# manifests with the committed publisher and packs them, and stages nothing.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\build-shell-menu.ps1 [-Prepare | -CompileOnly | -Check]

param(
    [switch]$Prepare,
    [switch]$CompileOnly,
    [switch]$Check,
    [string]$Publisher = "",
    [string]$DevSigningThumbprint = ""
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tauriDir = Join-Path $root "src-tauri"
$resourceDir = Join-Path $root "resources\shell"
$stageRoot = Join-Path $tauriDir "target\shell-menu-stage"
$checkRoot = Join-Path $tauriDir "target\shell-menu-check"
$packageName = "SpectraPDF.ExplorerCommands"
$developmentPublisher = "CN=Spectra PDF Development"
$arches = [ordered]@{ "x64" = "x86_64-pc-windows-msvc"; "arm64" = "aarch64-pc-windows-msvc" }
$logos = @("Square150x150Logo.png", "Square44x44Logo.png", "StoreLogo.png")

. (Join-Path $PSScriptRoot "windows-signing.ps1")

function Invoke-Checked {
    param([string]$What, [scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

function Invoke-HandlerBuild {
    param([string]$Triple)
    Push-Location $tauriDir
    try {
        Invoke-Checked "cargo build ($Triple)" {
            cargo build --release --locked -p spectrapdf-shell-menu --target $Triple
        }
    } finally {
        Pop-Location
    }
}

# The manifest renderer, built for the host ahead of the signing window.
function Invoke-RendererBuild {
    Push-Location $tauriDir
    try {
        Invoke-Checked "cargo build (render-manifest)" {
            cargo build --release --locked -p spectrapdf-shell-menu --example render-manifest
        }
    } finally {
        Pop-Location
    }
}

# Why one architecture's handler cannot be built here, or "" when it can:
# the Rust target, and for ARM64 the MSVC ARM64 linker, which Visual Studio
# installs only with its ARM64 build tools component.
function Get-MissingToolchain {
    param([string]$Arch)
    $triple = $arches[$Arch]
    if ($installed -notcontains $triple) {
        return "the Rust target $triple (rustup target add $triple)"
    }
    if ($Arch -ne "arm64") { return "" }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $vsRoot = @(& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath 2>$null | Where-Object { $_ })
        if ($vsRoot.Count -gt 0) {
            $linkers = @(Get-ChildItem -Path (Join-Path $vsRoot[0] "VC\Tools\MSVC\*\bin\Hostx64\arm64\link.exe") -File -ErrorAction SilentlyContinue)
            if ($linkers.Count -gt 0) { return "" }
        }
    }
    return "the MSVC ARM64 linker (Visual Studio Installer: 'MSVC C++ ARM64/ARM64EC build tools (Latest)' under 'Desktop development with C++')"
}

# One architecture's package layout: the manifest and the logos it names.
function New-PackageLayout {
    param([string]$Layout, [string]$Arch, [string]$Subject, [string]$Version, [string]$Identity)
    if (Test-Path -LiteralPath $Layout) { Remove-Item -LiteralPath $Layout -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $Layout "shell") | Out-Null
    foreach ($logo in $logos) {
        Copy-Item -LiteralPath (Join-Path $tauriDir "icons\$logo") -Destination (Join-Path $Layout "shell\$logo")
    }
    Push-Location $tauriDir
    try {
        Invoke-Checked "render-manifest ($Arch)" {
            cargo run --release --locked -q -p spectrapdf-shell-menu --example render-manifest -- `
                --version $Version --publisher $Subject --arch $Arch `
                --manifest (Join-Path $Layout "AppxManifest.xml") --identity $Identity
        }
    } finally {
        Pop-Location
    }
}

if ($Prepare) {
    New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null
    Write-Host "build-shell-menu: resources/shell exists; the bundle step builds its contents"
    exit 0
}

$conf = Get-Content (Join-Path $tauriDir "tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$conf.version
$committedPublisher = (Get-Content (Join-Path $PSScriptRoot "shell-menu-publisher.txt") -Raw -Encoding UTF8).Trim()
if (-not $committedPublisher.StartsWith("CN=")) {
    throw "scripts/shell-menu-publisher.txt must hold the signing certificate subject, starting with CN="
}
$installed = @(& rustup target list --installed 2>$null)

# The local mirror of the release job's handler build: compile, render both
# manifests with the committed publisher, and pack them, which validates each
# manifest against the package schema. Nothing is signed or staged.
if ($Check) {
    foreach ($arch in $arches.Keys) {
        $missing = Get-MissingToolchain $arch
        if ($missing) {
            Write-Host "build-shell-menu: NOT COMPILED for $arch -- missing $missing; the release job compiles it"
        } else {
            Invoke-HandlerBuild $arches[$arch]
        }
    }
    Invoke-RendererBuild
    New-Item -ItemType Directory -Force -Path $checkRoot | Out-Null
    $makeAppx = Get-MakeAppxPath
    foreach ($arch in $arches.Keys) {
        $layout = Join-Path $checkRoot $arch
        New-PackageLayout $layout $arch $committedPublisher $version (Join-Path $checkRoot "package-identity.json")
        Invoke-Checked "MakeAppx pack ($arch)" {
            & $makeAppx pack /o /d $layout /nv /p (Join-Path $checkRoot "$($packageName)_$arch.msix")
        }
    }
    Write-Host "build-shell-menu: both manifests render and pack (publisher '$committedPublisher', version $version)"
    exit 0
}

foreach ($arch in $arches.Keys) {
    $missing = Get-MissingToolchain $arch
    if ($missing) { throw "the $arch File Explorer command handler cannot be built: install $missing" }
}
New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null
foreach ($triple in $arches.Values) { Invoke-HandlerBuild $triple }
Invoke-RendererBuild

if ($CompileOnly) {
    Write-Host "build-shell-menu: compiled both handlers and the manifest renderer; resources/shell exists"
    exit 0
}

$signing = ($env:GITHUB_ACTIONS -ceq "true" -and $env:SPECTRAPDF_SIGN -ceq "1")
if (-not $Publisher) {
    $Publisher = if ($signing) { $committedPublisher } else { $developmentPublisher }
}
if ($signing -and $Publisher -cne $committedPublisher) {
    throw "a signed build must use the committed publisher '$committedPublisher', not '$Publisher'"
}

function Set-ArtifactSignature {
    param([string]$Path)
    if ($DevSigningThumbprint) {
        $signtool = Get-SignToolPath
        Invoke-Checked "signtool sign $Path" {
            & $signtool sign /fd SHA256 /sha1 $DevSigningThumbprint /s My $Path
        }
        return
    }
    Invoke-Checked "sign-windows.ps1 $Path" {
        powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "sign-windows.ps1") $Path
    }
}

# .NET reads the signer without loading Microsoft.PowerShell.Security, which
# the bundler's environment can leave unloadable.
function Get-SignerSubject {
    param([string]$Path)
    try {
        return [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($Path).Subject
    } catch {
        return ""
    }
}

$dlls = @{}
foreach ($arch in $arches.Keys) {
    $dll = Join-Path $tauriDir "target\$($arches[$arch])\release\spectrapdf_shell.dll"
    if (-not (Test-Path -LiteralPath $dll)) { throw "cargo produced no handler at $dll" }
    Set-ArtifactSignature $dll
    if ($signing -or $DevSigningThumbprint) {
        $subject = Get-SignerSubject $dll
        if ($subject -cne $Publisher) {
            throw "$dll is signed by '$subject', but the package publisher is '$Publisher'. Update scripts/shell-menu-publisher.txt to the signing subject, all RDNs in order."
        }
    }
    $dlls[$arch] = $dll
}

if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
$makeAppx = Get-MakeAppxPath
$identity = Join-Path $stageRoot "package-identity.json"
$packages = @{}
foreach ($arch in $arches.Keys) {
    $layout = Join-Path $stageRoot $arch
    New-PackageLayout $layout $arch $Publisher $version $identity
    $msix = Join-Path $stageRoot "$($packageName)_$arch.msix"
    Invoke-Checked "MakeAppx pack ($arch)" { & $makeAppx pack /o /d $layout /nv /p $msix }
    Set-ArtifactSignature $msix
    $packages[$arch] = $msix
}

Get-ChildItem -LiteralPath $resourceDir -Force | Remove-Item -Recurse -Force
foreach ($arch in $arches.Keys) {
    $target = Join-Path $resourceDir $arch
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath $dlls[$arch] -Destination (Join-Path $target "spectrapdf_shell.dll")
    Copy-Item -LiteralPath $packages[$arch] -Destination $resourceDir
}
Copy-Item -LiteralPath $identity -Destination $resourceDir
foreach ($logo in $logos) {
    Copy-Item -LiteralPath (Join-Path $tauriDir "icons\$logo") -Destination $resourceDir
}
Write-Host "build-shell-menu: staged both handlers and packages in resources/shell (publisher '$Publisher', version $version)"
