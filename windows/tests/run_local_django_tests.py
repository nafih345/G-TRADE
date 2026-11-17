"""Run Django tests under config.settings_local against a DISPOSABLE PostgreSQL 17 cluster.

    python windows/tests/run_local_django_tests.py apps.licensing [more labels...]
    python windows/tests/run_local_django_tests.py --cloud [labels...]   # cloud config.settings, full suite

--cloud runs the hosted-edition settings (config.settings) with DATABASE_URL pointed at the same kind of
throwaway cluster, so the full multi-tenant suite runs without the development DB, Neon or Render.

Creates a cluster in a temp folder on a free port, a test role with CREATEDB (the Django test runner
creates and drops test_<name>), runs the tests, then stops and deletes the cluster. The developer
database is never contacted.
"""

import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WIN))
from gtrade_ctl.pg import PgRuntime, find_free_port, find_pg_bin  # noqa: E402

BACKEND = WIN.parent / 'backend'


def main(labels, cloud=False):
    tmp = Path(tempfile.mkdtemp(prefix='gtrade-djtest-'))
    port = find_free_port(57440)
    su_pw, app_pw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    pg = PgRuntime(find_pg_bin(), tmp / 'pgsql' / 'data', port, tmp / 'logs')
    try:
        pg.initdb(su_pw)
        pg.start()
        pg.wait_ready()
        pg.psql(f"CREATE ROLE gtrade_test LOGIN CREATEDB PASSWORD '{app_pw}'; "
                "CREATE DATABASE gtrade_test OWNER gtrade_test;", user='postgres', password=su_pw)
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('GTRADE_', 'DATABASE_URL', 'POSTGRES_', 'DB_', 'EXPECTED_DATABASE'))
               or k.startswith('GTRADE_PERF')}  # opt-in benchmark switches only (tests_perf_benchmark)
        if cloud:
            env.update(DJANGO_SETTINGS_MODULE='config.settings', SECRET_KEY=secrets.token_urlsafe(64),
                       DATABASE_URL=f'postgres://gtrade_test:{app_pw}@127.0.0.1:{port}/gtrade_test?sslmode=disable',
                       OPENBLAS_NUM_THREADS='1')
            for k in ('VERCEL', 'RENDER', 'RENDER_EXTERNAL_HOSTNAME', 'AWS_LAMBDA_FUNCTION_NAME'):
                env.pop(k, None)
        else:
            env.update(DJANGO_SETTINGS_MODULE='config.settings_local', GTRADE_SECRET_KEY=secrets.token_urlsafe(64),
                       GTRADE_DATA_ROOT=str(tmp / 'data'), GTRADE_DB_HOST='127.0.0.1', GTRADE_DB_PORT=str(port),
                       GTRADE_DB_NAME='gtrade_test', GTRADE_DB_USER='gtrade_test', GTRADE_DB_PASSWORD=app_pw,
                       GTRADE_INSTALL_ID='5b0c1f7e-1111-4222-8333-444455556666', OPENBLAS_NUM_THREADS='1')
        proc = subprocess.run([sys.executable, 'manage.py', 'test', '--noinput', '-v', '2', *labels], cwd=BACKEND, env=env)
        return proc.returncode
    finally:
        try:
            pg.stop('immediate')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    args = sys.argv[1:]
    cloud = '--cloud' in args
    args = [a for a in args if a != '--cloud']
    sys.exit(main(args or ([] if cloud else ['apps.licensing']), cloud=cloud))
