"""Clean-shutdown assessment - the 2026-11-13 22:02 elevated self-test failure.

    FAIL db: graceful stop = clean shutdown checkpoint
         log: "shutting down" / "checkpoint starting: shutdown immediate" / "checkpoint complete ..."

The old assertion required the text "database system is shut down" in the server log right after SCM
reported STOPPED. That line is written by the postmaster's very last act (UnlinkLockFiles, after
postmaster.pid is removed) and reaches the log file only through the syslogger child, which drains its
pipe after the postmaster has gone; pg_ctl runservice reports SERVICE_STOPPED as soon as the postmaster
handle signals (and also after a 60 s timeout when it did NOT exit). In service mode the line can be
late or missing after a perfectly clean shutdown (live GTrade-DB log 2026-11-13 17:25:08: shutdown
checkpoint, next start "was shut down at 17:25:08", no final line). And the line is no proof at all:
it is also logged after an IMMEDIATE (no checkpoint, crash recovery needed) shutdown - shown below.

"checkpoint starting: shutdown immediate" is normal: every shutdown checkpoint logs its flags
(CHECKPOINT_IS_SHUTDOWN | CHECKPOINT_IMMEDIATE) that way; it does not mean "immediate shutdown mode".

Real disposable PostgreSQL 17 clusters under %TEMP% on free ports (no services are created).
"""

import os
import subprocess
import time
import unittest

from tests.helpers import PG_BIN, TempRoots, requires_pg

from gtrade_ctl import services
from gtrade_ctl.pg import PgRuntime, assess_shutdown, cluster_processes, find_free_port

# Verbatim from windows\out\selftest\elevated-selftest-20261113-220236.json (the failing check's detail).
LOG_22_02 = (
    'ST [26288] LOG:  shutting down\n'
    '2026-11-13 22:01:56.505 IST [26288] LOG:  checkpoint starting: shutdown immediate\n'
    '2026-11-13 22:01:56.538 IST [26288] LOG:  checkpoint complete: wrote 3 buffers (0.0%); 0 WAL file(s) added, '
    '0 removed, 0 recycled; write=0.015 s, sync=0.005 s, total=0.035 s; sync files=2, longest=0.003 s, '
    'average=0.003 s; distance=0 kB, estimate=0 kB; lsn=0/17BB568, redo lsn=0/17BB568\n')

FINAL = 'database system is shut down'


class AssessShutdownUnit(unittest.TestCase):
    def test_22_02_failure_replayed_is_a_clean_shutdown(self):
        # The old check on exactly this log: FAIL.
        self.assertNotIn(FINAL, LOG_22_02)
        # The same stop with the evidence the self-test now collects (the restart that followed
        # reported "database system was shut down at 22:01:56" = pg_control 'shut down').
        rep = assess_shutdown(control_state='shut down', pidfile_exists=False, live_pids=[], log_text=LOG_22_02,
                              exit_code=0)
        self.assertTrue(rep['clean'], rep)
        self.assertTrue(rep['shutdown_checkpoint_logged'])
        self.assertTrue(rep['checkpoint_complete_logged'])
        self.assertFalse(rep['final_line_logged'])

    def test_each_piece_of_evidence_is_required(self):
        ok = dict(control_state='shut down', pidfile_exists=False, live_pids=[], log_text=LOG_22_02, exit_code=0)
        self.assertTrue(assess_shutdown(**ok)['clean'])
        for change in ({'control_state': 'in production'}, {'control_state': 'unknown'},
                       {'pidfile_exists': True}, {'live_pids': [1234]}, {'exit_code': 1067},
                       {'log_text': LOG_22_02 + 'LOG:  received immediate shutdown request\n'},
                       {'log_text': LOG_22_02 + 'LOG:  terminating any other active server processes\n'},
                       {'log_text': LOG_22_02 + 'LOG:  checkpointer process (PID 77) exited with exit code 1\n'},
                       {'log_text': LOG_22_02 + 'PANIC:  could not write to file\n'}):
            rep = assess_shutdown(**{**ok, **change})
            self.assertFalse(rep['clean'], change)
            self.assertTrue(rep['problems'], change)
        # The final line alone never makes a dirty stop clean.
        self.assertFalse(assess_shutdown(**{**ok, 'control_state': 'in production', 'log_text': LOG_22_02 + FINAL})['clean'])

    def test_sc_query_exit_codes_parsed(self):
        text = ('SERVICE_NAME: GTradeST-DB-x\n        TYPE               : 10  WIN32_OWN_PROCESS\n'
                '        STATE              : 1  STOPPED\n        WIN32_EXIT_CODE    : 0  (0x0)\n'
                '        SERVICE_EXIT_CODE  : 0  (0x0)\n        CHECKPOINT         : 0x0\n')
        self.assertEqual(services.parse_exit_codes(text), {'win32': 0, 'service': 0})
        self.assertEqual(services.parse_exit_codes(text.replace(': 0  (0x0)\n        SERVICE', ': 1067  (0x42b)\n        SERVICE'))['win32'], 1067)
        self.assertEqual(services.parse_exit_codes(''), {'win32': None, 'service': None})

    def test_cluster_processes_never_match_unrelated_processes(self):
        self.assertEqual(cluster_processes(None), [])
        self.assertEqual(cluster_processes(os.getpid()), [])  # python.exe, not postgres.exe


