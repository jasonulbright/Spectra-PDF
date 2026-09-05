# The name a release asset has ON GitHub, derived from the local file name.
#
# GitHub renames an uploaded asset: every character that is not alphanumeric,
# '.', '-' or '_' is replaced with '.', and leading and trailing '.' are
# removed. `Spectra PDF_1.2.0_x64-setup.exe` is therefore served as
# `Spectra.PDF_1.2.0_x64-setup.exe`, and every consumer that names an asset --
# the draft verifier's set comparison, the SHA256SUMS.txt the public runs
# `sha256sum -c` against, the updater manifest's url -- must name the renamed
# form. This function is the ONE place the rule lives; it is dot-sourced by
# both the workflows' checksum step and scripts/verify-release-draft.ps1.
#
# The transform is idempotent: a name already in GitHub's form maps to itself.
# Comparison at every call site is ordinal; the rule preserves case.

function Get-GitHubAssetName([string]$name) {
    if ([string]::IsNullOrEmpty($name)) { throw "cannot derive a GitHub asset name from an empty name" }
    $mapped = [regex]::Replace($name, '[^A-Za-z0-9._-]', '.')
    $trimmed = $mapped.Trim('.')
    if ($trimmed.Length -eq 0) { throw "'$name' has no GitHub asset name: every character is rewritten away" }
    return $trimmed
}
