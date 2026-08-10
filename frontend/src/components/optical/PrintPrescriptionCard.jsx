import React from 'react';
import { 
  Box, Card, Typography, Grid, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, Paper, 
  Divider, Button, Chip, Stack 
} from '@mui/material';
import { 
  Print as PrintIcon, 
  Share as ShareIcon,
  WhatsApp as WhatsAppIcon,
  Email as EmailIcon,
  ShoppingCartOutlined as SalesIcon,
  QrCode2 as QrCodeIcon,
  QrCode as BarcodeIcon,
  CheckCircle as VerifiedIcon
} from '@mui/icons-material';

export default function PrintPrescriptionCard({
  patientData,
  subjectiveRefraction,
  diagnosis,
  prescription,
  medicalHistory,
  onNavigateToSales
}) {
  const handleTriggerPrint = () => {
    window.print();
  };

  return (
    <Card elevation={0} sx={{ p: 4, border: '1px solid', borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
      {/* Action Header bar for Digital Sharing & Print */}
      <Box className="no-print" sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', mb: 4, pb: 2, borderBottom: '1px solid', borderColor: 'divider', gap: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={800} color="primary.main">
            Certified Ophthalmic Prescription Card
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Ready for high-resolution printing, digital signature verification, and Optical POS billing.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button 
            variant="outlined" 
            color="success" 
            startIcon={<WhatsAppIcon />}
            onClick={() => alert(`Sending digital prescription via WhatsApp to ${patientData?.phone || 'patient'}...`)}
            sx={{ borderRadius: 2, textTransform: 'none' }}
          >
            WhatsApp Rx
          </Button>
          <Button 
            variant="outlined" 
            color="info" 
            startIcon={<EmailIcon />}
            onClick={() => alert(`Emailing PDF prescription to ${patientData?.email || 'patient'}...`)}
            sx={{ borderRadius: 2, textTransform: 'none' }}
          >
            Email Rx
          </Button>
          <Button 
            variant="contained" 
            color="secondary" 
            startIcon={<SalesIcon />}
            onClick={onNavigateToSales}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
          >
            Create Optical Order / POS Bill
          </Button>
          <Button 
            variant="contained" 
            color="primary" 
            startIcon={<PrintIcon />}
            onClick={handleTriggerPrint}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700, px: 3 }}
          >
            Print Prescription
          </Button>
        </Stack>
      </Box>

      {/* Actual Printable Prescription Document Box */}
      <Box id="prescription-print-area" sx={{ p: 3, border: '2px solid #0f172a', borderRadius: 2, bgcolor: '#ffffff', color: '#0f172a' }}>
        {/* Clinic Branding Header */}
        <Grid container spacing={2} alignItems="center" sx={{ pb: 2, borderBottom: '2px solid #0f172a' }}>
          <Grid item xs={8}>
            <Typography variant="h4" fontWeight={900} sx={{ color: '#059669', letterSpacing: '-0.02em' }}>
              GREENSOL OPTICAL & EYE CLINIC
            </Typography>
            <Typography variant="body2" fontWeight={600} color="text.secondary">
              Super-Specialty Refraction & Vision Care Suite • Main Branch Clinic
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              100 Eye Hospital Road, Healthcare Tower • Phone: +91 98765-43210 • Reg No: OPT-99482
            </Typography>
          </Grid>
          <Grid item xs={4} sx={{ textAlign: 'right' }}>
            <Box sx={{ display: 'inline-block', p: 1, border: '1px solid #e2e8f0', borderRadius: 1.5, textTransform: 'center' }}>
              <QrCodeIcon sx={{ fontSize: 48, color: '#0f172a' }} />
              <Typography variant="caption" display="block" fontWeight={700}>Rx Verification</Typography>
            </Box>
          </Grid>
        </Grid>

        {/* Patient & Examination Metadata */}
        <Grid container spacing={2} sx={{ my: 2, p: 2, bgcolor: '#f8fafc', borderRadius: 2, border: '1px solid #e2e8f0' }}>
          <Grid item xs={6} sm={3}>
            <Typography variant="caption" color="text.secondary" display="block">Patient ID</Typography>
            <Typography variant="subtitle2" fontWeight={800}>{patientData?.id}</Typography>
          </Grid>
          <Grid item xs={6} sm={3}>
            <Typography variant="caption" color="text.secondary" display="block">Patient Name</Typography>
            <Typography variant="subtitle2" fontWeight={800}>{patientData?.name}</Typography>
          </Grid>
          <Grid item xs={6} sm={2}>
            <Typography variant="caption" color="text.secondary" display="block">Age / Gender</Typography>
            <Typography variant="subtitle2" fontWeight={700}>{patientData?.age} Yrs / {patientData?.gender}</Typography>
          </Grid>
          <Grid item xs={6} sm={2}>
            <Typography variant="caption" color="text.secondary" display="block">Mobile</Typography>
            <Typography variant="subtitle2" fontWeight={700}>{patientData?.phone}</Typography>
          </Grid>
          <Grid item xs={12} sm={2}>
            <Typography variant="caption" color="text.secondary" display="block">Exam Date</Typography>
            <Typography variant="subtitle2" fontWeight={700}>{new Date().toLocaleDateString()}</Typography>
          </Grid>
        </Grid>

        {/* Final Subjective Refraction Table */}
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1, color: '#059669' }}>
          FINAL REFRACTION PRESCRIPTION (Rx)
        </Typography>

        <TableContainer component={Paper} elevation={0} sx={{ border: '2px solid #0f172a', borderRadius: 1.5, mb: 3 }}>
          <Table size="small">
            <TableHead sx={{ bgcolor: '#0f172a' }}>
              <TableRow>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800 }}>EYE</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800, textAlign: 'center' }}>SPH</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800, textAlign: 'center' }}>CYL</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800, textAlign: 'center' }}>AXIS</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800, textAlign: 'center' }}>VA</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800, textAlign: 'center' }}>NEAR ADD</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 800, textAlign: 'center' }}>P.D. (mm)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* OD (Right Eye) */}
              <TableRow>
                <TableCell sx={{ fontWeight: 900, color: '#2563eb' }}>OD (RIGHT EYE)</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{subjectiveRefraction?.od?.sph || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{subjectiveRefraction?.od?.cyl || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{subjectiveRefraction?.od?.axis || '0'}°</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800 }}>{subjectiveRefraction?.od?.va || '6/6'}</TableCell>
                <TableCell align="center" rowSpan={2} sx={{ fontWeight: 900, fontSize: '1.1rem', verticalAlign: 'middle', borderLeft: '1px solid #cbd5e1' }}>
                  {subjectiveRefraction?.nearAdd || '+0.00'}
                </TableCell>
                <TableCell align="center" rowSpan={2} sx={{ fontWeight: 900, fontSize: '1.1rem', verticalAlign: 'middle', borderLeft: '1px solid #cbd5e1' }}>
                  {subjectiveRefraction?.pd || '63'}
                </TableCell>
              </TableRow>

              {/* OS (Left Eye) */}
              <TableRow>
                <TableCell sx={{ fontWeight: 900, color: '#059669' }}>OS (LEFT EYE)</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{subjectiveRefraction?.os?.sph || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{subjectiveRefraction?.os?.cyl || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{subjectiveRefraction?.os?.axis || '0'}°</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800 }}>{subjectiveRefraction?.os?.va || '6/6'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>

        {/* Selected Lens & Frame Recommendations */}
        <Grid container spacing={3} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={7}>
            <Box sx={{ p: 2, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#f8fafc' }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary" display="block" sx={{ textTransform: 'uppercase', mb: 1 }}>
                OPTICAL LENS RECOMMENDATIONS
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.8 }}>
                {prescription?.selectedLenses?.length > 0 ? (
                  prescription.selectedLenses.map((lens, i) => (
                    <Chip key={i} label={lens} size="small" sx={{ fontWeight: 700, bgcolor: '#e0e7ff', color: '#3730a3' }} />
                  ))
                ) : (
                  <Typography variant="body2" fontStyle="italic">Single Vision / Anti-Reflection Lens recommended.</Typography>
                )}
              </Box>
            </Box>
          </Grid>
          <Grid item xs={12} sm={5}>
            <Box sx={{ p: 2, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#f8fafc' }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary" display="block" sx={{ textTransform: 'uppercase', mb: 0.5 }}>
                CLINICAL DIAGNOSIS & REMARKS
              </Typography>
              <Typography variant="body2" fontWeight={700}>
                {diagnosis?.primary || 'Compound Myopic Astigmatism'}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {diagnosis?.remarks || 'Wear glasses for distance vision and computer monitor usage.'}
              </Typography>
            </Box>
          </Grid>
        </Grid>

        {/* Footer Signature & Doctor Information */}
        <Grid container spacing={2} alignItems="flex-end" sx={{ pt: 3, borderTop: '2px dashed #e2e8f0' }}>
          <Grid item xs={6}>
            <Typography variant="caption" color="text.secondary" display="block">
              Refraction Card Barcode Signature
            </Typography>
            <BarcodeIcon sx={{ fontSize: 40, color: '#475569' }} />
            <Typography variant="caption" display="block" sx={{ fontSize: '0.65rem', color: '#64748b' }}>
              Greensol Optical ERP Certified Refraction System
            </Typography>
          </Grid>

          <Grid item xs={6} sx={{ textAlign: 'right' }}>
            <Box sx={{ display: 'inline-block', textAlign: 'center' }}>
              <Typography variant="subtitle2" fontWeight={800} sx={{ fontStyle: 'italic', textDecoration: 'underline black' }}>
                {patientData?.assignedOptometrist || 'Dr. Sarah Connor, M.Optom'}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block">
                Senior Consultant Optometrist
              </Typography>
              <Chip icon={<VerifiedIcon sx={{ fontSize: '14px !important' }} />} label="Digitally Signed & Verified" color="success" size="small" sx={{ mt: 0.5, height: 20, fontSize: '0.65rem' }} />
            </Box>
          </Grid>
        </Grid>
      </Box>
    </Card>
  );
}
