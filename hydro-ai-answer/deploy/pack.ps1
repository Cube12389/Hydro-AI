$ErrorActionPreference = 'Stop'

$pkgDir = Split-Path -Parent $PSScriptRoot
Push-Location $pkgDir
try {
    if (-not (Test-Path 'dist')) { New-Item -ItemType Directory -Path 'dist' | Out-Null }

    $pkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $ver = if ($pkg.version) { $pkg.version } else { '0.0.0' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $out = Join-Path 'dist' "hydro-ai-answer-$ver-$stamp.zip"

    $items = @('index.js', 'package.json', 'config.example.json', 'README.md', 'deploy') |
        Where-Object { Test-Path $_ }

    if (Test-Path $out) { Remove-Item $out -Force }
    Compress-Archive -Path $items -DestinationPath $out -Force

    $f = Get-Item $out
    Write-Host "[ok] $($f.FullName)"
    Write-Host "     size $($f.Length) bytes"

    Write-Host ''
    Write-Host 'Contents:'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($f.FullName)
    $zip.Entries | ForEach-Object { Write-Host "  $($_.FullName)  ($($_.Length) bytes)" }
    $zip.Dispose()
} finally {
    Pop-Location
}
