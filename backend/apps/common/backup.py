import os
import sys
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

def create_backup(dest_dir="backups", include_media=True):
    """
    Creates a compressed ZIP backup of the database and media files.
    """
    base_dir = Path(__file__).resolve().parent.parent.parent
    if getattr(sys, 'frozen', False):
        exe_dir = Path(sys.executable).parent
    else:
        exe_dir = base_dir

    backup_folder = exe_dir / dest_dir
    backup_folder.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_filename = backup_folder / f"OpticalERP_Backup_{timestamp}.zip"

    print(f"Creating backup archive: {zip_filename}")

    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # 1. Database File (SQLite fallback or dump notes)
        sqlite_db = base_dir / 'db.sqlite3'
        if sqlite_db.exists():
            zipf.write(sqlite_db, arcname='database/db.sqlite3')

        # 2. Config directory
        config_dir = exe_dir / 'config'
        if config_dir.exists():
            for root, _, files in os.walk(config_dir):
                for f in files:
                    fp = Path(root) / f
                    arc = Path('config') / fp.relative_to(config_dir)
                    zipf.write(fp, arcname=str(arc))

        # 3. Media files
        media_dir = exe_dir / 'media'
        if include_media and media_dir.exists():
            for root, _, files in os.walk(media_dir):
                for f in files:
                    fp = Path(root) / f
                    arc = Path('media') / fp.relative_to(media_dir)
                    zipf.write(fp, arcname=str(arc))

    print(f"Backup created successfully at {zip_filename}")
    return str(zip_filename)

if __name__ == '__main__':
    create_backup()
