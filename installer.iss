; Inno Setup Script for Optical ERP Professional Windows Desktop Software

#define MyAppName "Optical ERP"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "G Optical Software Enterprise"
#define MyAppExeName "ERP.exe"

[Setup]
AppId={{A821E310-9F12-421A-851C-1299901C928A}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=dist\installer
OutputBaseFilename=OpticalERP_Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallFilesDir={app}
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Dirs]
Name: "{app}\frontend"
Name: "{app}\backend"
Name: "{app}\database"
Name: "{app}\config"
Name: "{app}\images"
Name: "{app}\media"
Name: "{app}\static"
Name: "{app}\runtime"
Name: "{app}\logs"
Name: "{app}\reports"
Name: "{app}\temp"
Name: "{app}\cache"
Name: "{app}\dll"

[Files]
; Main Executables
Source: "dist\win-unpacked\ERP.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "backend_dist\backend.exe"; DestDir: "{app}"; Flags: ignoreversion; Tasks: 
Source: "backend_dist\backend.exe"; DestDir: "{app}\backend"; Flags: ignoreversion

; Electron resources and bundled frontend
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Config Files — database.json is deliberately excluded: it holds this dev machine's own
; local PostgreSQL credentials, which would fail on any other PC and would make every
; install point at the same shared database if that Postgres server were network-reachable.
; Without it, each install falls through to its own local, isolated SQLite database (see
; config/settings.py) with zero external setup required.
Source: "config\*"; DestDir: "{app}\config"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "database.json"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
