"""Copy the whole database from one Postgres to another, then prove every table arrived.

Written for moving the hosted database next to the backend: the Render service runs in
Singapore while the original Neon project was created in us-east-2 (Ohio), so every SQL query
crossed the Pacific — a few hundred milliseconds each, and a save runs dozens of them. See
DEPLOYMENT.md, "Keep the database in the backend's region".

    set SOURCE_DATABASE_URL=postgresql://...old project (direct, non-pooler host)...
    set TARGET_DATABASE_URL=postgresql://...new Singapore project (direct host)...
    venv\\Scripts\\python.exe scripts\\copy_database.py

Use Neon's *direct* connection strings (host without "-pooler"): pg_dump/pg_restore need a
real session, which the pooler does not give. Read-only on the source; refuses to write into a
target that already holds data unless --force. Needs pg_dump/pg_restore at least as new as the
servers (PostgreSQL 18 client tools are installed on this machine).
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

import psycopg2


def find_tool(name):
    found = shutil.which(name)
    if found:
        return found
    candidates = sorted(glob.glob(rf"C:\Program Files\PostgreSQL\*\bin\{name}.exe"),
                        key=lambda p: int(p.split('\\')[-3]) if p.split('\\')[-3].isdigit() else 0)
    if candidates:
        return candidates[-1]
    sys.exit(f"{name} not found - install the PostgreSQL client tools or put them on PATH.")


def table_counts(url):
    with psycopg2.connect(url) as conn, conn.cursor() as cur:
        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
        tables = [r[0] for r in cur.fetchall()]
        counts = {}
        for t in tables:
            cur.execute(f'SELECT count(*) FROM public."{t}"')
            counts[t] = cur.fetchone()[0]
    return counts


def host_of(url):
    from urllib.parse import urlparse
    return urlparse(url).hostname or '?'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--source', default=os.environ.get('SOURCE_DATABASE_URL'))
    ap.add_argument('--target', default=os.environ.get('TARGET_DATABASE_URL'))
    ap.add_argument('--force', action='store_true', help='restore even if the target already has rows')
    args = ap.parse_args()
    if not args.source or not args.target:
        sys.exit('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL (or pass --source/--target).')
    if args.source == args.target:
        sys.exit('Source and target are the same database.')

    print(f"source: {host_of(args.source)}\ntarget: {host_of(args.target)}")
    source_counts = table_counts(args.source)
    print(f"source has {len(source_counts)} tables, {sum(source_counts.values())} rows")

    target_counts = table_counts(args.target)
    if sum(target_counts.values()) and not args.force:
        busy = {t: n for t, n in target_counts.items() if n}
        sys.exit(f"Target already holds data in {len(busy)} tables (e.g. {next(iter(busy))}). "
                 f"Use a fresh, empty project - or --force if you really mean to merge.")

    pg_dump, pg_restore = find_tool('pg_dump'), find_tool('pg_restore')
    with tempfile.TemporaryDirectory() as tmp:
        dump = os.path.join(tmp, 'db.dump')
        print('dumping ...')
        subprocess.run([pg_dump, '--format=custom', '--no-owner', '--no-privileges', '--schema=public',
                        f'--file={dump}', f'--dbname={args.source}'], check=True)
        print('restoring ...')
        # Not --exit-on-error: harmless notices (e.g. "schema public already exists") would stop
        # it. The row-count comparison below is the real check.
        result = subprocess.run([pg_restore, '--no-owner', '--no-privileges', f'--dbname={args.target}', dump])
        if result.returncode:
            print(f"pg_restore reported problems (exit {result.returncode}) - checking what arrived ...")

    copied = table_counts(args.target)
    wrong = {t: (n, copied.get(t)) for t, n in source_counts.items() if copied.get(t) != n}
    if wrong:
        for t, (want, got) in sorted(wrong.items()):
            print(f"  MISMATCH {t}: source {want}, target {got}")
        sys.exit(f"{len(wrong)} tables differ - do NOT switch DATABASE_URL yet.")
    print(f"OK - all {len(source_counts)} tables match ({sum(source_counts.values())} rows). "
          f"Point DATABASE_URL on Render at the new project's *pooled* connection string.")


if __name__ == '__main__':
    main()
