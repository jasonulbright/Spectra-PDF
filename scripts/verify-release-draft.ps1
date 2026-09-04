# Verifies a DRAFT release against the build that produced it, from the bytes
# GitHub actually holds. Every asset is downloaded by its asset id into a
# scratch directory and hashed; the downloaded hash must equal the local
# build's, the downloaded SHA256SUMS.txt must name every checksummed asset with
# the hash of the downloaded bytes, and the downloaded installer signature must
# be the one latest.json carries. A size match proves nothing here: a
# same-length upload with different bytes is exactly the case that hashing
# exists to catch.
#
# Every identity comparison in this file is ORDINAL. PowerShell's default
# operators (-eq/-ne/-replace/-match), hashtables, and PSObject property
# lookups are case-insensitive, while every consumer of these identities is
# not: the updater resolves platform keys and requests `latest.json` by exact
# name, an asset name is exact on GitHub, a base64 signature differing in one
# letter's case is a different signature, and `sha256sum -c` matches filenames
# exactly. A case-only difference therefore has to fail here, so lookups go
# through ordinal dictionaries, sets through ordinal HashSets, and scalars
# through -ceq/-cne or [string]::Equals(..., Ordinal).
#
# Downloads go through curl.exe, never a PowerShell redirection: a redirected
# native command's stdout is decoded and re-encoded as text, which corrupts
# binary assets. The Authorization header is dropped on the cross-host redirect
# to the asset store (curl's default), which that store requires.
#
# The manifest's last check is the updater plugin's own deserializer: the
# downloaded latest.json is parsed by `cargo test --test verifier_<hex>_updater_manifest`
# in -CargoPackage with the RemoteRelease type the installed copies read it with
# (its `time` RFC 3339 parse of `pub_date`, its unknown-field policy), then
# compared against the tag version, the release body, and the installer. A
# manifest this script re-implemented the shape of could pass here and still
# refuse to parse in every installed copy, which is the launch update check
# failing everywhere at once. -CargoPackage defaults to the checkout's own
# `src-tauri`; the redo passes a TAG's package so the parse runs against the
# updater version THAT package pins.
#
# The verifier LOGIC never comes from -CargoPackage. The Rust source beside
# this script (src-tauri/tests/updater_manifest.rs at this script's revision)
# is copied on every run to a target name under the prefix reserved to this
# script -- src-tauri/tests/verifier_<16 random hex>_updater_manifest.rs. No
# product revision commits a file under `tests/verifier_`
# (tests/test_ci_capability_setup.py refuses the prefix in the index,
# .gitignore refuses it in the working tree). Selecting logic by whether the
# package already holds a conventionally named test would let a tag's own
# stale or accepting copy stand in for the current verifier while reporting
# the current verdict.
#
# A hashed file is not yet an executed target: cargo resolves `--test <name>`
# through the verified package's Cargo.toml, so a fixed reserved name could be
# claimed there by an explicit `[[test]] name = "<reserved>" path = "..."`
# (explicit targets outrank the inferred tests/<name>.rs of the same name) and
# `autotests = false` can suppress inference entirely. The invariant enforced
# instead: the executed test target IS the staged file, proven by cargo's own
# resolution. The target name is fresh per run, so no manifest can name it in
# advance; after staging, `cargo metadata --no-deps` for the package must list
# EXACTLY one `test` target of that name whose src_path, canonicalized (real
# on-disk case, compared ordinally), is the staged file; the package manifest
# must not set `autotests = false` and no `[[test]]` in it may name or path
# anything under the reserved prefix; and the `Running <path>` line cargo
# prints for the executed binary must resolve to the staged file. The staged
# bytes are hashed against the source after the copy and removed after the
# run; the package's own updater_manifest.rs is never read.
#
# An executed target is not yet an executed test: the harness takes a test
# name as a substring filter and a run that matches nothing passes with
# `running 0 tests`. The staged target is therefore listed first (exactly
# one test of the verifier's name, none sharing its prefix), then run with
# `--exact` on one thread, and the harness output must carry `running 1
# test`, `test <name> ... ok`, and a tally of 1 passed / 0 failed / 0
# ignored. cargo is never invoked through a pipeline: the exit code and
# both streams come from the child process and are retained beside the
# downloads.
#
# Residual, by design: the verification runs INSIDE the package under test --
# its pinned updater plugin, its build.rs, its Cargo.lock. The verifier CODE is
# this revision's; the CRATE the code exercises is the tag's, because the
# question being answered is whether the manifest parses with the updater
# version THAT tag's binaries carry.
#
# -Offline <dir> skips the API and reads <dir>/release.json, <dir>/assets.json
# and the "downloaded" asset files from <dir>; the comparison is otherwise the
# same, which is what tests/test_ci_capability_setup.py drives. -Repo is still
# required: the manifest urls are compared against the exact asset url built
# from it.
[CmdletBinding()]
param(
    [string]$Repo,
    [string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Bundle = "src-tauri/target/release/bundle/nsis",
    [string]$Portable = "src-tauri/target/release/bundle/portable",
    [string]$Sources = "release-sources",
    [string]$Downloads = "",
    [string]$Offline = "",
    [string]$CargoPackage = "src-tauri"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-Sha256([string]$path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}

function New-OrdinalMap {
    return [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
}

function Test-OrdinalEqual([string]$a, [string]$b) {
    return [string]::Equals($a, $b, [System.StringComparison]::Ordinal)
}

# Exact set equality: same members under ordinal comparison, and no member
# repeated (two names differing only by case are two members of `actual`
# and can never match one `expected` name). The sets are built inline: a
# HashSet returned from a function is enumerated by the pipeline.
function Assert-SameOrdinalSet([string[]]$expected, [string[]]$actual, [scriptblock]$message) {
    $expectedSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$expected, [System.StringComparer]::Ordinal)
    $actualSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$actual, [System.StringComparer]::Ordinal)
    if ($expectedSet.Count -ne $expected.Count -or $actualSet.Count -ne $actual.Count -or
        -not $expectedSet.SetEquals($actualSet)) {
        throw (& $message)
    }
}

# Ordinal sort for messages: Sort-Object is culture- and case-insensitive.
function Sort-Ordinal([string[]]$items) {
    return @([System.Linq.Enumerable]::OrderBy([string[]]$items, [Func[string, string]] { param($s) $s },
        [System.StringComparer]::Ordinal))
}

if ($Tag -cnotmatch '^v[0-9]') { throw "-Tag must be a lowercase 'v' tag, got '$Tag'" }
$version = $Tag.Substring(1)
# The manifest url is rebuilt from the repository, never pattern-matched.
if ($Repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Repo must be <owner>/<name>, got '$Repo'" }

# The platform set the updater manifest must carry for this build. Tauri emits
# one `windows-x86_64-<target>` entry per bundle target in tauri.conf.json
# (`bundle.targets` is `["nsis"]`) plus the bare `windows-x86_64` fallback, and
# the updater resolves the target-specific entry before the fallback; a
# manifest that validates only the fallback validates the entry nobody reads.
$expectedPlatforms = @("windows-x86_64-nsis", "windows-x86_64")

if ($Offline) {
    $Downloads = $Offline
    $release = Get-Content (Join-Path $Offline "release.json") -Raw | ConvertFrom-Json
    $assets = @(Get-Content (Join-Path $Offline "assets.json") -Raw | ConvertFrom-Json)
} else {
    if (-not $ReleaseId) { throw "-ReleaseId is required unless -Offline is given" }
    if (-not $env:GH_TOKEN) { throw "GH_TOKEN is not set" }
    if (-not $Downloads) { $Downloads = Join-Path $Bundle "draft-downloads" }
    if (Test-Path -LiteralPath $Downloads) { Remove-Item -LiteralPath $Downloads -Recurse -Force }
    New-Item -ItemType Directory -Path $Downloads | Out-Null
    $releaseJson = @(& gh api "repos/$Repo/releases/$ReleaseId")
    if ($LASTEXITCODE -ne 0) { throw "failed to read release $ReleaseId" }
    $release = ($releaseJson -join "`n") | ConvertFrom-Json
    $assetsJson = @(& gh api "repos/$Repo/releases/$ReleaseId/assets?per_page=100")
    if ($LASTEXITCODE -ne 0) { throw "failed to list the assets of release $ReleaseId" }
    $assets = @(($assetsJson -join "`n") | ConvertFrom-Json)
}

if (-not $release.draft) { throw "release $ReleaseId is already public before verification" }
if ([string]$release.tag_name -cne $Tag) { throw "draft is for tag '$($release.tag_name)', expected '$Tag'" }

$installer = @(Get-ChildItem -LiteralPath $Bundle -Filter "*-setup.exe" -File)
if ($installer.Count -ne 1) { throw "expected one installer, found $($installer.Count)" }
$signature = Get-Item -LiteralPath (Join-Path $Bundle "$($installer[0].Name).sig")
$portableZip = @(Get-ChildItem -LiteralPath $Portable -Filter "*-portable.zip" -File)
if ($portableZip.Count -ne 1) { throw "expected one portable zip, found $($portableZip.Count)" }
$sourceFiles = @(Get-ChildItem -LiteralPath $Sources -File)
if (-not $sourceFiles) { throw "no corresponding-source archives in $Sources" }
$sums = Get-Item -LiteralPath (Join-Path $Bundle "SHA256SUMS.txt")
$local = @($installer) + @($signature) + @($portableZip) + @($sourceFiles) + @($sums)

$expected = Sort-Ordinal (@($local.Name) + @("latest.json"))
$actual = Sort-Ordinal @($assets | ForEach-Object { [string]$_.name })
Assert-SameOrdinalSet $expected $actual {
    "draft assets differ from the built set.`nexpected:`n$($expected -join "`n")`nactual:`n$($actual -join "`n")"
}

# Every asset the draft holds, fetched by id and hashed. latest.json is
# included: its bytes are what the updater will read.
$downloaded = New-OrdinalMap
foreach ($asset in $assets) {
    $assetName = [string]$asset.name
    if ($downloaded.ContainsKey($assetName)) { throw "the draft lists '$assetName' twice" }
    $target = Join-Path $Downloads $assetName
    if (-not $Offline) {
        $url = "https://api.github.com/repos/$Repo/releases/assets/$($asset.id)"
        & curl.exe --fail --silent --show-error --location `
            -H "Authorization: Bearer $env:GH_TOKEN" `
            -H "Accept: application/octet-stream" `
            -o $target $url
        if ($LASTEXITCODE -ne 0) { throw "failed to download draft asset $assetName (id $($asset.id))" }
    }
    if (-not (Test-Path -LiteralPath $target)) { throw "${assetName}: no downloaded bytes at $target" }
    $length = (Get-Item -LiteralPath $target).Length
    if ($length -ne $asset.size) { throw "${assetName}: downloaded $length bytes, the draft lists $($asset.size)" }
    $downloaded[$assetName] = @{ path = $target; sha256 = (Get-Sha256 $target); id = [string]$asset.id }
}

function Get-Downloaded([string]$name) {
    if (-not $downloaded.ContainsKey($name)) { throw "'$name' is not an uploaded asset (exact name)" }
    return $downloaded[$name]
}

foreach ($file in $local) {
    $got = Get-Downloaded $file.Name
    $want = Get-Sha256 $file.FullName
    if (-not (Test-OrdinalEqual $got.sha256 $want)) {
        throw "$($file.Name): uploaded bytes differ from the built file (uploaded sha256 $($got.sha256), built $want)"
    }
}

# The checksum file the public will verify against, read from the draft, must
# name exactly the checksummed assets and carry the hash of the uploaded bytes.
# Entries are lowercase hex by construction (the workflow writes them so) and
# are compared as written: an uppercase digest is not this workflow's output.
$checksummed = Sort-Ordinal @(@($installer) + @($portableZip) + @($sourceFiles) | ForEach-Object { $_.Name })
$named = @()
foreach ($line in Get-Content -LiteralPath (Get-Downloaded "SHA256SUMS.txt").path) {
    if (-not $line.Trim()) { continue }
    $hash, $name = $line -split '  ', 2
    if ($hash -cnotmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS.txt carries a digest that is not lowercase sha256 hex: '$hash'" }
    if (-not $downloaded.ContainsKey($name)) { throw "SHA256SUMS.txt names '$name', which is not an uploaded asset" }
    if ($downloaded[$name].sha256 -cne $hash) {
        throw "SHA256SUMS.txt is wrong for $name (listed $hash, uploaded $($downloaded[$name].sha256))"
    }
    $named += $name
}
$named = Sort-Ordinal $named
Assert-SameOrdinalSet $checksummed $named {
    "SHA256SUMS.txt covers [$($named -join ', ')], expected [$($checksummed -join ', ')]"
}

$manifest = Get-Content -LiteralPath (Get-Downloaded "latest.json").path -Raw | ConvertFrom-Json
if ([string]$manifest.version -cne $version) { throw "latest.json version '$($manifest.version)' != tag version '$version'" }
$uploadedSig = (Get-Content -LiteralPath (Get-Downloaded $signature.Name).path -Raw).Trim()
$localSig = (Get-Content -LiteralPath $signature.FullName -Raw).Trim()
if ($uploadedSig -cne $localSig) { throw "uploaded $($signature.Name) is not the built signature" }
$installerId = (Get-Downloaded $installer[0].Name).id
$installerUrl = "https://api.github.com/repos/$Repo/releases/assets/$installerId"
# Platform entries are re-keyed into an ordinal map: `$manifest.platforms.$name`
# resolves a property case-insensitively, which would let `Windows-x86_64-NSIS`
# stand in for the key the updater actually looks up.
$platforms = New-OrdinalMap
foreach ($property in $manifest.platforms.PSObject.Properties) {
    if ($platforms.ContainsKey($property.Name)) { throw "latest.json lists platform '$($property.Name)' twice" }
    $platforms[$property.Name] = $property.Value
}
$present = Sort-Ordinal @($platforms.Keys)
$wanted = Sort-Ordinal $expectedPlatforms
Assert-SameOrdinalSet $wanted $present {
    "latest.json platforms [$($present -join ', ')] != [$($wanted -join ', ')]"
}
foreach ($name in $expectedPlatforms) {
    $platform = $platforms[$name]
    if (-not $platform.signature -or ([string]$platform.signature).Trim() -cne $uploadedSig) {
        throw "latest.json signature is not the uploaded installer's .sig (platform $name)"
    }
    if ([string]$platform.url -cne $installerUrl) {
        throw "latest.json url mismatch (platform $name): '$($platform.url)' != '$installerUrl'"
    }
}

# The real on-disk path: full, and with each segment's case as the file system
# holds it. .NET's own resolution keeps the caller's casing, and cargo reports
# src_path from the manifest directory it was given, so both sides are
# canonicalized here before the ordinal comparison.
function Get-CanonicalPath([string]$path) {
    $full = [System.IO.Path]::GetFullPath($path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $canonical = $root.ToUpperInvariant()
    foreach ($segment in $full.Substring($root.Length).Split([System.IO.Path]::DirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $entries = @([System.IO.Directory]::GetFileSystemEntries($canonical, $segment))
        if ($entries.Count -ne 1) { throw "cannot canonicalize '$path': '$segment' under '$canonical' resolves to $($entries.Count) entries" }
        $canonical = $entries[0]
    }
    return $canonical
}

# cargo, run as a child process with both streams captured to retained
# `<stem>.stdout.log` / `<stem>.stderr.log` files and echoed. Never a
# pipeline and never a PowerShell redirection: a pipeline reports the last
# stage's status, and a redirected native stderr is re-rendered as error
# records. The exit code is the process's own.
function Remove-AnsiEscapes([string]$text) {
    return [regex]::Replace($text, "`e\[[0-?]*[ -/]*[@-~]", "")
}

function Invoke-CargoTest([string]$logStem, [string[]]$arguments) {
    $cargo = @(Get-Command cargo -CommandType Application)[0].Source
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $cargo
    $startInfo.ArgumentList.Add("--color")
    $startInfo.ArgumentList.Add("never")
    foreach ($argument in $arguments) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.UseShellExecute = $false
    # The child's environment is the authoritative switch: a caller that
    # exports CARGO_TERM_COLOR=always (the hosted runners do) makes cargo
    # colour a redirected stream, and styled text is not parseable.
    $startInfo.Environment["CARGO_TERM_COLOR"] = "never"
    $startInfo.Environment["NO_COLOR"] = "1"
    $startInfo.Environment["TERM"] = "dumb"
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.WorkingDirectory = (Get-Location).Path
    $process = [System.Diagnostics.Process]::Start($startInfo)
    # Both streams drain concurrently: a full pipe on the unread one would
    # block the child before it exits.
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    # Every consumer parses these; nothing downstream sees terminal styling.
    $stdoutText = Remove-AnsiEscapes $stdoutTask.GetAwaiter().GetResult()
    $stderrText = Remove-AnsiEscapes $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    $process.Dispose()
    [System.IO.File]::WriteAllText("$logStem.stdout.log", $stdoutText, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText("$logStem.stderr.log", $stderrText, [System.Text.UTF8Encoding]::new($false))
    $newlines = [string[]]@("`r`n", "`n")
    $split = [System.StringSplitOptions]::RemoveEmptyEntries
    $stdout = @($stdoutText.Split($newlines, $split))
    $stderr = @($stderrText.Split($newlines, $split))
    Write-Host "cargo $($arguments -join ' ') (exit $exitCode)"
    foreach ($line in $stderr) { Write-Host $line }
    foreach ($line in $stdout) { Write-Host $line }
    return [pscustomobject]@{ ExitCode = $exitCode; StdOut = $stdout; StdErr = $stderr }
}

# Belt and braces on the metadata resolution: the binary cargo reports
# having run was built from the staged file. Cargo prints the source path
# relative to the workspace root it reported in the metadata.
function Test-CargoRanTheStagedVerifier([string[]]$stderr, [string]$phase) {
    $running = @($stderr | ForEach-Object {
        $m = [regex]::Match($_, '^\s*Running\s+(\S.*?\.rs)\s*\(')
        if ($m.Success) { $m.Groups[1].Value }
    })
    if ($running.Count -ne 1) { throw "cargo reported $($running.Count) 'Running' test binaries in the $phase, expected exactly 1" }
    $ran = $running[0]
    if (-not [System.IO.Path]::IsPathRooted($ran)) { $ran = Join-Path ([string]$metadata.workspace_root) $ran }
    $ranPath = Get-CanonicalPath $ran
    if (-not (Test-OrdinalEqual $ranPath $stagedPath)) {
        throw "cargo ran $ranPath in the $phase, not the staged verifier $stagedPath"
    }
}

# The consumer's parse (header). The release body is handed over as a file:
# an environment value would go through the console encoding.
# The verifier's own copy of the test source is staged under a fresh name in
# the reserved prefix unconditionally (header): the package's tests/ directory
# is never consulted for logic, only for the dependency graph its Cargo.toml
# and Cargo.lock pin.
$verifierPrefix = "verifier_"
$nonce = ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(8) | ForEach-Object { $_.ToString("x2") }) -join ""
$verifierTest = "${verifierPrefix}${nonce}_updater_manifest"
$verifierFunction = "verifies_the_manifest_named_by_the_environment"
$testSource = Join-Path $PSScriptRoot "..\src-tauri\tests\updater_manifest.rs"
if (-not (Test-Path -LiteralPath $testSource)) { throw "no updater manifest test at $testSource" }
$packageManifest = Join-Path $CargoPackage "Cargo.toml"
$testTarget = Join-Path (Join-Path $CargoPackage "tests") "$verifierTest.rs"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $testTarget) | Out-Null
Copy-Item -LiteralPath $testSource -Destination $testTarget -Force
$sourceSha = Get-Sha256 $testSource
$stagedSha = Get-Sha256 $testTarget
if (-not (Test-OrdinalEqual $sourceSha $stagedSha)) {
    throw "staged verifier test $testTarget (sha256 $stagedSha) is not the verifier's source $testSource (sha256 $sourceSha)"
}
Write-Host "staged $testSource as $testTarget (sha256 $stagedSha)"
try {
    $stagedPath = Get-CanonicalPath $testTarget
    $manifestPath = Get-CanonicalPath $packageManifest

    # The package manifest, as text: cargo metadata does not report
    # `autotests`, and a `[[test]]` under the reserved prefix is refused
    # whether or not cargo would let it shadow anything.
    $manifestText = Get-Content -LiteralPath $packageManifest -Raw
    if ($manifestText -cmatch '(?m)^\s*autotests\s*=\s*false\b') {
        throw "$packageManifest sets autotests = false: the staged verifier target cannot be inferred"
    }
    foreach ($section in [regex]::Split($manifestText, '(?m)^\s*\[\[test\]\]\s*$') | Select-Object -Skip 1) {
        $body = [regex]::Split($section, '(?m)^\s*\[')[0]
        foreach ($key in "name", "path") {
            $m = [regex]::Match($body, "(?m)^\s*$key\s*=\s*[`"']([^`"']*)[`"']")
            if (-not $m.Success) { continue }
            $value = $m.Groups[1].Value -replace '\\', '/'
            if ($value -cmatch "^(tests/)?$verifierPrefix") {
                throw "$packageManifest declares a [[test]] with $key '$($m.Groups[1].Value)' under the reserved '$verifierPrefix' prefix"
            }
        }
    }

    # Cargo's own resolution of the package's targets. Exactly one package at
    # this manifest, exactly one test target of the fresh name, and its source
    # is the staged file. Any other target under the reserved prefix, explicit
    # or inferred, is refused: the prefix is the verifier's alone.
    $metadataJson = & cargo metadata --no-deps --format-version 1 --manifest-path $packageManifest
    if ($LASTEXITCODE -ne 0) { throw "cargo metadata failed for $packageManifest" }
    $metadata = ($metadataJson -join "`n") | ConvertFrom-Json
    $packages = @($metadata.packages | Where-Object {
        Test-OrdinalEqual (Get-CanonicalPath ([string]$_.manifest_path)) $manifestPath
    })
    if ($packages.Count -ne 1) { throw "cargo metadata lists $($packages.Count) packages at $manifestPath, expected 1" }
    $testTargets = @($packages[0].targets | Where-Object { @($_.kind) -ccontains "test" })
    $named = @($testTargets | Where-Object { Test-OrdinalEqual ([string]$_.name) $verifierTest })
    if ($named.Count -ne 1) {
        throw "cargo resolves $($named.Count) test targets named '$verifierTest' in $manifestPath, expected exactly 1"
    }
    $resolvedPath = Get-CanonicalPath ([string]$named[0].src_path)
    if (-not (Test-OrdinalEqual $resolvedPath $stagedPath)) {
        throw "cargo resolves test target '$verifierTest' to $resolvedPath, not the staged $stagedPath"
    }
    foreach ($t in $testTargets) {
        $name = [string]$t.name
        $leaf = [System.IO.Path]::GetFileName([string]$t.src_path)
        if (Test-OrdinalEqual $name $verifierTest) { continue }
        if ($name.StartsWith($verifierPrefix, [System.StringComparison]::Ordinal) -or
            $leaf.StartsWith($verifierPrefix, [System.StringComparison]::Ordinal)) {
            throw "the package carries a test target '$name' ($($t.src_path)) under the reserved '$verifierPrefix' prefix"
        }
    }
    Write-Host "cargo resolves --test $verifierTest to $resolvedPath"

    $bodyFile = Join-Path $Downloads "release-body.local.txt"
    # The release body is multi-line (it is the changelog section for this
    # version). GitHub stores and returns a release body with CRLF line
    # endings, while `latest.json` carries the LF bytes the publisher wrote;
    # the comparison is over the notes' TEXT, so both sides are normalized to
    # LF here. Every other difference still fails.
    $bodyText = ([string]$release.body) -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($bodyFile, $bodyText, [System.Text.UTF8Encoding]::new($false))
    $env:SPECTRAPDF_UPDATER_MANIFEST = (Resolve-Path -LiteralPath (Get-Downloaded "latest.json").path).Path
    $env:SPECTRAPDF_UPDATER_VERSION = $version
    $env:SPECTRAPDF_UPDATER_NOTES_FILE = (Resolve-Path -LiteralPath $bodyFile).Path
    $env:SPECTRAPDF_UPDATER_PLATFORMS = $expectedPlatforms -join ","
    $env:SPECTRAPDF_UPDATER_URL = $installerUrl
    $env:SPECTRAPDF_UPDATER_SIGNATURE_FILE = (Resolve-Path -LiteralPath (Get-Downloaded $signature.Name).path).Path
    # A test-name argument is a substring FILTER to the harness, and a filter
    # that selects nothing is a passing run (`running 0 tests`, exit 0). A
    # staged file that executed is therefore not yet a manifest that was
    # read: the run must prove that exactly the verifier function ran and
    # passed. The listing is taken first so a filter drift in either
    # direction is visible -- the function absent from the staged file, or a
    # second function the substring filter would also select -- and the run
    # is then keyed by exact name on one thread, and its tally must read
    # exactly one test run, that test `ok`, 1 passed, 0 failed, 0 ignored.
    # Neither invocation goes through a pipeline: the harness's exit code
    # and streams are taken from the process itself and retained on disk.
    $listing = Invoke-CargoTest (Join-Path $Downloads "cargo-list.local") @(
        "test", "--manifest-path", $packageManifest, "--test", $verifierTest, "--", "--list"
    )
    Test-CargoRanTheStagedVerifier $listing.StdErr "listing"
    if ($listing.ExitCode -ne 0) { throw "cargo test --list of the staged verifier failed (exit $($listing.ExitCode), output above)" }
    $listed = @($listing.StdOut | ForEach-Object {
        $m = [regex]::Match($_, '^(\S+): test$')
        if ($m.Success) { $m.Groups[1].Value }
    })
    $exact = @($listed | Where-Object { Test-OrdinalEqual $_ $verifierFunction })
    if ($exact.Count -ne 1) {
        throw "the staged verifier lists $($exact.Count) tests named '$verifierFunction', expected exactly 1 (listed: $($listed -join ', '))"
    }
    $siblings = @($listed | Where-Object {
        -not (Test-OrdinalEqual $_ $verifierFunction) -and $_.StartsWith($verifierFunction, [System.StringComparison]::Ordinal)
    })
    if ($siblings.Count -ne 0) {
        throw "the staged verifier lists tests the '$verifierFunction' filter would also select: $($siblings -join ', ')"
    }

    $run = Invoke-CargoTest (Join-Path $Downloads "cargo-test.local") @(
        "test", "--manifest-path", $packageManifest, "--test", $verifierTest, "--",
        "--exact", $verifierFunction, "--test-threads=1"
    )
    # The test's own diagnostics are the refusal's reason.
    if ($run.ExitCode -ne 0) {
        throw "latest.json is refused by the updater's own deserializer or differs from the release (cargo output above)"
    }
    Test-CargoRanTheStagedVerifier $run.StdErr "run"
    $headers = @($run.StdOut | Where-Object { $_ -cmatch '^running \d+ tests?$' })
    if ($headers.Count -ne 1 -or -not (Test-OrdinalEqual $headers[0] "running 1 test")) {
        throw "the verifier run did not execute exactly one test (harness reported: $($headers -join ' / '))"
    }
    $outcomes = @($run.StdOut | Where-Object { $_ -cmatch '^test \S+ \.\.\. ' })
    if ($outcomes.Count -ne 1 -or -not (Test-OrdinalEqual $outcomes[0] "test $verifierFunction ... ok")) {
        throw "the verifier run did not report exactly 'test $verifierFunction ... ok' (harness reported: $($outcomes -join ' / '))"
    }
    $tallies = @($run.StdOut | Where-Object { $_ -cmatch '^test result: ' })
    if ($tallies.Count -ne 1) { throw "the verifier run printed $($tallies.Count) tallies, expected exactly 1" }
    $tally = [regex]::Match($tallies[0], '^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out')
    if (-not $tally.Success -or -not (Test-OrdinalEqual $tally.Groups[1].Value "ok") -or
        $tally.Groups[2].Value -ne "1" -or $tally.Groups[3].Value -ne "0" -or $tally.Groups[4].Value -ne "0") {
        throw "the verifier run's tally is not exactly one passed test: '$($tallies[0])'"
    }
    Write-Host "verifier test '$verifierFunction' executed: $($tallies[0])"
} finally {
    Remove-Item -LiteralPath $testTarget -Force -ErrorAction SilentlyContinue
}

Write-Host "draft $ReleaseId verified from downloaded bytes: $($actual.Count) assets hashed, latest.json at $version"
