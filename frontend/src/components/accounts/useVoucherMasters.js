// Masters the Receipt / Payment voucher form needs outside the Financial module: the Chart of
// Accounts (with ledger balances), its cash / bank subset and the supplier / dealer party list.
// Same shapes FinancialManagement hands StandardVoucherForm, read from the same endpoints.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiError, finGet } from '../financial/financialApi';
import { fetchAllPages } from '../../utils/fetchAllPages';
import { notify } from '../../utils/notify';

const TYPES = { ASSET: 'Assets', ASSETS: 'Assets', LIABILITY: 'Liabilities', LIABILITIES: 'Liabilities', EQUITY: 'Equity', INCOME: 'Income', EXPENSE: 'Expenses', EXPENSES: 'Expenses' };
const str = (v) => (v !== null && v !== undefined ? String(v).trim() : '');

const toAccount = (a) => ({
  id: a.id,
  code: str(a.code),
  name: str(a.name),
  account_type: TYPES[String(a.account_type || '').toUpperCase()] || 'Assets',
  backend_type: a.account_type,
  account_group: a.account_group_name || '',
  account_group_id: a.account_group,
  account_subtype: a.account_subtype || '',
  parent_account_id: a.parent_account || null,
  current_balance: parseFloat(a.ledger_balance || 0),
  status: a.status === 'Inactive' ? 'Inactive' : 'Active',
  is_system: !!a.is_system,
  description: str(a.description),
});

export default function useVoucherMasters() {
  const [accounts, setAccounts] = useState([]);
  const [partiesList, setPartiesList] = useState([]);

  const reloadAccounts = useCallback(async () => {
    try {
      const rows = await finGet('accounts/', { with_balances: 1 });
      setAccounts((Array.isArray(rows) ? rows : (rows.results || [])).map(toAccount));
    } catch (e) {
      notify(apiError(e, 'Could not load the Chart of Accounts.'), 'error');
    }
  }, []);

  useEffect(() => {
    reloadAccounts();
    (async () => {
      const [suppliers, dealers] = await Promise.all([
        fetchAllPages('/api/purchase/suppliers/').catch(() => []),
        fetchAllPages('/api/sales/wholesale/dealers/').catch(() => []),
      ]);
      setPartiesList([
        ...(suppliers || []).map(s => ({ id: s.id, name: s.name, code: s.supplier_code, category: 'Supplier' })),
        ...(dealers || []).map(d => ({ id: d.id, name: d.business_name, code: d.dealer_code, category: 'Wholesale Dealer' })),
      ]);
    })();
  }, [reloadAccounts]);

  const cashOrBankAccounts = useMemo(() => accounts.filter(a => {
    const grp = a.account_group.toLowerCase();
    const name = a.name.toLowerCase();
    return grp.includes('cash') || grp.includes('bank') || name.includes('cash') || name.includes('bank') || a.code === '1001' || a.code === '1002';
  }), [accounts]);

  return { accounts, cashOrBankAccounts, partiesList, reloadAccounts };
}
