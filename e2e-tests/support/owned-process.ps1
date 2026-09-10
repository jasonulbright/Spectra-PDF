$ErrorActionPreference = 'Stop'
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
    Add-Type -Path (Join-Path $PSScriptRoot 'owned-process.cs')
    $executable = (Get-Command -Name $request.executable -CommandType Application -ErrorAction Stop).Source
    exit [OwnedProcess]::Run($executable, [string[]]$request.args, [string]$request.ready)
} catch {
    [Console]::Error.WriteLine($_.ToString())
    exit 1
}
