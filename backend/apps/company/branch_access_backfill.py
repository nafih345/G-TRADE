"""Link UserBranchAccess rows to stable user ids (P1 Task 4) — shared by migration
0015_backfill_userbranchaccess_user and `manage.py verify_branch_access`.

Old rule (what every signed-in request used before P1 Task 4):
    UserBranchAccess.objects.filter(username__iexact=<token user's username>).first()
inside the user's tenant, ignoring soft-deleted rows. The model has no ordering, so .first()
means "lowest primary key".

The backfill links, for every user, *exactly the row the old rule picked for them*, so nobody's
effective branch access changes:
  * that row is not linked yet            -> link it to the user                ('linked')
  * that row is already linked to another user (two users whose names differ only in case,
    who both resolved to it)              -> copy it for this user             ('cloned')
  * the user already has a linked row     -> nothing to do (re-run)            ('already')
Rows no user resolves to are left unlinked and reported:
  * 'orphan'     — no user of the tenant has that name (deleted user / never existed)
  * 'superseded' — a duplicate for a name whose lower-pk row won under the old rule
Nothing is deleted, nothing is overwritten, and a second run changes nothing.
"""
import uuid
from collections import defaultdict


def old_rule_row(rows, username):
    """The row the pre-P1 resolver returned for `username` (rows: live rows of one tenant)."""
    name = (username or '').lower()
    matches = [r for r in rows if (r.username or '').lower() == name]
    return min(matches, key=lambda r: str(r.pk)) if matches else None


def backfill_tenant(Access, User, tenant_id, apply=True):
    """Link one tenant's rows. Returns a report dict. With apply=False nothing is written."""
    rows = list(Access._base_manager.filter(tenant_id=tenant_id, is_deleted=False))
    users = list(User._base_manager.filter(tenant_id=tenant_id))
    report = {'tenant': tenant_id, 'rows': len(rows), 'users': len(users), 'linked': [], 'cloned': [],
              'already': [], 'orphan': [], 'superseded': [], 'unconfigured_users': 0}
    linked_to = {str(r.pk): r.user_id for r in rows if r.user_id is not None}
    has_row = {r.user_id for r in rows if r.user_id is not None}
    exact_names = {r.username for r in rows}
    # Users whose name matches a row exactly go first, so they keep the original row and a
    # case-variant user gets the copy.
    users.sort(key=lambda u: (0 if u.username in exact_names else 1, str(u.pk)))
    used = set()
    for user in users:
        if user.pk in has_row:
            report['already'].append(user.username)
            used.update(k for k, v in linked_to.items() if v == user.pk)
            continue
        row = old_rule_row(rows, user.username)
        if row is None:
            report['unconfigured_users'] += 1
            continue
        used.add(str(row.pk))
        owner = linked_to.get(str(row.pk))
        if owner is None:
            linked_to[str(row.pk)] = user.pk
            has_row.add(user.pk)
            report['linked'].append(user.username)
            if apply:
                Access._base_manager.filter(pk=row.pk).update(user_id=user.pk)
            continue
        # The row already belongs to another user: give this user an identical copy.
        has_row.add(user.pk)
        report['cloned'].append(f'{user.username} (from {row.username})')
        if apply:
            copy = Access._base_manager.create(id=uuid.uuid4(), tenant_id=tenant_id, username=user.username,
                                         user_id=user.pk, access_all_branches=row.access_all_branches,
                                         default_branch_id=row.default_branch_id)
            copy.branches.set(list(row.branches.values_list('pk', flat=True)))
    names = {(u.username or '').lower() for u in users}
    for r in rows:
        if str(r.pk) in used or r.user_id is not None:
            continue
        (report['superseded'] if (r.username or '').lower() in names else report['orphan']).append(r.username)
    return report


def backfill_all(Access, User, Tenant, apply=True):
    return [backfill_tenant(Access, User, t, apply=apply) for t in Tenant.objects.values_list('pk', flat=True)]


def summary_line(report):
    return (f"tenant {report['tenant']}: rows={report['rows']} users={report['users']} "
            f"linked={len(report['linked'])} cloned={len(report['cloned'])} already={len(report['already'])} "
            f"orphan={len(report['orphan'])} superseded={len(report['superseded'])} "
            f"users_without_access_row={report['unconfigured_users']}")


def verify_tenant(Access, User, tenant_id):
    """Compare, for every user, the access the old username rule gives with the access the new
    user-id rule gives. Returns a list of mismatches (empty = permissions preserved)."""
    rows = list(Access._base_manager.filter(tenant_id=tenant_id, is_deleted=False))
    by_user = defaultdict(list)
    for r in rows:
        if r.user_id is not None:
            by_user[r.user_id].append(r)

    def effective(r):
        if r is None:
            return None
        return (bool(r.access_all_branches), frozenset(str(b) for b in r.branches.values_list('pk', flat=True)),
                str(r.default_branch_id) if r.default_branch_id else None)

    problems = []
    for user in User._base_manager.filter(tenant_id=tenant_id):
        old = effective(old_rule_row(rows, user.username))
        mine = by_user.get(user.pk, [])
        if len(mine) > 1:
            problems.append(f'{user.username}: {len(mine)} live rows linked')
        new = effective(min(mine, key=lambda r: str(r.pk)) if mine else None)
        if old != new:
            problems.append(f'{user.username}: old={old} new={new}')
    return problems
