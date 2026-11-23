# G-OPTICALS - create the vendor licence signing key on the OWNER's installation (this PC only),
# make its encrypted GTKB1 backup, and verify a backup copy (e.g. one downloaded from Google Drive).
#
#   Check first (creates nothing):
#     powershell -ExecutionPolicy Bypass -File "D:\G OPTICALS\windows\tooling\provision_vendor_key.ps1" -CheckOnly
#   Create the key + backup (PowerShell opened with "Run as administrator"):
#     powershell -ExecutionPolicy Bypass -File "D:\G OPTICALS\windows\tooling\provision_vendor_key.ps1"
#   Only (re)make the backup of the existing key (administrator; never touches the key):
#     powershell -ExecutionPolicy Bypass -File "D:\G OPTICALS\windows\tooling\provision_vendor_key.ps1" -ExportOnly
#   Verify a downloaded backup copy (administrator; writes nothing):
#     powershell -ExecutionPolicy Bypass -File "D:\G OPTICALS\windows\tooling\provision_vendor_key.ps1" -VerifyBackup "C:\Users\<you>\Downloads\gtl-vendor-2026a.gtkb"
#
# Python: the INSTALLED G-TRADE production runtime (the same embedded Python 3.12 + cryptography the
# G-TRADE service runs), never a developer environment. That runtime's python312._pth ignores
# PYTHONPATH, so the repository's gtrade_ctl (which has the `vendor-key` command; the installed 1.0.0
# copy does not yet) is put on sys.path explicitly - the same way gtrade-ctl.cmd loads the installed one.
#
# What it does (nothing else):
#   1. creates a NEW Ed25519 key inside the installed G-TRADE data folder:
#      C:\ProgramData\G-TRADE\config\license\vendor-signing.dpapi
#      (DPAPI machine-encrypted, readable only by SYSTEM, Administrators and the G-TRADE app service).
#      It refuses if a key already exists - an existing key is never replaced.
#   2. writes a GTKB1 backup (scrypt N=2^17,r=8,p=1 + AES-256-GCM, authenticated header) to a local
#      folder, after decrypting it again in memory and checking it restores this exact key. The
#      passphrase is typed twice in a hidden prompt (16+ characters) and is never stored or printed.
#      Nothing is uploaded: you upload that one .gtkb file to Google Drive yourself.
#   3. writes ONLY the public information (key id, public key, proof) to
#      D:\G OPTICALS\windows\out\vendor_public_key.json - safe to share; it is what the release build
#      embeds so customer installations trust your licences.
# The private key is never printed, never copied into the repository and never put in an installer.

