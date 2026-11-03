// Administration → Users: the business's admin staff create staff accounts (ID, password, role,
// branch access) directly — no approval step. Server: /api/auth/users/ (apps/authentication/
// user_admin.py), which only admin roles with full Administration access may call.
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Card, CircularProgress } from '@mui/material';
import ClientUsersPanel from '../superadmin/ClientUsersPanel';
import { apiErrorMessage } from '../../utils/apiError';

const USERS_URL = '/api/auth/users/';

export default function StaffUsersManager() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data: d } = await axios.get(USERS_URL);
      setData(d);
      setError('');
    } catch (err) {
      setError(err?.response?.status === 403
        ? 'Only admin staff (Super Admin, Administrator or Branch Admin with full Administration access) can manage user accounts.'
        : apiErrorMessage(err, 'The user list could not be loaded.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <Alert severity={data ? 'error' : 'warning'}>{error}</Alert>;
  if (!data) return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress size={28} /></Box>;

  return (
    <Card sx={{ borderRadius: 3, p: 2.5 }}>
      <ClientUsersPanel
        catalog={data.catalog}
        tenant={data}
        usersUrl={USERS_URL}
        onChanged={setData}
        seatHint="Disabled users don’t use a seat. Ask the platform administrator for more seats."
      />
    </Card>
  );
}
