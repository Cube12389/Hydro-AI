param(
    [string]$Distro = 'Ubuntu-22.04-new'
)

$ErrorActionPreference = 'Stop'

$pkgDir = Split-Path -Parent $PSScriptRoot

function Fail([string]$msg) {
    Write-Host "[fail] $msg" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Fail 'wsl.exe not found. Please install WSL2 first.'
}

# Verify distro and root access
$null = & wsl.exe -d $Distro -u root -e true 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "Cannot enter WSL distro '$Distro' as root. Run 'wsl -l -v' to check the name."
}

# Convert Windows path to WSL path
$abs = (Resolve-Path $pkgDir).Path
$drive = $abs.Substring(0, 1).ToLower()
$rest = $abs.Substring(2).Replace('\', '/')
$wslPath = "/mnt/$drive$rest"

Write-Host '=========================================================='
Write-Host '  Hydro AI Answer Plugin - Auto Deploy'
Write-Host '=========================================================='
Write-Host "  Distro : $Distro"
Write-Host "  Package: $wslPath"
Write-Host '=========================================================='
Write-Host ''

Write-Host '[1/2] Installing plugin, creating bot account, restarting Hydro...'
$script = "$wslPath/deploy/deploy-wsl.sh"
& wsl.exe -d $Distro -u root -e bash $script $wslPath
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Fail 'Deployment failed. See output above.'
}

Write-Host ''
Write-Host '[2/2] Done.'
Write-Host ''
Write-Host 'Config file (inside WSL): /root/.hydro/addons/ai-answer/config.json'
Write-Host 'No restart needed after editing config - the plugin hot-reloads it.'
Write-Host ''
Write-Host 'Tail logs with:'
Write-Host "  wsl -d $Distro -u root -e /root/.nix-profile/bin/pm2 logs hydrooj"
Write-Host ''
