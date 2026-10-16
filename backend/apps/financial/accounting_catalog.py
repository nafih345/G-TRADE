"""Static catalog for the accounting integration: default Chart of Accounts, the posting
roles the rules ask for, and the operational sources the engine books.

Nothing in application logic refers to an account by id or code. A posting rule asks for a
role ("RETAIL_SALES"), and mapping.resolve_role() returns whatever account an
AccountMapping currently points that role at. The codes below are only the *defaults* the
seed migration creates and maps; they match the codes the earlier hard-coded signals used
(1001/1002/1003/1004/2001/2020/4001/4002/5050), so existing ledgers keep their accounts.
"""

# (code, name, group, account_type, subtype, is_system)
DEFAULT_ACCOUNTS = [
    ('1001', 'Cash in Hand', 'Cash Accounts', 'Asset', 'CASH', True),
    ('1002', 'Bank Account', 'Bank Accounts', 'Asset', 'BANK', True),
    ('1003', 'Optical Stock Inventory', 'Inventory Assets', 'Asset', 'INVENTORY', True),
    ('1004', 'Customer Accounts Receivable', 'Accounts Receivable', 'Asset', 'RECEIVABLE', True),
    ('1005', 'Wholesale Dealer Receivables', 'Accounts Receivable', 'Asset', 'RECEIVABLE', True),
    ('1020', 'GST Input Tax Credit', 'Tax Assets', 'Asset', 'TAX_ASSET', True),
    ('1500', 'Furniture & Fixtures', 'Fixed Assets', 'Asset', 'FIXED_ASSET', False),
    ('1510', 'Optical Equipment', 'Fixed Assets', 'Asset', 'FIXED_ASSET', False),
    ('2001', 'Supplier Accounts Payable', 'Accounts Payable', 'Liability', 'PAYABLE', True),
    ('2020', 'GST Output Tax Payable', 'GST Payable', 'Liability', 'TAX_LIABILITY', True),
    ('2030', 'Customer Advances', 'Current Liabilities', 'Liability', 'ADVANCE', True),
    ('3001', 'Opening Balance Equity', 'Capital Account', 'Equity', 'EQUITY', True),
    ('4001', 'Retail Frame & Lens Sales', 'Retail Sales', 'Income', 'REVENUE', True),
    ('4002', 'Wholesale B2B Revenue', 'Wholesale Sales', 'Income', 'REVENUE', True),
    ('4003', 'Optical Service Revenue', 'Service Income', 'Income', 'REVENUE', True),
    ('4080', 'Stock Adjustment Gain', 'Other Income', 'Income', 'OTHER_INCOME', True),
    ('4090', 'Sales Returns & Allowances', 'Sales Returns', 'Income', 'CONTRA_REVENUE', True),
    ('5001', 'Cost of Goods Sold', 'Direct Expenses', 'Expense', 'COGS', True),
    ('5050', 'Discount Allowed', 'Selling', 'Expense', 'EXPENSE', True),
    ('5060', 'Inventory Shrinkage & Write-offs', 'Direct Expenses', 'Expense', 'EXPENSE', True),
    ('5070', 'Round Off', 'Indirect Expenses', 'Expense', 'EXPENSE', True),
    ('5100', 'Rent', 'Indirect Expenses', 'Expense', 'EXPENSE', False),
    ('5110', 'Salaries & Wages', 'Indirect Expenses', 'Expense', 'EXPENSE', False),
    ('5120', 'Electricity & Utilities', 'Indirect Expenses', 'Expense', 'EXPENSE', False),
    ('5130', 'General Administrative Expenses', 'Indirect Expenses', 'Expense', 'EXPENSE', False),
]

