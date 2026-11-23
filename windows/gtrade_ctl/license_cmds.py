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


def _vendor_principals():
    """SYSTEM, Administrators and the application service account (it signs). Test stacks that
    run without ACLs (GTRADE_SKIP_ACL=1) run the app as the current user, who is added then."""
    from . import winacl
    app = winacl.service_principals().get('app') or []
    extra = [winacl.current_user_sid()] if winacl._skip() else []
    return [p for p in dict.fromkeys([winacl.SYSTEM, winacl.ADMINISTRATORS, *app, *extra]) if p]


def _read_passphrase(prompt: str, twice: bool) -> str:
    """Hidden prompt (or piped stdin lines for automation). Never an argument: it must not appear in
    process listings, shell history or logs. Twice = typed again and compared."""
    if sys.stdin is not None and sys.stdin.isatty():
        import getpass
        first = getpass.getpass(prompt)
        second = getpass.getpass('Repeat it: ') if twice else first
    else:
        first = (sys.stdin.readline() if sys.stdin is not None else '').rstrip('\r\n')
        second = (sys.stdin.readline() if sys.stdin is not None else '').rstrip('\r\n') if twice else first
    if first != second:
        raise ValueError('the two passphrases are different; nothing was changed')
    return first


@command('vendor-key', 'VENDOR PC ONLY: licence signing key - status | generate --key-id ID | export --out FILE | '
                       'verify-backup --file FILE | import --file FILE')
def cmd_vendor_key(args, sub=None):
    """The owner's licence signing key on the vendor-owner installation (gtrade_ctl/vendor_key.py).
    Never run this on a customer's computer. Output never contains the private key."""
    if sub:
        sub.add_argument('action', choices=['status', 'generate', 'export', 'verify-backup', 'import'])
        sub.add_argument('--key-id', help='generate: new key id, e.g. gtl-vendor-2026a')
        sub.add_argument('--out', help='export: GTKB1 backup file to write (must not exist)')
        sub.add_argument('--file', help='verify-backup / import: GTKB1 backup file')
        return None
    from . import install_config, vendor_key
    from .django_bridge import backend_dir
    from .installer_cmds import _config_access_refusal
    lay = _layout(args)
    refused = _config_access_refusal(lay, 'vendor-key', write=args.action in ('generate', 'import'))
    if refused:
        return refused
    path = vendor_key.key_path(lay)
    install_id = install_config.read_env(lay.env_file).get('GTRADE_INSTALL_ID', '')
    try:
        if args.action == 'generate':
            info = vendor_key.generate(path, args.key_id or '', _vendor_principals())
        elif args.action == 'import':
            if not args.file:
                return out({'error': '--file is required'}, EXIT['config'])
            if path.exists():  # refused before the passphrase is even asked
                return out({'error': f'{path} already exists. A vendor signing key is never overwritten.',
                            'changed': False}, EXIT['license'])
            info = vendor_key.import_encrypted(path, Path(args.file).read_bytes(),
                                               _read_passphrase('Backup passphrase: ', False), _vendor_principals())
        elif args.action == 'verify-backup':
            if not args.file:
                return out({'error': '--file is required'}, EXIT['config'])
            result = vendor_key.verify_backup(Path(args.file).read_bytes(), _read_passphrase('Backup passphrase: ', False),
                                              path)
            result['file'] = str(Path(args.file).resolve())
            ok = result['matches_installed_key'] is not False
            result['verdict'] = ('OK: the backup decrypts and matches the installed key' if result['matches_installed_key']
                                 else 'OK: the backup decrypts (no vendor key installed here to compare)' if ok
                                 else 'MISMATCH: this backup holds a DIFFERENT key than the installed one')
            _public_out(result)
            return 0 if ok else EXIT['license']
        elif args.action == 'export':
            if not args.out or Path(args.out).exists():
                return out({'error': '--out must name a NEW file'}, EXIT['config'])
            if not path.exists():
                return out({'error': 'This installation has no vendor signing key to back up.'}, EXIT['license'])
            target = Path(args.out)
            data = vendor_key.export_encrypted(
                path, _read_passphrase(f'New backup passphrase ({vendor_key.MIN_PASSPHRASE}+ characters): ', True))
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, 'xb') as fh:   # never overwrites
                fh.write(data)
            # Read back what is really on disk and prove it restores the installed key (in memory).
            key_id, key = vendor_key.load(path)
            on_disk = target.read_bytes()
            if on_disk != data:
                target.unlink(missing_ok=True)
                return out({'error': 'The backup file on disk differs from what was written; it was removed.'},
                           EXIT['license'])
            return _public_out({'key_id': key_id, 'public_key': vendor_key.public_b64(key), 'written': str(target.resolve()),
                                'format': vendor_key.BACKUP_FORMAT, 'verified': True,
                                'note': 'Encrypted with your passphrase (scrypt + AES-256-GCM) and verified. Upload this '
                                        'one file to Google Drive yourself; keep the passphrase somewhere else.'})
        key_id, key = vendor_key.load(path)
        info = {'key_id': key_id, 'public_key': vendor_key.public_b64(key)}
    except (vendor_key.VendorKeyError, ValueError, OSError) as exc:
        return out({'error': str(exc)}, EXIT['license'])
    trusted = {}
    try:
        trusted = json.loads((backend_dir(lay) / 'apps' / 'licensing' / 'vendor_public_keys.json').read_text('utf-8') or '{}')
    except Exception:  # informational only (no active app version, unreadable file): treated as not trusted
        pass
    _, key = vendor_key.load(path)
    info.update({
        'key_file': str(path),
        'trusted_by_installed_build': trusted.get(info['key_id']) == info['public_key'],
        'proof': vendor_key.proof(info['key_id'], key, install_id),
        'vendor_public_keys.json entry': {info['key_id']: info['public_key']},
    })
    if not info['trusted_by_installed_build']:
        info['next_step'] = ('Build the release that trusts this key (repository PC, PowerShell): '
                             r'windows\out\venv-candidate\Scripts\python.exe windows\tooling\finalize_release.py '
                             f'--key-id {info["key_id"]} --public-key {info["public_key"]} --proof <proof>. '
                             'Install it here and on customer PCs.')
    return _public_out(info)


def _public_out(info: dict) -> int:
    """Public key material only (key id, public key, proof signature): printed without the generic
    secret masking, which would hide exactly what the owner has to copy. The private key is never in it."""
    print(json.dumps(info, indent=2))
    return 0
