"""Error 70 of 2026-11-17: GTrade-Web exited right after the update switched it to its virtual account.

    nginx: [emerg] CreateDirectory() "C:/ProgramData/G-TRADE/temp/nginx/client_body" failed (5: Access is denied)

The account HAD Modify on temp\\nginx. nginx for Windows validates every path it opens or creates with
GetLongPathNameW (ngx_win32_check_filename), which looks each 8.3-shaped component ("temp", "nginx",
"logs", "web", "run") up by LISTING the parent folder - and temp / logs / run gave the web account
nothing. The update then failed at "switch" (after the migration), so it had to restore the database.

The elevated self-test could not see it: its probe runs AS the service but writes with .NET/Python
file APIs, which never call GetLongPathNameW. These tests use the REAL staged nginx.exe.

* Plan: every path the real rendered nginx.conf names is reachable (List on each parent folder,
  this folder only) and nothing else is opened up.
* Live (non-elevated, scratch folder under %TEMP%): the web account's view of the data root is built
  from service_access_plan with THIS user standing in for NT SERVICE\\GTrade-Web, then
  ``nginx -t`` with the real config + real TLS files must pass. NEGATIVE CONTROL: the same tree
  without the parent List grants reproduces the exact 2026-11-17 message, and the new pre-start check
  (winacl.service_access_problems) reports it before anything is started.
No service is created, started or touched; nothing outside the scratch folder is changed.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gtrade_ctl import install_config, nginx, winacl
from gtrade_ctl.paths import layout

WIN = Path(__file__).resolve().parents[1]
STAGE = WIN / 'out' / 'stage'
NGINX = STAGE / 'runtime' / 'nginx' / 'nginx.exe'
SPA = WIN / 'out' / 'placeholder-spa'
ADM = [(winacl.SYSTEM, 'F'), (winacl.ADMINISTRATORS, 'F')]
WEB_SID = '*S-1-5-80-1-2-3-4-5'


def norm(p) -> str:
    return os.path.normcase(os.path.abspath(p))


def conf_paths(text: str) -> list[Path]:
    """Every quoted absolute path in a rendered nginx.conf."""
    return [Path(m) for m in re.findall(r'"([A-Za-z]:[/\\][^"]+)"', text)]


class PlanCoversEveryNginxPath(unittest.TestCase):
    """Pure: no ACL is written."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-ngxplan-'))
        self.lay = layout(STAGE, self.tmp / 'G-TRADE')
        self.p = {'web': [WEB_SID], 'app': ['*S-1-5-80-9-9-9-9-9'], 'db': ['*S-1-5-80-7-7-7-7-7']}
        self.plan = winacl.service_access_plan(self.lay, self.p)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def web_grants(self) -> dict:
        out = {}
        for path, who, right, inh in self.plan:
            if WEB_SID in who:
                out.setdefault(norm(path), []).append((right, inh))
        return out

    def test_every_folder_on_the_way_to_an_nginx_path_is_listable(self):
        text = nginx.render(listen_host='127.0.0.1', https_port=8443, app_port=8001, spa_root=SPA,
                            static_root=self.lay.static_dir, tls_dir=self.lay.tls_dir,
                            logs_dir=self.lay.logs_dir / 'web', temp_dir=self.lay.temp_dir / 'nginx')
        g = self.web_grants()
        checked = 0
        for target in [*conf_paths(text), self.lay.nginx_conf, self.lay.config_dir / 'mime.types',
                       self.lay.run_dir / 'nginx' / 'logs' / 'error.log']:
            if not norm(target).startswith(norm(self.lay.data_root) + os.sep) or norm(target).startswith(norm(self.lay.static_dir)):
                continue  # SPA (program files) / static: readable through the data root's RX for web
            checked += 1
            # Walk down from the data root: each folder must be listable until one grants Modify (inherited below).
            covered = False
            for a in winacl._ancestors_below(target, self.lay.data_root):
                rights = g.get(norm(a), [])
                if ('M', True) in rights:
                    covered = True
                    break
                self.assertIn(('RX', False), rights, f'{a} (on the way to {target}) is not listable by the web account')
            if not covered:
                self.assertTrue(g.get(norm(target)), f'{target} itself is not granted to the web account')
        self.assertGreaterEqual(checked, 12)

    def test_the_2026_11_17_folders_get_list_this_folder_only(self):
        g = self.web_grants()
        for d in (self.lay.temp_dir, self.lay.logs_dir, self.lay.run_dir, self.lay.config_dir, self.lay.tls_dir):
            self.assertEqual(g.get(norm(d)), [('RX', False)], d)

    def test_parent_grants_never_inherit_and_never_reach_private_folders(self):
        for path, who, right, inh in self.plan:
            if right == 'RX':
                self.assertFalse(inh, f'{path}: a parent List grant must not be inherited by its contents')
        granted = {norm(path) for path, *_ in self.plan}
        for private in (self.lay.media_dir, self.lay.backups_dir, self.lay.pg_data, self.lay.pg_data.parent,
                        self.lay.updates_dir, self.lay.config_dir / 'secrets.dpapi', self.lay.tls_dir / 'ca.key',
                        self.lay.env_file, self.lay.temp_dir / 'app', self.lay.logs_dir / 'app'):
            self.assertNotIn(norm(private), granted, private)

    def test_db_log_folder_parent_listable_for_db(self):
        db = {norm(p): (r, i) for p, who, r, i in self.plan if self.p['db'][0] in who}
        self.assertEqual(db[norm(self.lay.logs_dir / 'db')], ('M', True))
        self.assertEqual(db[norm(self.lay.logs_dir)], ('RX', False))

    def test_localsystem_needs_no_grants(self):
        self.assertEqual(winacl.service_access_plan(self.lay, {'web': [], 'app': [], 'db': []}), [])


