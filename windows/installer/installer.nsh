; G OPTICALS (internal id G-TRADE) - NSIS customisation for electron-builder (perMachine, assisted installer).
;
; Rule: this script only COLLECTS choices and CALLS gtrade-ctl. All installation logic (database,
; secrets, certificates, services, firewall, company/admin, backups, updates) lives in
; windows/gtrade_ctl and is tested there.
;
; Pages added after "Choose install location":
;   1. Installation mode    Standalone / LAN Server / LAN Workstation (locked on upgrade/repair)
;   2a. Server settings     data folder + HTTPS port              (Standalone, LAN Server; new installs)
;   2b. Connect to server   server address + pairing code         (LAN Workstation)
;   3. Company + admin      company, branch, admin user/password  (Standalone, LAN Server; new installs)
; Uninstall adds an options page: business data is KEPT unless the box is ticked AND the company
; name is typed exactly. Silent uninstall (/S) always keeps data.
;
; Silent install: G-TRADE-Setup.exe /S /MODE=standalone|server|workstation [/DATA=dir] [/PORT=8443]
;                 [/ANSWERS=answers.ini] [/SERVER=host:port /PAIRCODE=XXXX-XXXX]

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
!include "WinVer.nsh"

; Business data folder: %ProgramData%\G-TRADE (normally C:\ProgramData\G-TRADE). The folder name is
; an internal identifier kept for upgrade compatibility - do not rename it with the product brand.
; NSIS has NO "$COMMONPROGRAMDATA" constant: an unknown $NAME is kept as literal text (only a build
; warning), which made the data root the relative path "$COMMONPROGRAMDATA\G-TRADE" -> resolved under
; Program Files -> gtrade-ctl refused it (error 2). windows/tests/test_installer_nsh.py now fails the
; build on any undeclared variable/constant in this file.
!define GT_DATA_DIRNAME "G-TRADE"
; ${APP_EXECUTABLE_FILENAME} is defined by electron-builder's common.nsh, which is included AFTER this
; file: never !define it here ("already defined" aborts the build). Macros expand it when inserted.
; Stop order (Web -> App -> DB). A test harness overrides this with names that do not exist.
!ifndef GT_SERVICES
  !define GT_SERVICES "'GTrade-Web','GTrade-App','GTrade-DB'"
!endif
!ifndef GT_STOP_WAIT
  !define GT_STOP_WAIT 60
!endif

; ---------------- stopping a running installation (upgrade / uninstall) ----------------
; electron-builder's default "app running" check force-kills EVERY process whose path is under
; $INSTDIR. PostgreSQL runs from $INSTDIR\resources\server\runtime\pgsql\bin, so on 2026-11-13 it
; was hard-killed mid-upgrade (crash recovery in the PG log), SCM's restart then found pg_ctl.exe
; already deleted ("The system cannot find the file specified") and the update's pre-checks hit a
; dead port 5544. Instead: close only the desktop window, stop the services through SCM (PostgreSQL
; then does a clean shutdown), wait for everything under resources\server to exit, and NEVER kill
; postgres.exe - if it is still alive, setup stops before changing anything.
; Result in $0: 0 = stopped, 3 = PostgreSQL still running, anything else = could not check.
!macro gtStopServer
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$e='SilentlyContinue';$$r='$INSTDIR';gcim Win32_Process|?{$$_.Path -ieq ($$r+'\${APP_EXECUTABLE_FILENAME}')}|%{Stop-Process -Id $$_.ProcessId -Force -EA $$e};foreach($$n in ${GT_SERVICES}){$$s=Get-Service -Name $$n -EA $$e;if($$s -and $$s.Status -ne 'Stopped'){Stop-Service -Name $$n -Force -EA $$e;try{$$s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(180))}catch{}}};exit 0"`
  Pop $0
  ${If} $0 == 0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$r='$INSTDIR\resources\server\';$$t=(Get-Date).AddSeconds(${GT_STOP_WAIT});do{$$p=@(gcim Win32_Process|?{$$_.Path -and $$_.Path.StartsWith($$r,'CurrentCultureIgnoreCase')});if(!$$p.Count){exit 0};Start-Sleep 2}while((Get-Date) -lt $$t);if(@($$p|?{$$_.Name -ieq 'postgres.exe'}).Count){exit 3};$$p|%{Stop-Process -Id $$_.ProcessId -Force};exit 0"`
    Pop $0
  ${EndIf}
