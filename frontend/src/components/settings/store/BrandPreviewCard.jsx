import React from 'react';
import { Avatar, Box, Button, Card, Chip, Divider, Stack, Typography } from '@mui/material';
import {
  ReceiptLong as InvoiceIcon, Place as PlaceIcon, Phone as PhoneIcon, WhatsApp as WhatsAppIcon,
  Email as EmailIcon, Language as WebIcon, Image as ImageIcon,
} from '@mui/icons-material';
import { documentAddress, storeTypeLabel } from '../../../utils/storeProfile';
import { GREEN, GREEN_SOFT } from './storeUi';

function Line({ icon, children, label }) {
  if (!children) return null;
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }} aria-label={label}>
      <Box sx={{ color: 'text.secondary', mt: '2px', display: 'flex' }}>{icon}</Box>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{children}</Typography>
    </Box>
  );
}

const initials = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Live header preview built from the (unsaved) form. */
export default function BrandPreviewCard({ form, onPreviewInvoice }) {
  const name = (form.display_name || form.name).trim();
  const address = documentAddress(form);
  const country = form.country && form.country !== 'India' ? form.country : '';

  return (
    <Card elevation={0} sx={{ p: { xs: 2, sm: 3 }, borderRadius: 3, border: '1px solid', borderColor: 'divider', boxShadow: '0 1px 3px rgba(15,23,42,0.05)' }}>
      <Typography variant="h6" component="h2" fontWeight={800} sx={{ fontSize: '1.05rem' }}>Brand Preview</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        This information will appear on your invoices, reports and receipts.
      </Typography>

      <Box
        aria-live="polite"
        sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden', bgcolor: 'background.paper' }}
      >
        <Box sx={{ height: 4, bgcolor: GREEN }} />
        <Stack alignItems="center" spacing={0.75} sx={{ p: 2.5, textAlign: 'center' }}>
          <Avatar
            src={form.logo_data_url || undefined}
            alt={name ? `${name} logo` : 'Store logo'}
            sx={{
              width: 72, height: 72, bgcolor: GREEN_SOFT, color: GREEN, fontWeight: 800, fontSize: 24,
              '& img': { objectFit: 'contain' }, border: '1px solid', borderColor: 'divider',
            }}
          >
            {initials(name) || <ImageIcon />}
          </Avatar>
          <Typography variant="h6" fontWeight={800} sx={{ lineHeight: 1.25, overflowWrap: 'anywhere', color: name ? 'text.primary' : 'text.disabled' }}>
            {name || 'Your store name'}
          </Typography>
          {form.store_type && (
            <Typography variant="caption" sx={{ color: GREEN, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
              {storeTypeLabel(form.store_type)}
            </Typography>
          )}
          {form.tagline && <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>{form.tagline}</Typography>}
        </Stack>
        <Divider />
        <Stack spacing={1} sx={{ p: 2 }}>
          <Line icon={<PlaceIcon sx={{ fontSize: 16 }} />} label="Address">
            {[address, country].filter(Boolean).join(', ')}
          </Line>
          <Line icon={<PhoneIcon sx={{ fontSize: 16 }} />} label="Phone">{form.phone}</Line>
          <Line icon={<WhatsAppIcon sx={{ fontSize: 16 }} />} label="WhatsApp">{form.whatsapp}</Line>
          <Line icon={<EmailIcon sx={{ fontSize: 16 }} />} label="Email">{form.email}</Line>
          <Line icon={<WebIcon sx={{ fontSize: 16 }} />} label="Website">{form.website}</Line>
          {!address && !form.phone && !form.email && !form.website && (
            <Typography variant="body2" color="text.disabled">Contact details will appear here.</Typography>
          )}
        </Stack>
        {form.gstin && (
          <>
            <Divider />
            <Box sx={{ px: 2, py: 1.25, display: 'flex', justifyContent: 'center' }}>
              <Chip size="small" label={`GSTIN: ${form.gstin.toUpperCase()}`} sx={{ fontWeight: 700, bgcolor: GREEN_SOFT, color: GREEN }} />
            </Box>
          </>
        )}
      </Box>

      <Button
        fullWidth
        variant="outlined"
        startIcon={<InvoiceIcon />}
        onClick={onPreviewInvoice}
        sx={{ mt: 2, fontWeight: 700, color: GREEN, borderColor: GREEN, '&:hover': { borderColor: GREEN, bgcolor: GREEN_SOFT } }}
      >
        Preview Invoice
      </Button>
    </Card>
  );
}
