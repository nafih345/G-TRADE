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
    """The supplier's Accounts Payable sub-ledger, provisioned if missing. New suppliers get
    one automatically on create (financial.party_ledgers, wired in financial.signals)."""
    from apps.financial.party_ledgers import ensure_party_ledger
    return ensure_party_ledger(supplier, 'supplier')