!macroend

!macro customCheckAppRunning
  DetailPrint "G OPTICALS: stopping the application and database safely..."
  !insertmacro gtStopServer
  ${If} $0 == 3
    MessageBox MB_ICONSTOP "The G OPTICALS database is still running and could not be stopped safely.$\r$\nNothing has been changed. Restart this PC and run setup again." /SD IDOK
    Quit
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "Setup could not stop the G OPTICALS services safely (error $0).$\r$\nNothing has been changed. Restart this PC and run setup again." /SD IDOK
    Quit
  ${EndIf}
!macroend

; Sets $GtDataRoot to the default data folder (absolute). ProgramData env var first; in the
; all-users shell context $APPDATA is the same folder (CSIDL_COMMON_APPDATA).
!macro gtDefaultDataRoot
  ReadEnvStr $GtDataRoot "ProgramData"
  ${If} $GtDataRoot == ""
    SetShellVarContext all
    StrCpy $GtDataRoot "$APPDATA"
  ${EndIf}
  StrCpy $GtDataRoot "$GtDataRoot\${GT_DATA_DIRNAME}"
!macroend

Var GtMode
Var GtUpgrade
Var GtDataRoot
Var GtPort
Var GtServer
Var GtCode
Var GtCompany
Var GtBranch
Var GtAdminUser
Var GtAdminName
Var GtAdminEmail
Var GtAdminPass
Var GtAdminPass2
Var GtAnswers
Var GtPrevApp
; dialog controls
Var GtDlg
Var GtC1
Var GtC2
Var GtC3
Var GtC4
Var GtC5
Var GtC6
Var GtC7
Var GtC8

