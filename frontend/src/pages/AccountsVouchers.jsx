// Accounts module: Payment / Receipt / Contra / Journal Voucher entry, the Accounts → Reports
// section (voucher reports, Expense, Customer / Supplier Outstanding, Accounts Activity), the
// Transaction Report (every cash & bank movement, live, with admin edit / append) and Statements
// (the shared statement engine, opened on the voucher statements). Entry uses
// the same voucher forms and posting service as Financial → Vouchers, so a voucher saved here is on
// the same books.
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Box, Tab, Tabs, Typography } from '@mui/material';
import StandardVoucherForm from '../components/financial/StandardVoucherForm';
import JournalVoucherForm from '../components/financial/JournalVoucherForm';
import VoucherReport from '../components/accounts/VoucherReport';
import ExpenseReport from '../components/accounts/ExpenseReport';
import OutstandingReport from '../components/accounts/OutstandingReport';
import AccountsActivityReport from '../components/accounts/AccountsActivityReport';
import TransactionReport from '../components/accounts/TransactionReport';
import FinancialStatements from '../components/financial/FinancialStatements';
import useVoucherMasters from '../components/accounts/useVoucherMasters';
import { apiError, finPost } from '../components/financial/financialApi';
import { notify } from '../utils/notify';

const ACCOUNTS_VOUCHER_TABS = [
  { path: '/accounts/vouchers/payment', label: 'Payment Voucher', voucherType: 'PAYMENT' },
  { path: '/accounts/vouchers/receipt', label: 'Receipt Voucher', voucherType: 'RECEIPT' },
  { path: '/accounts/vouchers/contra', label: 'Contra Entry', voucherType: 'CONTRA' },
  { path: '/accounts/vouchers/journal', label: 'Journal Voucher', voucherType: 'JOURNAL' },
];
const ACCOUNTS_REPORT_TABS = [
  { path: '/accounts/reports/payment-vouchers', label: 'Payment Voucher Report', voucher: 'PV' },
  { path: '/accounts/reports/receipt-vouchers', label: 'Receipt Voucher Report', voucher: 'RV' },
  { path: '/accounts/reports/contra-entries', label: 'Contra Entry Report', voucher: 'CV' },
  { path: '/accounts/reports/journal-vouchers', label: 'Journal Voucher Report', voucher: 'JV' },
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

  if (tab.voucherType === 'JOURNAL') {
    return <JournalVoucherForm accounts={accounts} showToast={notify} onSaveVoucher={postVoucher} />;
  }

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

// Single-screen Accounts sections (no tab strip).
const ACCOUNTS_SECTIONS = [
  {
    path: '/accounts/transactions', title: 'Transaction Report',
    subtitle: 'Every cash and bank transaction across the system, updated live as it posts. Finance admins can add details, correct entries and append missing transactions.',
    render: () => <TransactionReport />,
  },
  {
    path: '/accounts/statements', title: 'Statements',
    subtitle: 'Statements for every voucher type, ledger, sub-ledger, cash & bank book and final account — print, PDF or Excel. Every posted entry is traceable to its voucher.',
    render: () => <FinancialStatements defaultType="vouchers" />,
  },
];

export default function AccountsVouchers() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const section = ACCOUNTS_SECTIONS.find(s => pathname.startsWith(s.path));
  if (section) {
    return (
      <Box sx={{ p: { xs: 2, md: 4 }, pb: 8 }}>
        <Box sx={{ mb: 3 }}>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>{section.title}</Typography>
          <Typography variant="body2" color="text.secondary">{section.subtitle}</Typography>
        </Box>
        {section.render()}
      </Box>
    );
  }
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
            : 'Record money paid out and received, transfers between cash and bank, and journal adjustments. Every voucher posts straight to the ledger.'}
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
