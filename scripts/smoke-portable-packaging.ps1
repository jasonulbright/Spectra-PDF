# Exercise the real NSIS -> portable boundary without building the application.
# With -ExpectSigned, use the signing smoke's fresh signed/unsigned probe pair;
# this adds exactly the uninstaller and installer signatures to its app signature.
param(
    [string]$SignedProbe = '',
    [string]$UnsignedProbe = '',
    [string]$InstallerInput = '',
    [string]$NsisCompiler = '',
    [switch]$ExpectSigned
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$compiler = Get-Command makensis.exe -ErrorAction SilentlyContinue
$makensis = if ($NsisCompiler) { $NsisCompiler } elseif ($compiler) { $compiler.Source } else { "${env:ProgramFiles(x86)}\NSIS\makensis.exe" }
if (-not $InstallerInput -and -not (Test-Path -LiteralPath $makensis)) { throw 'NSIS is required for the packaging smoke (makensis.exe not found)' }
$work = Join-Path $repo ('portable-smoke-' + [guid]::NewGuid().ToString('N') + '.local.d')
$src = Join-Path $work 'src'
$out = Join-Path $work 'portable'
$bundle = Join-Path $work 'bundle\nsis'
New-Item -ItemType Directory -Path $src, $bundle | Out-Null
$app = Join-Path $src 'spectrapdf.exe'
if ($ExpectSigned -and (-not $SignedProbe -or -not $UnsignedProbe)) { throw 'signed smoke requires both probe paths' }
if ($SignedProbe) { Copy-Item -LiteralPath $SignedProbe -Destination $app }
else { [IO.File]::WriteAllText($app, 'packed application bytes') }
$packedHash = (Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash
$installer = Join-Path $bundle 'portable-smoke-setup.exe'
$manifest = Join-Path $work 'installer.nsi'
$resources = @{
    'THIRD-PARTY-LICENSES.md' = Join-Path $repo 'THIRD-PARTY-LICENSES.md'
    'THIRD-PARTY-LICENSES-RUST.html' = Join-Path $src 'rust-notices.html'
    'icc\Adobe-Color-Profile-License.txt' = Join-Path $src 'icc-license.txt'
}
[IO.File]::WriteAllText($resources['THIRD-PARTY-LICENSES-RUST.html'], 'fixture Rust notices')
[IO.File]::WriteAllText($resources['icc\Adobe-Color-Profile-License.txt'], 'fixture ICC notice')
$lines = @(
    'Unicode true', 'Name "Portable packaging smoke"', 'RequestExecutionLevel user',
    "OutFile `"$installer`"", 'SetCompressor /SOLID lzma',
    "!define MAINBINARYSRCPATH `"$app`"", '!define MAINBINARYNAME "spectrapdf"',
    '!define VERSION "9.9.9"'
)
if ($ExpectSigned) {
    $signScript = Join-Path $repo 'scripts\sign-windows.ps1'
    $lines += "!uninstfinalize 'powershell -NoProfile -ExecutionPolicy Bypass -File `"$signScript`" `"%1`"' = 0"
}
$lines += @('Section', 'SetOutPath "$INSTDIR"', 'File "${MAINBINARYSRCPATH}"')
foreach ($rel in $resources.Keys) { $lines += "File /a `"/oname=$rel`" `"$($resources[$rel])`"" }
$lines += @('WriteUninstaller "$INSTDIR\uninstall.exe"', 'SectionEnd', 'Section "Uninstall"', 'SectionEnd')
[IO.File]::WriteAllLines($manifest, $lines, [Text.UTF8Encoding]::new($false))
if ($InstallerInput) { Copy-Item -LiteralPath $InstallerInput -Destination $installer }
else {
    & $makensis /V2 $manifest
    if ($LASTEXITCODE -ne 0) { throw "fixture NSIS build failed (exit $LASTEXITCODE)" }
}
if ($ExpectSigned -and -not $InstallerInput) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\sign-windows.ps1" $installer
    if ($LASTEXITCODE -ne 0) { throw "fixture installer signing failed (exit $LASTEXITCODE)" }
}
# Reproduce Tauri's post-bundle restoration, not an assumed signed target.
if ($UnsignedProbe) { Copy-Item -LiteralPath $UnsignedProbe -Destination $app -Force }
else { [IO.File]::WriteAllText($app, 'restored unsigned application bytes') }
if ((Get-FileHash -LiteralPath $app).Hash -ceq $packedHash) { throw 'restoration fixture did not change the app' }

$builder = Join-Path $PSScriptRoot 'build-portable-zip.ps1'
$script:checks = 0
function Invoke-PortableCheck([string]$Name, [string[]]$Extra, [bool]$Pass, [string]$Reason = '', [string]$Shell = 'powershell') {
    $log = Join-Path $work "$Name.log"
    $builderArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $builder,
        '-ProjectRoot', $repo, '-Manifest', $manifest, '-Installer', $installer, '-OutputDirectory', $out)
    if ($ExpectSigned) { $builderArgs += '-ExpectSigned' }
    # Windows PowerShell treats a child's stderr as ErrorRecords; expected
    # refusals must reach the exit-code assertion, not abort the parent.
    $prior = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Shell @builderArgs @Extra *> $log
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prior }
    $body = Get-Content -LiteralPath $log -Raw
    if (($code -eq 0) -ne $Pass -or ($Reason -and -not $body.Contains($Reason))) {
        throw "$Name unexpected exit $code (expected success=$Pass):`n$body"
    }
    $script:checks++
    Write-Host "PASS $Name (exit $code)"
}
Invoke-PortableCheck 'restored-source-build' @() $true
$tree = Join-Path $out 'tree.staging'
$portableApp = Join-Path $tree 'spectrapdf.exe'
if ((Get-FileHash -LiteralPath $portableApp).Hash -cne $packedHash) { throw 'portable did not preserve the packed app bytes' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $out 'spectrapdf-9.9.9-portable.zip'))
try {
    $entry = $zip.GetEntry('spectrapdf.exe')
    if (-not $entry) { throw 'archive contains no root app' }
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $zipHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
    if ($zipHash -cne $packedHash) { throw 'ZIP contains the wrong app bytes' }
    if ($zip.GetEntry('uninstall.exe')) { throw 'portable must not carry an uninstaller' }
} finally { $zip.Dispose() }
$script:checks++
Write-Host 'PASS archived app equals installer app; uninstaller excluded'
Invoke-PortableCheck 'faithful-tree' @('-Verify', $tree) $true
Invoke-PortableCheck 'faithful-tree-pwsh' @('-Verify', $tree) $true '' 'pwsh'
Copy-Item -LiteralPath $app -Destination $portableApp -Force
Invoke-PortableCheck 'old-unsigned-copy' @('-Verify', $tree) $false 'portable bytes differ'
$rustNotice = Join-Path $tree 'THIRD-PARTY-LICENSES-RUST.html'
# Restore just the app, then change a same-length resource byte: path-only
# inventory checks used to claim this tree was identical too.
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $out 'spectrapdf-9.9.9-portable.zip'))
try { [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry('spectrapdf.exe'), $portableApp, $true) }
finally { $zip.Dispose() }
$bytes = [IO.File]::ReadAllBytes($rustNotice)
$bytes[0] = $bytes[0] -bxor 1
[IO.File]::WriteAllBytes($rustNotice, $bytes)
Invoke-PortableCheck 'changed-resource' @('-Verify', $tree) $false 'portable bytes differ'
Copy-Item -LiteralPath $resources['THIRD-PARTY-LICENSES-RUST.html'] -Destination $rustNotice -Force
[IO.File]::WriteAllText((Join-Path $tree 'extra.txt'), 'unexpected')
Invoke-PortableCheck 'unexpected-file' @('-Verify', $tree) $false 'not in the installer manifest'
$originalManifest = [IO.File]::ReadAllText($manifest)
[IO.File]::WriteAllText($manifest, $originalManifest + "`nFile /a `"/oname=../escape.txt`" `"$app`"`n")
Invoke-PortableCheck 'escaping-destination' @() $false 'unsafe payload destination'
[IO.File]::WriteAllText($manifest, $originalManifest + "`nFile /a `"/oname=spectrapdf.exe`" `"$app`"`n")
Invoke-PortableCheck 'duplicate-app' @() $false 'maps one destination twice'
[IO.File]::WriteAllText($manifest, $originalManifest)
if (-not $ExpectSigned) {
    $priorSubject = $env:SPECTRAPDF_SIGN_SUBJECT_CN
    try {
        $env:SPECTRAPDF_SIGN_SUBJECT_CN = 'Unsigned fixture must never reach a subject check'
        Invoke-PortableCheck 'unsigned-installer-refused' @('-ExpectSigned') $false 'No signature found'
    } finally { $env:SPECTRAPDF_SIGN_SUBJECT_CN = $priorSubject }
}
Write-Host "Portable packaging smoke: $script:checks checks passed; evidence at $work"