!macro gtReadMode
  StrCpy $GtUpgrade "0"
  !insertmacro gtDefaultDataRoot
  IfFileExists "$GtDataRoot\config\install.mode" 0 +4
    FileOpen $0 "$GtDataRoot\config\install.mode" r
    FileRead $0 $GtMode
    FileClose $0
  ; Upgrade/repair (mode locked, setup pages skipped) only for a COMPLETED installation. A server
  ; install that stopped part-way (install.mode is written by its first step) has no install.complete:
  ; it goes through the full wizard again and gtrade-ctl install resumes it, so the company and
  ; administrator are still created. A workstation writes install.mode only after pairing succeeded.
  ${If} $GtMode == "workstation"
    StrCpy $GtUpgrade "1"
  ${ElseIf} $GtMode != ""
    ${If} ${FileExists} "$GtDataRoot\config\install.complete"
      StrCpy $GtUpgrade "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  SetShellVarContext all
  StrCpy $GtMode ""
  StrCpy $GtPort "8443"
  !insertmacro gtReadMode
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/MODE=" $R1
  ${IfNot} ${Errors}
    ${If} $GtUpgrade == "1"
    ${AndIf} $R1 != $GtMode
      MessageBox MB_ICONSTOP "This computer is already installed as '$GtMode'. The installation mode cannot be changed by reinstalling." /SD IDOK
      Abort
    ${EndIf}
    StrCpy $GtMode $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/DATA=" $R1
  ${IfNot} ${Errors}
    StrCpy $GtDataRoot $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/PORT=" $R1
  ${IfNot} ${Errors}
    StrCpy $GtPort $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/SERVER=" $GtServer
  ClearErrors
  ${GetOptions} $R0 "/PAIRCODE=" $GtCode
  ClearErrors
  ${GetOptions} $R0 "/ANSWERS=" $GtAnswers
  ${If} $GtMode == ""
    StrCpy $GtMode "standalone"
  ${EndIf}
  ; Keep the running version's application code so a failed update can roll back to it
  ; (electron-builder removes the old program files before copying the new ones).
  StrCpy $GtPrevApp ""
  ${If} $GtUpgrade == "1"
    IfFileExists "$GtDataRoot\config\install.version" 0 gtNoPrev
      FileOpen $0 "$GtDataRoot\config\install.version" r
      FileRead $0 $1
      FileClose $0
      IfFileExists "$INSTDIR\resources\server\app\$1\backend\manage.py" 0 gtNoPrev
        ; Refresh the rollback copy ONLY from a build gtrade-ctl proved healthy (config\verified-build
        ; == app\<v>\BUILD_ID). After a failed update Program Files holds the new, never-migrated code;
        ; copying it over the snapshot would destroy the only code that matches the database.
        StrCpy $R2 ""
        StrCpy $R3 ""
        IfFileExists "$INSTDIR\resources\server\app\$1\BUILD_ID" 0 +4
          FileOpen $0 "$INSTDIR\resources\server\app\$1\BUILD_ID" r
          FileRead $0 $R2
          FileClose $0
        IfFileExists "$GtDataRoot\config\verified-build" 0 +4
          FileOpen $0 "$GtDataRoot\config\verified-build" r
          FileRead $0 $R3
          FileClose $0
        ${If} ${FileExists} "$GtDataRoot\rollback\app-$1\backend\manage.py"
          ${If} $R2 == ""
          ${OrIf} $R2 != $R3
            StrCpy $GtPrevApp "$GtDataRoot\rollback\app-$1"
            Goto gtNoPrev
          ${EndIf}
        ${EndIf}
        CreateDirectory "$GtDataRoot\rollback"
        RMDir /r "$GtDataRoot\rollback\app-$1"
        CopyFiles /SILENT "$INSTDIR\resources\server\app\$1" "$GtDataRoot\rollback\app-$1"
        StrCpy $GtPrevApp "$GtDataRoot\rollback\app-$1"
    gtNoPrev:
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER

; System requirements, checked BEFORE any file is copied (gtrade-ctl preflight repeats them, plus the
; port and administrator checks, as the authoritative gate). Thresholds mirror
; windows/gtrade_ctl/installer_cmds.py: MIN_BUILD 19045, MIN_RAM_BLOCK 4 GB, MIN_RAM_WARN 8 GB,
; MIN_DISK_SERVER 10 GB.
;
; gtProbeSystem sets $R7 = Windows build, $R8 = total physical RAM in MB (GlobalMemoryStatusEx, as
; gtrade-ctl reads it), $R9 = free MB on the data folder's drive ("" for a UNC path or when unknown).
; windows/tests/test_installer_nsh.py runs this macro and compares the values with Python's.
!macro gtProbeSystem
  ${WinVerGetBuild} $R7
  System::Call "*(i 64, i, l, l, l, l, l, l, l)p.r1"
  System::Call "Kernel32::GlobalMemoryStatusEx(p r1)"
  System::Call "*$1(i, i, l.r2)"
  System::Free $1
  System::Int64Op $2 / 1048576
  Pop $R8
  StrCpy $R9 ""
  StrCpy $3 $GtDataRoot 2 1
  ${If} $3 == ":\"
    StrCpy $3 $GtDataRoot 3
    ClearErrors
    ${DriveSpace} "$3" "/D=F /S=M" $0
    ${IfNot} ${Errors}
      StrCpy $R9 $0
    ${EndIf}
  ${EndIf}
!macroend

