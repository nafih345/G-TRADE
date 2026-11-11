"""Shared vocabulary for Sales Return (sales.SalesReturn) and Purchase Return
(purchasing.PurchaseReturn). Pure constants — imported by both apps' models, so it must not
import any model itself."""

# Why a line came back. OTHER and EXCHANGE need a note (the screen asks for it, the API refuses
# a blank one).
RETURN_REASONS = (
    ('DAMAGED', 'Damaged'),
    ('DEFECTIVE', 'Defective'),
    ('POWER_MISMATCH', 'Power / Specification Mismatch'),
    ('WRONG_ITEM', 'Wrong Item Delivered'),
    ('EXCHANGE', 'Customer Exchange'),
    ('OTHER', 'Other Issue'),
)
REASON_LABELS = dict(RETURN_REASONS)
REASONS_NEEDING_NOTE = {'OTHER', 'EXCHANGE'}

# How the return value is settled. GPAY and BANK need a bank ledger (a BANK-subtype Chart of
# Accounts row); CREDIT moves no money — it adjusts the party's receivable / payable instead.
SETTLEMENT_MODES = (
    ('CASH', 'Cash'),
    ('GPAY', 'GPay / UPI'),
    ('BANK', 'Bank Transfer'),
    ('CREDIT', 'Credit Note / Ledger Adjustment'),
)
MODE_LABELS = dict(SETTLEMENT_MODES)
BANK_MODES = {'GPAY', 'BANK'}
# The header's payment_mode: one of the modes above, or SPLIT when more than one was used.
PAYMENT_MODE_CHOICES = SETTLEMENT_MODES + (('SPLIT', 'Split'),)

RETURN_STATUSES = (
    ('COMPLETED', 'Completed'),
    ('CANCELLED', 'Cancelled'),
)
