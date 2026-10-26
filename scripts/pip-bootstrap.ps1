# Installs one pinned pip into an interpreter that has none (the embeddable
# CPython package ships without ensurepip). Dot-source it:
#   . (Join-Path $PSScriptRoot "pip-bootstrap.ps1")
#
# pip is fetched as its release wheel and refused unless the bytes match the
# SHA-256 below; nothing executes before that check. A wheel is a zip of the
# installed layout, so unpacking it into site-packages IS the install, and its
# RECORD lets `pip uninstall pip` remove it again. pip run from the wheel path
# refuses to install itself on Windows, so the unpack is the bootstrap.

. (Join-Path $PSScriptRoot "download-retry.ps1")

$PipVersion = "26.2.2"
$PipWheel = "pip-$PipVersion-py3-none-any.whl"
$PipSha256 = "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
$PipUrl = "https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/$PipWheel"

function Get-PipWheelSha256([string]$Path) {
    # Use .NET directly: the isolated Windows PowerShell image may not expose
    # Microsoft.PowerShell.Utility's optional Get-FileHash command.
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = $null
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        $digest = $algorithm.ComputeHash($stream)
        return [System.BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant()
    } finally {
        $stream.Dispose()
        if ($algorithm) { $algorithm.Dispose() }
    }
}

function Install-PinnedPip {
    param([Parameter(Mandatory)][string]$Python)
    $pythonHome = Split-Path -Parent $Python
    $sitePackages = Join-Path $pythonHome "Lib\site-packages"
    # Expand-Archive in Windows PowerShell 5.1 accepts only a .zip extension.
    # A per-run name: concurrent bootstraps sharing TEMP would otherwise
    # replace each other's archive between the hash check and the expand.
    $archive = Join-Path $env:TEMP "$PipWheel.$([guid]::NewGuid().ToString('N')).zip"
    try {
        Invoke-DownloadWithRetry -Uri $PipUrl -Description $PipWheel -OutFile $archive
        $actual = Get-PipWheelSha256 -Path $archive
        if ($actual -ne $PipSha256) {
            throw "$PipWheel has SHA-256 $actual; the pin is $PipSha256"
        }
        New-Item -ItemType Directory -Force $sitePackages | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $sitePackages -Force
    } finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
    $reported = & $Python -m pip --version 2>&1
    if ($LASTEXITCODE -ne 0 -or ([string]$reported) -notmatch "^pip $([regex]::Escape($PipVersion)) ") {
        throw "pip $PipVersion did not install into ${Python}: $reported"
    }
}