!macro gtCheckRequirements
  !insertmacro gtProbeSystem
  ${If} $R7 < 19045
    MessageBox MB_ICONSTOP "G OPTICALS needs Windows 10 22H2 (build 19045) or newer. This PC is build $R7."
    Abort
  ${EndIf}
  ${If} $R8 < 4096
    MessageBox MB_ICONSTOP "G OPTICALS needs at least 4 GB of RAM for a server or single-PC installation. This PC has $R8 MB."
    Abort
  ${ElseIf} $R8 < 8192
    MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "This PC has less than 8 GB of RAM ($R8 MB). G OPTICALS will work but may be slow under load.$\r$\n$\r$\nContinue?" IDOK gtRamOk
    Abort
    gtRamOk:
  ${EndIf}
  ${If} $R9 != ""
  ${AndIf} $R9 < 10240
    MessageBox MB_ICONSTOP "At least 10 GB of free disk space is needed on the data folder's drive. Free space: $R9 MB."
    Abort
  ${EndIf}
!macroend

Function gtModePageCreate
  ${If} $GtUpgrade == "1"
    Abort ; mode is fixed on upgrade / repair
  ${EndIf}
  nsDialogs::Create 1018
  Pop $GtDlg
  ${NSD_CreateLabel} 0 0 100% 24u "How will this computer be used?"
  Pop $0
  ${NSD_CreateRadioButton} 0 28u 100% 12u "Standalone - one PC with its own database (single shop counter)"
  Pop $GtC1
  ${NSD_CreateRadioButton} 0 48u 100% 12u "LAN Server - holds the shop's database; other PCs connect to it"
  Pop $GtC2
  ${NSD_CreateRadioButton} 0 68u 100% 12u "LAN Workstation - connects to an existing G OPTICALS server (no database here)"
  Pop $GtC3
  ${NSD_CreateLabel} 0 92u 100% 36u "Install the LAN Server first. Each workstation then needs the server address and pairing code printed on the server's connection sheet."
  Pop $0
  ${If} $GtMode == "server"
    ${NSD_Check} $GtC2
  ${ElseIf} $GtMode == "workstation"
    ${NSD_Check} $GtC3
  ${Else}
    ${NSD_Check} $GtC1
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function gtModePageLeave
  ${NSD_GetState} $GtC2 $0
  ${NSD_GetState} $GtC3 $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $GtMode "server"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $GtMode "workstation"
  ${Else}
    StrCpy $GtMode "standalone"
  ${EndIf}
FunctionEnd

Function gtServerPageCreate
  ${If} $GtMode == "workstation"
  ${OrIf} $GtUpgrade == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $GtDlg
  ${NSD_CreateLabel} 0 0 100% 20u "Business data folder (database, documents, backups). It is kept when G OPTICALS is uninstalled or updated."
  Pop $0
  ${NSD_CreateText} 0 22u 100% 12u "$GtDataRoot"
  Pop $GtC1
  ${NSD_CreateLabel} 0 44u 100% 10u "Secure (HTTPS) port"
  Pop $0
  ${NSD_CreateNumber} 0 56u 60u 12u "$GtPort"
  Pop $GtC2
  ${If} $GtMode == "server"
    ${NSD_CreateLabel} 0 80u 100% 40u "A Windows Firewall rule will allow this port from the local network only (Private profile). The connection sheet for workstations is shown at the end of setup."
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function gtServerPageLeave
  ${NSD_GetText} $GtC1 $GtDataRoot
  ${NSD_GetText} $GtC2 $GtPort
  ${If} $GtDataRoot == ""
    MessageBox MB_ICONEXCLAMATION "Choose a data folder."
    Abort
  ${EndIf}
  ; Must be a full path (C:\... or \\server\...): a relative path would resolve under Program Files.
  StrCpy $0 $GtDataRoot 2 1
  StrCpy $1 $GtDataRoot 2
  ${If} $0 != ":\"
  ${AndIf} $1 != "\\"
    MessageBox MB_ICONEXCLAMATION "Enter a full folder path, for example C:\ProgramData\G-TRADE."
    Abort
  ${EndIf}
  ${If} $GtPort < 1024
  ${OrIf} $GtPort > 65535
    MessageBox MB_ICONEXCLAMATION "Choose a port between 1024 and 65535."
    Abort
  ${EndIf}
  !insertmacro gtCheckRequirements
