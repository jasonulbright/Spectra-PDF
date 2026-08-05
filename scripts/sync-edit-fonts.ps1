# Vendors the Edit-tool fallback font FAMILY (Phase 7.4 + 9.B1 + 9.A3b)
# into resources/fonts - the same repo-hygiene class as resources/python and
# resources/ghostscript: assembled by script, gitignored, SHIPPED in the
# product bundle (tauri.conf.json resources maps ../resources/fonts -> fonts).
#
# Twelve Liberation faces (all SIL OFL 1.1) - Regular/Bold/Italic/BoldItalic
# for each family, metric-compatible with the ubiquitous Microsoft cores so
# the substituted look matches the original:
#   Sans  -> Arial     (the common sans body default)
#   Serif -> Times New Roman
#   Mono  -> Courier New
# The engine (font_fallback.resolve_fallback_font) picks the face matching
# the run's own font family (and, since 9.A3b, the requested style) so a
# serif document's converted text stays serif and a bold restyle lands on
# the real Bold face. THIRD-PARTY-LICENSES.md section Fonts carries the license
# text pointer.
#
# The release tarball is sha256-pinned AND each extracted face is
# individually pinned: a silent upstream change fails loudly here instead
# of shipping unnoticed. To bump: update $Version/$Sha256 + the per-face
# hashes together, re-run, eyeball, commit.

$ErrorActionPreference = 'Stop'

$Version = '2.1.5'
$Url = "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-$Version.tar.gz"
$Sha256 = '7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0'

# NOTE: the pinned URL is a github FILES attachment (the project's release
# posts link these); it has weaker longevity guarantees than a
# /releases/download asset. The sha256 pin protects content either way; a
# future 404 means re-pointing at whatever official artifact then exists.
#
# ASCII ONLY in this file: Windows PowerShell 5.1 reads BOM-less UTF-8 as
# ANSI, and a multi-byte dash inside a QUOTED string mangles into a
# parser-breaking byte (bitten live).
# The SIL OFL 1.1 requires the license text to ACCOMPANY distributed font
# copies, so each family's license file is vendored beside the faces (and
# ships with them via the same tauri resources mapping). Pinned like the
# faces: sourced from inside the SAME pinned archives, hash-verified.
$LiberationLicense = @{ ArchiveName = 'LICENSE'; Dest = 'LICENSE-Liberation-OFL.txt'; Sha256 = '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b' }
$LibertinusLicense = @{ ArchiveName = 'OFL.txt'; Dest = 'LICENSE-Libertinus-OFL.txt'; Sha256 = '9aeecc8107c489ec1ec0068b0313e531a760edf3493705b32ab8ab8215a8794e' }

$Faces = @(
    @{ Name = 'LiberationSans-Regular.ttf';     Sha256 = '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8' }
    @{ Name = 'LiberationSans-Bold.ttf';        Sha256 = '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173' }
    @{ Name = 'LiberationSans-Italic.ttf';      Sha256 = 'e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0' }
    @{ Name = 'LiberationSans-BoldItalic.ttf';  Sha256 = '698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee' }
    @{ Name = 'LiberationSerif-Regular.ttf';    Sha256 = '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74' }
    @{ Name = 'LiberationSerif-Bold.ttf';       Sha256 = 'd754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce' }
    @{ Name = 'LiberationSerif-Italic.ttf';     Sha256 = '0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e' }
    @{ Name = 'LiberationSerif-BoldItalic.ttf'; Sha256 = 'f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7' }
    @{ Name = 'LiberationMono-Regular.ttf';     Sha256 = 'f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1' }
    @{ Name = 'LiberationMono-Bold.ttf';        Sha256 = 'bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb' }
    @{ Name = 'LiberationMono-Italic.ttf';      Sha256 = '605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1' }
    @{ Name = 'LiberationMono-BoldItalic.ttf';  Sha256 = '79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130' }
)

