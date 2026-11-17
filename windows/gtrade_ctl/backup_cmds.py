"""gtrade-ctl backup run|list|verify|restore|retention|status|offsite."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from .cli import EXIT, _cfg, _layout, command, out


@command('backup', 'Database + documents backups: run | list | verify | restore | retention | status | offsite')
def cmd_backup(args, sub=None):
    if sub:
        sub.add_argument('action', choices=['run', 'list', 'verify', 'restore', 'retention', 'status', 'offsite'])
        sub.add_argument('--kind', default='manual', choices=['manual', 'scheduled'])
        sub.add_argument('--name', help='backup name (verify / restore)')
        sub.add_argument('--path', help='backup folder (restore from another location)')
        sub.add_argument('--deep', action='store_true', help='verify by restoring into a throwaway database')
        sub.add_argument('--confirm', action='store_true', help='restore: required (replaces the live database)')
        sub.add_argument('--target', help='offsite: folder on a USB disk / second drive / network share')
        sub.add_argument('--no-services', action='store_true')
        return None
    from . import backup as b
    lay = _layout(args)
    if args.action == 'list':
        return out({'backups': b.list_backups(lay)})
    if args.action == 'status':
        idx = lay.backups_dir / 'db' / 'index.json'
        return out(json.loads(idx.read_text()) if idx.exists() else b.write_index(lay))
    cfg = _cfg(lay)
    if args.action == 'run':
        try:
            m = b.create_backup(lay, cfg, kind=args.kind, include_media=True, actor='gtrade-ctl')
        except Exception as exc:
            b.write_index(lay, last_error=str(exc))
            raise
        deleted = b.apply_retention(lay) if args.kind == 'scheduled' else []
        return out({'backup': m['name'], 'verified': m['verified'], 'bytes': sum(f['bytes'] for f in m['files'].values()),
                    'retention_deleted': deleted})
    if args.action == 'retention':
        return out({'deleted': b.apply_retention(lay)})
    src = Path(args.path) if args.path else (lay.backups_dir / 'db' / args.name if args.name else None)
    if src is None:
        return out({'error': '--name or --path is required'}, EXIT['config'])
    if args.action == 'verify':
        rep = b.verify_backup(src, lay=lay, cfg=cfg, deep=args.deep)
        return out(rep, 0 if rep['ok'] else EXIT['backup'])
    if args.action == 'offsite':
        if not args.target:
            return out({'error': '--target is required'}, EXIT['config'])
        dest = Path(args.target) / src.name
        shutil.copytree(src, dest, dirs_exist_ok=False)
        rep = b.verify_backup(dest)
        idx = b.write_index(lay)
        idx['offsite_copy'] = {'target': str(args.target), 'backup': src.name, 'verified': rep['ok']}
        (lay.backups_dir / 'db' / 'index.json').write_text(json.dumps(idx, indent=1))
        return out({'copied_to': str(dest), 'verified': rep['ok']}, 0 if rep['ok'] else EXIT['backup'])
    # restore
    if not args.confirm:
        return out({'error': 'Restoring replaces the live database with the backup (the current one is kept '
                             'under another name). Re-run with --confirm.'}, EXIT['config'])
    from . import services
    if args.no_services:
        stop, start = (lambda: None), (lambda: None)
    else:
        services.require_elevation('Restoring a backup')
        stop = lambda: services.stop_all(lay, include_db=False)  # noqa: E731
        start = lambda: services.start_all(lay)  # noqa: E731
    pre = b.create_backup(lay, cfg, kind='pre-restore', include_media=True, actor='gtrade-ctl')
    rep = b.restore_backup(lay, cfg, src, stop_app=stop, start_app=start)
    rep['safety_backup_before_restore'] = pre['name']
    return out(rep)