FunctionEnd


Function gtConnectPageCreate
  ${If} $GtMode != "workstation"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $GtDlg
  ${NSD_CreateLabel} 0 0 100% 20u "Enter the server address and pairing code from the G OPTICALS server's connection sheet."
  Pop $0
  ${NSD_CreateLabel} 0 24u 100% 10u "Server address (for example SHOP-SERVER or 192.168.1.20:8443)"
  Pop $0
  ${NSD_CreateText} 0 36u 100% 12u "$GtServer"
  Pop $GtC1
  ${NSD_CreateLabel} 0 56u 100% 10u "Pairing code (for example 7Q4K-29AB)"
  Pop $0
  ${NSD_CreateText} 0 68u 80u 12u "$GtCode"
  Pop $GtC2
  nsDialogs::Show
FunctionEnd

Function gtConnectPageLeave
  ${NSD_GetText} $GtC1 $GtServer
  ${NSD_GetText} $GtC2 $GtCode
  ${If} $GtServer == ""
  ${OrIf} $GtCode == ""
    MessageBox MB_ICONEXCLAMATION "Enter both the server address and the pairing code."
    Abort
  ${EndIf}
FunctionEnd

Function gtAdminPageCreate
  ${If} $GtMode == "workstation"
  ${OrIf} $GtUpgrade == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $GtDlg
  ${NSD_CreateLabel} 0 0 50% 10u "Company name"
  Pop $0
  ${NSD_CreateText} 0 11u 48% 12u "$GtCompany"
  Pop $GtC1
  ${NSD_CreateLabel} 52% 0 48% 10u "First branch"
  Pop $0
  ${NSD_CreateText} 52% 11u 48% 12u "$GtBranch"
  Pop $GtC2
  ${NSD_CreateLabel} 0 30u 50% 10u "Administrator full name"
  Pop $0
  ${NSD_CreateText} 0 41u 48% 12u "$GtAdminName"
  Pop $GtC3
  ${NSD_CreateLabel} 52% 30u 48% 10u "Administrator e-mail (recovery)"
  Pop $0
  ${NSD_CreateText} 52% 41u 48% 12u "$GtAdminEmail"
  Pop $GtC4
  ${NSD_CreateLabel} 0 60u 50% 10u "Administrator user name"
  Pop $0
  ${NSD_CreateText} 0 71u 48% 12u "$GtAdminUser"
  Pop $GtC5
  ${NSD_CreateLabel} 0 90u 50% 10u "Password (10+ characters)"
  Pop $0
  ${NSD_CreatePassword} 0 101u 48% 12u ""
  Pop $GtC6
  ${NSD_CreateLabel} 52% 90u 48% 10u "Confirm password"
  Pop $0
  ${NSD_CreatePassword} 52% 101u 48% 12u ""
  Pop $GtC7
  ${NSD_CreateLabel} 0 120u 100% 20u "This becomes the shop's main administrator. The password is never stored in plain text."
  Pop $GtC8
  nsDialogs::Show
FunctionEnd

