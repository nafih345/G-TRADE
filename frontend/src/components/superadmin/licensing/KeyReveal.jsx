// The generated licence key with a Copy button (and a .lic download for offline activation by
// file). The key is a signed licence: it is not a password, but only the vendor hands it out.
import React from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import { ContentCopy as CopyIcon, Download as DownloadIcon } from '@mui/icons-material';
import { copy } from '../clientApi';

export const downloadLicenceFile = (licId, key) => {
  const blob = new Blob([`${key}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${licId || 'licence'}.lic`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function KeyReveal({ licence, keyText, note }) {
  const key = keyText || licence?.key || '';
  if (!key) return null;
  return (
    <Box>
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        {note || 'Send this licence key to the customer. They paste it in G OPTICALS → Licence → Activate.'}
      </Typography>
      <Box component="code" data-testid="licence-key"
        sx={{ display: 'block', wordBreak: 'break-all', fontSize: 12, p: 1, bgcolor: 'action.hover', borderRadius: 1,
          maxHeight: 140, overflow: 'auto', userSelect: 'all' }}>
        {key}
      </Box>
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" variant="contained" startIcon={<CopyIcon />} onClick={() => copy(key)}>Copy licence key</Button>
        <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadLicenceFile(licence?.lic_id, key)}>
          Download .lic file
        </Button>
      </Stack>
    </Box>
  );
}
