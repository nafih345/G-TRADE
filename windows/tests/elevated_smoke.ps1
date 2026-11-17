<#
  G-TRADE ERP - elevated installer smoke test (run on a CLEAN Windows 10 22H2 / Windows 11 test PC or VM).
  Needs: an elevated PowerShell, the built installer. Never run on a machine with real customer data.

    powershell -ExecutionPolicy Bypass -File elevated_smoke.ps1 -Installer .\G-TRADE-Setup-1.0.0.exe -Mode standalone

  What it checks: silent install -> 3 Windows services running and set to Automatic -> HTTPS health with
  the pinned CA -> service restart recovery -> (server) firewall rule scoped to Private/LocalSubnet ->
  silent uninstall keeps C:\ProgramData\G-TRADE -> reinstall reuses the same data.
  Writes a JSON evidence file next to this script.
#>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [ValidateSet('standalone', 'server')][string]$Mode = 'standalone',
  [string]$Answers = "$env:TEMP\gtrade-smoke-answers.ini"
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell.'
}
$ev = [ordered]@{ started = (Get-Date).ToString('s'); windows = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + [Environment]::OSVersion.Version; mode = $Mode }
@"
[answers]
company_name=Smoke Test Opticals
branch_name=Main
admin_username=smokeadmin
admin_password=Smoke-Test-Pass-2026!
admin_full_name=Smoke Admin
"@ | Set-Content -Encoding UTF8 $Answers

$p = Start-Process -FilePath $Installer -ArgumentList "/S /MODE=$Mode /ANSWERS=`"$Answers`"" -Wait -PassThru
$ev.install_exit = $p.ExitCode
$ev.answers_file_deleted = -not (Test-Path $Answers)
$svc = 'GTrade-DB', 'GTrade-App', 'GTrade-Web' | ForEach-Object { Get-Service $_ -ErrorAction SilentlyContinue }
$ev.services = $svc | ForEach-Object { @{ name = $_.Name; status = "$($_.Status)"; start = "$($_.StartType)" } }

$ctl = "${env:ProgramFiles}\G-TRADE ERP\resources\server"
$py = "$ctl\runtime\python\python.exe"
$ver = (Get-Content "$env:ProgramData\G-TRADE\config\install.version")
$env:GTRADE_APP_DIR = "$ctl\app\$ver"
$health = & $py -m gtrade_ctl --install-root $ctl health | ConvertFrom-Json
$ev.health_ok = $health.ok

Restart-Service GTrade-App -Force
Start-Sleep 15
$ev.health_after_restart = (& $py -m gtrade_ctl --install-root $ctl health | ConvertFrom-Json).ok
Stop-Process -Name python -Force -ErrorAction SilentlyContinue  # crash; WinSW must restart it
Start-Sleep 25
$ev.health_after_crash = (& $py -m gtrade_ctl --install-root $ctl health | ConvertFrom-Json).ok

if ($Mode -eq 'server') {
  $rule = Get-NetFirewallRule -DisplayName 'G-TRADE ERP HTTPS (LAN)' -ErrorAction SilentlyContinue
  $ev.firewall = @{ present = [bool]$rule; profile = "$($rule.Profile)"; remote = "$(($rule | Get-NetFirewallAddressFilter).RemoteAddress)" }
}
$ev.acl_config = (icacls "$env:ProgramData\G-TRADE\config") -join ' | '

$un = "${env:ProgramFiles}\G-TRADE ERP\Uninstall G-TRADE ERP.exe"
Start-Process -FilePath $un -ArgumentList '/S' -Wait
$ev.services_after_uninstall = ('GTrade-DB', 'GTrade-App', 'GTrade-Web' | Where-Object { Get-Service $_ -ErrorAction SilentlyContinue })
$ev.data_kept_after_uninstall = Test-Path "$env:ProgramData\G-TRADE\pgsql\data\PG_VERSION"

$p = Start-Process -FilePath $Installer -ArgumentList "/S /MODE=$Mode" -Wait -PassThru
$ev.reinstall_exit = $p.ExitCode
$ev.health_after_reinstall = (& $py -m gtrade_ctl --install-root $ctl health | ConvertFrom-Json).ok
$ev.finished = (Get-Date).ToString('s')
$out = Join-Path $PSScriptRoot "elevated-smoke-$Mode-$(Get-Date -Format yyyyMMdd-HHmmss).json"
$ev | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $out
Write-Host "Evidence: $out"
