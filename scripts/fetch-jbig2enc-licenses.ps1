# MAINTENANCE TOOL, not a build step. Run only when the jbig2enc pin in
# bundle-jbig2enc.ps1 changes; review the git diff and commit the result.
#
# The jbig2enc release asset is SHA-256 pinned and its `jbig2.exe` is a STATIC
# build — leptonica, libtiff, libjpeg-turbo, libpng, zlib-ng, openjpeg, libwebp
# and giflib are linked INSIDE the one binary. So the applicable licences are
# those of the exact versions frozen in that executable and they cannot change,
# because the binary cannot change. Fetching at build time would be worse than
# unnecessary: upstream HEAD can carry the licence for a DIFFERENT version than
# the one redistributed, so a "refresh" could replace a correct notice with an
# inapplicable one, and it would make every build depend on external hosts.
# Texts are checked in at scripts/jbig2enc-licenses/; bundle-jbig2enc.ps1
# copies them, offline.
#
# Every URL below is pinned to the component VERSION the artifact actually
# carries (upstream's own `depmf.json`, cross-checked against `jbig2.exe
# --version`), not to a moving branch. jbig2enc's own Apache-2.0 COPYING and
# its PATENTS note ship inside the zip, so they are not fetched here.
#
# scripts/jbig2enc-licenses.tsv is the manifest: its notice column says what
# must exist, this table says where each came from.

param(
    # Integrity is git's: the diff of a re-run is the review.
    [string]$DestDir = (Join-Path $PSScriptRoot "jbig2enc-licenses")
)

$ErrorActionPreference = "Stop"

# Floor for a plausible licence text; pointer stubs run under 150 bytes.
$MinNoticeBytes = 400

$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# notice file -> ordered PARTS. Each part is concatenated into the output (how a
# dual-licence component ships its full terms — libjpeg-turbo's LICENSE.md
# names three licences and the IJG terms live in a separate README). A part may
# itself be an array of ALTERNATES: the first that fetches wins.
$Sources = [ordered]@{
    # giflib is on SourceForge, which serves the raw file to a plain client and
    # 403s a browser User-Agent — the opposite of every other host here — so
    # the GitHub mirror is primary and SourceForge is the alternate. Byte
    # counts were compared: the two are the same file.
    "LICENSE-giflib.txt"        = @(,@("https://raw.githubusercontent.com/mirrorer/giflib/master/COPYING",
                                       "https://sourceforge.net/p/giflib/code/ci/5.2.2/tree/COPYING?format=raw"))
    "LICENSE-leptonica.txt"     = @("https://raw.githubusercontent.com/DanBloomberg/leptonica/1.87.0/leptonica-license.txt")
    "LICENSE-openjpeg.txt"      = @("https://raw.githubusercontent.com/uclouvain/openjpeg/v2.5.4/LICENSE")
    # BSD-3-Clause AND IJG: LICENSE.md is the statement over three licences and
    # README.ijg carries the IJG terms it refers to, so both ship.
    "LICENSE-libjpeg-turbo.txt" = @("https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/3.1.4/LICENSE.md",
                                    "https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/3.1.4/README.ijg")
    "LICENSE-libpng.txt"        = @("https://raw.githubusercontent.com/pnggroup/libpng/v1.6.58/LICENSE")
    "LICENSE-zlib-ng.txt"       = @("https://raw.githubusercontent.com/zlib-ng/zlib-ng/2.3.3/LICENSE.md")
    "LICENSE-libtiff.txt"       = @(,@("https://gitlab.com/libtiff/libtiff/-/raw/v4.7.1/LICENSE.md",
                                       "https://raw.githubusercontent.com/libsdl-org/libtiff/main/LICENSE.md"))
    "LICENSE-libwebp.txt"       = @("https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/COPYING")
}

New-Item -ItemType Directory -Force $DestDir | Out-Null
Write-Host "Fetching $($Sources.Count) notice texts for the pinned jbig2enc build..."

$failed = @()
$records = @()
foreach ($notice in $Sources.Keys) {
    $parts = @()
    $ok = $true
    foreach ($part in $Sources[$notice]) {
        $got = $null
        $lastErr = ""
        foreach ($url in @($part)) {
            if ($got) { break }
            # Download to a FILE, never through $resp.Content: for a text
            # response that property is a String, so decoding it as bytes
            # throws a type error that looks exactly like a network failure.
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("jblic-" + [System.Guid]::NewGuid().ToString("N") + ".tmp")
            foreach ($attempt in 1..3) {
                try {
                    # SourceForge is the one host here that PREFERS the default
                    # agent, so the alternate is fetched without the override.
                    if ($url -like "*sourceforge.net*") {
                        Invoke-WebRequest -Uri $url -MaximumRedirection 5 -TimeoutSec 60 -OutFile $tmp
                    } else {
                        Invoke-WebRequest -Uri $url -UserAgent $UA -MaximumRedirection 5 -TimeoutSec 60 -OutFile $tmp
                    }
                    $got = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
                    if ($got.Trim().Length -eq 0) { throw "empty body" }
                    if ($got.Trim().Length -lt $MinNoticeBytes) {
                        throw "suspiciously short ($($got.Trim().Length) bytes) -- probably a pointer, not licence text"
                    }
                    # Anti-bot and repo-browser pages return HTTP 200 well over
                    # the floor. A licence is plain text.
                    if ($got -imatch '<!doctype\s+html|<html[\s>]|<head[\s>]|<script[\s>]') {
                        throw "served HTML, not licence text (anti-bot page or a repo-browser view -- use a raw/plain URL)"
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
    Write-Host ("  ok  {0,-30} {1,7} bytes" -f $notice, $text.Length)
}

if ($failed) {
    Write-Host ""
    Write-Error ("Could not fetch:`n  " + ($failed -join "`n  "))
    exit 1
}

Write-Host ""
Write-Host "Done. $($records.Count) notices written to $DestDir"
Write-Host "REVIEW THE GIT DIFF and commit -- these files are what ships."
