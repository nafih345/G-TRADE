"""Desktop print preview on real Windows (opt-in, GTRADE_E2E=1).

Runs the desktop app's own print self-test (`--print-selftest`, windows/desktop/lib/printSelfTest.js):
sample A4 invoice, A5 prescription, 80 mm receipt roll ("80mm auto"), fixed-size receipt, 38x25 mm
labels, an unsized app screen and an A4-landscape report are printed with window.print() in an app
window, plus a bill from an about:blank pop-up. Each opens the app's preview window, which renders
the real pages (printToPDF), switches paper / orientation / margins through its own controls and
saves a PDF. No server, database or user profile is touched.

* GTRADE_DESKTOP_EXE=<...\\win-unpacked\\G-TRADE.exe> tests the PACKAGED build (default: the dev
  Electron binary with windows/desktop as the app).
* GTRADE_PRINT_SPOOLER=1 additionally prints 4 documents through the Windows spooler to
  "Microsoft Print to PDF" (answering its file-name prompt) and checks the spooled page sizes.
  This creates real print jobs; Windows may then make that printer the default if
  "Let Windows manage my default printer" is on.

    cd windows && set GTRADE_E2E=1 && python -m unittest tests.test_print_preview_e2e -v
"""
import ctypes
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import unittest
from ctypes import wintypes
from pathlib import Path

WINDOWS_DIR = Path(__file__).resolve().parents[1]
DESKTOP = WINDOWS_DIR / 'desktop'
DEV_ELECTRON = DESKTOP / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
PACKAGED = os.environ.get('GTRADE_DESKTOP_EXE', '')
SPOOLER_PRINTER = 'Microsoft Print to PDF'


def run_selftest(out_dir: Path, printer: str = '', timeout: int = 600) -> dict:
    env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
    out = out_dir / 'result.json'
    cmd = [PACKAGED] if PACKAGED else [str(DEV_ELECTRON), str(DESKTOP)]
    cmd += [f'--print-selftest={out}', f'--user-data-dir={out_dir / "ud"}']
    if printer:
        cmd.append(f'--print-selftest-printer={printer}')
    proc = subprocess.run(cmd, env=env, timeout=timeout, capture_output=True)
    if not out.exists():
        raise AssertionError(f'no result (exit {proc.returncode}): {proc.stderr.decode(errors="replace")[-2000:]}')
    result = json.loads(out.read_text(encoding='utf-8'))
    result['_exit'] = proc.returncode
    return result


def pdf_pages(path: Path):
    """[(width_mm, height_mm), ...] of a PDF written by Chromium or by Microsoft Print to PDF."""
    import zlib
    data = path.read_bytes()
    text = data.decode('latin1')
    for m in re.finditer(rb'stream\r?\n', data):
        end = data.find(b'endstream', m.end())
        try:
            text += zlib.decompress(data[m.end():end]).decode('latin1')
        except Exception:  # noqa: BLE001 - not a deflate stream
            pass
    boxes = re.findall(r'/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]', text)
    return [(round((float(c) - float(a)) * 25.4 / 72, 1), round((float(d) - float(b)) * 25.4 / 72, 1)) for a, b, c, d in boxes]


class SaveAsAnswerer(threading.Thread):
    """Answers Microsoft Print to PDF's "Save Print Output As" prompt (Win32 messages), one file per job."""

    def __init__(self, out_dir: Path, count: int, timeout: float = 400):
        super().__init__(daemon=True)
        self.out_dir, self.count, self.deadline, self.saved = out_dir, count, time.time() + timeout, []

    def run(self):
        u = ctypes.WinDLL('user32', use_last_error=True)
        enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        u.FindWindowW.restype = wintypes.HWND
        u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        u.GetParent.restype = wintypes.HWND
        u.GetParent.argtypes = [wintypes.HWND]
        u.GetDlgItem.restype = wintypes.HWND
        u.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
        u.GetDlgCtrlID.argtypes = [wintypes.HWND]
        u.IsWindow.argtypes = [wintypes.HWND]
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.EnumChildWindows.argtypes = [wintypes.HWND, enum_proc, wintypes.LPARAM]
        u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPCWSTR]
        u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        while len(self.saved) < self.count and time.time() < self.deadline:
            dlg = u.FindWindowW('#32770', 'Save Print Output As')
            if not dlg:
                time.sleep(0.3)
                continue
            target = self.out_dir / f'spooled-{len(self.saved) + 1:02d}.pdf'
            time.sleep(1.2)  # the dialog is still populating when it first appears
            for _ in range(6):
                if not u.IsWindow(dlg):
                    break
                edits = []

                def collect(h, _l, edits=edits):
                    cls = ctypes.create_unicode_buffer(64)
                    u.GetClassNameW(h, cls, 64)
                    if cls.value == 'Edit':
                        parent, in_name_box = u.GetParent(h), False
                        while parent and parent != dlg:
                            in_name_box = in_name_box or u.GetDlgCtrlID(parent) == 1148
                            parent = u.GetParent(parent)
                        edits.append((not in_name_box, h))
                    return True
                u.EnumChildWindows(dlg, enum_proc(collect), 0)
                if not edits:
                    time.sleep(0.5)
                    continue
                edit = sorted(edits, key=lambda e: e[0])[0][1]
                u.SendMessageW(edit, 0x000C, 0, str(target))  # WM_SETTEXT
                time.sleep(0.3)
                u.PostMessageW(dlg, 0x0111, 1, u.GetDlgItem(dlg, 1) or 0)  # WM_COMMAND IDOK
                t = time.time() + 5
                while u.IsWindow(dlg) and time.time() < t:
                    time.sleep(0.2)
            t = time.time() + 30
            while not target.exists() and time.time() < t:
                time.sleep(0.2)
            self.saved.append(target)


