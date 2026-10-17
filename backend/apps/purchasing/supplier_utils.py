"""
Concurrency-safe Supplier.supplier_code generation, plus auto-provisioning of each
supplier's individual Chart of Accounts ledger.

reserve_supplier_codes mirrors apps.sales.patient_utils.reserve_patient_codes /
apps.products.barcode_utils.reserve_barcodes: a single atomic UPDATE ... RETURNING
statement rather than select_for_update() + read-modify-write, since select_for_update()
is a silent no-op on SQLite (which this app also runs under as a packaged desktop build).
"""

from .models import SupplierCodeSequence
from apps.common.sequences import bump_sequence

DEFAULT_PREFIX = 'SUP'


def reserve_supplier_codes(prefix=DEFAULT_PREFIX, count=1):
    """Atomically reserves `count` sequential supplier codes (e.g. SUP-1001) for `prefix`."""
    new_last = bump_sequence(SupplierCodeSequence, {'prefix': prefix}, count, defaults={'last_number': 1000})
    start = new_last - count + 1
    return [f"{prefix}-{start + i}" for i in range(count)]


def get_or_create_supplier_ledger_account(supplier):
    """
    Provisions (or returns the existing) Chart of Accounts sub-ledger for a supplier, filed
    under the "Sundry Creditors" Liability group. Code is derived from supplier_code so it
    stays stable and unique even if the supplier is later renamed.
    """
    from apps.financial.models import AccountGroup, ChartOfAccount

    if supplier.ledger_account_id:
        return supplier.ledger_account

    group, _ = AccountGroup.objects.get_or_create(
        name='Sundry Creditors',
        defaults={'account_type': 'Liability'}
    )
    code = f"AP-{supplier.supplier_code}"
    # ChartOfAccount.name is unique, but Supplier.name isn't (two suppliers can legitimately
    # share a company name) — folding supplier_code into the ledger name keeps it unique
    # without colliding, since supplier_code always is.
    account, _ = ChartOfAccount.objects.get_or_create(
        code=code,
        defaults={
            'name': f"{supplier.name} (Supplier {supplier.supplier_code})",
            'account_group': group,
            'opening_balance': supplier.outstanding_balance or 0,
            'current_balance': supplier.outstanding_balance or 0,
            'status': 'Active'
        }
    )
    return account
