#!/usr/bin/env python
import os
import sys
import csv
import argparse
import logging
from decimal import Decimal
import datetime

# Ensure Django environment is configured
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django
django.setup()

from django.db import transaction
from apps.financial.models import AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry
from apps.financial.services import get_or_create_account, get_or_create_voucher_type

# Configure manual review log file
LOG_FILE = os.path.join(BASE_DIR, "scripts", "manual_review.log")
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.WARNING,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("LegacyLedgerImport")

# Mapping of known VTYPE codes to friendly names
VTYPE_MAP = {
    'CS': 'Cash Sale',
    'CE': 'Credit Estimate',
    'OB': 'Opening Balance',
    'JV': 'Journal Voucher',
    'PV': 'Payment Voucher',
    'RV': 'Receipt Voucher',
    'PUR': 'Purchase Order',
    'SAL': 'Sales Invoice'
}

def parse_date(val):
    if not val:
        return datetime.date.today()
    val_str = str(val).strip().split('T')[0]
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%Y/%m/%d'):
        try:
            return datetime.datetime.strptime(val_str, fmt).date()
        except ValueError:
            pass
    return datetime.date.today()

def import_legacy_ledger_csv(csv_filepath):
    print(f"Starting import of legacy LedgerSheets from: {csv_filepath}")
    
    if not os.path.exists(csv_filepath):
        print(f"Error: File '{csv_filepath}' does not exist.")
        return

    total_rows = 0
    imported_count = 0
    flagged_count = 0

    with open(csv_filepath, mode='r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        
        for row_index, row in enumerate(reader, start=1):
            total_rows += 1
            
            dr_code = (row.get('DR_AC_CODE') or row.get('dr_ac_code') or '').strip()
            cr_code = (row.get('CR_AC_CODE') or row.get('cr_ac_code') or '').strip()
            amount_raw = (row.get('AMOUNT') or row.get('amount') or '0').strip()
            vtype_raw = (row.get('VTYPE') or row.get('vtype') or 'JV').strip()
            vno_raw = (row.get('VNO') or row.get('vno') or f"LEG-{row_index}").strip()
            vdate_raw = row.get('VDATE') or row.get('vdate') or row.get('date')
            narration = row.get('NARRATION') or row.get('narration') or f"Legacy import voucher #{vno_raw}"

            # Flags translation
            is_reverse = str(row.get('isReverse', '')).strip().lower() in ('1', 'true', 'yes')
            is_unposting = str(row.get('is_UnPosting', '')).strip().lower() in ('1', 'true', 'yes')

            # Validation: DR_AC_CODE / CR_AC_CODE cannot be NULL
            if not dr_code or not cr_code:
                flagged_count += 1
                msg = (f"Row {row_index} [VNO: {vno_raw}] Flagged for Manual Review: "
                       f"DR_AC_CODE='{dr_code}', CR_AC_CODE='{cr_code}'. Skipping auto-import.")
                print(f"⚠️  {msg}")
                logger.warning(msg)
                continue

            try:
                amt = Decimal(amount_raw)
                if amt <= 0:
                    continue
            except Exception:
                flagged_count += 1
                msg = f"Row {row_index} [VNO: {vno_raw}]: Invalid amount '{amount_raw}'. Flagged for review."
                logger.warning(msg)
                continue

            # Lookup or create VoucherType
            vtype_name = VTYPE_MAP.get(vtype_raw.upper(), f"Voucher {vtype_raw.upper()}")
            vtype_obj = get_or_create_voucher_type(vtype_raw, vtype_name)

            # Lookup or create ChartOfAccount records for DR and CR
            dr_account = get_or_create_account(dr_code, f"Account {dr_code}", "Current Assets", "Asset")
            cr_account = get_or_create_account(cr_code, f"Account {cr_code}", "Retail Sales", "Income")

            # Determine status from legacy flags
            if is_unposting:
                status = 'CANCELLED'
            elif is_reverse:
                status = 'REVERSED'
            else:
                status = 'POSTED'

            vdate = parse_date(vdate_raw)

            with transaction.atomic():
                # Avoid duplicate entry numbers
                entry_num = f"LEG-{vtype_raw.upper()}-{vno_raw}"
                if JournalEntry.objects.filter(entry_number=entry_num).exists():
                    entry_num = f"LEG-{vtype_raw.upper()}-{vno_raw}-{row_index}"

                je = JournalEntry.objects.create(
                    entry_number=entry_num,
                    date=vdate,
                    narration=narration,
                    voucher_type=vtype_obj,
                    reference_type='LEGACY_IMPORT',
                    reference_id=row_index,
                    status=status
                )

                # Debit line
                LedgerEntry.objects.create(
                    journal_entry=je,
                    account=dr_account,
                    debit=amt,
                    credit=Decimal('0.00')
                )

                # Credit line
                LedgerEntry.objects.create(
                    journal_entry=je,
                    account=cr_account,
                    debit=Decimal('0.00'),
                    credit=amt
                )

                # Update account current_balance if POSTED
                if status == 'POSTED':
                    dr_type = dr_account.account_group.account_type
                    cr_type = cr_account.account_group.account_type

                    if dr_type in ['Asset', 'Expense']:
                        dr_account.current_balance += amt
                    else:
                        dr_account.current_balance -= amt
                    dr_account.save(update_fields=['current_balance'])

                    if cr_type in ['Asset', 'Expense']:
                        cr_account.current_balance -= amt
                    else:
                        cr_account.current_balance += amt
                    cr_account.save(update_fields=['current_balance'])

            imported_count += 1

    print("\n" + "="*60)
    print("LEGACY LEDGER IMPORT SUMMARY")
    print("="*60)
    print(f"Total Rows Processed:   {total_rows}")
    print(f"Successfully Imported: {imported_count}")
    print(f"Flagged for Review:     {flagged_count}")
    print(f"Manual Review Log:      {LOG_FILE}")
    print("="*60 + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import legacy LedgerSheets data into Django Financial app.")
    parser.add_argument("--csv", default=os.path.join(BASE_DIR, "scripts", "data", "ledgersheets.csv"), help="Path to CSV export of LedgerSheets")
    args = parser.parse_args()
    
    import_legacy_ledger_csv(args.csv)