# 9.K2 OpenType features: Libertinus Serif (SIL OFL 1.1) as a SECOND, feature-
# bearing family. The four Serif OTF faces carry smcp/c2sc/salt/onum/liga/dlig
# in their GSUB - Liberation has NONE of those, and Libertinus's own TTF builds
# STRIP the features (only 'kern' survives), so the CFF-flavoured OTF is
# REQUIRED (the engine embeds it via FontFile3 /OpenType). Libertinus is NOT a
# metric-compatible drop-in for Liberation and never a silent or automatic
# fallback. It is an explicit opt-in family for small-caps and alternate
# authoring. Libertinus has no Sans BoldItalic face, so Serif
# only. THIRD-PARTY-LICENSES.md carries the OFL pointer.
$LibVersion = '7.051'
$LibUrl = "https://github.com/alerque/libertinus/releases/download/v$LibVersion/Libertinus-$LibVersion.zip"
$LibSha256 = '4d9be29b5cb380c35af8ba967abcc752ad1e07be1f738a9789c33e0dd7478c92'
$LibFaces = @(
    @{ Name = 'LibertinusSerif-Regular.otf';    Sha256 = 'fcf06307a77367394fcb0ccb241e59eea70dba3d732be309647611224679c733' }
    @{ Name = 'LibertinusSerif-Bold.otf';       Sha256 = '0264914210ed51b3231ebc92ce529e9f2e166ba9eebf0cd4a579558690a27b64' }
    @{ Name = 'LibertinusSerif-Italic.otf';     Sha256 = '9a393d63d6e05f620d3dc0190dfd35a8ede58c0808cf0fc9de7fcb9c723e4c24' }
    @{ Name = 'LibertinusSerif-BoldItalic.otf'; Sha256 = '47a665259f09f554f5d133d7718cdad43ff462c6a6b2328f38023465e62d57ce' }
)

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'resources\fonts'

