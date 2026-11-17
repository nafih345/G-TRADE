# G OPTICALS: Local Super Admin bootstrap, "WinError 5 Access is denied" (2026-11-17)

## 1. Symptom

```
gtrade-ctl.cmd create-superadmin --user nafih --full-name "Local Super Admin"
```

The first attempt correctly rejected mismatched passwords. The second accepted matching passwords and then failed:

```
PermissionError: [WinError 5] Access is denied: C:\ProgramData\G-TRADE\config\install.json
  cli.py main -> installer_cmds.py cmd_create_superadmin -> cli.py _cfg -> install_config.read
```

## 2. Root cause

**The command ran in a Command Prompt that was not elevated. The installation's permissions are correct and were not the problem.**

Evidence from this PC (read-only; nothing was changed):

| Check | Result |
|---|---|
| Service accounts | `GTrade-DB/App/Web` all Running as `NT SERVICE\GTrade-DB/App/Web` (the 13:35 install of RC 51D84F8C) |
| `C:\ProgramData\G-TRADE\config` ACL (elevated `icacls` / SDDL) | Protected. SYSTEM Full, Administrators Full, `NT SERVICE\GTrade-App` Read & execute, `NT SERVICE\GTrade-Web` List (this folder only). Owner: Administrators |
| `config\install.json` (also `gtrade.env`, `secrets.dpapi`) | Inherited only: SYSTEM Full, Administrators Full, GTrade-App Read & execute. Exactly the designed policy (`winacl.apply_data_root_policy`) |
| Elevated (High integrity, Administrators *enabled*) | `install.json` opens (1,390 bytes); `gtrade-ctl create-superadmin --status` works end to end: `ok`, `exists: false`, company "GREENSOL SOLUTION" |
| Same account, **not elevated** (Administrators *deny-only*: the normal UAC token, also every VS Code terminal) | Effective rights on `config`, `install.json`, `secrets.dpapi`: `0x0`. Running the same command reproduces the reported traceback **line for line** |
| AuthzAccessCheck per identity | Elevated admin: full. Not-elevated admin: none. GTrade-App: read, no write. GTrade-Web / GTrade-DB: no access to settings or secrets. SYSTEM: full |

Under UAC, an administrator account's normal token holds `BUILTIN\Administrators` only as a deny-only group, so it matches no entry in `config\`. That is by design: the folder holds the database passwords (machine-scope DPAPI, so the file ACL is what protects them).

Two defects in `gtrade-ctl` made this hard to see:

1. `create-superadmin` (and `reset-password`) **asked for the password twice before checking** that the prompt could read the configuration.
2. `install_config.read()` called `Path.exists()` first. On Windows, when the folder cannot be listed, `exists()` **itself raises `PermissionError`**. That bypassed the code that turns a denial into a clear `ConfigAccessError` ("running as a NON-elevated user …"), so a raw traceback came out instead.

## 3. Fix (no permission, service account or secret was changed)

| File | Change |
|---|---|
| `windows/gtrade_ctl/install_config.py` | `require_access(layout, command, write=)`: opens `install.json` (read; also write when the command will record history), `gtrade.env` and `secrets.dpapi`, then closes them. It never changes anything. If access is denied and the prompt is not elevated, it raises `ConfigAccessError` with an exact instruction ("must be run from an elevated Command Prompt … Run as administrator … cd /d "<install root>" … Nothing was changed. Do not change the permissions of the config folder."). If access is denied while elevated, it reports the ACL problem and `repair-permissions`. The read-only file *attribute* is not treated as a denial (`atomic_write_text` clears it). `read()` no longer calls `exists()`: `FileNotFoundError` means "not installed" and `PermissionError` becomes `ConfigAccessError` |
| `windows/gtrade_ctl/installer_cmds.py` | `create-superadmin` (all modes) and `reset-password` run `_config_access_refusal` **before** any password prompt. On refusal: exit 2 with `{"error": …, "elevated": false, "changed": false}`; no prompt, no Django, no file written |
| `windows/gtrade_ctl/winacl.py` | `access_problem()`: a hint that depends on elevation (not elevated → "Run as administrator"; elevated → `repair-permissions`). `effective_rights(…, deny_only=())`: models UAC's deny-only Administrators, read-only, used by the tests |
| `windows/gtrade_ctl/cli.py` | `ConfigAccessError` is printed without a traceback (all commands, e.g. `health`) |
| `windows/docs/ADMINISTRATOR_GUIDE.md`, `TROUBLESHOOTING_GUIDE.md` | What "elevated" means (title `Administrator:`; VS Code / normal prompts are not), the new message, and "never change the config folder permissions" |

Unchanged: the Django `local_superadmin` command (password validation, hashing, exactly-one / idempotent, never promotes an existing account, `LOCAL_SUPER_ADMIN_*` audit events), all ACL policies, service accounts, DPAPI secrets.

## 4. Tests

New: `windows/tests/test_superadmin_config_access.py` (25 tests, real ACLs on `%TEMP%` scratch folders shaped by the real `apply_data_root_policy`):

