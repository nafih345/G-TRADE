import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

WINDOWS_DIR = Path(__file__).resolve().parents[1]
REPO = WINDOWS_DIR.parent
if str(WINDOWS_DIR) not in sys.path:
    sys.path.insert(0, str(WINDOWS_DIR))

from gtrade_ctl.pg import find_pg_bin  # noqa: E402

PG_BIN = find_pg_bin()


class TempRoots(unittest.TestCase):
    """Fresh install/data roots per test, under the system temp folder (never the repo)."""

    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix='gtrade-test-'))
        self.install_root = self._tmp / 'install'
        self.data_root = self._tmp / 'data'
        self.install_root.mkdir()
        os.environ['GTRADE_SKIP_ACL'] = '1'
        from gtrade_ctl.paths import layout
        self.layout = layout(self.install_root, self.data_root)

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)


def requires_pg(test):
    return unittest.skipUnless(PG_BIN, 'PostgreSQL 17 binaries not found')(test)
