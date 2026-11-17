"""Whole-database backup / restore policy — the one source of truth (P1 Task 3, final rule P2).

RULE (Phase 2, decision D1 — Company = Tenant + Organization):

  A whole-database backup, an uploaded whole-database archive, and a whole-database restore are
  allowed ONLY while this server holds at most one ORGANIZATION (customer). One organization may own
  several companies (tenants); its archive then holds those companies only — never another
  customer's. With two or more organizations (the multi-customer cloud) the service refuses,
  whoever calls it (HTTP view, scheduler, management command, shell). Per-client exports
  (start_client_backup / TenantScope) are unaffected; they are the cloud's backup path.

  Who may run them over HTTP stays as strict as before: with several companies on the server, the
  caller must also be an administrator of the organization (SingleTenantInstall in
  security/views.py), because the archive contains every company of it.

  A restore is also refused unless the archive belongs to THIS install's customer:
    * archives made since Phase 2 carry the organization table: it must hold exactly one
      organization, with this install's organization id AND code (and, while that code is the
      generic 'default', the same name), and every company in the archive must belong to it;
    * older archives (no organization table) follow the P1 rule: at most one tenant, with this
      install's single tenant id AND code (same name while generic), and only while the install
      itself still holds a single company;
    * an archive with no tenant table at all (made before multi-tenancy) restores only onto an
      install whose single tenant is the default tenant #1.

The HTTP permission SingleTenantInstall calls whole_db_allowed() too, so the UI, the API and the
service can never disagree. This module never changes the policy silently: every refusal raises
WholeDatabaseBlocked with an operator-safe message and is audit-logged by its caller.
"""
import json
import zipfile

from .archive import BackupError

TENANT_ENTRY = 'data/common.tenant.jsonl'
ORGANIZATION_ENTRY = 'data/common.organization.jsonl'
GENERIC_TENANT_CODE = 'default'

BLOCKED_MESSAGE = ('Whole-database backups and restores are disabled while this server hosts more than one '
                   'customer organization: the archive would contain (or replace) every customer\'s data. Use the '
                   'per-client backup in the platform console instead.')


class WholeDatabaseBlocked(BackupError):
    """The interim multi-tenant rule refused a whole-database operation."""


class ForeignArchive(BackupError):
    """The archive belongs to another customer (tenant) than this install."""


def install_tenants():
    from apps.common.models import Tenant
    return list(Tenant.objects.order_by('pk').values('id', 'code', 'name', 'organization_id'))


def organization_count():
    """Customers on this server: distinct organizations of its tenants; a tenant not yet given an
    organization counts as its own."""
    from apps.common.models import Tenant
    orgs, loose = set(), 0
    for org_id in Tenant.objects.values_list('organization_id', flat=True):
        if org_id is None:
            loose += 1
        else:
            orgs.add(org_id)
    return len(orgs) + loose


def whole_db_allowed():
    """Phase 2 rule: at most one organization (customer) on this server."""
    return organization_count() <= 1


def install_organization():
    """{'id', 'code', 'name'} of this install's single organization, or None."""
    from apps.common.models import Organization, Tenant
    ids = {o for o in Tenant.objects.values_list('organization_id', flat=True) if o is not None}
    if len(ids) != 1:
        return None
    return Organization.objects.filter(pk=next(iter(ids))).values('id', 'code', 'name').first()


def assert_whole_db_allowed(action='This operation'):
    if not whole_db_allowed():
        raise WholeDatabaseBlocked(f'{action} refused. {BLOCKED_MESSAGE}')


def archive_tenants(path_or_zip):
    """[{'id', 'code', 'name'}] of the archive's common.tenant rows, or None when the archive has
    no tenant table (made before multi-tenancy)."""
    own = not isinstance(path_or_zip, zipfile.ZipFile)
    zf = zipfile.ZipFile(path_or_zip, 'r') if own else path_or_zip
    try:
        if TENANT_ENTRY not in zf.namelist():
            return None
        out = []
        with zf.open(TENANT_ENTRY) as fh:
            header = None
            for raw in fh:
                line = raw.decode('utf-8').strip()
                if not line:
                    continue
                if header is None:
                    header = json.loads(line).get('fields') or []
                    continue
                row = dict(zip(header, json.loads(line)))
                out.append({'id': row.get('id'), 'code': row.get('code') or '', 'name': row.get('name') or '',
                            'organization_id': row.get('organization_id')})
        return out
    except (KeyError, ValueError, UnicodeDecodeError, zipfile.BadZipFile):
        raise BackupError('The backup archive has an unreadable tenant table.')
    finally:
        if own:
            zf.close()


