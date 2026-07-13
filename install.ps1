# =====================================================================
# Client Reel Builder — install the panel into Premiere
# =====================================================================
#
# Run once:   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# CEP panels don't get "loaded" by a developer tool the way UXP ones do.
# Premiere scans a fixed folder on disk at startup and shows whatever it
# finds. So there are exactly two things to arrange:
#
#   1. PlayerDebugMode — Premiere refuses to run an extension that Adobe
#      hasn't signed. Ours isn't (signing needs a certificate and is only
#      worth it for public distribution). This registry flag tells Premiere
#      to run unsigned extensions anyway. It's the normal, intended way to
#      develop a panel — not a hack.
#
#   2. A junction (a folder alias) pointing Premiere's extensions folder at
#      this repo. That way Premiere reads the panel straight out of your
#      working copy: edit a file, reopen the panel, see the change. No
#      copying, no "which version is Premiere actually running" confusion.
#      A junction rather than a symlink because junctions don't need admin.
#
# Safe to re-run. It replaces the junction if it already exists and never
# touches the repo itself.
# =====================================================================

$ErrorActionPreference = "Stop"

$extensionId = "com.danharris.reelbuilder"
$repoRoot    = $PSScriptRoot
$cepRoot     = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$target      = Join-Path $cepRoot $extensionId

Write-Host ""
Write-Host "Client Reel Builder — installing" -ForegroundColor Cyan
Write-Host ""

# --- 1. Allow unsigned extensions -------------------------------------
# Premiere 25.6 runs CEP 12, but the version it reads varies by build, so
# set the flag for every CSXS version in the plausible range. Setting one
# that Premiere doesn't use is harmless.
Write-Host "Enabling unsigned extensions (PlayerDebugMode)…" -ForegroundColor White
foreach ($v in 9..12) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String
    Write-Host "  CSXS.$v -> PlayerDebugMode = 1" -ForegroundColor DarkGray
}

# --- 2. Point Premiere's extensions folder at this repo ----------------
Write-Host ""
Write-Host "Linking the panel into Premiere…" -ForegroundColor White

if (-not (Test-Path $cepRoot)) {
    New-Item -ItemType Directory -Path $cepRoot -Force | Out-Null
    Write-Host "  created $cepRoot" -ForegroundColor DarkGray
}

# Clear out whatever's there from a previous run.
if (Test-Path $target) {
    $existing = Get-Item $target -Force
    if ($existing.LinkType) {
        # It's a junction/symlink — remove the link, NOT what it points at.
        [System.IO.Directory]::Delete($target, $false)
        Write-Host "  removed the old link" -ForegroundColor DarkGray
    } else {
        # A real folder. Don't silently delete something we didn't create.
        Write-Host ""
        Write-Host "  A REAL FOLDER already exists at:" -ForegroundColor Yellow
        Write-Host "  $target" -ForegroundColor Yellow
        Write-Host "  That isn't ours. Move or delete it yourself, then re-run." -ForegroundColor Yellow
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
