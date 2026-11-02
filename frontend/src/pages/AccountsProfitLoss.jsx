// Accounts → Profit & Loss: grouped P&L statement (direct / indirect income and expenses,
// gross and net profit) over a daily, monthly, quarterly, financial-year or custom period.
import React from 'react';
import { Box, Typography } from '@mui/material';
import ProfitLossStatement from '../components/accounts/ProfitLossStatement';

export default function AccountsProfitLoss() {
  return (
    <Box sx={{ p: { xs: 2, md: 4 }, pb: 8 }}>
      <Box sx={{ mb: 3 }} className="no-print">
        <Typography variant="h4" sx={{ fontWeight: 800 }}>Profit &amp; Loss</Typography>
        <Typography variant="body2" color="text.secondary">
          Revenue against costs and expenses for the period, from posted journals. Gross profit after direct costs, net profit after everything.
        </Typography>
      </Box>
      <ProfitLossStatement />
    </Box>
  );
}
