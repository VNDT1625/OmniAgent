# MTUI one-line installer for Windows (PowerShell)
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"
$Version = "0.1.0"
$Repo = "AionUi/MTUI"
$Arch = if ([Environment]::Is64BitOperatingSystem) { "x86_64" } else { "x86" }
$Platform = "pc-windows-msvc"
$Binary = "mtui.exe"
$InstallDir = "$env:LOCALAPPDATA\mtui"
$VersionStamp = "$Version-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$VersionDir = Join-Path $InstallDir "versions\$VersionStamp"
$LatestFile = Join-Path $InstallDir "latest.json"
$PrimaryBinaryUpdated = $false

Write-Host "Installing MTUI v$Version..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $VersionDir | Out-Null

function Install-Binary {
    param([string]$SourcePath, [string]$Message, [ConsoleColor]$Color)

    Copy-Item $SourcePath $VersionDir -Force
    try {
        Copy-Item $SourcePath $InstallDir -Force
        $script:PrimaryBinaryUpdated = $true
        Write-Host "  $Message" -ForegroundColor $Color
    } catch [System.IO.IOException] {
        $script:PrimaryBinaryUpdated = $false
        Write-Host "  Installed to $VersionDir because the primary mtui.exe is currently in use" -ForegroundColor Yellow
    }
}

# Build from source, use an existing local binary, or download binary.
$SourcePath = Join-Path $PSScriptRoot "target\release\$Binary"
$DebugSourcePath = Join-Path $PSScriptRoot "target\debug\$Binary"
if ($env:MTUI_SOURCE_PATH -and (Test-Path $env:MTUI_SOURCE_PATH)) {
    Install-Binary $env:MTUI_SOURCE_PATH "Installed from MTUI_SOURCE_PATH" Green
} elseif (Test-Path $SourcePath) {
    Install-Binary $SourcePath "Installed from local build" Green
} elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "  Building release binary from source..."
    Push-Location $PSScriptRoot
    try {
        cargo build --release
    } finally {
        Pop-Location
    }
    Install-Binary $SourcePath "Installed from newly built release" Green
} elseif (Test-Path $DebugSourcePath) {
    Install-Binary $DebugSourcePath "Installed from existing debug build" Yellow
} else {
    $Url = "https://github.com/$Repo/releases/download/v$Version/mtui-$Arch-$Platform.zip"
    Write-Host "  Downloading from $Url..."
    # Uncomment when releases are published:
    # Invoke-WebRequest -Uri $Url -OutFile "$env:TEMP\mtui.zip"
    # Expand-Archive "$env:TEMP\mtui.zip" $InstallDir
    Write-Host "  (Download support will be available with first GitHub release)" -ForegroundColor Yellow
    Write-Host "  Build from source: cd packages/mtui && cargo build --release" -ForegroundColor Yellow
    exit 1
}

# Record the newest versioned binary for app/agent diagnostics.
$Latest = @{
    version = $Version
    versionStamp = $VersionStamp
    versionDir = $VersionDir
    binary = (Join-Path $VersionDir $Binary)
    installedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
}
$Latest | ConvertTo-Json -Depth 3 | Set-Content -Path $LatestFile -Encoding UTF8

# Keep only the most recent versioned installs to avoid PATH/cache clutter.
$VersionsRoot = Join-Path $InstallDir "versions"
Get-ChildItem -Path $VersionsRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -Skip 5 |
    ForEach-Object {
        try {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        } catch {
            Write-Host "  Could not remove old version $($_.FullName): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

# Add to PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$VersionRootPrefix = (Join-Path $InstallDir "versions").TrimEnd('\') + '\'
$PathParts = @($UserPath -split ';' | Where-Object {
    $_ -and
    $_ -ne $InstallDir -and
    $_ -ne $VersionDir -and
    -not ($_.StartsWith($VersionRootPrefix, [System.StringComparison]::OrdinalIgnoreCase))
})
if ($PrimaryBinaryUpdated) {
    $PathParts = @($InstallDir) + $PathParts
    Write-Host "  Set MTUI primary install directory first in user PATH" -ForegroundColor Green
} else {
    $PathParts = @($VersionDir, $InstallDir) + $PathParts
    Write-Host "  Set latest version directory first in user PATH until primary mtui.exe can be replaced" -ForegroundColor Yellow
}
[Environment]::SetEnvironmentVariable("Path", ($PathParts -join ';'), "User")

Write-Host "MTUI installed. Run 'mtui --help' to get started." -ForegroundColor Cyan