def archive_organizations(path_or_zip):
    """[{'id', 'code', 'name'}] of the archive's organization rows, or None for an archive made
    before Phase 2 (no organization table)."""
    own = not isinstance(path_or_zip, zipfile.ZipFile)
    zf = zipfile.ZipFile(path_or_zip, 'r') if own else path_or_zip
    try:
        if ORGANIZATION_ENTRY not in zf.namelist():
            return None
        out = []
        with zf.open(ORGANIZATION_ENTRY) as fh:
            header = None
            for raw in fh:
                line = raw.decode('utf-8').strip()
                if not line:
                    continue
                if header is None:
                    header = json.loads(line).get('fields') or []
                    continue
                row = dict(zip(header, json.loads(line)))
                out.append({'id': row.get('id'), 'code': row.get('code') or '', 'name': row.get('name') or ''})
        return out
    except (KeyError, ValueError, UnicodeDecodeError, zipfile.BadZipFile):
        raise BackupError('The backup archive has an unreadable organization table.')
    finally:
        if own:
            zf.close()


def archive_owner_problem(path_or_zip):
    """'' when this install may restore the archive, else why not."""
    if not whole_db_allowed():
        return BLOCKED_MESSAGE
    mine = install_tenants()
    theirs = archive_tenants(path_or_zip)
    if not mine:
        return ''  # an empty install (no tenant yet): nothing of anyone else's to protect
    their_orgs = archive_organizations(path_or_zip)
    if their_orgs is not None:
        return _organization_archive_problem(their_orgs, theirs or [])
    if len(mine) > 1:
        return ('This backup was made before multi-company support and holds a single company, while this '
                'server now holds several companies. It cannot be restored here.')
    if not theirs:  # no tenant table (pre-multi-tenancy archive) or an empty one
        from apps.common.tenancy import DEFAULT_TENANT_ID
        if mine[0]['id'] == DEFAULT_TENANT_ID:
            return ''
        return 'This backup was made before multi-business support and cannot be matched to this business.'
    if len(theirs) > 1:
        return ('This backup contains several businesses (it was taken on a multi-business server). It cannot be '
                'restored here.')
    a, b = theirs[0], mine[0]
    if str(a['id']) != str(b['id']) or a['code'] != b['code']:
        return (f'This backup belongs to another business ("{a["name"] or a["code"]}"), not to '
                f'"{b["name"] or b["code"]}". It cannot be restored here.')
    if b['code'] == GENERIC_TENANT_CODE and a['name'] != b['name']:
        return (f'This backup belongs to another business ("{a["name"]}"), not to "{b["name"]}". '
                'It cannot be restored here.')
    return ''


def _organization_archive_problem(their_orgs, their_tenants):
    """Phase 2 archive: exactly this install's organization, and only its companies."""
    org = install_organization()
    if org is None:
        if any(t['organization_id'] is None for t in install_tenants()):
            return "This server's business has no organization yet. Sign in once, then try again."
        return BLOCKED_MESSAGE
    if len(their_orgs) != 1:
        return ('This backup contains several customer organizations (it was taken on a multi-customer '
                'server). It cannot be restored here.')
    a = their_orgs[0]
    if str(a['id']) != str(org['id']) or a['code'] != org['code']:
        return (f'This backup belongs to another organization ("{a["name"] or a["code"]}"), not to '
                f'"{org["name"] or org["code"]}". It cannot be restored here.')
    if org['code'] == GENERIC_TENANT_CODE and a['name'] != org['name']:
        return (f'This backup belongs to another organization ("{a["name"]}"), not to "{org["name"]}". '
                'It cannot be restored here.')
    if any(str(t.get('organization_id')) != str(org['id']) for t in their_tenants):
        return 'This backup contains a company of another organization. It cannot be restored here.'
    # Defence in depth: every company in the archive must also be one of this install's companies
    # (same id AND code; same name while the code is the generic one). A company created here
    # after the backup was taken may be missing from it — restoring rolls back to that point.
    mine = {str(t['id']): t for t in install_tenants()}
    for t in their_tenants:
        own = mine.get(str(t['id']))
        if own is None or own['code'] != t['code'] or (
                own['code'] == GENERIC_TENANT_CODE and own['name'] != t['name']):
            return (f'This backup belongs to another business ("{t["name"] or t["code"]}"). '
                    'It cannot be restored here.')
    return ''


def assert_archive_restorable(path_or_zip):
    problem = archive_owner_problem(path_or_zip)
    if problem:
        if not whole_db_allowed():
            raise WholeDatabaseBlocked(problem)
        raise ForeignArchive(problem)


def disable_whole_db_schedule_if_multi_tenant(reason='A second business was added to this server.'):
    """Called when a tenant is created: switch the whole-database schedule off once the server holds
    more than one organization (it would start producing all-customer archives) and record why.
    A company added to the same organization leaves it on. Returns True when it changed anything."""
    if whole_db_allowed():
        return False
    from apps.security.audit import log_event
    from apps.security.models import BackupSchedule
    changed = BackupSchedule.objects.filter(pk=1, enabled=True).update(enabled=False, next_run_at=None,
                                                                      last_run_status='BLOCKED')
    if changed:
        log_event('BACKUP_SCHEDULE_DISABLED', 'BACKUP',
                  'Automatic whole-database backups switched off: this server now hosts more than one customer organization',
                  actor_name='System', severity='WARNING', details={'reason': reason})
    return bool(changed)
