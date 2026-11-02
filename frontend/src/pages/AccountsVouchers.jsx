// Accounts module: Payment / Receipt Voucher entry and the Accounts → Reports section
// (Payment / Receipt Voucher, Expense, Customer / Supplier Outstanding, Accounts Activity). Entry uses the same voucher form and posting
// service as Financial → Vouchers, so a voucher saved here is on the same books.
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Box, Tab, Tabs, Typography } from '@mui/material';
import StandardVoucherForm from '../components/financial/StandardVoucherForm';
import VoucherReport from '../components/accounts/VoucherReport';
import ExpenseReport from '../components/accounts/ExpenseReport';
import OutstandingReport from '../components/accounts/OutstandingReport';
import AccountsActivityReport from '../components/accounts/AccountsActivityReport';
import useVoucherMasters from '../components/accounts/useVoucherMasters';
import { apiError, finPost } from '../components/financial/financialApi';
import { notify } from '../utils/notify';

const ACCOUNTS_VOUCHER_TABS = [
  { path: '/accounts/vouchers/payment', label: 'Payment Voucher', voucherType: 'PAYMENT' },
  { path: '/accounts/vouchers/receipt', label: 'Receipt Voucher', voucherType: 'RECEIPT' },
];
const ACCOUNTS_REPORT_TABS = [
  { path: '/accounts/reports/payment-vouchers', label: 'Payment Voucher Report', voucher: 'PV' },
  { path: '/accounts/reports/receipt-vouchers', label: 'Receipt Voucher Report', voucher: 'RV' },
  { path: '/accounts/reports/expenses', label: 'Expense Report', render: () => <ExpenseReport /> },
  { path: '/accounts/reports/customer-outstanding', label: 'Customer Outstanding', render: () => <OutstandingReport key="receivable" side="receivable" /> },
  { path: '/accounts/reports/supplier-outstanding', label: 'Supplier Outstanding', render: () => <OutstandingReport key="payable" side="payable" /> },
  { path: '/accounts/reports/activity', label: 'Accounts Activity', render: () => <AccountsActivityReport /> },
];

function ReportView({ tab }) {
  return tab.render ? tab.render() : <VoucherReport key={tab.voucher} voucher={tab.voucher} />;
}

function VoucherEntry({ tab }) {
  const { accounts, cashOrBankAccounts, partiesList, reloadAccounts } = useVoucherMasters();

  // A voucher is never "saved" unless the posting service put it on the books.
  const postVoucher = async (payload) => {
    try {
      const entry = await finPost('journals/', payload);
      notify(`${entry.voucher_type_name || 'Voucher'} ${entry.entry_number} posted.`, 'success');
      reloadAccounts();
      return entry;
    } catch (e) {
      notify(apiError(e, 'The voucher could not be posted.'), 'error');
      return null;
    }
  };

  return (
    <StandardVoucherForm
      key={tab.voucherType}
      voucherType={tab.voucherType}
      accounts={accounts}
      cashOrBankAccounts={cashOrBankAccounts}
      partiesList={partiesList}
      showToast={notify}
      onSaveVoucher={postVoucher}
      onPosted={reloadAccounts}
    />
  );
}

export default function AccountsVouchers() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isReports = pathname.startsWith('/accounts/reports');
  const tabs = isReports ? ACCOUNTS_REPORT_TABS : ACCOUNTS_VOUCHER_TABS;
  const tab = tabs.find(t => pathname.startsWith(t.path)) || tabs[0];

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, pb: 8 }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>{isReports ? 'Accounts Reports' : 'Accounts Vouchers'}</Typography>
        <Typography variant="body2" color="text.secondary">
          {isReports
            ? 'Vouchers, expenses, customer and supplier dues, and every entry on the books, with date filters, search, print and CSV.'
            : 'Record money paid out and received. Every voucher posts straight to the ledger.'}
        </Typography>
      </Box>
      <Tabs value={tab.path} onChange={(e, path) => navigate(path)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
        sx={{ mb: 3, borderBottom: '1px solid #e2e8f0' }}>
        {tabs.map(t => <Tab key={t.path} value={t.path} label={t.label} sx={{ fontWeight: 700, textTransform: 'none' }} />)}
      </Tabs>
      {isReports ? <ReportView tab={tab} /> : <VoucherEntry tab={tab} />}
    </Box>
  );
}
