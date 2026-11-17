"""Phase 2 migration rehearsal on a DISPOSABLE copy of a LOCAL database.

    python scripts/p2_migration_rehearsal.py --source "G OPTICALS" [--keep]

What it does, in order:
  1. CREATE DATABASE <scratch> TEMPLATE <source> on localhost (the source is only read).
  2. Row counts of every table in the scratch copy (baseline).
  3. `migrate --plan`, then `migrate` (forward: all pending migrations incl. common 0009/0010).
  4. Verifies: every tenant has an organization, one organization per pre-existing tenant,
     max_companies = 1 everywhere, owners are organization admins, and every pre-existing table
     still has exactly its baseline row count (no business row added, removed or moved).
  5. Rollback rehearsal: `migrate common 0008` → same baseline counts, organization tables gone
     → `migrate` again → same verification as step 4.
  6. DROP DATABASE <scratch> (unless --keep).

Guards: refuses any host other than localhost / 127.0.0.1, refuses to use the source database
as the scratch target, never reads backend/.env (which holds the hosted DATABASE_URL), and
passes the scratch URL to manage.py explicitly.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import psycopg2

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
NEW_TABLES = {'common_organization', 'common_organizationadmin', 'common_usercompanymembership'}


def creds():
    cfg = json.loads((ROOT / 'config' / 'database.json').read_text(encoding='utf-8'))
    host = cfg.get('HOST') or 'localhost'
    if host not in ('localhost', '127.0.0.1'):
        sys.exit(f'Refusing: database host {host!r} is not local.')
    return {'host': host, 'port': int(cfg.get('PORT') or 5432), 'user': cfg['USER'], 'password': cfg['PASSWORD']}


class connect:
    """Autocommit connection closed on exit. (psycopg2's own `with conn:` opens a transaction
    even in autocommit mode, and CREATE / DROP DATABASE cannot run inside one.)"""

    def __init__(self, c, dbname):
        self.conn = psycopg2.connect(dbname=dbname, **c)
        self.conn.autocommit = True

    def __enter__(self):
        return self.conn

    def __exit__(self, *exc):
        self.conn.close()


def table_counts(c, dbname):
    with connect(c, dbname) as conn, conn.cursor() as cur:
        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
        tables = [r[0] for r in cur.fetchall()]
        out = {}
        for t in tables:
            cur.execute(f'SELECT COUNT(*) FROM "{t}"')
            out[t] = cur.fetchone()[0]
    return out


def manage(c, dbname, *args):
    url = f"postgresql://{quote(c['user'])}:{quote(c['password'])}@{c['host']}:{c['port']}/{quote(dbname)}"
    env = {**os.environ, 'DATABASE_URL': url, 'AUTO_MIGRATE': 'False', 'OPENBLAS_NUM_THREADS': '1'}
    for k in ('POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'RENDER', 'VERCEL'):
        env.pop(k, None)
    res = subprocess.run([sys.executable, 'manage.py', *args], cwd=BACKEND, env=env, capture_output=True, text=True)
    print(f'$ manage.py {" ".join(args)}  (exit {res.returncode})')
    print((res.stdout + res.stderr).strip()[-4000:])
    if res.returncode:
        raise SystemExit('manage.py failed')
    return res.stdout


def verify_organizations(c, dbname, tenants_before):
    with connect(c, dbname) as conn, conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM common_tenant WHERE organization_id IS NULL')
        assert cur.fetchone()[0] == 0, 'a tenant has no organization'
        cur.execute('SELECT COUNT(*), COUNT(DISTINCT organization_id) FROM common_tenant')
        n, distinct = cur.fetchone()
        assert n == tenants_before == distinct, f'expected {tenants_before} one-company organizations, got {distinct}'
        cur.execute('SELECT COUNT(*) FROM common_organization')
        assert cur.fetchone()[0] == tenants_before, 'organization count differs from tenant count'
        cur.execute('SELECT DISTINCT max_companies FROM common_organization')
        assert [r[0] for r in cur.fetchall()] == [1], 'max_companies must be 1 after the backfill'
        cur.execute("""SELECT COUNT(*) FROM authentication_user u JOIN common_tenant t ON t.id = u.tenant_id
                       WHERE (u.role = 'SUPER_ADMIN' OR u.is_superuser) AND NOT EXISTS (
                           SELECT 1 FROM common_organizationadmin a
                           WHERE a.user_id = u.id AND a.organization_id = t.organization_id)""")
        assert cur.fetchone()[0] == 0, 'an owner is not an admin of their organization'
        cur.execute('SELECT COUNT(*) FROM common_usercompanymembership')
        assert cur.fetchone()[0] == 0, 'the migration must not create memberships'
        cur.execute('SELECT COUNT(*) FROM common_organizationadmin')
        admins = cur.fetchone()[0]
    print(f'  ✔ {tenants_before} tenant(s) → {tenants_before} organization(s), {admins} organization admin row(s), '
          '0 memberships, max_companies=1')


def compare(before, after, label):
    changed = {t: (before[t], after.get(t)) for t in before if t not in NEW_TABLES and t != 'django_migrations'
               and before[t] != after.get(t)}
    if changed:
        raise SystemExit(f'{label}: row counts changed: {changed}')
    print(f'  ✔ {label}: all {len([t for t in before if t not in NEW_TABLES])} pre-existing tables keep their row counts')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default='G OPTICALS')
    ap.add_argument('--scratch', default='gtrade_p2_rehearsal')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--copy', choices=('template', 'dump'), default='template',
                    help='template = CREATE DATABASE … TEMPLATE (needs no other sessions on the source); '
                         'dump = pg_dump | pg_restore (works while the dev server is connected)')
    ap.add_argument('--pg-bin', default=r'C:\Program Files\PostgreSQL\18\bin')
    a = ap.parse_args()
    if a.scratch == a.source:
        sys.exit('Refusing: the scratch database must differ from the source.')
    c = creds()
    with connect(c, 'postgres') as conn, conn.cursor() as cur:
        cur.execute('SELECT 1 FROM pg_database WHERE datname=%s', (a.scratch,))
        if cur.fetchone():
            cur.execute(f'DROP DATABASE "{a.scratch}"')
        if a.copy == 'template':
            cur.execute(f'CREATE DATABASE "{a.scratch}" TEMPLATE "{a.source}"')
        else:
            cur.execute(f'CREATE DATABASE "{a.scratch}"')
    if a.copy == 'dump':
        # pg_dump reads a consistent snapshot while other sessions stay connected to the source.
        env = {**os.environ, 'PGPASSWORD': c['password']}
        conn_args = ['-h', c['host'], '-p', str(c['port']), '-U', c['user']]
        dump = subprocess.run([str(Path(a.pg_bin) / 'pg_dump.exe'), *conn_args, '-Fc', '-d', a.source],
                              env=env, capture_output=True)
        if dump.returncode:
            raise SystemExit(dump.stderr.decode(errors='replace'))
        rest = subprocess.run([str(Path(a.pg_bin) / 'pg_restore.exe'), *conn_args, '--no-owner', '-d', a.scratch],
                              input=dump.stdout, env=env, capture_output=True)
        if rest.returncode:
            raise SystemExit(rest.stderr.decode(errors='replace'))
    print(f'Scratch copy {a.scratch!r} created from {a.source!r} by {a.copy} (source only read).')
    try:
        if 'common_organization' in table_counts(c, a.scratch):
            # The source already has Phase 2: recreate the pre-Phase-2 state on the copy first.
            print('Source already at Phase 2: rolling the COPY back to common 0008 to start from P1 state.')
            manage(c, a.scratch, 'migrate', 'common', '0008_tenant_defaults_version', '--noinput')
        baseline = table_counts(c, a.scratch)
        tenants = baseline['common_tenant']
        print(f'Baseline: {len(baseline)} tables, {tenants} tenant(s), '
              f'{sum(v for k, v in baseline.items() if k != "django_migrations")} rows.')
        manage(c, a.scratch, 'migrate', '--plan')
        manage(c, a.scratch, 'migrate', '--noinput')
        after = table_counts(c, a.scratch)
        compare(baseline, after, 'forward migration')
        verify_organizations(c, a.scratch, tenants)

        manage(c, a.scratch, 'migrate', 'common', '0008_tenant_defaults_version', '--noinput')
        rolled = table_counts(c, a.scratch)
        assert not NEW_TABLES & set(rolled), 'organization tables still present after rollback'
        compare(baseline, rolled, 'rollback to common 0008')

        manage(c, a.scratch, 'migrate', '--noinput')
        again = table_counts(c, a.scratch)
        compare(baseline, again, 're-apply after rollback')
        verify_organizations(c, a.scratch, tenants)
        manage(c, a.scratch, 'migrate', '--check')
        print('REHEARSAL PASSED')
    finally:
        if not a.keep:
            with connect(c, 'postgres') as conn, conn.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS "{a.scratch}"')
            print(f'Scratch copy {a.scratch!r} dropped.')


if __name__ == '__main__':
    main()
