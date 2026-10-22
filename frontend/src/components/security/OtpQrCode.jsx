import React, { useEffect, useState } from 'react';
import { Box, Skeleton, Stack, Typography } from '@mui/material';

/** QR code for an otpauth:// URI, plus the secret for manual entry. Rendered locally — the
 *  secret never leaves the browser for a third-party QR service. */
export default function OtpQrCode({ uri, secret, size = 180 }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    // Loaded on demand: only the 2FA screens need it, and the sign-in page is on the startup path.
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(uri, { width: size, margin: 1, errorCorrectionLevel: 'M' }))
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(''); });
    return () => { alive = false; };
  }, [uri, size]);

  const grouped = (secret || '').replace(/(.{4})/g, '$1 ').trim();
  return (
    <Stack alignItems="center" spacing={1.25}>
      <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#fff', border: '1px solid', borderColor: 'divider', lineHeight: 0 }}>
        {src ? <img src={src} width={size} height={size} alt="QR code to add this account to an authenticator app" />
          : <Skeleton variant="rectangular" width={size} height={size} />}
      </Box>
      <Typography variant="caption" color="text.secondary" textAlign="center">
        Can't scan? Enter this key in the app:
      </Typography>
      <Typography component="code" sx={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.06em', fontSize: '0.9rem',
        px: 1.25, py: 0.5, borderRadius: 1, bgcolor: 'action.hover', userSelect: 'all', wordBreak: 'break-all', textAlign: 'center' }}
      >
        {grouped}
      </Typography>
    </Stack>
  );
}