# role -> (label, default account code, allowed account types, description)
ROLES = {
    'CASH': ('Cash', '1001', ('Asset',), 'Cash receipts and payments (POS cash, cash purchases).'),
    'BANK': ('Bank', '1002', ('Asset',), 'Bank transfers / cheques, and the fallback for unrecognised payment methods.'),
    'PAYMENT_CARD': ('Card settlements', '1002', ('Asset',), 'Card payments taken at the counter.'),
    'PAYMENT_UPI': ('UPI settlements', '1002', ('Asset',), 'UPI / wallet payments.'),
    'INVENTORY': ('Inventory', '1003', ('Asset',), 'Stock on hand, valued at cost.'),
    'RETAIL_RECEIVABLE': ('Retail receivables', '1004', ('Asset',), 'Amounts retail / optical customers owe.'),
    'WHOLESALE_RECEIVABLE': ('Wholesale receivables', '1005', ('Asset',), 'Amounts wholesale dealers owe.'),
    'GST_INPUT': ('GST input credit', '1020', ('Asset',), 'GST / VAT / cess paid on purchases.'),
    'SUPPLIER_PAYABLE': ('Supplier payables', '2001', ('Liability',), 'Used when a supplier has no own sub-ledger account.'),
    'GST_OUTPUT': ('GST output tax', '2020', ('Liability',), 'GST collected on sales.'),
    'CUSTOMER_ADVANCES': ('Customer advances', '2030', ('Liability',), 'Money taken against orders / quotations before they are invoiced.'),
    'OPENING_EQUITY': ('Opening balance equity', '3001', ('Equity',), 'Contra account for posted opening balances.'),
    'RETAIL_SALES': ('Retail product sales', '4001', ('Income',), 'Frames, lenses and other products sold at retail.'),
    'WHOLESALE_SALES': ('Wholesale sales', '4002', ('Income',), 'Wholesale / B2B invoices.'),
    'SERVICE_REVENUE': ('Service revenue', '4003', ('Income',), 'Optical services (repairs, fitting, eye tests) billed on invoices.'),
    'STOCK_GAIN': ('Stock adjustment gain', '4080', ('Income',), 'Stock found / added by adjustment.'),
    'SALES_RETURNS': ('Sales returns', '4090', ('Income', 'Expense'), 'Credit notes and returns (contra revenue).'),
    'COGS': ('Cost of goods sold', '5001', ('Expense',), 'Cost of stock that left on a sale.'),
    'DISCOUNT_ALLOWED': ('Discount allowed', '5050', ('Expense', 'Income'), 'Bill-level discounts on sales.'),
    'STOCK_LOSS': ('Stock loss / write-off', '5060', ('Expense',), 'Stock removed by adjustment (damage, loss, write-off).'),
    'ROUND_OFF': ('Round off', '5070', ('Expense', 'Income'), 'Rounding differences on purchase bills.'),
}

# Operational documents the engine books. source_key -> (label, description of the rule)
SOURCES = {
    'sales.invoice': ('Retail / optical invoice', 'Dr Receivable + Discount; Cr Product / Service revenue + GST output; Dr COGS / Cr Inventory for stocked lines'),
    'sales.payment': ('Retail receipt / refund', 'Dr Cash/Bank/Card/UPI; Cr Receivable (or Customer Advances when the bill is not yet an invoice). Negative = refund.'),
    'sales.wholesale_invoice': ('Wholesale invoice', 'Dr Wholesale receivable; Cr Wholesale revenue + GST output'),
    'sales.wholesale_collection': ('Wholesale collection', 'Dr Cash/Bank; Cr Wholesale receivable'),
    'sales.wholesale_return': ('Wholesale return / credit note', 'Dr Sales returns + GST output; Cr Wholesale receivable'),
    'purchasing.purchase_invoice': ('Purchase entry (supplier invoice)', 'Dr Inventory + GST input (+/- round off); Cr Supplier payable'),
    'purchasing.purchase_payment': ('Purchase entry payment', 'Dr Supplier payable; Cr Cash/Bank'),
    'purchasing.purchase_order': ('Purchase order received directly', 'Dr Inventory + GST input; Cr Supplier payable (only when the PO itself moved stock)'),
    'inventory.stock_adjustment': ('Stock adjustment', 'ADD: Dr Inventory / Cr Stock gain. SUB: Dr Stock loss (or COGS for a wholesale POS sale) / Cr Inventory'),
}

# Legacy JournalEntry.reference_type -> (source_module, source_event), for adopting entries
# posted by the old signal handlers.
LEGACY_REFERENCE_TYPES = {
    'SALE': ('sales', 'invoice'),
    'WHOLESALE': ('sales', 'invoice'),
    'PAYMENT_RECEIPT': ('sales', 'payment'),
    'PURCHASE': ('purchasing', 'purchase_order'),
}

# Payment method text -> role. Matched as lowercase substrings in this order.
PAYMENT_METHOD_ROLES = [
    ('upi', 'PAYMENT_UPI'),
    ('gpay', 'PAYMENT_UPI'),
    ('phonepe', 'PAYMENT_UPI'),
    ('paytm', 'PAYMENT_UPI'),
    ('wallet', 'PAYMENT_UPI'),
    ('card', 'PAYMENT_CARD'),
    ('cash', 'CASH'),
    ('bank', 'BANK'),
    ('neft', 'BANK'),
    ('rtgs', 'BANK'),
    ('imps', 'BANK'),
    ('cheque', 'BANK'),
    ('transfer', 'BANK'),
]


def payment_role(method):
    text = (method or '').strip().lower()
    if not text:
        return 'CASH'
    for needle, role in PAYMENT_METHOD_ROLES:
        if needle in text:
            return role
    return 'BANK'


def is_credit_method(method):
    text = (method or '').strip().lower()
    return text in ('credit', 'credit sale', 'on credit', 'credit_sale')
