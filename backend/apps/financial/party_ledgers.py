"""Per-party sub-ledgers in the Chart of Accounts.

Every supplier gets its own Accounts Payable ledger and every wholesale dealer its own Accounts
Receivable ledger, created the moment the party is created (signals.connect wires post_save),
whichever screen or import created it. Each sits under its control account (the
SUPPLIER_PAYABLE / WHOLESALE_RECEIVABLE role mapping) as `parent_account`, so the COA shows it
nested and the balance sheet still sums it with the control account (same account type).

Retail customers deliberately do NOT get one: an optical store has thousands of walk-in
patients, and their dues are tracked bill by bill (open_bills / Customer Outstanding) against
the 1004 control account.

Only *new* parties are provisioned automatically. An older party with history on the control
account is moved with `manage.py accounting link-party-ledgers` (dry run first), which also
re-books its live documents so the history and the new postings sit in the same ledger.
"""
from django.db import transaction
from django.db.models import Q

from .models import AccountGroup, ChartOfAccount

PARTIES = {
    # kind: (model label, control role, code prefix, label, COA group, account type, subtype,
    #        code attr, name attr, opening balance attr)
    'supplier': ('purchasing.Supplier', 'SUPPLIER_PAYABLE', 'AP', 'Supplier', 'Sundry Creditors', 'Liability',
                 'PAYABLE', 'supplier_code', 'name', 'outstanding_balance'),
    'dealer': ('sales.Dealer', 'WHOLESALE_RECEIVABLE', 'AR', 'Dealer', 'Sundry Debtors', 'Asset',
               'RECEIVABLE', 'dealer_code', 'business_name', 'opening_balance'),
}


def party_kind(party):
    return {cfg[0].split('.')[1]: kind for kind, cfg in PARTIES.items()}.get(type(party).__name__)


def ledger_name(kind, party):
    _, _, _, label, _, _, _, code_attr, name_attr, _ = PARTIES[kind]
    return f"{getattr(party, name_attr) or label} ({label} {getattr(party, code_attr)})"[:150]


def _control_account(role):
    from .mapping import resolve_role
    try:
        return resolve_role(role)
    except Exception:  # unmapped control: the ledger is still created, just not nested
        return None


def _group(name, acc_type):
    group = AccountGroup.objects.filter(name=name).first()
    if group is None:
        return AccountGroup.objects.create(name=name, account_type=acc_type)
    if group.account_type != acc_type:
        group, _ = AccountGroup.objects.get_or_create(name=f"{name} ({acc_type})", defaults={'account_type': acc_type})
    return group


def ensure_party_ledger(party, kind=None):
    """The party's sub-ledger, created (and linked on the party) if it has none. Idempotent:
    a ledger already carrying the party's code is reused rather than duplicated."""
    kind = kind or party_kind(party)
    _, role, prefix, label, group_name, acc_type, subtype, code_attr, _, opening_attr = PARTIES[kind]
    if party.ledger_account_id:
        return party.ledger_account
    party_code = getattr(party, code_attr)
    if not party_code:
        return None
    code = f"{prefix}-{party_code}"[:50]
    name = ledger_name(kind, party)
    # savepoint=False: inside a save that is already atomic this only groups the writes. Each
    # SAVEPOINT / RELEASE is its own round trip (~250 ms each on the hosted database), and an
    # error still undoes the whole save.
    with transaction.atomic(savepoint=False):
        # One query answers both "is there a ledger with this code?" and "is the name taken?"
        # (a hand-made account may already have it) — the name clash used to be found by
        # attempting the INSERT inside a savepoint and catching the IntegrityError.
        found = list(ChartOfAccount.all_objects.filter(Q(code=code) | Q(name=name)))
        account = next((a for a in found if a.code == code), None)
        if account is None:
            control = _control_account(role)
            fields = dict(code=code, account_group=_group(group_name, acc_type), parent_account=control,
                          account_subtype=subtype, status='Active',
                          # Typed only; reaches the books via "Post opening balances", like any account.
                          opening_balance=getattr(party, opening_attr, 0) or 0,
                          description=f"{label} sub-ledger, created automatically with the {label.lower()}.")
            if any(a.name == name for a in found):
                name = f"{name[:140]} [{code}]"[:150]
            account = ChartOfAccount.objects.create(name=name, **fields)
        elif account.is_deleted:
            account.is_deleted = False
            account.save(update_fields=['is_deleted', 'updated_at'])
        type(party).all_objects.filter(pk=party.pk).update(ledger_account=account)
        party.ledger_account = account
    return account