Function gtAdminPageLeave
  ${NSD_GetText} $GtC1 $GtCompany
  ${NSD_GetText} $GtC2 $GtBranch
  ${NSD_GetText} $GtC3 $GtAdminName
  ${NSD_GetText} $GtC4 $GtAdminEmail
  ${NSD_GetText} $GtC5 $GtAdminUser
  ${NSD_GetText} $GtC6 $GtAdminPass
  ${NSD_GetText} $GtC7 $GtAdminPass2
  ${If} $GtCompany == ""
  ${OrIf} $GtAdminUser == ""
    MessageBox MB_ICONEXCLAMATION "Enter the company name and the administrator user name."
    Abort
  ${EndIf}
  StrLen $0 $GtAdminPass
  ${If} $0 < 10
    MessageBox MB_ICONEXCLAMATION "The password must have at least 10 characters."
    Abort
  ${EndIf}
  ${If} $GtAdminPass != $GtAdminPass2
    MessageBox MB_ICONEXCLAMATION "The two passwords are different."
    Abort
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom gtModePageCreate gtModePageLeave
  Page custom gtServerPageCreate gtServerPageLeave
  Page custom gtConnectPageCreate gtConnectPageLeave
  Page custom gtAdminPageCreate gtAdminPageLeave
!macroend

; Runs gtrade-ctl with the bundled Python. Output goes to the install log; exit code in $0.
!macro gtCtl ARGS
  System::Call 'Kernel32::SetEnvironmentVariable(t "GTRADE_APP_DIR", t "$INSTDIR\resources\server\app\${VERSION}")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
  nsExec::ExecToLog '"$INSTDIR\resources\server\runtime\python\python.exe" -m gtrade_ctl --install-root "$INSTDIR\resources\server" --data-root "$GtDataRoot" ${ARGS}'
  Pop $0
!macroend

!macro customInstall
  SetShellVarContext all
  DetailPrint "G OPTICALS: configuring this computer as '$GtMode'..."
  ${If} $GtMode == "workstation"
    ${If} $GtUpgrade == "1"
      DetailPrint "Workstation update: connection settings kept."
    ${Else}
      !insertmacro gtCtl 'install --mode workstation --version ${VERSION} --server "$GtServer" --code "$GtCode"'
      ${If} $0 != 0
        MessageBox MB_ICONSTOP "Could not connect to the G OPTICALS server (error $0).$\r$\nCheck the address and pairing code; you can also connect later from File > Server connection." /SD IDOK
      ${EndIf}
    ${EndIf}
    ; A workstation never hosts a database or services: drop the server runtime it does not need.
    RMDir /r "$INSTDIR\resources\server\runtime\pgsql"
    RMDir /r "$INSTDIR\resources\server\runtime\nginx"
    RMDir /r "$INSTDIR\resources\server\runtime\winsw"
  ${Else}
    ${If} $GtUpgrade == "1"
      DetailPrint "G OPTICALS: updating (verified backup first; automatic rollback on failure)..."
      !insertmacro gtCtl 'update apply --version ${VERSION} --previous-app-dir "$GtPrevApp"'
      ; 70 = failed, previous version started again AND health-checked. Anything else = not proven:
      ; never tell the shop it is running when nothing checked it (2026-11-13 false message).
      ${If} $0 == 70
        MessageBox MB_ICONEXCLAMATION "The update did not complete (error 70). Your data is safe: the previous version was started again and checked, and you can keep working.$\r$\nDetails: $GtDataRoot\logs\update" /SD IDOK
        SetErrorLevel $0
      ${ElseIf} $0 != 0
        MessageBox MB_ICONSTOP "The update did not complete (error $0) and setup could NOT confirm that G OPTICALS is running.$\r$\nNo business data was deleted, and a verified backup is taken before any database change.$\r$\nRun this setup again. If it fails again, send the folder $GtDataRoot\logs to support." /SD IDOK
        SetErrorLevel $0
      ${EndIf}
    ${Else}
      ${If} $GtAnswers == ""
        InitPluginsDir
        StrCpy $GtAnswers "$PLUGINSDIR\answers.ini"
        WriteINIStr $GtAnswers "answers" "company_name" "$GtCompany"
        WriteINIStr $GtAnswers "answers" "branch_name" "$GtBranch"
        WriteINIStr $GtAnswers "answers" "admin_full_name" "$GtAdminName"
        WriteINIStr $GtAnswers "answers" "admin_email" "$GtAdminEmail"
        WriteINIStr $GtAnswers "answers" "admin_username" "$GtAdminUser"
        WriteINIStr $GtAnswers "answers" "admin_password" "$GtAdminPass"
        StrCpy $GtAdminPass ""
        StrCpy $GtAdminPass2 ""
      ${EndIf}
      DetailPrint "G OPTICALS: database, services, certificates (this takes a few minutes)..."
      !insertmacro gtCtl 'install --mode $GtMode --version ${VERSION} --https-port $GtPort --answers "$GtAnswers"'
      Delete $GtAnswers
      ${If} $0 != 0
        MessageBox MB_ICONSTOP "G OPTICALS setup did not complete (error $0).$\r$\nNothing in an existing database was changed. See $GtDataRoot\logs\install, fix the cause and run this setup again (it resumes safely)." /SD IDOK
        SetErrorLevel $0
        Abort
      ${EndIf}
      ${If} $GtMode == "server"
        !insertmacro gtCtl 'connection-sheet'
        ExecShell "open" "$GtDataRoot\config\connection-sheet.txt"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER

