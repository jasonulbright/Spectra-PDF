# MAINTENANCE TOOL, not a build step. Run only when the Tesseract pin in
# bundle-tesseract.ps1 changes; review the git diff and commit the result.
#
# The Tesseract build is SHA-256 pinned, so the applicable licences are those
# of the library versions inside that binary and are fixed. Upstream HEAD may
# carry the licence for a different version, so refreshing at build time can
# replace a correct notice with an inapplicable one. Texts are checked in at
# scripts/tesseract-licenses/; bundle-tesseract.ps1 copies them, offline.
#
# The installer supplies notices for 2 of the 52 shipped binaries (doc/LICENSE,
# doc/AUTHORS). The other 39 components are fetched here.
#
# Sources are chosen for plain-text delivery: sourceware.org answers scripted
# fetches with an anti-bot page and gitlab.freedesktop.org with an Anubis wall,
# both HTTP 200, so those components resolve through GitHub mirrors. The size
# floor and HTML guard below reject a page served in place of a file.
#
# scripts/tesseract-licenses.tsv is the manifest: its notice column says what
# must exist, this table says where each comes from. A manifest row with no
# source here is an error, not a warning.

param(
    # Integrity is git's: the diff of a re-run is the review.
    [string]$DestDir = (Join-Path $PSScriptRoot "tesseract-licenses"),
    [string]$Manifest = (Join-Path $PSScriptRoot "tesseract-licenses.tsv")
)

$ErrorActionPreference = "Stop"

# Floor for a plausible licence text. Shortest real notice here is ~700 bytes
# (LZ4's BSD-2); pointer stubs run under 150.
$MinNoticeBytes = 400

