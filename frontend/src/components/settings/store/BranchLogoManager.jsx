// Per-branch logo overrides (multi-branch mode). A branch with its own logo prints it on every
// bill; a branch without one prints the store logo. Each change saves immediately through
// /api/company/store-profile/branch-logo/<id>/ — it is separate from the profile form's Save.
import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Avatar, Box, Button, CircularProgress, Stack, Typography,
} from '@mui/material';
import {
  CloudUpload as UploadIcon, DeleteOutline as DeleteIcon, Image as ImageIcon,
} from '@mui/icons-material';
import { useBranch } from '../../../context/BranchContext';
import { invalidateBillingContext } from '../../../billing/billingContext';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { fetchStoreProfile } from '../../../utils/storeProfile';
import { GREEN, GREEN_SOFT, prepareLogo } from './storeUi';

const logoUrl = (id) => `/api/company/store-profile/branch-logo/${id}/`;

function BranchLogoRow({ branch, storeLogo }) {
  const [logo, setLogo] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ error: '', warning: '' });
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    axios.get(logoUrl(branch.id))
      .then(({ data }) => { if (alive) setLogo(data.logo_data_url || ''); })
      .catch(() => { if (alive) setMsg({ error: 'Could not load this branch’s logo.', warning: '' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [branch.id]);

  const save = async (value, warning = '') => {
    setBusy(true);
    try {
      const { data } = await axios.put(logoUrl(branch.id), { logo_data_url: value });
      setLogo(data.logo_data_url || '');
      setMsg({ error: '', warning });
      invalidateBillingContext();
      fetchStoreProfile().catch(() => {});
      notify(value ? `Logo saved for ${branch.name}.` : `${branch.name} now prints the store logo.`);
    } catch (err) {
      setMsg({ error: apiErrorMessage(err, 'Could not save the branch logo.'), warning: '' });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { dataUrl, warning } = await prepareLogo(file);
      await save(dataUrl, warning);
    } catch (err) {
      setMsg({ error: err.message || 'Could not use this image.', warning: '' });
    }
  };

  const shown = logo || storeLogo;
  return (
    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', py: 1, borderTop: 1, borderColor: 'divider' }}>
      <Avatar
        variant="rounded"
        src={shown || undefined}
        alt={`${branch.name} logo`}
        sx={{
          width: 56, height: 56, bgcolor: 'background.default', color: 'text.disabled',
          border: '1px dashed', borderColor: logo ? GREEN : 'divider', opacity: logo ? 1 : 0.55,
          '& img': { objectFit: 'contain', p: 0.5 },
        }}
      >
        <ImageIcon />
      </Avatar>
      <Box sx={{ flex: 1, minWidth: 160 }}>
        <Typography variant="body2" fontWeight={700}>
          {branch.name}{branch.code ? ` (${branch.code})` : ''}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {loading ? 'Loading…' : logo ? 'Prints its own logo' : 'Uses the store logo'}
        </Typography>
        {msg.error && <Typography variant="caption" color="error" role="alert" sx={{ display: 'block' }}>{msg.error}</Typography>}
        {msg.warning && <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>{msg.warning}</Typography>}
      </Box>
      <Stack direction="row" spacing={1} alignItems="center">
        {busy && <CircularProgress size={18} />}
        <Button
          size="small"
          variant="outlined"
          startIcon={<UploadIcon />}
          disabled={loading || busy}
          onClick={() => fileRef.current?.click()}
          sx={{ fontWeight: 700, color: GREEN, borderColor: GREEN, '&:hover': { borderColor: GREEN, bgcolor: GREEN_SOFT } }}
        >
          {logo ? 'Replace' : 'Upload'}
        </Button>
        <Button
          size="small"
          color="error"
          startIcon={<DeleteIcon />}
          disabled={loading || busy || !logo}
          onClick={() => save('')}
          sx={{ fontWeight: 700 }}
        >
          Use Store Logo
        </Button>
      </Stack>
      <input
        ref={fileRef}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
        onChange={onFile}
        aria-label={`Upload logo for ${branch.name}`}
      />
    </Box>
  );
}

export default function BranchLogoManager({ storeLogo }) {
  const { branches } = useBranch();
  if (!branches?.length) return null;
  return (
    <Box id="sp-branch-logos" sx={{ mb: 3 }}>
      <Typography variant="subtitle2" fontWeight={800}>Branch Logos</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Optional. A branch with its own logo prints it on its bills; the others print the store logo.
        Changes here save immediately.
      </Typography>
      {branches.map((b) => <BranchLogoRow key={b.id} branch={b} storeLogo={storeLogo} />)}
    </Box>
  );
}
