// Settings → Barcode Labels. The store-wide barcode label system:
//   Designer             — visual editor for database-saved label templates.
//   Printing & Defaults  — template per workflow, printers, calibration, test prints.
// Every Print button (Products, Purchase Entry, Barcode Printing) prints from these.
import React, { useState } from 'react';
import { Card, Box, Tabs, Tab, Typography, Alert, Button, CircularProgress } from '@mui/material';
import { Brush, Print } from '@mui/icons-material';
import useLabelBundle from '../../labels/useLabelBundle';
import LabelDesigner from './labels/LabelDesigner';
import LabelPrintingPanel from './labels/LabelPrintingPanel';
import BarcodePrintDialog from '../inventory/BarcodePrintDialog';
import { notify } from '../../utils/notify';

export default function BarcodeLabelSettings() {
  const { bundle, setBundle, loading, error, reload } = useLabelBundle(true);
  const [tab, setTab] = useState(0);
  const [printJob, setPrintJob] = useState(null);

  const onPrintLabels = (template, product) => {
    if (!product) {
      notify('Pick “Real product” in “Preview with” to print from here — or print from Inventory, Purchase Entry or Barcode Printing.', 'info');
      return;
    }
    setPrintJob({ template, products: [product] });
  };

  return (
    <Card sx={{ p: { xs: 1.5, md: 2.5 }, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: { md: 'center' }, flexDirection: { xs: 'column', md: 'row' }, gap: 1, mb: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6" fontWeight={800}>Barcode Label Designer</Typography>
          <Typography variant="body2" color="text.secondary">
            Design once — Products, Purchase Entry and Barcode Printing print with these templates and fill in each product’s real data.
          </Typography>
        </Box>
        <Tabs value={tab} onChange={(e, v) => setTab(v)}>
          <Tab icon={<Brush fontSize="small" />} iconPosition="start" label="Designer" sx={{ fontWeight: 700, minHeight: 44 }} />
          <Tab icon={<Print fontSize="small" />} iconPosition="start" label="Printing & Defaults" sx={{ fontWeight: 700, minHeight: 44 }} data-testid="tab-printing" />
        </Tabs>
      </Box>

      {error && !bundle && (
        <Alert severity="error" action={<Button onClick={reload}>Retry</Button>}>{error}</Alert>
      )}
      {error && bundle && <Alert severity="warning" sx={{ mb: 1 }}>{error}</Alert>}
      {!bundle && loading && <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>}

      {bundle && tab === 0 && <LabelDesigner bundle={bundle} setBundle={setBundle} reload={reload} onPrintLabels={onPrintLabels} />}
      {bundle && tab === 1 && <LabelPrintingPanel bundle={bundle} setBundle={setBundle} />}

      <BarcodePrintDialog
        open={!!printJob}
        onClose={() => setPrintJob(null)}
        products={printJob?.products || []}
        template={printJob?.template || undefined}
        workflow="barcode_printing"
      />
    </Card>
  );
}