# Some hosts (and the Tesseract mirror) 403 PowerShell's default UA. Documented
# in bundle-tesseract.ps1:69-74; do not "simplify" this away.
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# notice file -> ordered PARTS. Each part is concatenated into the output, which
# is how dual/exception licences ship their full terms (GCC runtime = GPL-3 +
# the Runtime Library Exception). A part may itself be an array, in which case
# the entries are ALTERNATES and the first that fetches wins -- needed because
# several upstreams are hostile to scripted fetches: GNOME GitLab answers 406,
# SourceForge answers 403, so those resolve through their GitHub mirrors.
$Sources = [ordered]@{
    "LICENSE-LERC.txt"            = @("https://raw.githubusercontent.com/Esri/lerc/master/LICENSE")
    "LICENSE-libarchive.txt"      = @("https://raw.githubusercontent.com/libarchive/libarchive/master/COPYING")
    "LICENSE-libb2.txt"           = @("https://raw.githubusercontent.com/BLAKE2/libb2/master/COPYING")
    "LICENSE-brotli.txt"          = @("https://raw.githubusercontent.com/google/brotli/master/LICENSE")
    "LICENSE-bzip2.txt"           = @(,@("https://raw.githubusercontent.com/libarchive/bzip2/master/LICENSE",
                                         "https://raw.githubusercontent.com/enthought/bzip2-1.0.6/master/LICENSE"))
    # cairo/COPYING is the dual-licence STATEMENT and points at two sibling
    # files for the actual terms, so all three ship (the graphite2 shape).
    # gitlab.freedesktop.org is behind an Anubis proof-of-work anti-bot and
    # answers every scripted fetch with HTML, so the mirror is the source.
    "LICENSE-cairo.txt"           = @("https://raw.githubusercontent.com/freedesktop-unofficial-mirror/cairo/master/COPYING",
                                      "https://raw.githubusercontent.com/freedesktop-unofficial-mirror/cairo/master/COPYING-LGPL-2.1",
                                      "https://raw.githubusercontent.com/freedesktop-unofficial-mirror/cairo/master/COPYING-MPL-1.1")
    "LICENSE-openssl.txt"         = @("https://raw.githubusercontent.com/openssl/openssl/master/LICENSE.txt")
    "LICENSE-libdatrie.txt"       = @("https://raw.githubusercontent.com/tlwg/libdatrie/master/COPYING")
    "LICENSE-libdeflate.txt"      = @("https://raw.githubusercontent.com/ebiggers/libdeflate/master/COPYING")
    "LICENSE-expat.txt"           = @("https://raw.githubusercontent.com/libexpat/libexpat/master/expat/COPYING")
    "LICENSE-libffi.txt"          = @("https://raw.githubusercontent.com/libffi/libffi/master/LICENSE")
    "LICENSE-fontconfig.txt"      = @(,@("https://raw.githubusercontent.com/freedesktop/fontconfig/main/COPYING",
                                         "https://raw.githubusercontent.com/behdad/fontconfig/master/COPYING"))
    # FreeType is dual FTL/GPL-2: ship the top-level notice AND the FTL text.
    "LICENSE-freetype.txt"        = @(@("https://raw.githubusercontent.com/freetype/freetype/master/LICENSE.TXT",
                                        "https://gitlab.freedesktop.org/freetype/freetype/-/raw/master/LICENSE.TXT"),
                                      @("https://raw.githubusercontent.com/freetype/freetype/master/docs/FTL.TXT",
                                        "https://gitlab.freedesktop.org/freetype/freetype/-/raw/master/docs/FTL.TXT"))
    "LICENSE-fribidi.txt"         = @("https://raw.githubusercontent.com/fribidi/fribidi/master/COPYING")
    # SPDX license-list-data rather than gnu.org: same texts, canonical and
    # machine-readable, on a CDN. gnu.org timed out mid-run here and these are
    # the ONLY source for three copyleft notices, which would block a release.
    # Single source per part on purpose — a fallback serving different bytes
    # just trips the hash gate, so it buys nothing but a worse error.
    "LICENSE-gcc-runtime.txt"     = @("https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt",
                                      "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GCC-exception-3.1.txt")
    "LICENSE-giflib.txt"          = @(,@("https://raw.githubusercontent.com/mirrorer/giflib/master/COPYING",
                                         "https://sourceforge.net/p/giflib/code/ci/master/tree/COPYING?format=raw"))
    # glib/COPYING is a ONE-LINE POINTER to LICENSES/ -- fetch the real text.
    "LICENSE-glib.txt"            = @("https://raw.githubusercontent.com/GNOME/glib/main/LICENSES/LGPL-2.1-or-later.txt")
    # graphite2/COPYING is the licensing STATEMENT; LICENSE carries the terms.
    "LICENSE-graphite2.txt"       = @("https://raw.githubusercontent.com/silnrsi/graphite/master/COPYING",
                                      "https://raw.githubusercontent.com/silnrsi/graphite/master/LICENSE")
    "LICENSE-harfbuzz.txt"        = @("https://raw.githubusercontent.com/harfbuzz/harfbuzz/main/COPYING")
    "LICENSE-libiconv.txt"        = @("https://raw.githubusercontent.com/spdx/license-list-data/main/text/LGPL-2.1-only.txt")
    # icu4c/LICENSE is a POINTER ("../LICENSE") -- fetch the real text.
    "LICENSE-icu.txt"             = @("https://raw.githubusercontent.com/unicode-org/icu/main/LICENSE")
    "LICENSE-gettext-runtime.txt" = @("https://raw.githubusercontent.com/spdx/license-list-data/main/text/LGPL-2.1-only.txt")
    "LICENSE-libjpeg-turbo.txt"   = @("https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/main/LICENSE.md")
    "LICENSE-leptonica.txt"       = @("https://raw.githubusercontent.com/DanBloomberg/leptonica/master/leptonica-license.txt")
    # We ship the LIBRARY (liblz4), which is BSD-2 under lib/. The repo-root
    # LICENSE only DESCRIBES the split and carries no terms.
    "LICENSE-lz4.txt"             = @("https://raw.githubusercontent.com/lz4/lz4/dev/lib/LICENSE")
    "LICENSE-xz.txt"              = @("https://raw.githubusercontent.com/tukaani-project/xz/master/COPYING")
    "LICENSE-openjpeg.txt"        = @("https://raw.githubusercontent.com/uclouvain/openjpeg/master/LICENSE")
    "LICENSE-pango.txt"           = @(,@("https://raw.githubusercontent.com/GNOME/pango/main/COPYING",
                                         "https://gitlab.gnome.org/GNOME/pango/-/raw/main/COPYING"))
    "LICENSE-pcre2.txt"           = @(,@("https://raw.githubusercontent.com/PCRE2Project/pcre2/master/LICENCE.md",
                                         "https://raw.githubusercontent.com/PCRE2Project/pcre2/main/LICENCE",
                                         "https://raw.githubusercontent.com/PCRE2Project/pcre2/master/COPYING"))
    # Same Anubis wall as cairo; pixman's COPYING carries the MIT text AND the
    # full copyright-holder list, which MIT requires us to reproduce.
    "LICENSE-pixman.txt"          = @("https://raw.githubusercontent.com/freedesktop-unofficial-mirror/pixman/master/COPYING")
    "LICENSE-libpng.txt"          = @("https://raw.githubusercontent.com/pnggroup/libpng/master/LICENSE")
    "LICENSE-libthai.txt"         = @("https://raw.githubusercontent.com/tlwg/libthai/master/COPYING")
    "LICENSE-libtiff.txt"         = @("https://gitlab.com/libtiff/libtiff/-/raw/master/LICENSE.md")
    "LICENSE-libwebp.txt"         = @("https://raw.githubusercontent.com/webmproject/libwebp/main/COPYING")
    "LICENSE-mingw-w64.txt"       = @(,@("https://raw.githubusercontent.com/mingw-w64/mingw-w64/master/COPYING",
                                         "https://sourceforge.net/p/mingw-w64/mingw-w64/ci/master/tree/COPYING?format=raw"))
    "LICENSE-zstd.txt"            = @("https://raw.githubusercontent.com/facebook/zstd/dev/LICENSE")
    "LICENSE-zlib.txt"            = @("https://raw.githubusercontent.com/madler/zlib/develop/LICENSE")
    # LICENSE-Tesseract.txt is NOT here: bundle-tesseract.ps1 copies it (and
    # AUTHORS-Tesseract.txt) straight out of the installer, which is a better
    # source than upstream HEAD -- it is the text for the exact build we ship.
}

