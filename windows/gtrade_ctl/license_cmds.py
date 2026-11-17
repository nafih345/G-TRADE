"""``gtrade-ctl license status|activate|import|request|checkin`` and the installer licence step.

The licence key is a secret: it is read from an answers file or stdin and passed to Django on stdin.
Verification always happens in the backend (apps/licensing) with the embedded public keys.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .cli import EXIT, _cfg, _layout, command, out


def _manage_license(lay, action, *, stdin_text=None, extra=()):
    from .django_bridge import manage
    proc = manage(lay, ['license', action, *extra], cfg=_cfg(lay), input_text=stdin_text, timeout=120)
    line = (proc.stdout.strip().splitlines() or ['{}'])[-1]
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        data = {'error': (proc.stderr.strip().splitlines() or ['failed'])[-1]}
    return proc.returncode, data


def install_step(lay, answers_path):
    """Installer: activate online / import a file if the answers say so; otherwise evaluation mode."""
    from .installer_cmds import _read_answers
    answers = {}
    if answers_path and Path(answers_path).exists():
        # The organization step already consumed (and shredded) the answers file; licence answers are
        # read from the companion file the wizard writes, if any.
        pass
    lic_file = Path(str(answers_path) + '.license') if answers_path else None
    if lic_file and lic_file.exists():
        answers = _read_answers(str(lic_file))
    if answers.get('license_file'):
        code, data = _manage_license(lay, 'import', extra=['--file', answers['license_file']])
        return {'mode': 'import', 'status': data.get('status'), 'error': data.get('error')}
    if answers.get('license_key'):
        code, data = _manage_license(lay, 'activate', stdin_text=answers['license_key'] + '\n')
        return {'mode': 'online', 'status': data.get('status'), 'error': data.get('error')}
    code, data = _manage_license(lay, 'status')
    return {'mode': 'evaluation', 'status': data.get('status'), 'days_left': data.get('days_left')}


@command('license', 'Licence: status | activate (key on stdin) | import FILE | request (key on stdin) | checkin')
def cmd_license(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['status', 'activate', 'import', 'request', 'checkin'])
        sub.add_argument('--file', help='import: licence file')
        sub.add_argument('--out', help='request: where to write the offline activation request')
        return None
    lay = _layout(args)
    if args.action in ('activate', 'request'):
        key = sys.stdin.readline().strip()
        if not key:
            return out({'error': 'pass the licence key on stdin'}, EXIT['config'])
        code, data = _manage_license(lay, args.action, stdin_text=key + '\n')
        if args.action == 'request' and code == 0 and args.out:
            Path(args.out).write_text(json.dumps(data, indent=2), encoding='utf-8')
            data = {'written': args.out}
    elif args.action == 'import':
        if not args.file:
            return out({'error': '--file is required'}, EXIT['config'])
        code, data = _manage_license(lay, 'import', extra=['--file', str(Path(args.file).resolve())])
    else:
        code, data = _manage_license(lay, args.action)
    return out(data, 0 if code == 0 else EXIT['license'])