@requires_pg
class RealClusterShutdowns(TempRoots):
    @classmethod
    def setUpClass(cls):
        cls.port = find_free_port(56520)

    def setUp(self):
        super().setUp()
        self.pg = PgRuntime(PG_BIN, self.layout.pg_data, self.port, self.layout.logs_dir / 'db')
        self.pg.initdb('selftest-' + 'x' * 20)
        self.pg.start()
        self.pg.wait_ready()

    def tearDown(self):
        pm = self.pg.postmaster_pid()
        try:
            self.pg.stop('immediate')
        except Exception:
            pass
        deadline = time.monotonic() + 30
        while pm and cluster_processes(pm) and time.monotonic() < deadline:
            time.sleep(0.25)
        super().tearDown()

    def _stop(self, mode):
        pm, offsets = self.pg.postmaster_pid(), self.pg.log_offsets()
        self.assertTrue(pm and pm in cluster_processes(pm), pm)
        self.assertGreater(len(cluster_processes(pm)), 1, 'postmaster children (syslogger, checkpointer...)')
        self.pg.stop(mode)
        return pm, offsets

    def test_fast_stop_is_clean_with_or_without_the_final_log_line(self):
        pm, offsets = self._stop('fast')
        rep = self.pg.shutdown_report(pm, offsets)
        self.assertTrue(rep['clean'], rep)
        self.assertEqual(rep['control_state'], 'shut down')
        self.assertTrue(rep['shutdown_checkpoint_logged'] and rep['checkpoint_complete_logged'], rep)
        self.assertEqual(rep['live_pids'], [])
        # Service mode can lose the syslogger's last line: the verdict must not depend on it.
        stripped = '\n'.join(l for l in self.pg.log_since(offsets).splitlines() if FINAL not in l)
        rep2 = assess_shutdown(control_state=rep['control_state'], pidfile_exists=False, live_pids=[],
                               log_text=stripped, exit_code=0)
        self.assertTrue(rep2['clean'], rep2)
        # Restart: no crash recovery.
        offsets = self.pg.log_offsets()
        self.pg.start()
        self.pg.wait_ready()
        after = self.pg.log_since(offsets)
        self.assertNotIn('not properly shut down', after)

    def test_immediate_stop_is_not_clean_although_it_logs_the_old_success_line(self):
        pm, offsets = self._stop('immediate')
        rep = self.pg.shutdown_report(pm, offsets)
        self.assertFalse(rep['clean'], rep)
        self.assertEqual(rep['control_state'], 'in production')
        self.assertTrue(rep['final_line_logged'], 'the old assertion would have PASSED this unclean stop')
        offsets = self.pg.log_offsets()
        self.pg.start()
        self.pg.wait_ready()
        self.assertIn('not properly shut down', self.pg.log_since(offsets))

    def test_killed_postmaster_is_not_clean(self):
        pm, offsets = self.pg.postmaster_pid(), self.pg.log_offsets()
        self.assertIn(pm, cluster_processes(pm))
        subprocess.run(['taskkill', '/PID', str(pm), '/F'], capture_output=True)
        rep = self.pg.shutdown_report(pm, offsets)
        self.assertFalse(rep['clean'], rep)
        self.assertTrue(rep['pidfile_exists'])
        self.assertEqual(rep['control_state'], 'in production')
        self.assertEqual(rep['live_pids'], [], 'children exit when the postmaster dies')
        # Crash recovery on the next start, and a clean stop afterwards.
        self.pg.start()
        self.pg.wait_ready()
        self.assertIn('not properly shut down', self.pg.log_since(offsets))
        pm, offsets = self._stop('fast')
        self.assertTrue(self.pg.shutdown_report(pm, offsets)['clean'])


if __name__ == '__main__':
    unittest.main()
