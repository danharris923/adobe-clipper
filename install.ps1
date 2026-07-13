# =====================================================================
# Client Reel Builder - install the panel into Premiere
# =====================================================================
#
# Run once:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# NOTE: ASCII only, deliberately. Windows PowerShell 5.1 reads a UTF-8 file
# with no BOM as ANSI, so any em-dash or curly quote in here becomes garbage
# bytes and the script fails to parse. Keep it plain.
#
# CEP panels aren't "loaded" by a dev tool the way UXP ones are. Premiere
# scans a fixed folder at startup and shows whatever it finds - much like a
# VST. So there are exactly two things to arrange:
#
#   1. PlayerDebugMode - Premiere refuses to run an extension Adobe hasn't
#      signed. Ours isn't (signing needs a certificate, and is only worth it
#      for public distribution). This registry flag tells Premiere to run
#      unsigned extensions anyway. It's the normal, intended way to develop
#      a panel, not a hack.
#
#   2. A junction (a folder alias) pointing Premiere's extensions folder at
#      this repo, so Premiere reads the panel straight out of the working
#      copy: edit a file, reopen the panel, see the change. No copying, and
#      no confusion about which version Premiere is actually running.
#      A junction rather than a symlink because junctions don't need admin.
#
# Safe to re-run.
# =====================================================================

$ErrorActionPreference = "Stop"

$extensionId = "com.danharris.reelbuilder"
$repoRoot    = $PSScriptRoot
$cepRoot     = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$target      = Join-Path $cepRoot $extensionId

Write-Host ""
Write-Host "Client Reel Builder - installing" -ForegroundColor Cyan
Write-Host ""

# --- 1. Allow unsigned extensions -------------------------------------
# Premiere 25.6 runs CEP 12, but the CSXS version a given build reads varies,
# so set the flag across the plausible range. Setting one Premiere doesn't
# use is harmless.
Write-Host "Enabling unsigned extensions (PlayerDebugMode)..." -ForegroundColor White
foreach ($v in 9..12) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
    Write-Host "  CSXS.$v -> PlayerDebugMode = 1" -ForegroundColor DarkGray
}

# --- 2. Point Premiere's extensions folder at this repo ----------------
Write-Host ""
Write-Host "Linking the panel into Premiere..." -ForegroundColor White

if (-not (Test-Path $cepRoot)) {
    New-Item -ItemType Directory -Path $cepRoot -Force | Out-Null
    Write-Host "  created $cepRoot" -ForegroundColor DarkGray
}

# Clear out whatever a previous run left behind.
if (Test-Path $target) {
    $existing = Get-Item $target -Force
    if ($existing.LinkType) {
        # A junction/symlink: remove the LINK, not what it points at.
        [System.IO.Directory]::Delete($target, $false)
        Write-Host "  removed the old link" -ForegroundColor DarkGray
    }
    else {
        # A real folder. Never silently delete something we didn't create.
        Write-Host ""
        Write-Host "  A REAL FOLDER already exists at:" -ForegroundColor Yellow
        Write-Host "  $target" -ForegroundColor Yellow
        Write-Host "  That is not ours. Move or delete it yourself, then re-run." -ForegroundColor Yellow
        exit 1
    }
}

New-Item -ItemType Junction -Path $target -Value $repoRoot | Out-Null
Write-Host "  $target" -ForegroundColor DarkGray
Write-Host "    -> $repoRoot" -ForegroundColor DarkGray

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "Now:" -ForegroundColor White
Write-Host "  1. Fully quit Premiere Pro (it only scans for panels at startup)"
Write-Host "  2. Start Premiere 25.6 and open a project"
Write-Host "  3. Window -> Extensions -> Client Reel Builder"
Write-Host ""
Write-Host "To see the log: right-click inside the panel -> Inspect." -ForegroundColor DarkGray
Write-Host ""