# ---- what the manifest demands -------------------------------------------
if (-not (Test-Path $Manifest)) { Write-Error "Manifest not found: $Manifest"; exit 1 }
$needed = Get-Content $Manifest |
    Where-Object { $_ -and $_ -notmatch '^\s*#' } |
    Select-Object -Skip 1 |
    ForEach-Object { ($_ -split "`t")[3] } |
    Where-Object { $_ } |
    Sort-Object -Unique

$installerSupplied = @("LICENSE-Tesseract.txt")
$mustFetch = $needed | Where-Object { $installerSupplied -notcontains $_ }

$missingSource = $mustFetch | Where-Object { -not $Sources.Contains($_) }
if ($missingSource) {
    Write-Error ("Manifest demands notices with no source URL:`n  " + ($missingSource -join "`n  "))
    exit 1
}

New-Item -ItemType Directory -Force $DestDir | Out-Null

Write-Host "Fetching $($mustFetch.Count) licence texts into $DestDir"
$failed = @()
$records = @()

foreach ($notice in $mustFetch) {
    $parts = @()
    $ok = $true
    foreach ($part in $Sources[$notice]) {
      $got = $null
      $lastErr = ""
      foreach ($url in @($part)) {
        if ($got) { break }
        # Download to a FILE, never through $resp.Content: for a text response
        # that property is a String, so decoding it as bytes throws a type error
        # that looks exactly like a network failure. -OutFile takes the raw
        # bytes and leaves the decoding to one explicit read.
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lic-" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
        foreach ($attempt in 1..3) {
            try {
                Invoke-WebRequest -Uri $url -UserAgent $UA -MaximumRedirection 5 -TimeoutSec 60 -OutFile $tmp
                $got = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
                if ($got.Trim().Length -eq 0) { throw "empty body" }
                # Some upstreams keep a one-line pointer where the licence
                # should be (glib's COPYING names LICENSES/LGPL-2.1-or-later.txt;
                # icu4c/LICENSE names ../LICENSE). They fetch fine and are
                # useless as notices.
                if ($got.Trim().Length -lt $MinNoticeBytes) {
                    throw "suspiciously short ($($got.Trim().Length) bytes) -- probably a pointer, not licence text"
                }
                # Anti-bot and repo-browser pages return HTTP 200 at 4-7KB, over
                # the floor. A licence is plain text.
                if ($got -imatch '<!doctype\s+html|<html[\s>]|<head[\s>]|<script[\s>]') {
                    throw "served HTML, not licence text (anti-bot page, login wall, or a repo-browser view -- use a raw/plain URL)"
                }
                break
            } catch {
                # $got is assigned before the checks above, so it must be
                # cleared here or a rejected body is used anyway.
                $got = $null
                $lastErr = $_.Exception.Message
                if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
            }
        }
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        if ($got) {
            $parts += ("=== source: $url ===`r`n`r`n" + ($got -replace "`r`n", "`n" -replace "`n", "`r`n"))
        }
      }
      if (-not $got) { $ok = $false; $failed += "$notice  <-  $(@($part)[-1])`n      $lastErr"; break }
    }
    if (-not $ok) { continue }

    $text = ($parts -join "`r`n`r`n")
    $out = Join-Path $DestDir $notice
    [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false)))
    $records += $notice
    Write-Host ("  ok  {0,-32} {1,7} bytes" -f $notice, $text.Length)
}

if ($failed) {
    Write-Host ""
    Write-Error ("Could not fetch:`n  " + ($failed -join "`n  "))
    exit 1
}

Write-Host ""
Write-Host "Done. $($records.Count) notices written to $DestDir"
Write-Host "REVIEW THE GIT DIFF and commit -- these files are what ships."
