# Downloads and configures the embedded Python runtime for SpectraPDF.
# Run once before packaging: powershell -ExecutionPolicy Bypass -File scripts\setup-python-embed.ps1

$PythonVersion = "3.14.5"
$Url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$ZipPath = "$env:TEMP\python-embed.zip"
$DestDir = "$PSScriptRoot\..\resources\python"

# Gate the download on the minor-version-tagged runtime DLL (e.g. python314.dll)
# so changing $PythonVersion re-provisions the embedded runtime.
$parts = $PythonVersion.Split('.')
$PyTag = "$($parts[0])$($parts[1])"
$VersionMarker = "$DestDir\python$PyTag.dll"

Write-Host "Setting up Python $PythonVersion embedded runtime..."

# Download (re-download if the target version's runtime isn't already present)
if (-not (Test-Path $VersionMarker)) {
    Write-Host "Downloading $Url..."
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath
    Write-Host "Extracting to $DestDir..."
    Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $ZipPath -DestinationPath $DestDir -Force
} else {
    Write-Host "Python already present at $DestDir"
}

# Enable site-packages
$pthFile = Get-ChildItem $DestDir -Filter "python*._pth" | Select-Object -First 1
if ($pthFile) {
    @(
        ($pthFile.BaseName -replace '\._pth$','') + ".zip"
        "."
        "Lib\site-packages"
        "import site"
    ) | Set-Content $pthFile.FullName -Encoding ASCII
    Write-Host "Enabled site-packages in $($pthFile.Name)"
}

# Install pip
Write-Host "Installing pip..."
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile "$env:TEMP\get-pip.py"
& $DestDir\python.exe "$env:TEMP\get-pip.py" --no-warn-script-location 2>&1 | Out-Null

# Install dependencies (pinned versions — update deliberately, not automatically)
$PikepdfVersion = "10.7.2"
$PdfminerVersion = "20260107"
# pyHanko powers digital-signature verification; it pulls cryptography,
# asn1crypto, and pyhanko-certvalidator (all permissive). See
# docs/architecture/10-phase2h-signatures.md.
$PyhankoVersion = "0.35.2"
Write-Host "Installing pikepdf==$PikepdfVersion, pdfminer.six==$PdfminerVersion, pyHanko==$PyhankoVersion..."
& $DestDir\python.exe -m pip install "pikepdf==$PikepdfVersion" "pdfminer.six==$PdfminerVersion" "pyHanko==$PyhankoVersion" --no-warn-script-location 2>&1 | Out-Null

# Cleanup — remove pip, caches, metadata
Write-Host "Cleaning up..."
& $DestDir\python.exe -m pip uninstall pip -y 2>&1 | Out-Null
Get-ChildItem $DestDir -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Get-ChildItem $DestDir -Recurse -Directory -Filter "*.dist-info" | Remove-Item -Recurse -Force
Get-ChildItem $DestDir -Recurse -Directory -Filter "tests" | Remove-Item -Recurse -Force
Remove-Item "$DestDir\Scripts" -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Embedded Python: ${sizeMB}MB"