@unittest.skipUnless(sys.platform == 'win32', 'Windows ACLs + nginx.exe')
@unittest.skipUnless(NGINX.exists(), f'staged nginx not found ({NGINX}); run tooling/build_runtime.py')
class RealNginxUnderTheWebAccountsView(unittest.TestCase):
    """nginx -t as this user, who sees the data root exactly as the web account would."""

    def setUp(self):
        self._skip = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.me = winacl.current_user_sid()
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-ngx70-'))
        self.lay = layout(STAGE, self.tmp / 'G-TRADE')
        self.touched: list[tuple[Path, bool]] = []

    def tearDown(self):
        # Owner keeps READ_CONTROL/WRITE_DAC: give this user Full control back, top-down, then delete.
        for path, is_dir in sorted(self.touched, key=lambda t: len(t[0].parts)):
            try:
                winacl.set_acl(path, [(self.me, 'F')], replace=True, protect=False, inherit=is_dir)
            except winacl.AclError:
                pass
        subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._skip is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._skip
        self.assertFalse(self.tmp.exists(), f'scratch folder left behind: {self.tmp}')

    def build(self, with_parent_list: bool) -> dict:
        lay = self.lay
        lay.ensure_data_tree()
        for s in winacl.MANAGED_SUBDIRS:
            (lay.data_root / s).mkdir(parents=True, exist_ok=True)
        from gtrade_ctl import certs
        certs.ensure(lay.tls_dir, 'error70-test', ['localhost'])
        cfg = install_config.InstallConfig(mode='standalone', version='1.0.0', https_port=18443, app_port=18001)
        nginx.write(lay, cfg, SPA)
        for d in ('logs', 'temp'):
            (lay.run_dir / 'nginx' / d).mkdir(parents=True, exist_ok=True)
        p = {'web': [self.me], 'app': [], 'db': []}
        plan = [e for e in winacl.service_access_plan(lay, p) if with_parent_list or e[2] != 'RX']
        grants = {norm(path): (path, right, inh) for path, _w, right, inh in plan}
        managed = [lay.data_root / s for s in winacl.MANAGED_SUBDIRS] + [lay.tls_dir]
        targets = {norm(x): x for x in [*managed, *(g[0] for g in grants.values())]}
        # Deepest first, so this user keeps the access it needs to finish.
        for key, path in sorted(targets.items(), key=lambda kv: -len(kv[1].parts)):
            is_dir = path.is_dir()
            self.touched.append((path, is_dir))
            if key in grants:
                _p, right, inh = grants[key]
                winacl.set_acl(path, ADM + [(self.me, right)], replace=True, protect=True, inherit=inh)
            elif norm(path) == norm(lay.static_dir):
                winacl.set_acl(path, ADM + [(self.me, 'RX')], replace=True, protect=True, inherit=True)
            else:  # App-only / admin-only folders: nothing for the web account
                winacl.set_acl(path, ADM, replace=True, protect=True, inherit=False)
        # The data root: Read & execute for the web account (apply_data_root_policy: read=app + web).
        self.touched.append((lay.data_root, True))
        winacl.set_acl(lay.data_root, ADM + [(self.me, 'RX')], replace=True, protect=True, inherit=False)
        return p

    def nginx_t(self):
        lay = self.lay
        r = subprocess.run([str(NGINX), '-t', '-p', f'{lay.run_dir / "nginx"}/', '-c', str(lay.nginx_conf)],
                           capture_output=True, text=True, errors='replace', timeout=60)
        return r.returncode, (r.stdout + r.stderr).strip()

    def test_fixed_policy_nginx_starts_with_real_config_and_tls(self):
        p = self.build(with_parent_list=True)
        code, out = self.nginx_t()
        self.assertEqual(code, 0, out)
        self.assertIn('test is successful', out)
        self.assertEqual(winacl.service_access_problems(self.lay, p, groups=()), [])

    def test_negative_control_reproduces_error_70_and_precheck_catches_it(self):
        p = self.build(with_parent_list=False)
        code, out = self.nginx_t()
        self.assertNotEqual(code, 0, out)
        self.assertRegex(out, r'CreateDirectory\(\) ".*/temp/nginx/client_body" failed \(5: Access is denied\)')
        # The new pre-start check flags exactly the folders nginx could not list (with the FULL plan).
        problems = winacl.service_access_problems(self.lay, p, groups=())
        joined = '\n'.join(problems)
        for d in (self.lay.temp_dir, self.lay.logs_dir, self.lay.run_dir):
            self.assertIn(f'{d}: {self.me}', joined)

    def test_precheck_finds_a_protected_leftover_subfolder(self):
        """An earlier setup's protected sub-folder under temp\\nginx: nginx still STARTS (the folder
        exists), but the first large request body it buffers there would fail - found up front."""
        p = self.build(with_parent_list=True)
        stale = self.lay.temp_dir / 'nginx' / 'client_body'
        winacl.set_acl(stale, ADM, replace=True, protect=True, inherit=True)
        problems = winacl.service_access_problems(self.lay, p, groups=())
        self.assertTrue(any(str(stale) in x for x in problems), problems)