param(
  [string]$KeyId = 'gtl-vendor-2026a',
  [string]$InstallRoot = 'C:\Program Files\G-TRADE\resources\server',
  [string]$DataRoot = 'C:\ProgramData\G-TRADE',
  # Not Documents: on many PCs Documents is synced to OneDrive, which would upload the backup by itself.
  [string]$BackupFolder = (Join-Path $env:USERPROFILE 'G-OPTICALS-key-backup'),
  [string]$VerifyBackup = '',
  [switch]$ExportOnly,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoWindows = Split-Path -Parent $PSScriptRoot
$python = Join-Path $InstallRoot 'runtime\python\python.exe'
$outFile = Join-Path $repoWindows 'out\vendor_public_key.json'
$env:GTRADE_REPO_WINDOWS = $repoWindows
# Runs the repository's gtrade_ctl with the installed runtime (sys.path set here, not PYTHONPATH).
$boot = "import os,runpy,sys;sys.path.insert(0,os.environ['GTRADE_REPO_WINDOWS']);sys.argv=['gtrade-ctl']+sys.argv[1:];runpy.run_module('gtrade_ctl',run_name='__main__')"

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 2 }
# Nothing may be uploaded automatically: refuse folders that a cloud client syncs on its own.
function Test-SyncedFolder($path) {
  $full = [IO.Path]::GetFullPath($path).TrimEnd('\') + '\'
  $roots = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ }
  foreach ($r in $roots) { if ($full.StartsWith(([IO.Path]::GetFullPath($r).TrimEnd('\') + '\'), 'OrdinalIgnoreCase')) { return $true } }
  return ($full -match '\\(OneDrive[^\\]*|Google Drive|My Drive|GoogleDrive|Dropbox|iCloudDrive)\\')
}
if (Test-SyncedFolder $BackupFolder) {
  Fail "Backup folder $BackupFolder is synced to the cloud automatically (OneDrive / Google Drive / Dropbox). Choose a local folder with -BackupFolder; you upload the file to Google Drive yourself."
}
function Ctl { & $python -c $boot --install-root $InstallRoot --data-root $DataRoot vendor-key @args }

# ---- pre-flight (nothing is created here) ----------------------------------------------------------
if (-not (Test-Path $python)) { Fail "G-TRADE runtime not found at $python" }
if (-not (Test-Path (Join-Path $InstallRoot 'app\current.json'))) { Fail "Not a G-TRADE install root: $InstallRoot" }
if (-not (Test-Path (Join-Path $repoWindows 'gtrade_ctl\vendor_key.py'))) { Fail "gtrade_ctl\vendor_key.py missing under $repoWindows" }
$probe = "import os,sys;sys.path.insert(0,os.environ['GTRADE_REPO_WINDOWS']);import cryptography,gtrade_ctl.vendor_key as v;from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey;from cryptography.hazmat.primitives.kdf.scrypt import Scrypt;from cryptography.hazmat.primitives.ciphers.aead import AESGCM;assert sys.version_info[:2]==(3,12);assert v.BACKUP_FORMAT=='GTKB1';print(sys.version.split()[0]+' | cryptography '+cryptography.__version__+' | Ed25519, scrypt, AES-GCM available | backup '+v.BACKUP_FORMAT+' | gtrade_ctl '+os.path.dirname(v.__file__))"
$info = & $python -c $probe
if ($LASTEXITCODE -ne 0) { Fail 'The installed runtime failed the checks (Python 3.12, cryptography, Ed25519, scrypt, AES-GCM, gtrade_ctl).' }
Write-Host "Runtime: $python"
Write-Host "         $info"
$keyFile = Join-Path $DataRoot 'config\license\vendor-signing.dpapi'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$keyExists = $false
if ($elevated) {
  $keyExists = Test-Path $keyFile
  if ($keyExists) { Write-Host "A vendor key already exists: $keyFile (it is never replaced)." -ForegroundColor Yellow }
  else { Write-Host "No vendor key exists yet: $keyFile" }
} else {
  Write-Host 'Not elevated: the data folder check, key creation and backup verification need "Run as administrator".' -ForegroundColor Yellow
}
Write-Host "Backup folder: $BackupFolder (local only; you upload the .gtkb file to Google Drive yourself)"
if ($CheckOnly) { Write-Host 'Check only: nothing was created.' -ForegroundColor Green; exit 0 }
if (-not $elevated) { Fail 'Run this from PowerShell opened with "Run as administrator".' }

# ---- verify a backup copy (writes nothing) -------------------------------------------------------
if ($VerifyBackup) {
  if (-not (Test-Path $VerifyBackup)) { Fail "Backup file not found: $VerifyBackup" }
  Write-Host 'Enter the backup passphrase (hidden). The key is decrypted in memory only.'
  Ctl verify-backup --file $VerifyBackup
  exit $LASTEXITCODE
}

# ---- backup of the existing key only --------------------------------------------------------------
function Export-Backup {
  New-Item -ItemType Directory -Force $BackupFolder | Out-Null
  $backup = Join-Path $BackupFolder "$KeyId.gtkb"
  if (Test-Path $backup) { Fail "$backup already exists (never overwritten). Move it away or pass -BackupFolder <other folder>." }
  Write-Host ''
  Write-Host 'Choose a backup passphrase: 16+ characters, ideally 5-6 random words. Type it twice (hidden).'
  Write-Host 'Keep it in a password manager or on paper - NEVER in Google Drive, Gmail, Keep or a file on this PC.'
  Ctl export --out $backup
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Backup NOT written. Fix the problem shown above, then run this script again with -ExportOnly.' -ForegroundColor Yellow
    exit $LASTEXITCODE
  }
  Write-Host ''
  Write-Host "Backup written and verified: $backup" -ForegroundColor Green
  Write-Host 'Now, by hand:' -ForegroundColor Cyan
  Write-Host "  1. Upload $backup to Google Drive (browser, drag and drop). Google account with 2-Step Verification." -ForegroundColor Cyan
  Write-Host '  2. Download it back to another folder and run this script with -VerifyBackup "<downloaded file>".' -ForegroundColor Cyan
  Write-Host '  3. Delete the local copy in Documents if you wish (a copy on this PC does not help if the PC is lost).' -ForegroundColor Cyan
}
if ($ExportOnly) {
  if (-not $keyExists) { Fail "No vendor key exists yet ($keyFile); run the script without -ExportOnly first." }
  Export-Backup
  exit 0
}

# ---- create the key ------------------------------------------------------------------------------
if ($keyExists) { Fail "A vendor key already exists ($keyFile). Nothing was changed. Use -VerifyBackup to check a backup." }
Write-Host "Creating vendor signing key $KeyId in $DataRoot ..."
$json = Ctl generate --key-id $KeyId
if ($LASTEXITCODE -ne 0) { Write-Host $json -ForegroundColor Red; exit $LASTEXITCODE }
New-Item -ItemType Directory -Force (Split-Path -Parent $outFile) | Out-Null
$json | Out-File -Encoding utf8 $outFile
Write-Host "Public key information written to $outFile" -ForegroundColor Green

# ---- encrypted backup (GTKB1) ---------------------------------------------------------------------
Export-Backup
Write-Host '  4. Tell Claude the key is created (it reads windows\out\vendor_public_key.json) to build the final installer.' -ForegroundColor Cyan
