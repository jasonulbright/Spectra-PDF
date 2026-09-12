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
# Two payload controls the archive module's wildcard walk cannot represent: a
# hidden binary file (dropped by the walk) and a nested destination with
# spaces and non-ASCII letters (separator and encoding both chosen by the
# module). Sources stay ASCII-named; the manifest destination carries the name.
$hiddenRel = 'engine\hidden data\.hidden control.bin'
$unicodeRel = [string]::Format('engine\{0}n{1}code dir\na{1}ve r{2}sum{2}.txt', [char]0x00FC, [char]0x00EF, [char]0x00E9)
$resources = @{
    'THIRD-PARTY-LICENSES.md' = Join-Path $repo 'THIRD-PARTY-LICENSES.md'
    'THIRD-PARTY-LICENSES-RUST.html' = Join-Path $src 'rust-notices.html'
    'icc\Adobe-Color-Profile-License.txt' = Join-Path $src 'icc-license.txt'
    $hiddenRel = Join-Path $src 'hidden-control.bin'
    $unicodeRel = Join-Path $src 'unicode-control.txt'
}
[IO.File]::WriteAllText($resources['THIRD-PARTY-LICENSES-RUST.html'], 'fixture Rust notices')
[IO.File]::WriteAllText($resources['icc\Adobe-Color-Profile-License.txt'], 'fixture ICC notice')
[IO.File]::WriteAllBytes($resources[$hiddenRel], [byte[]](@(0..255) + @(0..255)))
(Get-Item -LiteralPath $resources[$hiddenRel] -Force).Attributes = [IO.FileAttributes]::Hidden
[IO.File]::WriteAllText($resources[$unicodeRel], 'fixture unicode control')
$hiddenHash = (Get-FileHash -LiteralPath $resources[$hiddenRel] -Algorithm SHA256).Hash
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
    & $makensis /V2 /INPUTCHARSET UTF8 $manifest
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
    # Names are the manifest's, forward-slashed, nothing more and nothing less.
    $expectedNames = @('spectrapdf.exe') + @($resources.Keys | ForEach-Object { $_.Replace('\', '/') })
    $actualNames = @($zip.Entries | ForEach-Object { $_.FullName })
    foreach ($name in $actualNames) { if ($name.Contains('\')) { throw "archive entry stored with a backslash: $name" } }
    $missingNames = @($expectedNames | Where-Object { $actualNames -cnotcontains $_ })
    $extraNames = @($actualNames | Where-Object { $expectedNames -cnotcontains $_ })
    if ($missingNames -or $extraNames) { throw "archive names differ from the manifest: missing [$($missingNames -join ', ')] extra [$($extraNames -join ', ')]" }
    $hiddenEntry = $zip.GetEntry($hiddenRel.Replace('\', '/'))
    $stream = $hiddenEntry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hiddenZipHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
    if ($hiddenZipHash -cne $hiddenHash) { throw 'ZIP carries the wrong bytes for the hidden control' }
} finally { $zip.Dispose() }
$script:checks++
Write-Host 'PASS archived app equals installer app; uninstaller excluded; hidden and non-ASCII entries stored by canonical name'
Invoke-PortableCheck 'faithful-tree' @('-Verify', $tree) $true
Invoke-PortableCheck 'faithful-tree-pwsh' @('-Verify', $tree) $true '' 'pwsh'

# The finished archive, mutated one way at a time and verified against the
# untouched tree: -Verify must read the ZIP, not infer it from the tree.
$zipPath = Join-Path $out 'spectrapdf-9.9.9-portable.zip'
$goodZip = Join-Path $work 'good-portable.zip'
Copy-Item -LiteralPath $zipPath -Destination $goodZip
function Restore-PortableArchive { Copy-Item -LiteralPath $goodZip -Destination $zipPath -Force }
function Edit-PortableArchive([scriptblock]$Mutation) {
    $archive = [IO.Compression.ZipFile]::Open($zipPath, 'Update')
    try { & $Mutation $archive } finally { $archive.Dispose() }
}
Remove-Item -LiteralPath $zipPath
Invoke-PortableCheck 'archive-missing' @('-Verify', $tree) $false 'portable archive missing'
Restore-PortableArchive
Edit-PortableArchive {
    param($archive)
    $entry = $archive.GetEntry('icc/Adobe-Color-Profile-License.txt')
    $stream = $entry.Open()
    $buffer = [IO.MemoryStream]::new()
    try { $stream.CopyTo($buffer) } finally { $stream.Dispose() }
    $entry.Delete()
    $moved = $archive.CreateEntry('icc\Adobe-Color-Profile-License.txt')
    $stream = $moved.Open()
    try { $buffer.WriteTo($stream) } finally { $stream.Dispose() }
}
Invoke-PortableCheck 'archive-backslash-name' @('-Verify', $tree) $false 'backslash separator'
Restore-PortableArchive
Edit-PortableArchive {
    param($archive)
    $stream = $archive.GetEntry('THIRD-PARTY-LICENSES-RUST.html').Open()
    try {
        $first = $stream.ReadByte()
        $stream.Position = 0
        $stream.WriteByte($first -bxor 1)
    } finally { $stream.Dispose() }
}
Invoke-PortableCheck 'archive-changed-bytes' @('-Verify', $tree) $false 'archive bytes differ'
Restore-PortableArchive
Edit-PortableArchive {
    param($archive)
    $stream = $archive.CreateEntry('extra.txt').Open()
    try { $stream.WriteByte(65) } finally { $stream.Dispose() }
}
Invoke-PortableCheck 'archive-extra-entry' @('-Verify', $tree) $false 'in the archive but not in the installer manifest'
Restore-PortableArchive
Edit-PortableArchive { param($archive) $archive.GetEntry('THIRD-PARTY-LICENSES-RUST.html').Delete() }
Invoke-PortableCheck 'archive-missing-entry' @('-Verify', $tree) $false 'in the installer manifest but not in the archive'
Restore-PortableArchive
Edit-PortableArchive {
    param($archive)
    $stream = $archive.CreateEntry('spectrapdf.exe').Open()
    try { $stream.WriteByte(66) } finally { $stream.Dispose() }
}
Invoke-PortableCheck 'archive-duplicate-app' @('-Verify', $tree) $false 'duplicate entry'
Restore-PortableArchive
# The first local file header opens the file; its name is patched in place
# while the central directory keeps the manifest's spelling.
$raw = [IO.File]::ReadAllBytes($zipPath)
if ([BitConverter]::ToUInt32($raw, 0) -ne 0x04034B50) { throw 'archive does not open with a local file header' }
if ($raw[30] -lt 0x61 -or $raw[30] -gt 0x7A) { throw 'first entry name does not open with a lowercase letter' }
$raw[30] = $raw[30] -bxor 0x20
[IO.File]::WriteAllBytes($zipPath, $raw)
Invoke-PortableCheck 'archive-local-name-tamper' @('-Verify', $tree) $false 'local header name differs'
Restore-PortableArchive
Invoke-PortableCheck 'archive-restored' @('-Verify', $tree) $true 'Verified archive'
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