@unittest.skipUnless(sys.platform == 'win32', 'Windows ACLs')
class EffectiveRights(unittest.TestCase):
    """winacl.effective_rights = what Windows would grant a service token (SID + service groups)."""

    def setUp(self):
        self._skip = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-authz-'))
        self.me = winacl.current_user_sid()
        (self.tmp / 'child').mkdir()
        winacl.set_acl(self.tmp, [(winacl.SYSTEM, 'F'), (self.me, 'F')], replace=True, protect=True, inherit=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._skip is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._skip

    def test_grants_denies_groups_and_this_folder_only(self):
        child = self.tmp / 'child'
        self.assertEqual(winacl.effective_rights(child, WEB_SID), 0)
        winacl.set_acl(child, [(WEB_SID, 'M')], replace=False, protect=None, inherit=True)
        self.assertEqual(winacl.effective_rights(child, WEB_SID) & 0x1301BF, 0x1301BF)
        self.assertEqual(winacl.effective_rights(self.tmp, WEB_SID), 0)
        winacl.set_acl(self.tmp, [(WEB_SID, 'RX')], replace=False, protect=None, inherit=False)
        self.assertEqual(winacl.effective_rights(self.tmp, WEB_SID) & 0x21, 0x21)
        self.assertEqual(winacl.effective_rights(child, WEB_SID) & 0x1301BF, 0x1301BF, 'parent RX must not change the child')
        # A grant to BUILTIN\\Users reaches every service token; a deny on Everyone beats an allow.
        other = '*S-1-5-80-11-22-33-44-55'
        winacl.set_acl(child, [(winacl.USERS, 'R')], replace=False, protect=None, inherit=True)
        self.assertTrue(winacl.effective_rights(child, other) & 0x1)
        subprocess.run(['icacls', str(child), '/deny', '*S-1-1-0:(OI)(CI)(AD)'], check=True, capture_output=True)
        self.assertFalse(winacl.effective_rights(child, WEB_SID) & 0x4)
        subprocess.run(['icacls', str(child), '/remove:d', '*S-1-1-0'], check=True, capture_output=True)


class FailFastAndReportTheRealReason(unittest.TestCase):
    """No SCM / no services: the functions' collaborators are replaced."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-svcmsg-'))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_start_failure_quotes_the_programs_own_new_stderr_lines(self):
        from unittest import mock
        from gtrade_ctl import services
        err = self.tmp / 'logs' / 'services' / 'GTrade-Web.err.log'
        err.parent.mkdir(parents=True)
        err.write_text('nginx: [emerg] an OLD line from last week\n', encoding='utf-8')
        emerg = 'nginx: [emerg] CreateDirectory() "C:/ProgramData/G-TRADE/temp/nginx/client_body" failed (5: Access is denied)'

        def fake_run(cmd, check=False):
            with open(err, 'a', encoding='utf-8') as fh:
                fh.write(emerg + '\n' + emerg + '\n')
            return subprocess.CompletedProcess(cmd, 0, 'SERVICE_NAME: GTrade-Web STATE : 2 START_PENDING', '')

        with mock.patch.dict(os.environ, {'GTRADE_DATA_ROOT': str(self.tmp)}), \
                mock.patch.object(services, 'query', return_value='STOPPED'), \
                mock.patch.object(services, 'run', side_effect=fake_run), \
                mock.patch.object(services, 'wait_state', return_value='STOPPED'):
            with self.assertRaises(services.ServiceError) as cm:
                services.start_service('GTrade-Web', timeout=1)
        msg = str(cm.exception)
        self.assertIn('client_body" failed (5: Access is denied)', msg)
        self.assertNotIn('OLD line', msg)
        self.assertEqual(msg.count('[emerg]'), 1, 'repeated lines are shown once')
        self.assertNotIn('START_PENDING', msg)

    def test_access_defect_stops_before_any_registration_change(self):
        from unittest import mock
        from gtrade_ctl import services
        lay = layout(STAGE, self.tmp / 'G-TRADE')
        cfg = install_config.InstallConfig(mode='standalone', version='1.0.0')
        with mock.patch.object(services, 'write_service_files', return_value={}), \
                mock.patch.object(winacl, 'apply_service_access', return_value={}), \
                mock.patch.object(winacl, 'require_service_access',
                                  side_effect=winacl.AclError('temp: *S-1-5-80-x has 0x0, needs 0x21 (RX)')), \
                mock.patch.object(services, 'configure_registration') as conf, \
                mock.patch.object(services, 'stop_service') as stop, \
                mock.patch.object(services, 'query_config', return_value={'account': 'LocalSystem'}):
            with self.assertRaises(services.ServiceError) as cm:
                services.ensure_service_files(lay, cfg, '1.0.0')
        self.assertIn('needs 0x21', str(cm.exception))
        conf.assert_not_called()
        stop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
