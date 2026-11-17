"""P1 production-safety rehearsal on a DISPOSABLE Neon branch (never on production).

Usage (from backend/):
    set REHEARSAL_DATABASE_URL=postgresql://USER:PASS@ep-<branch-endpoint>.<region>.aws.neon.tech/<db>?sslmode=require
    python scripts/p1_neon_rehearsal.py --out ../backups/p1-rehearsal

What it does, in order (P1_PRODUCTION_REHEARSAL_REPORT.md):
  0. Guard: refuses production's endpoint, refuses a URL without a password-free host check, prints
     the target with the password masked. Nothing is written before the guard passes.
  1. BEFORE snapshot (read-only): applied migrations, table list, row count per table, journal
     balance, stock consistency, P1 pre-flight queries, pre-P1 user branch-access impact.
  2. `migrate --plan` must list exactly the pending release migrations (RELEASE_PLAN: 12 P1 +
     3 Phase 2 + Client Management 0012; Django orders them by dependency). Else stop.
  3. `migrate` (the only write step), then `check`, `makemigrations --check`, empty `migrate --plan`.
  4. verify_branch_access, branch_backfill_report (dry run), relocate_media (dry run),
     branch_backfill_report --wholesale-journals (dry run).
  5. AFTER snapshot, before/after comparison, decision-1 impact query (needs company.0015's user link).
  6. Writes summary.json, row_counts.csv, users_losing_access.csv and a step log to --out.

It never changes user permissions, never applies a backfill beyond what the migrations themselves do,
and never deletes anything. `--local-dry-run` lets the script be proven against a local scratch copy.
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse, unquote

# Production endpoint(s) as reported by the public /api/health/ (db_target.host) on 2026-11-12.
# Add more with PROD_NEON_ENDPOINTS=ep-a,ep-b. The rehearsal refuses any of them.
PRODUCTION_ENDPOINTS = {'ep-purple-unit-b4mlt53f'} | {
    e.strip() for e in os.environ.get('PROD_NEON_ENDPOINTS', '').split(',') if e.strip()}

# Exact production database name (owner decision N1, confirmed from /api/health/ on 2026-11-12).
PRODUCTION_DATABASE = 'Uae client'

P1_PLAN = [
    'company.0013_private_media_paths',
    'company.0014_userbranchaccess_user',
    'company.0015_backfill_userbranchaccess_user',
    'company.0016_userbranchaccess_unique_user',
    'company.0017_stock_transfer_workflow',
    'company.0018_stock_transfer_db_defaults',          # P1 N2: keeps DB defaults for old code
    'products.0026_private_media_paths',
    'purchasing.0016_private_attachment',
    'purchasing.0017_attachment_name_db_default',       # P1 N2
    'sales.0037_wholesale_exam_branch',
    'sales.0038_backfill_wholesale_branch',
    'sales.0039_backfill_exam_appointment_branch_ref',
]
# The rest of the pending release (2026-11-13): Phase 2 multi-company and Client Management
# subscription terms. Production is still pre-P1, so a deploy applies all of them together.
PHASE2_PLAN = [
    'common.0009_organizations',
    'common.0010_backfill_organizations',
    'common.0011_membership_edit_permissions',
]
CLIENT_MANAGEMENT_PLAN = ['common.0012_tenant_subscription_profile']
RELEASE_PLAN = P1_PLAN + PHASE2_PLAN + CLIENT_MANAGEMENT_PLAN
NEW_TABLES = {'company_stocktransferevent', 'common_organization', 'common_organizationadmin',
              'common_usercompanymembership'}
BOOKKEEPING = {'django_migrations', 'django_content_type', 'auth_permission', 'django_session'}

ADMIN_ROLES_SQL = "('SUPER_ADMIN','ADMINISTRATOR')"
PRE_P1_IMPACT_SQL = f"""
SELECT u.tenant_id, u.username, u.role FROM authentication_user u
 WHERE u.is_active AND NOT u.is_superuser
   AND upper(coalesce(u.role,'')) NOT IN {ADMIN_ROLES_SQL}
   AND EXISTS (SELECT 1 FROM company_businesssettings s
                WHERE s.tenant_id=u.tenant_id AND s.multi_branch_enabled AND NOT s.is_deleted)
   AND NOT EXISTS (SELECT 1 FROM company_userbranchaccess a
                    WHERE a.tenant_id=u.tenant_id AND lower(a.username)=lower(u.username) AND NOT a.is_deleted)
 ORDER BY 1, 2"""
# Exactly the query in P1_FINAL_RELEASE_READINESS.md §2 (needs company.0014/0015 for a.user_id).
IMPACT_SQL = f"""
SELECT u.tenant_id, u.username, u.role FROM authentication_user u
 WHERE u.is_active AND NOT u.is_superuser
   AND upper(coalesce(u.role,'')) NOT IN {ADMIN_ROLES_SQL}
   AND EXISTS (SELECT 1 FROM company_businesssettings s WHERE s.tenant_id=u.tenant_id AND s.multi_branch_enabled)
   AND NOT EXISTS (SELECT 1 FROM company_userbranchaccess a WHERE a.user_id=u.id AND NOT a.is_deleted)
 ORDER BY 1, 2"""
PREFLIGHT_SQL = {
    'access_rows_per_tenant': "SELECT tenant_id, count(*) FROM company_userbranchaccess WHERE NOT is_deleted GROUP BY 1 ORDER BY 1",
    'access_case_duplicates': "SELECT tenant_id, lower(username), count(*) FROM company_userbranchaccess WHERE NOT is_deleted GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2",
    'wholesale_invoices_per_tenant': "SELECT tenant_id, count(*) FROM sales_wholesaleinvoice GROUP BY 1 ORDER BY 1",
    'exam_branch_text': "SELECT tenant_id, branch, count(*) FROM sales_eyeexamination GROUP BY 1, 2 ORDER BY 1, 3 DESC",
    'stock_transfers': "SELECT count(*) FROM company_stocktransfer",
    'purchase_attachments': "SELECT count(*) FROM purchasing_purchaseinvoice WHERE coalesce(attachment, '') <> ''",
    'multi_branch_tenants': "SELECT tenant_id, count(*) FROM company_businesssettings WHERE multi_branch_enabled AND NOT is_deleted GROUP BY 1 ORDER BY 1",
}
UNBALANCED_SQL = """
SELECT count(*) FROM (
  SELECT j.id FROM financial_journalentry j JOIN financial_ledgerentry l ON l.journal_entry_id = j.id
   WHERE NOT j.is_deleted AND NOT l.is_deleted AND j.status IN ('POSTED','REVERSED')
   GROUP BY j.id HAVING round(sum(l.debit) - sum(l.credit), 2) <> 0) x"""
STOCK_MISMATCH_SQL = """
SELECT count(*) FROM products_product p
 WHERE NOT p.is_deleted
   AND EXISTS (SELECT 1 FROM company_branchstock b WHERE b.product_id = p.id AND NOT b.is_deleted)
   AND coalesce(p.stock, 0) <> (SELECT coalesce(sum(b.quantity), 0) FROM company_branchstock b
                                 WHERE b.product_id = p.id AND NOT b.is_deleted)"""
TOTALS_SQL = {
    'journal_debit_total': "SELECT coalesce(sum(l.debit),0)::text FROM financial_ledgerentry l JOIN financial_journalentry j ON j.id=l.journal_entry_id WHERE NOT l.is_deleted AND NOT j.is_deleted AND j.status IN ('POSTED','REVERSED')",
    'journal_credit_total': "SELECT coalesce(sum(l.credit),0)::text FROM financial_ledgerentry l JOIN financial_journalentry j ON j.id=l.journal_entry_id WHERE NOT l.is_deleted AND NOT j.is_deleted AND j.status IN ('POSTED','REVERSED')",
    'product_stock_total': "SELECT coalesce(sum(stock),0)::text FROM products_product WHERE NOT is_deleted",
    'branchstock_total': "SELECT coalesce(sum(quantity),0)::text FROM company_branchstock WHERE NOT is_deleted",
}


def mask(url):
    p = urlparse(url)
    netloc = p.hostname or ''
    if p.username:
        netloc = f'{p.username}:****@{netloc}'
    if p.port:
        netloc += f':{p.port}'
    return p._replace(netloc=netloc).geturl()


class Run:
    def __init__(self, url, out, local):
        self.url, self.out, self.local = url, out, local
        p = urlparse(url)
        self.host, self.db = p.hostname or '', unquote((p.path or '/')[1:])
        self.log = open(os.path.join(out, 'rehearsal.log'), 'a', encoding='utf-8')
        self.summary = {'started_utc': datetime.now(timezone.utc).isoformat(), 'target': mask(url),
                        'host': self.host, 'database': self.db, 'steps': {}}
        self.env = dict(os.environ, DATABASE_URL=url, EXPECTED_DATABASE_NAME=self.db,
                        AUTO_MIGRATE='False', RUN_MIGRATIONS='False', OPENBLAS_NUM_THREADS='1',
                        PYTHONIOENCODING='utf-8')
        for k in ('POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'):
            self.env.pop(k, None)

    def say(self, msg):
        print(msg)
        self.log.write(msg + '\n')
        self.log.flush()

    def stop(self, why):
        self.say(f'STOP: {why}')
        self.summary['result'] = f'STOPPED: {why}'
        self.write_summary()
        sys.exit(2)

    # -- guard -------------------------------------------------------------------------------
    def guard(self):
        endpoint = self.host.split('.')[0].replace('-pooler', '')
        self.summary['endpoint'] = endpoint
        if endpoint in PRODUCTION_ENDPOINTS:
            self.stop(f'{endpoint} is the PRODUCTION endpoint. Create a Neon branch and use its endpoint.')
        if not self.local and not self.host.endswith('.neon.tech'):
            self.stop(f'{self.host} is not a Neon host (use --local-dry-run for a local scratch copy).')
        if self.local and self.host not in ('localhost', '127.0.0.1'):
            self.stop('--local-dry-run only accepts localhost.')
        # Owner decision N1 (2026-11-12): only the production database's copy is rehearsed.
        # `neondb` (or any other database on the branch) must not be migrated or modified.
        if not self.local and self.db != PRODUCTION_DATABASE:
            self.stop(f'database "{self.db}" is not the production database "{PRODUCTION_DATABASE}". '
                      'Use the branch URL ending in /Uae%20client. No other database may be migrated.')
        # Settings must resolve to this exact URL (DATABASE_URL decides; no local database.json fallback).
        code = ("import django,json;django.setup();from django.db import connection as c;"
                "s=c.settings_dict;c.ensure_connection();cur=c.cursor();"
                "cur.execute(\"select current_database(), version(), current_setting('neon.branch_id', true), "
                "current_setting('neon.endpoint_id', true)\");r=cur.fetchone();"
                "print(json.dumps({'host':s['HOST'],'name':s['NAME'],'db':r[0],'version':r[1].split(' on ')[0],"
                "'neon_branch_id':r[2],'neon_endpoint_id':r[3]}))")
        res = self.py(code)
        info = json.loads(res.strip().splitlines()[-1])
        self.summary['connection'] = info
        self.say(f'Target: {mask(self.url)}')
        self.say(f'Connected: host={info["host"]} db={info["db"]} {info["version"]} '
                 f'neon_branch_id={info["neon_branch_id"]} neon_endpoint_id={info["neon_endpoint_id"]}')
        if info['host'] != self.host or info['db'] != self.db:
            self.stop('Django resolved a different database than REHEARSAL_DATABASE_URL.')
        if info.get('neon_endpoint_id') and info['neon_endpoint_id'] in PRODUCTION_ENDPOINTS:
            self.stop('The server reports the production endpoint id.')

    # -- helpers -----------------------------------------------------------------------------
    def py(self, code, check=True):
        r = subprocess.run([sys.executable, '-c', 'import os;os.environ.setdefault("DJANGO_SETTINGS_MODULE","config.settings");' + code],
                           env=self.env, capture_output=True, text=True, encoding='utf-8', errors='replace')
        if check and r.returncode != 0:
            self.stop(f'python helper failed: {r.stderr.strip()[-800:]}')
        return r.stdout

    def manage(self, name, *args):
        r = subprocess.run([sys.executable, 'manage.py', *args], env=self.env, capture_output=True,
                           text=True, encoding='utf-8', errors='replace')
        out = (r.stdout + r.stderr).strip()
        self.say(f'\n$ manage.py {" ".join(args)}  -> exit {r.returncode}')
        self.say(out[-6000:])
        self.summary['steps'][name] = {'exit': r.returncode, 'tail': out[-1500:]}
        return r.returncode, out

    def snapshot(self, label):
        code = ("import django,json;django.setup();from django.db import connection as c;cur=c.cursor();"
                "cur.execute(\"select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1\");"
                "ts=[t for (t,) in cur.fetchall()];rows={}\n"
                "for t in ts:\n cur.execute('select count(*) from \"%s\"' % t.replace('\"','\"\"'));rows[t]=cur.fetchone()[0]\n"
                "cur.execute('select app, name from django_migrations order by id');mig=[a+'.'+n for a,n in cur.fetchall()]\n"
                f"q=json.loads({json.dumps(json.dumps({'unbalanced': UNBALANCED_SQL, 'stock_mismatch': STOCK_MISMATCH_SQL, **TOTALS_SQL}))})\n"
                "chk={}\n"
                "for k,s in q.items():\n cur.execute(s);chk[k]=cur.fetchone()[0]\n"
                f"pf=json.loads({json.dumps(json.dumps(PREFLIGHT_SQL))});pre={{}}\n"
                "for k,s in pf.items():\n"
                " try:\n  cur.execute(s);pre[k]=[list(map(str,r)) for r in cur.fetchall()]\n"
                " except Exception as e:\n  c.rollback() if not c.get_autocommit() else None;pre[k]='error: '+str(e).splitlines()[0]\n"
                "print(json.dumps({'tables':ts,'rows':rows,'migrations':mig,'checks':chk,'preflight':pre}))")
        snap = json.loads(self.py(code).strip().splitlines()[-1])
        p1_applied = [m for m in P1_PLAN if m in snap['migrations']]
        self.say(f'\n== {label}: {len(snap["tables"])} tables, {sum(snap["rows"].values())} rows, '
                 f'{len(snap["migrations"])} applied migrations ({len(p1_applied)}/{len(P1_PLAN)} P1), '
                 f'unbalanced journals={snap["checks"]["unbalanced"]}, stock mismatches={snap["checks"]["stock_mismatch"]}')
        for k, v in snap['preflight'].items():
            self.say(f'   {k}: {v}')
        return snap

    def query(self, sql):
        code = ("import django,json;django.setup();from django.db import connection as c;cur=c.cursor();"
                f"cur.execute({sql!r});print(json.dumps([list(map(str,r)) for r in cur.fetchall()]))")
        r = self.py(code, check=False)
        try:
            return json.loads(r.strip().splitlines()[-1])
        except Exception:
            return None

    def write_summary(self):
        self.summary['finished_utc'] = datetime.now(timezone.utc).isoformat()
        with open(os.path.join(self.out, 'summary.json'), 'w', encoding='utf-8') as fh:
            json.dump(self.summary, fh, indent=2, default=str)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--local-dry-run', action='store_true', help='prove the script on a localhost scratch copy')
    a = ap.parse_args()
    url = os.environ.get('REHEARSAL_DATABASE_URL', '').strip()
    if not url:
        sys.exit('Set REHEARSAL_DATABASE_URL to the Neon BRANCH connection string (never production).')
    os.makedirs(a.out, exist_ok=True)
    run = Run(url, a.out, a.local_dry_run)
    run.guard()

    before = run.snapshot('BEFORE')
    run.summary['before'] = {k: before[k] for k in ('checks', 'preflight')}
    run.summary['before']['table_count'] = len(before['tables'])
    run.summary['before']['row_total'] = sum(before['rows'].values())
    run.summary['p1_applied_before'] = [m for m in P1_PLAN if m in before['migrations']]
    pre_impact = run.query(PRE_P1_IMPACT_SQL)
    run.summary['pre_p1_users_without_access_row'] = pre_impact

    code, out = run.manage('plan', 'migrate', '--plan')
    planned = re.findall(r'^\s*([a-z_]+)\.(\d{4}_\w+)', out, re.M)
    planned = [f'{a_}.{n}' for a_, n in planned]
    run.summary['planned'] = planned
    applied_before = [m for m in RELEASE_PLAN if m in before['migrations']]
    run.summary['release_applied_before'] = applied_before
    pending = [m for m in RELEASE_PLAN if m not in applied_before]
    # Exactly the release's pending migrations — nothing more, nothing missing, no duplicates.
    if code != 0 or sorted(planned) != sorted(pending) or len(set(planned)) != len(planned):
        run.stop(f'migrate --plan lists {planned}, expected exactly {pending} (any order).')

    if planned:
        code, out = run.manage('migrate', 'migrate', '--noinput')
        if code != 0:
            run.stop('migrate failed (see log). The branch is disposable: delete it, fix, re-branch.')
    for name, args in (('check', ('check',)),
                       ('makemigrations_check', ('makemigrations', '--check', '--dry-run')),
                       ('plan_after', ('migrate', '--plan')),
                       ('verify_branch_access', ('verify_branch_access',)),
                       ('branch_backfill_report', ('branch_backfill_report',)),
                       ('wholesale_journals_dry_run', ('branch_backfill_report', '--wholesale-journals')),
                       ('relocate_media_dry_run', ('relocate_media',))):
        run.manage(name, *args)

    after = run.snapshot('AFTER')
    run.summary['after'] = {k: after[k] for k in ('checks', 'preflight')}
    run.summary['after']['table_count'] = len(after['tables'])
    run.summary['after']['row_total'] = sum(after['rows'].values())
    run.summary['p1_applied_after'] = [m for m in P1_PLAN if m in after['migrations']]

    diffs = []
    with open(os.path.join(a.out, 'row_counts.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['table', 'before', 'after', 'delta'])
        for t in sorted(set(before['rows']) | set(after['rows'])):
            b, c = before['rows'].get(t), after['rows'].get(t)
            w.writerow([t, b, c, (c or 0) - (b or 0)])
            if b != c and t not in BOOKKEEPING:
                diffs.append({'table': t, 'before': b, 'after': c})
    run.summary['business_row_changes'] = diffs
    run.summary['unexpected_tables'] = sorted(set(after['tables']) - set(before['tables']) - NEW_TABLES)

    impact = run.query(IMPACT_SQL) or []
    run.summary['users_losing_access'] = impact
    with open(os.path.join(a.out, 'users_losing_access.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['tenant_id', 'username', 'role', 'assign_branches (admin fills in)'])
        for r in impact:
            w.writerow(r + [''])

    ok = (run.summary['p1_applied_after'] == P1_PLAN
          and run.summary['steps']['check']['exit'] == 0
          and run.summary['steps']['makemigrations_check']['exit'] == 0
          and run.summary['steps']['verify_branch_access']['exit'] == 0
          and str(after['checks']['unbalanced']) == '0'
          and str(after['checks']['stock_mismatch']) == str(before['checks']['stock_mismatch'])
          and all(after['checks'][k] == before['checks'][k] for k in TOTALS_SQL)
          and not run.summary['unexpected_tables'])
    run.summary['result'] = 'PASS' if ok else 'REVIEW (see summary.json)'
    run.say(f'\nRows changed (excluding bookkeeping tables): {diffs or "none"}')
    run.say(f'Users who would lose access under decision 1: {len(impact)} (users_losing_access.csv)')
    run.say(f'RESULT: {run.summary["result"]}')
    run.write_summary()


if __name__ == '__main__':
    main()