- `NotElevatedPrompt` (7, runs only when not elevated, i.e. the reported situation): the scratch `config\` holds exactly SYSTEM / Administrators / App / Web, as on this PC. `exists()` raises. `read()` gives `ConfigAccessError`. The exact reported command is refused before the password prompt (getpass and Django patched to fail if called) with exit 2 and no traceback. `--status`, `--reset-password`, `reset-password --user/--list-admins` are refused the same way, and `health` gives a clear message. The refusal changes no ACE and no byte, and leaves no temp file.
- `ConfigAclByToken` (7): AuthzAccessCheck per token. Elevated administrator read+write; same account not elevated (Administrators deny-only) nothing; standard user nothing; GTrade-App read, never write; GTrade-Web / GTrade-DB no settings, secrets or CA key; SYSTEM full; deny-only groups match deny entries but never allow.
- `ElevatedAdministrator` (4, runs only elevated): the policy exactly as installed (no extra user ACE); `require_access` passes for read+write; the bootstrap prompts twice, sends the password on stdin only, records history in `install.json`, and adds no ACE (`install.json` still only inherits); mismatched passwords change nothing.
- `RequireAccessUnit` (7): decision logic, the read-only attribute case, missing install.

Extended: `windows/tests/test_create_superadmin_cmd.py` (+6). Mismatched passwords → exit 2, Django never runs. Matching → one call, the full JSON payload, history recorded once. Access is checked before the prompt. A refusal means no prompt and no Django. The idempotent re-run writes no history. `--status` checks read access only.

| Run | Result |
|---|---|
| Negative control: new tests vs the **old installed** `gtrade_ctl` (scratch copy) | 4 of 7 `NotElevatedPrompt` tests **fail**, reproducing `PermissionError: [WinError 5] … install.json` |
| New + related ACL/install suites, not elevated | 103 / 103 OK; new module 21 OK + 4 skipped (elevated-only) |
| Same modules **elevated** (real admin token, final code) | 36 OK, 7 skipped (non-elevated-only) |
| Full Windows suite with real-stack E2E (`GTRADE_E2E=1`, incl. `test_superadmin_e2e`) | **269 OK**, 4 skipped (elevated-only, run above), 1,034 s (`windows/out/saaccess_windows_suite_e2e.log`) |
| Windows-edition Django tests (`apps.licensing`, disposable PostgreSQL 17) | **38 / 38 OK**, incl. hash, audit, idempotency, weak password, taken username, status/reset (`windows/out/saaccess_local_django.log`) |
| New code vs the **live** install, not elevated, the exact command | exit 2, the new instruction, `changed: false`, no prompt |
| New code vs the **live** install, elevated, `create-superadmin --status` | `ok`, `exists: false`; `config` ACL unchanged afterwards |

## 5. Installer

| Item | Value |
|---|---|
| File | `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe`, 206,219,506 bytes, unsigned |
| SHA-256 | `A96A78D577F247B4EFDF15AE60B4EAE8139616B3A7675FC16B57529ED7AB002D` |
| BUILD_ID | `1.0.0-20261117T084352Z-eea62f5c` |
| `verify_package.py` (7-Zip-extracted `.exe`) | **29 / 29**, incl. "packaged app == current source", 148 migrations, no secrets or private keys |
| `payload_guard` on `win-unpacked` | OK |
| Previous RC | `51D84F8C…C730C` (installed on this PC 13:35) archived in `windows\out\archive\pre-saaccess-20261117\`: **superseded, not defective** |

**You do not need to install this build to create the Local Super Admin.** The installed version works from an elevated prompt (proven above). The new build only changes what happens in a prompt that is not elevated. Install it at your next planned update.

## 6. Safe command to run now (on the server PC)

1. Start menu → type `cmd` → right-click **Command Prompt** → **Run as administrator** → **Yes**. The title must start with `Administrator:` (not a VS Code terminal).
2. `cd /d "C:\Program Files\G-TRADE\resources\server"`
3. `gtrade-ctl.cmd create-superadmin --user nafih --full-name "Local Super Admin"`
4. Type a strong password twice (not shown). Expected result: `"created": true`, `"sign_in_page": "/#/super-admin/login"`.
5. Check: `gtrade-ctl.cmd create-superadmin --status`

If it answers that the user name is already used by another account (for example the company administrator created in setup), choose another name. The tool never promotes an existing account. Running it again with the same name changes nothing.

## 7. Separate finding (not changed)

On this PC, `config\tls` (which holds `ca.key` and `server.key`) and `config\license` still carry an explicit **`NT AUTHORITY\NETWORK SERVICE` Read & execute** entry from the pre-13-Nov installation. The current code never removes it: the policy's NETWORK SERVICE cleanup covers only the top-level data folders, and `drop_legacy_grants` covers only `pgsql`, `logs` and the program folder. No G OPTICALS service runs as NETWORK SERVICE any more. Recommended follow-up: extend `drop_legacy_grants` to `config\tls` and `config\license` (with a test), applied by the next update or `repair-permissions`. Not done here, to keep this fix limited to the reported problem.