def sync_ledger_name(party, kind=None):
    """Keep the ledger head's name in step with a renamed party (best effort: a name another
    account already uses is left alone)."""
    kind = kind or party_kind(party)
    acc = party.ledger_account if party.ledger_account_id else None
    if acc is None:
        return
    name = ledger_name(kind, party)
    if acc.name == name or ChartOfAccount.all_objects.filter(name=name).exclude(pk=acc.pk).exists():
        return
    ChartOfAccount.all_objects.filter(pk=acc.pk).update(name=name)


def party_account(party):
    """The account a party's postings use: its own live sub-ledger, else None (caller falls
    back to the control role)."""
    acc = getattr(party, 'ledger_account', None) if party is not None else None
    if acc is not None and not acc.is_deleted and acc.status == 'Active':
        return acc
    return None


def on_party_saved(sender, instance, created=False, raw=False, **kwargs):
    if raw:
        return
    from apps.common import tenancy
    with tenancy.use_tenant(instance.tenant_id):
        if created:
            ensure_party_ledger(instance)
        else:
            sync_ledger_name(instance)


# Documents whose postings name the party's ledger: (source key, model label, party FK attr).
PARTY_SOURCES = {
    'supplier': [('purchasing.purchase_invoice', 'purchasing.PurchaseInvoice', 'supplier_id'),
                 ('purchasing.purchase_payment', 'purchasing.PurchaseInvoice', 'supplier_id'),
                 ('purchasing.purchase_order', 'purchasing.PurchaseOrder', 'supplier_id'),
                 ('purchasing.purchase_return', 'purchasing.PurchaseReturn', 'supplier_id')],
    'dealer': [('sales.wholesale_invoice', 'sales.WholesaleInvoice', 'dealer_id'),
               ('sales.wholesale_collection', 'sales.WholesalePaymentCollection', 'dealer_id'),
               ('sales.wholesale_return', 'sales.WholesaleReturn', 'dealer_id')],
}


def link_existing_parties(kinds=None, commit=False, user=None):
    """Give every supplier / dealer that has no sub-ledger one, and move its history there:
    each of its documents that is on the books is re-booked (reverse on the control account,
    re-post on the sub-ledger), so the party's whole balance sits in one ledger. Documents
    not on the books (historical / never posted) are left alone. Dry run unless commit."""
    from django.apps import apps as django_apps
    from . import integration
    from .models import JournalEntry
    from .services import audit

    report = []
    for kind in (kinds or list(PARTIES)):
        model = django_apps.get_model(PARTIES[kind][0])
        for party in model.objects.filter(ledger_account__isnull=True).order_by(PARTIES[kind][7]):
            docs = []
            for key, label, fk in PARTY_SOURCES[kind]:
                module, event = integration.split_key(key)
                ids = list(django_apps.get_model(label).all_objects.filter(**{fk: party.pk}).values_list('pk', flat=True))
                live = JournalEntry.objects.filter(source_module=module, source_event=event, reference_id__in=ids,
                                                   status='POSTED', is_reversal=False).values_list('reference_id', flat=True)
                docs += [(key, pk) for pk in live]
            row = {'kind': kind, 'id': str(party.pk), 'code': getattr(party, PARTIES[kind][7]),
                   'name': getattr(party, PARTIES[kind][8]), 'ledger': f"{PARTIES[kind][2]}-{getattr(party, PARTIES[kind][7])}",
                   'documents': len(docs)}
            if commit:
                acc = ensure_party_ledger(party, kind)
                row['ledger'] = f"{acc.code} {acc.name}" if acc else None
                results = [integration.book_source_safely(key, pk, user=user, force=True, cascade=False) for key, pk in docs]
                row['rebooked'] = sum(1 for r in results if r.get('outcome') not in ('failed',))
                row['failed'] = sum(1 for r in results if r.get('outcome') == 'failed')
            report.append(row)
    if commit and report:
        audit('PARTY_LEDGERS_LINKED', 'party_ledger', '', f"Linked {len(report)} party sub-ledger(s)",
              after={'parties': len(report), 'documents': sum(r['documents'] for r in report)}, user=user)
    return report