; ---------------- uninstaller ----------------
Var GtUnDelete
Var GtUnConfirm
Var GtUnChk
Var GtUnTxt

!ifdef BUILD_UNINSTALLER
Function un.gtOptionsCreate
  !insertmacro gtReadMode
  ${If} $GtMode == ""
  ${OrIf} $GtMode == "workstation"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $GtDlg
  ${NSD_CreateLabel} 0 0 100% 36u "G OPTICALS program files and Windows services will be removed.$\r$\nYour business data and backups in $GtDataRoot are KEPT, so you can reinstall later and continue."
  Pop $0
  ${NSD_CreateCheckbox} 0 44u 100% 12u "Also permanently delete ALL business data and backups"
  Pop $GtUnChk
  ${NSD_CreateLabel} 0 62u 100% 20u "To confirm deletion type the company name exactly. A final backup is saved to your Desktop first."
  Pop $0
  ${NSD_CreateText} 0 84u 100% 12u ""
  Pop $GtUnTxt
  nsDialogs::Show
FunctionEnd

Function un.gtOptionsLeave
  ${NSD_GetState} $GtUnChk $GtUnDelete
  ${NSD_GetText} $GtUnTxt $GtUnConfirm
  ${If} $GtUnDelete == ${BST_CHECKED}
  ${AndIf} $GtUnConfirm == ""
    MessageBox MB_ICONEXCLAMATION "Type the company name to confirm, or untick the box to keep your data."
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.gtOptionsCreate un.gtOptionsLeave
!macroend

!macro customUnInstall
  SetShellVarContext all
  !insertmacro gtReadMode
  ; electron-builder runs the old uninstaller during an upgrade (with --updated). Never remove
  ; services or data then: the new installer's update step takes over.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    StrCpy $1 ""
    ${If} $GtUnDelete == ${BST_CHECKED}
      StrCpy $1 '--delete-data --confirm-company "$GtUnConfirm"'
    ${EndIf}
    IfFileExists "$INSTDIR\resources\server\runtime\python\python.exe" 0 gtUnNoPy
      System::Call 'Kernel32::SetEnvironmentVariable(t "GTRADE_APP_DIR", t "$INSTDIR\resources\server\app\${VERSION}")i'
      nsExec::ExecToLog '"$INSTDIR\resources\server\runtime\python\python.exe" -m gtrade_ctl --install-root "$INSTDIR\resources\server" --data-root "$GtDataRoot" uninstall $1'
      Pop $0
      ${If} $0 != 0
      ${AndIf} $GtUnDelete == ${BST_CHECKED}
        MessageBox MB_ICONEXCLAMATION "Your business data was NOT deleted (the confirmation did not match or the final backup failed). It is still in $GtDataRoot." /SD IDOK
      ${EndIf}
    gtUnNoPy:
  ${EndIf}
!macroend