# Skip the download entirely only when EVERY face is present and verified
# (the bundle-ghostscript re-check precedent: a corrupted/wrong file must
# not silently satisfy the skip).
#
# EVERY face means every face the script vendors, not just the two families
# it started with: the CJK and right-to-left blocks live BELOW this guard, so
# The presence guard and download blocks read the same tables so a partial font
# directory cannot be reported as complete.
$CjkFaces = @(
    @{ Name = 'NotoSansCJKsc-Regular.otf'; Sha256 = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b' }
    @{ Name = 'NotoSansCJKsc-Bold.otf';    Sha256 = 'b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a' }
)
$CjkLicense = @{ Name = 'LICENSE-NotoCJK.txt'; Sha256 = '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2' }
$RtlWanted = @(
    @{ Name = 'IBMPlexSansArabic-Regular.ttf'; Sha256 = '8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981' }
    @{ Name = 'IBMPlexSansArabic-Bold.ttf';    Sha256 = 'b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e' }
    @{ Name = 'LICENSE-IBMPlexArabic-OFL.txt'; Sha256 = '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da' }
    @{ Name = 'NotoSansHebrew-Regular.ttf';    Sha256 = '04272f5600d0ec816d31d0df73b23aa8d3501ea359ebe820da31c11ffcf00853' }
    @{ Name = 'NotoSansHebrew-Bold.ttf';       Sha256 = 'dfdb3056de1f4542b888c77a1a8a750548a802e271479f56e52152423b64dde8' }
    @{ Name = 'LICENSE-NotoHebrew-OFL.txt';    Sha256 = '9b9fe028b5ba74d231659a1bbaf0ed09b11e759d1ca6a070999e16d151616b47' }
    @{ Name = 'NotoSansMongolian-Regular.ttf'; Sha256 = 'e458bbdef2ac9579315293070b8f72abc290a42a0279a99b50a9829a7ccd8245' }
    @{ Name = 'LICENSE-NotoMongolian-OFL.txt'; Sha256 = 'b0158b3c0b16c20e22ea662850503a7980111c5c704501e942cc1a7ed12dc011' }
)
$allPresent = $true
$Wanted = @($Faces + $LibFaces + $CjkFaces + $RtlWanted + @(
    @{ Name = $LiberationLicense.Dest; Sha256 = $LiberationLicense.Sha256 }
    @{ Name = $LibertinusLicense.Dest; Sha256 = $LibertinusLicense.Sha256 }
    $CjkLicense
))
foreach ($face in $Wanted) {
    $t = Join-Path $Dest $face.Name
    if (-not (Test-Path $t)) { $allPresent = $false; break }
    $h = (Get-FileHash -Algorithm SHA256 $t).Hash.ToLowerInvariant()
    if ($h -ne $face.Sha256) { $allPresent = $false; break }
}
if ($allPresent) {
    Write-Host "All faces present and verified in $Dest"
    exit 0
}

New-Item -ItemType Directory -Force $Dest | Out-Null
$Tmp = Join-Path $env:TEMP "liberation-fonts-$Version.tar.gz"

Write-Host "Downloading Liberation Fonts $Version..."
Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing

$actual = (Get-FileHash -Algorithm SHA256 $Tmp).Hash.ToLowerInvariant()
if ($actual -ne $Sha256) {
    Remove-Item $Tmp -Force
    throw "sha256 mismatch for $Url`n  expected $Sha256`n  actual   $actual"
}

$Extract = Join-Path $env:TEMP "liberation-fonts-$Version"
if (Test-Path $Extract) { Remove-Item $Extract -Recurse -Force }
New-Item -ItemType Directory -Force $Extract | Out-Null
# System32's bsdtar EXPLICITLY: a Git-Bash GNU tar earlier on PATH parses
# "C:\..." as a remote host ("Cannot connect to C:") and dies.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $Tmp -C $Extract
if ($LASTEXITCODE -ne 0) { throw "tar extraction failed ($LASTEXITCODE)" }

foreach ($face in $Faces) {
    $ttf = Get-ChildItem -Recurse $Extract -Filter $face.Name | Select-Object -First 1
    if (-not $ttf) { throw "$($face.Name) not found in the release archive" }
    $Target = Join-Path $Dest $face.Name
    Copy-Item $ttf.FullName $Target -Force
    $h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
    if ($h -ne $face.Sha256) { throw "sha256 mismatch for $($face.Name): $h" }
    Write-Host "Vendored: $Target"
}

$lic = Get-ChildItem -Recurse $Extract -Filter $LiberationLicense.ArchiveName | Select-Object -First 1
if (-not $lic) { throw "$($LiberationLicense.ArchiveName) not found in the Liberation archive" }
$Target = Join-Path $Dest $LiberationLicense.Dest
Copy-Item $lic.FullName $Target -Force
$h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
if ($h -ne $LiberationLicense.Sha256) { throw "sha256 mismatch for $($LiberationLicense.Dest): $h" }
Write-Host "Vendored: $Target"

Remove-Item $Tmp -Force
Remove-Item $Extract -Recurse -Force

# --- Libertinus Serif OTF (9.K2 OpenType features) ---
$LibTmp = Join-Path $env:TEMP "libertinus-$LibVersion.zip"
Write-Host "Downloading Libertinus $LibVersion..."
Invoke-WebRequest -Uri $LibUrl -OutFile $LibTmp -UseBasicParsing
$libActual = (Get-FileHash -Algorithm SHA256 $LibTmp).Hash.ToLowerInvariant()
if ($libActual -ne $LibSha256) {
    Remove-Item $LibTmp -Force
    throw "sha256 mismatch for $LibUrl`n  expected $LibSha256`n  actual   $libActual"
}
$LibExtract = Join-Path $env:TEMP "libertinus-$LibVersion"
if (Test-Path $LibExtract) { Remove-Item $LibExtract -Recurse -Force }
# A .zip, not a .tar.gz - Expand-Archive is native and needs no bsdtar dance.
Expand-Archive -Path $LibTmp -DestinationPath $LibExtract -Force
foreach ($face in $LibFaces) {
    $otf = Get-ChildItem -Recurse $LibExtract -Filter $face.Name | Select-Object -First 1
    if (-not $otf) { throw "$($face.Name) not found in the Libertinus archive" }
    $Target = Join-Path $Dest $face.Name
    Copy-Item $otf.FullName $Target -Force
    $h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
    if ($h -ne $face.Sha256) { throw "sha256 mismatch for $($face.Name): $h" }
    Write-Host "Vendored: $Target"
}

$lic = Get-ChildItem -Recurse $LibExtract -Filter $LibertinusLicense.ArchiveName | Select-Object -First 1
if (-not $lic) { throw "$($LibertinusLicense.ArchiveName) not found in the Libertinus archive" }
$Target = Join-Path $Dest $LibertinusLicense.Dest
Copy-Item $lic.FullName $Target -Force
$h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
if ($h -ne $LibertinusLicense.Sha256) { throw "sha256 mismatch for $($LibertinusLicense.Dest): $h" }
Write-Host "Vendored: $Target"

Remove-Item $LibTmp -Force
Remove-Item $LibExtract -Recurse -Force

# --- Noto Sans CJK SC: the CJK-capable fallback face ---
# SIL OFL 1.1 like the rest. Regular + Bold (no CJK italic exists; the
# resolve ladder's style degrade lands italic requests on Regular by
# design). Pinned per-face from the tagged release tree; ~16MB/weight is
# an accepted cost (the standing size ruling). The engine reaches these
# through font_fallback's text-aware CJK step - never as a silent
# substitution for text the family face can already express.
$NotoBase = 'https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/OTF/SimplifiedChinese'
foreach ($face in $CjkFaces) {
    $Target = Join-Path $Dest $face.Name
    Invoke-WebRequest -Uri "$NotoBase/$($face.Name)" -OutFile $Target -UseBasicParsing
    $h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
    if ($h -ne $face.Sha256) {
        Remove-Item $Target -Force
        throw "sha256 mismatch for $($face.Name): $h"
    }
    Write-Host "Vendored: $Target"
}
$NotoLicense = Join-Path $Dest $CjkLicense.Name
Invoke-WebRequest -Uri 'https://github.com/notofonts/noto-cjk/raw/Sans2.004/LICENSE' -OutFile $NotoLicense -UseBasicParsing
$h = (Get-FileHash -Algorithm SHA256 $NotoLicense).Hash.ToLowerInvariant()
if ($h -ne $CjkLicense.Sha256) {
    Remove-Item $NotoLicense -Force
    throw "sha256 mismatch for $($CjkLicense.Name): $h"
}
Write-Host "Vendored: $NotoLicense"

# --- Right-to-left faces ---
# IBM Plex Sans Arabic (OFL 1.1) is the SHAPING face and Noto Sans Hebrew
# (OFL 1.1) the coverage face. Both ship Regular + Bold; neither has an
# italic, so the resolve ladder degrades italic requests to Regular exactly
# as the CJK map does.
#
# IBM Plex rather than Noto Sans Arabic on a MEASURED difference, not taste:
# Noto's GSUB decomposes each Arabic letter into a dotless skeleton plus
# separately positioned dots, so one character draws as several glyphs and
# the letter is spelled by the SEQUENCE - which a per-code /ToUnicode cannot
# express, making a shaped edit unreadable back. IBM Plex shapes one
# composite glyph per character, so the round trip is exact by construction.
# (Verified: 15 glyphs / 15 clusters vs Noto's 19 / 15 on the same string.)
#
# Both come from release ZIPs (the Libertinus pattern) because neither
# repo exposes the built faces in its tag tree. The archive sha256 is
# pinned AND each extracted face is re-hashed.
$RtlSources = @(
    @{
        Label   = 'IBM Plex Sans Arabic'
        Url     = 'https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-sans-arabic%401.1.0/ibm-plex-sans-arabic.zip'
        Sha256  = 'f03915581aea37d82792c188b08064023a73494d679b8e19f85f5971db714013'
        Faces   = @(
            @{ In = 'ibm-plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-Regular.ttf'; Out = 'IBMPlexSansArabic-Regular.ttf'; Sha256 = '8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981' }
            @{ In = 'ibm-plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-Bold.ttf';    Out = 'IBMPlexSansArabic-Bold.ttf';    Sha256 = 'b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e' }
        )
        License = @{ In = 'ibm-plex-sans-arabic/LICENSE.txt'; Out = 'LICENSE-IBMPlexArabic-OFL.txt'; Sha256 = '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da' }
    }
    @{
        Label   = 'Noto Sans Hebrew'
        Url     = 'https://github.com/notofonts/hebrew/releases/download/NotoSansHebrew-v3.001/NotoSansHebrew-v3.001.zip'
        Sha256  = 'df0a71814b4e63644cf40fcc4529111b61266b7a2dafbe95068b29a7520cc3cb'
        Faces   = @(
            @{ In = 'NotoSansHebrew/unhinted/ttf/NotoSansHebrew-Regular.ttf'; Out = 'NotoSansHebrew-Regular.ttf'; Sha256 = '04272f5600d0ec816d31d0df73b23aa8d3501ea359ebe820da31c11ffcf00853' }
            @{ In = 'NotoSansHebrew/unhinted/ttf/NotoSansHebrew-Bold.ttf';    Out = 'NotoSansHebrew-Bold.ttf';    Sha256 = 'dfdb3056de1f4542b888c77a1a8a750548a802e271479f56e52152423b64dde8' }
        )
        License = @{ In = 'OFL.txt'; Out = 'LICENSE-NotoHebrew-OFL.txt'; Sha256 = '9b9fe028b5ba74d231659a1bbaf0ed09b11e759d1ca6a070999e16d151616b47' }
    }
    @{
        # 9.T12 — the Mongolian shaping face. Mongolian joins cursively, and a
        # PDF viewer never shapes, so a re-emitted Mongolian column MUST come
        # from a face that still carries the joining rules; the document's own
        # program is preferred (T26 in-place) and this is what substitutes when
        # it cannot.
        #
        # Chosen on the same MEASUREMENT that chose IBM Plex over Noto Sans
        # Arabic (`mongolian-measure.local.py`, run against this face and
        # against Mongolian Baiti as the script's reference implementation):
        # every cluster has exactly ONE advancing glyph (ligating clusters
        # included), no `.notdef` across the corpus, and real per-glyph
        # horizontal advances of 284–1065 per 1000/em. It is embedded
        # HORIZONTALLY under a rotated Tm — a Mongolian face states no
        # vertical advance worth putting in /W2 (Mongolian Baiti carries no
        # `vmtx` at all).
        #
        # The `full` build, deliberately: the `unhinted` one this repo's
        # Hebrew entry uses has NO Latin or digit coverage, and a Mongolian
        # column with a year in it would have refused. Regular only — the
        # style map degrades exactly as the CJK map does for italic.
        Label   = 'Noto Sans Mongolian'
        Url     = 'https://github.com/notofonts/mongolian/releases/download/NotoSansMongolian-v3.002/NotoSansMongolian-v3.002.zip'
        Sha256  = 'a5d3085d4040ecd92d44bf5c4f8faaeae7ba3147cf82e09aa2ef5ad46475de6c'
        Faces   = @(
            @{ In = 'NotoSansMongolian/full/ttf/NotoSansMongolian-Regular.ttf'; Out = 'NotoSansMongolian-Regular.ttf'; Sha256 = 'e458bbdef2ac9579315293070b8f72abc290a42a0279a99b50a9829a7ccd8245' }
        )
        License = @{ In = 'OFL.txt'; Out = 'LICENSE-NotoMongolian-OFL.txt'; Sha256 = 'b0158b3c0b16c20e22ea662850503a7980111c5c704501e942cc1a7ed12dc011' }
    }
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($src in $RtlSources) {
    $Tmp = Join-Path $env:TEMP ("rtl-" + [IO.Path]::GetRandomFileName() + ".zip")
    Invoke-WebRequest -Uri $src.Url -OutFile $Tmp -UseBasicParsing
    $h = (Get-FileHash -Algorithm SHA256 $Tmp).Hash.ToLowerInvariant()
    if ($h -ne $src.Sha256) {
        Remove-Item $Tmp -Force
        throw "sha256 mismatch for $($src.Label) archive`n  expected $($src.Sha256)`n  actual   $h"
    }
    # Read entries straight out of the archive: these ZIPs carry hundreds of
    # weights and widths, and only four files are wanted.
    $zip = [IO.Compression.ZipFile]::OpenRead($Tmp)
    try {
        foreach ($item in @($src.Faces) + @($src.License)) {
            $entry = $zip.Entries | Where-Object { $_.FullName -eq $item.In }
            if (-not $entry) { throw "$($item.In) not found in $($src.Label) archive" }
            $Target = Join-Path $Dest $item.Out
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $Target, $true)
            $h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
            if ($h -ne $item.Sha256) {
                Remove-Item $Target -Force
                throw "sha256 mismatch for $($item.Out): $h"
            }
            Write-Host "Vendored: $Target"
        }
    } finally {
        $zip.Dispose()
        Remove-Item $Tmp -Force
    }
}
