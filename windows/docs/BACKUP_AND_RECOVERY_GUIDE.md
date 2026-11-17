# G OPTICALS for Windows: Backup and Recovery Guide

For the shop owner and the technician who looks after the Standalone PC or LAN Server. Workstations hold no data and need no backups.

## 1. What is backed up

A **server backup** contains everything needed to bring the shop back:
- the whole database (sales, stock, patients, prescriptions, accounts, users, settings);
- uploaded documents and images (`media`).

Every backup is checked when it is made. Checksums are verified, and the database archive and documents zip are confirmed readable. A backup that fails this check is marked failed and never counted as good.

Backups are stored in `<data folder>\backups` (default `C:\ProgramData\G-TRADE\backups`).

## 2. When backups happen

| Kind | When | How many are kept |
|---|---|---|
| Scheduled | Every day at 21:30. If the PC was off at that time, at the next start-up. | 14 daily, 8 weekly, 12 monthly |
| Manual | **Back up now** on the *Server backups* page (`/#/server-backups`), or `gtrade-ctl backup run` | Until you delete them |
| Before an update or reinstall | Automatically, before any database change | The last 5 |
| Before a restore | Automatically: a safety backup of the data being replaced | Until you delete them |

To change the daily time, set `GTRADE_BACKUP_TIME` in `<data folder>\config\gtrade.env`, then restart the `GTrade-App` service.

**Settings → System Security & Backup → Download Backup** is a second, independent safety net. It downloads a checksummed `.zip` of the database to the PC you are using. It does not include uploaded images. Use it for an extra copy, not instead of server backups.

## 3. Keep a copy off the PC

A backup on the same disk does not survive a disk failure, theft or ransomware. **At least once a week:**

1. Plug in a USB disk (for example `E:`).
2. In an elevated Command Prompt, in `C:\Program Files\G-TRADE\resources\server`, run:
   ```
   gtrade-ctl backup list
   gtrade-ctl backup offsite --name <latest backup name> --target E:\G-OPTICALS-Backups
   ```
3. `offsite` copies the backup and verifies the copy.
4. Unplug the disk and keep it somewhere else.

The *Server backups* page warns while no second copy exists.

## 4. Checking a backup

```
gtrade-ctl backup verify --name <backup>          (checksums and archive)
gtrade-ctl backup verify --name <backup> --deep   (also test-restores into a throwaway database)
```

Run a `--deep` check once a month on the latest backup. It never touches the live database.

## 5. Restoring

A restore brings back the data **as it was when that backup was taken**. Anything entered after that time is lost. Stop and confirm with the owner first.

1. Ask everyone to sign out. Workstations show "being restored" while it runs.
2. Choose the backup:
   ```
   gtrade-ctl backup list
   gtrade-ctl backup verify --name <backup> --deep
   ```
3. Restore:
   ```
   gtrade-ctl backup restore --name <backup> --confirm
   ```
   To restore from a copied folder, such as one on a USB disk, use `--path <folder>` instead of `--name`.
4. Before replacing anything, the restore takes a **safety backup** and keeps the replaced database as `gtrade_pre_restore_<time>`. A mistaken restore can itself be undone (section 7).
5. Run `gtrade-ctl health`, sign in, and check the latest bills.

Users may have to sign in again after a restore.

## 6. Moving the server to a new PC

1. On the old PC: `gtrade-ctl backup run`, then copy that backup to a USB disk with `backup offsite`.
2. On the new PC: install **LAN Server** (or Standalone) with any temporary company and administrator.
3. Restore the copied backup: `gtrade-ctl backup restore --path <copied folder> --confirm`. Your real company and users come back.
4. Licence: use *Check now* on the Licence page, or ask your provider for a transfer. Full use continues for 14 days in the meantime.
5. Print the new connection sheet (`gtrade-ctl connection-sheet`) and re-pair each workstation (*File → Server connection…*). The new server has a new certificate, so workstations must be paired again.

## 7. Recovery recipes

| Situation | What to do |
|---|---|
| A wrong restore | `gtrade-ctl backup list` shows the `pre-restore` safety backup. Restore it with `backup restore --name <that backup> --confirm`. |
| A failed update | Setup restores the pre-update backup and the previous version automatically. Send `logs\update\*.jsonl` and a diagnostics zip to support. |
| Going back after a successful update | `gtrade-ctl update rollback ... --i-understand-data-entered-after-the-backup-is-lost`. This restores the pre-update backup. |
| Server disk failed | Install on a new PC and restore the newest off-PC copy (section 6). |
| "No database backup exists" or "older than 2 days" warning | Check free disk space and `logs\app\error.log`, then run **Back up now**. |
| Uninstalling | Data and backups are kept unless you explicitly choose to delete them. Even then, a final backup is written to the Desktop first. |

## 8. What G OPTICALS never does

- It never deletes the database or backups during install, update, repair or a normal uninstall.
- It never restores without `--confirm`.
- It never touches other PostgreSQL or MySQL servers on the PC.
