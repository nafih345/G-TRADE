from pathlib import Path

from django.test import SimpleTestCase

BACKEND = Path(__file__).resolve().parents[2]


class SourceEncodingTests(SimpleTestCase):
    """Every Python source must be valid UTF-8. A single Windows-1252 byte (an em dash pasted
    from a Windows editor) made Python refuse to import the app on Linux, so every Render build
    failed and the hosted backend silently stayed on an old release."""

    def test_python_sources_are_utf8(self):
        bad = []
        for path in BACKEND.rglob('*.py'):
            if any(part in ('venv', '.venv', 'build', 'dist', 'node_modules') for part in path.parts):
                continue
            try:
                path.read_bytes().decode('utf-8')
            except UnicodeDecodeError as exc:
                bad.append(f'{path.relative_to(BACKEND)} (byte {exc.start})')
        self.assertEqual(bad, [], 'Re-save these files as UTF-8: ' + ', '.join(bad))