@unittest.skipUnless(os.name == 'nt' and os.environ.get('GTRADE_E2E') == '1' and (PACKAGED and Path(PACKAGED).exists() or DEV_ELECTRON.exists()),
                     'set GTRADE_E2E=1 (Windows, desktop dependencies installed)')
class PrintPreviewE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-print-'))

    def test_01_every_document_kind_previews_saves_and_matches_its_paper(self):
        r = run_selftest(self.tmp)
        self.assertTrue(r['ok'], json.dumps(r['failures'], indent=1))
        self.assertEqual(r['_exit'], 0)
        self.assertEqual(r['packaged'], bool(PACKAGED))
        docs = {d['file']: d for d in r['docs']}
        self.assertEqual(len(docs), 7)
        for name, d in docs.items():
            self.assertTrue(d['pass'], f'{name}: {d.get("checks")} {d.get("error", "")}')
            # window.print() resolved when the preview closed, reporting what the user did there
            self.assertEqual(d['outcome']['outcome'], 'saved', name)
            png = Path(f"{self.tmp / 'result.json'}.shots") / name.replace('.html', '.png')
            self.assertGreater(png.stat().st_size, 20000, f'{name}: preview screenshot looks empty')
        self.assertEqual(docs['a4-invoice.html']['kind'], 'sheet')
        self.assertEqual(docs['receipt-roll.html']['kind'], 'receipt')
        self.assertEqual(docs['labels.html']['kind'], 'label')
        self.assertEqual(docs['report-screen.html']['kind'], 'screen')
        self.assertEqual(docs['labels.html']['first']['pages'], 3)
        roll = docs['receipt-roll.html']
        self.assertLess(roll['changed']['heightMm'], roll['first']['heightMm'])  # margins=none: shorter receipt
        self.assertTrue(r['popup']['pass'], r['popup'])
        # Printer classification: whatever this PC has, virtual printers are never "paper".
        printers = r['printers']
        for p in printers['printers']:
            if re.search(r'pdf|xps|onenote|fax', p['name'], re.I):
                self.assertTrue(p['virtual'], p)
        if not printers['hasPhysical']:
            self.assertEqual(printers['selected'], '__save_as_pdf__')
            self.assertIn('No paper printer is set up', docs['a4-invoice.html']['notice'])
            self.assertEqual(docs['a4-invoice.html']['printLabel'], 'Save PDF')

    @unittest.skipUnless(os.environ.get('GTRADE_PRINT_SPOOLER') == '1', 'set GTRADE_PRINT_SPOOLER=1 to send real jobs to Microsoft Print to PDF')
    def test_02_real_windows_spooler_gets_the_previewed_paper(self):
        answerer = SaveAsAnswerer(self.tmp, count=4)
        answerer.start()
        r = run_selftest(self.tmp, printer=SPOOLER_PRINTER)
        answerer.join(60)
        self.assertTrue(r['ok'], json.dumps(r['failures'], indent=1))
        printed = [d for d in r['docs'] if d.get('print')]
        self.assertEqual([d['file'] for d in printed], ['a4-invoice.html', 'a5-prescription.html', 'receipt-roll.html', 'labels.html'])
        for d in printed:
            self.assertTrue(d['print']['message'].startswith(f'Sent 1 copy to {SPOOLER_PRINTER}'), d['print'])
        self.assertEqual([p.name for p in answerer.saved], [f'spooled-0{i}.pdf' for i in range(1, 5)])
        pages = [pdf_pages(p) for p in answerer.saved]
        self.assertEqual(pages[0], [(210.0, 297.0)])  # A4 invoice -> A4
        self.assertEqual(pages[1], [(148.0, 210.0)])  # A5 prescription -> A5
        # Microsoft Print to PDF has no custom paper sizes: the receipt and the 3 labels land on its
        # default sheet (the preview warns about exactly this); page count is kept.
        self.assertEqual(len(pages[2]), 1)
        self.assertEqual(len(pages[3]), 3)


if __name__ == '__main__':
    unittest.main()
