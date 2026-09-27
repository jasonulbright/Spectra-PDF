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

$PipVersion = "26.2.1"
$PipWheel = "pip-$PipVersion-py3-none-any.whl"
$PipSha256 = "71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"
$PipUrl = "https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/$PipWheel"

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
    $archive = Join-Path $env:TEMP "$PipWheel.zip"
    Invoke-DownloadWithRetry -Description $PipWheel -OutFile $archive -Download {
        Invoke-WebRequest -Uri $PipUrl -OutFile $archive -UseBasicParsing -TimeoutSec $DownloadRetryTimeoutSeconds
    }
    $actual = Get-PipWheelSha256 -Path $archive
    if ($actual -ne $PipSha256) {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        throw "$PipWheel has SHA-256 $actual; the pin is $PipSha256"
    }
    New-Item -ItemType Directory -Force $sitePackages | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $sitePackages -Force
    Remove-Item -LiteralPath $archive -Force
    $reported = & $Python -m pip --version 2>&1
    if ($LASTEXITCODE -ne 0 -or ([string]$reported) -notmatch "^pip $([regex]::Escape($PipVersion)) ") {
        throw "pip $PipVersion did not install into ${Python}: $reported"
    }
}
