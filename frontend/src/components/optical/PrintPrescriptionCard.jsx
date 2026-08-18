import React, { useState } from 'react';
import {
  Box, Card, Typography, Grid, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Paper,
  Divider, Button, Chip, Stack, ToggleButtonGroup, ToggleButton
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

// Page geometry for the two supported sizes. Doctors can type arbitrarily long text into the
// free-text fields (chief complaints, diagnosis remarks, advice, ...), so a fixed shrink guess
// isn't reliable — a short record should print at full size exactly as it looks on screen, a
// verbose one can genuinely run past one physical page and needs shrinking to still fit on one.
// handleTriggerPrint measures the actual rendered height and only shrinks when it would
// otherwise overflow onto a second, mostly-blank page.
//
// The shrink uses `transform: scale` on #prescription-print-area, wrapped by
// #prescription-print-wrap with an explicit pixel height — NOT the `zoom` CSS property. `zoom`
// reports correctly through getComputedStyle and renders correctly in a live print preview, but
// Chromium's print-to-PDF pipeline (used by both "Save as PDF" and this app's automated tests)
// does not reliably apply it, silently ignoring the shrink and letting content overflow to a
// second page anyway. `transform: scale` is a standard, universally-honored property; pairing it
// with an explicit wrapper height (transform doesn't change layout size, only paint) keeps
// pagination correct too.
const PAGE_TARGET = {
  A4: { pageSize: 'A4', widthMm: 210, heightMm: 297, marginMm: 12 },
  A5: { pageSize: 'A5', widthMm: 148, heightMm: 210, marginMm: 8 }
};
const MM_TO_PX = 96 / 25.4;
const MIN_SCALE = 0.55;

export default function PrintPrescriptionCard({
  patientData,
  subjectiveRefraction,
  diagnosis,
  prescription,
  medicalHistory,
  onNavigateToSales
}) {
  const [paperSize, setPaperSize] = useState('A4');
  // MUI's Grid `sm` breakpoint resolves against the actual browser viewport, not this card's own
  // (much narrower, on A5) rendered width — so at A5 print width those two/three-column rows
  // would otherwise still try to lay out as wide desktop columns, cramming each into a sliver
  // and wrapping their text far more than the same content needs when stacked full-width.
  // Forcing every such row to stack (sm=12) for A5 keeps each box comfortably readable.
  const smCol = (value) => (paperSize === 'A5' ? 12 : value);

  const handleTriggerPrint = () => {
    const target = PAGE_TARGET[paperSize];
    const original = document.getElementById('prescription-print-area');
    const maxContentHeightPx = (target.heightMm - target.marginMm * 2) * MM_TO_PX;
    const widthPx = target.widthMm * MM_TO_PX;

    // Measure how tall the card actually renders at this page's real physical width — off-screen,
    // unscaled, with the same padding print uses — so the shrink factor is based on real content,
    // not a guess.
    let contentHeightPx = 0;
    if (original) {
      const clone = original.cloneNode(true);
      clone.removeAttribute('id');
      clone.style.position = 'fixed';
      clone.style.left = '-9999px';
      clone.style.top = '0';
      clone.style.transform = 'none';
      clone.style.width = `${target.widthMm}mm`;
      clone.style.minHeight = '0';
      clone.style.maxHeight = 'none';
      clone.style.padding = '20px';
      document.body.appendChild(clone);
      contentHeightPx = clone.scrollHeight;
      document.body.removeChild(clone);
    }

    const scale = contentHeightPx > maxContentHeightPx
      ? Math.max(MIN_SCALE, maxContentHeightPx / contentHeightPx)
      : 1;
    // The wrapper's height is the card's real natural height post-scale: exactly the natural
    // size when nothing needs shrinking (so short content prints at full size, ending exactly
    // where it ends on screen — no artificial blank space forced below it), or exactly the
    // page's available height when it does (guaranteeing a single page).
    const wrapHeightPx = scale === 1 ? contentHeightPx : maxContentHeightPx;

    let styleTag = document.getElementById('dynamic-rx-print-size');
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'dynamic-rx-print-size';
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = `
      @media print {
        @page { size: ${target.pageSize} portrait; margin: ${target.marginMm}mm; }
        #prescription-print-wrap {
          width: ${target.widthMm}mm !important;
          min-height: 0 !important;
          max-height: ${wrapHeightPx}px !important;
          height: ${wrapHeightPx}px !important;
          overflow: hidden !important;
        }
        #prescription-print-area {
          width: ${widthPx}px !important;
          padding: 20px !important;
          transform: scale(${scale}) !important;
          transform-origin: top left !important;
        }
      }
    `;
    // Give the browser a paint cycle to apply the freshly-injected stylesheet before print
    // captures the layout — calling window.print() in the very same tick occasionally races
    // ahead of style recalculation, printing against the pre-injection (unscaled) layout.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.print();
      });
    });
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

        <Stack direction="row" spacing={1.5} flexWrap="wrap" alignItems="center">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={paperSize}
            onChange={(e, val) => val && setPaperSize(val)}
            sx={{ mr: 0.5 }}
          >
            <ToggleButton value="A4" sx={{ textTransform: 'none', fontWeight: 700, px: 2 }}>A4</ToggleButton>
            <ToggleButton value="A5" sx={{ textTransform: 'none', fontWeight: 700, px: 2 }}>A5</ToggleButton>
          </ToggleButtonGroup>
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
      <Box id="prescription-print-wrap">
      <Box id="prescription-print-area" sx={{ p: 5, border: '2px solid #0f172a', borderRadius: 2, bgcolor: '#ffffff', color: '#0f172a' }}>
        {/* Clinic Branding Header */}
        <Grid container spacing={2} alignItems="center" sx={{ pb: 3, borderBottom: '2px solid #0f172a' }}>
          <Grid item xs={8}>
            <Typography sx={{ fontSize: '2.4rem', fontWeight: 900, color: '#059669', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
              GREENSOL OPTICAL & EYE CLINIC
            </Typography>
            <Typography variant="subtitle1" fontWeight={600} color="text.secondary">
              Super-Specialty Refraction & Vision Care Suite • Main Branch Clinic
            </Typography>
            <Typography variant="body2" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              100 Eye Hospital Road, Healthcare Tower • Phone: +91 98765-43210 • Reg No: OPT-99482
            </Typography>
          </Grid>
          <Grid item xs={4} sx={{ textAlign: 'right' }}>
            <Box sx={{ display: 'inline-block', p: 1.5, border: '1px solid #e2e8f0', borderRadius: 1.5, textTransform: 'center' }}>
              <QrCodeIcon sx={{ fontSize: 68, color: '#0f172a' }} />
              <Typography variant="body2" display="block" fontWeight={700}>Rx Verification</Typography>
            </Box>
          </Grid>
        </Grid>

        {/* Patient & Examination Metadata */}
        <Grid container spacing={3} sx={{ my: 4, p: 3, bgcolor: '#f8fafc', borderRadius: 2, border: '1px solid #e2e8f0' }}>
          <Grid item xs={6} sm={smCol(3)}>
            <Typography variant="body2" color="text.secondary" display="block">Patient ID</Typography>
            <Typography variant="h6" fontWeight={800}>{patientData?.id}</Typography>
          </Grid>
          <Grid item xs={6} sm={smCol(3)}>
            <Typography variant="body2" color="text.secondary" display="block">Patient Name</Typography>
            <Typography variant="h6" fontWeight={800}>{patientData?.name}</Typography>
          </Grid>
          <Grid item xs={6} sm={smCol(2)}>
            <Typography variant="body2" color="text.secondary" display="block">Age / Gender</Typography>
            <Typography variant="h6" fontWeight={700}>{patientData?.age} Yrs / {patientData?.gender}</Typography>
          </Grid>
          <Grid item xs={6} sm={smCol(2)}>
            <Typography variant="body2" color="text.secondary" display="block">Mobile</Typography>
            <Typography variant="h6" fontWeight={700}>{patientData?.phone}</Typography>
          </Grid>
          <Grid item xs={12} sm={smCol(2)}>
            <Typography variant="body2" color="text.secondary" display="block">Exam Date</Typography>
            <Typography variant="h6" fontWeight={700}>{new Date().toLocaleDateString()}</Typography>
          </Grid>
        </Grid>

        {/* Final Subjective Refraction Table — styled to match the ACCP model on the eye test form:
            OD/OS as column groups (not row labels), with DV/ADD rows underneath a shared TYPE/VAL header. */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
          <Typography variant="h6" fontWeight={800} color="#2563eb">
            ACCP (Final Acceptance Refraction & Subjective Rx)
          </Typography>
          <Chip label="Final Rx" sx={{ fontWeight: 800, bgcolor: '#2563eb', color: '#fff' }} />
        </Box>

        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #bfdbfe', borderRadius: 2, mb: 0.75 }}>
          <Table sx={{ tableLayout: 'fixed' }}>
            <TableHead sx={{ bgcolor: '#dbeafe' }}>
              <TableRow>
                <TableCell colSpan={2} align="center" sx={{ fontWeight: 900, fontSize: '0.95rem', color: '#1e40af', borderRight: '1px solid #bfdbfe' }}>ACCP</TableCell>
                <TableCell colSpan={4} align="center" sx={{ fontWeight: 900, fontSize: '1rem', color: '#2563eb', bgcolor: '#eff6ff', borderRight: '1px solid #bfdbfe' }}>OD (RIGHT EYE)</TableCell>
                <TableCell colSpan={4} align="center" sx={{ fontWeight: 900, fontSize: '1rem', color: '#059669', bgcolor: '#ecfdf5' }}>OS (LEFT EYE)</TableCell>
              </TableRow>
              <TableRow>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#1e40af' }}>TYPE</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#1e40af', borderRight: '1px solid #bfdbfe' }}>VAL</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#1e40af' }}>SPH</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#1e40af' }}>CYL</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#1e40af' }}>AXIS</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#1e40af', borderRight: '1px solid #bfdbfe' }}>VA</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#059669' }}>SPH</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#059669' }}>CYL</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#059669' }}>AXIS</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#059669' }}>VA</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* DV Row */}
              <TableRow>
                <TableCell rowSpan={2} align="center" sx={{ fontWeight: 900, fontSize: '0.9rem', color: '#1e40af', bgcolor: '#f8fafc', borderRight: '1px solid #bfdbfe' }}>
                  ACCP
                </TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#2563eb', bgcolor: '#eff6ff', borderRight: '1px solid #bfdbfe' }}>DV</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.15rem' }}>{subjectiveRefraction?.od?.sph || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.15rem' }}>{subjectiveRefraction?.od?.cyl || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.15rem' }}>{subjectiveRefraction?.od?.axis || '0'}°</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1rem', borderRight: '1px solid #bfdbfe' }}>{subjectiveRefraction?.od?.va || '6/6'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.15rem' }}>{subjectiveRefraction?.os?.sph || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.15rem' }}>{subjectiveRefraction?.os?.cyl || '0.00'}</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1.15rem' }}>{subjectiveRefraction?.os?.axis || '0'}°</TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1rem' }}>{subjectiveRefraction?.os?.va || '6/6'}</TableCell>
              </TableRow>

              {/* ADD Row */}
              <TableRow>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.85rem', color: '#059669', bgcolor: '#ecfdf5', borderRight: '1px solid #bfdbfe' }}>ADD</TableCell>
                <TableCell colSpan={3} align="center" sx={{ fontWeight: 800, fontSize: '1.1rem' }}>
                  {subjectiveRefraction?.nearAdd || subjectiveRefraction?.odNv?.sph || '+0.00'}
                </TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1rem', borderRight: '1px solid #bfdbfe' }}>{subjectiveRefraction?.odNv?.va || 'N6'}</TableCell>
                <TableCell colSpan={3} align="center" sx={{ fontWeight: 800, fontSize: '1.1rem' }}>
                  {subjectiveRefraction?.nearAdd || subjectiveRefraction?.osNv?.sph || '+0.00'}
                </TableCell>
                <TableCell align="center" sx={{ fontWeight: 800, fontSize: '1rem' }}>{subjectiveRefraction?.osNv?.va || 'N6'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 4, textAlign: 'right' }}>
          Pupil Distance (P.D.): <strong>{subjectiveRefraction?.pd || '63'} mm</strong>
        </Typography>

        {/* Selected Lens & Frame Recommendations */}
        <Grid container spacing={3} sx={{ mb: 4 }}>
          <Grid item xs={12} sm={smCol(7)}>
            <Box sx={{ p: 2.5, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#f8fafc', height: '100%' }}>
              <Typography variant="body2" fontWeight={800} color="text.secondary" display="block" sx={{ textTransform: 'uppercase', mb: 1.5 }}>
                Optical Lens Recommendations
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {prescription?.selectedLenses?.length > 0 ? (
                  prescription.selectedLenses.map((lens, i) => (
                    <Chip key={i} label={lens} sx={{ fontWeight: 700, fontSize: '0.85rem', height: 32, bgcolor: '#e0e7ff', color: '#3730a3' }} />
                  ))
                ) : (
                  <Typography variant="body1" fontStyle="italic">Single Vision / Anti-Reflection Lens recommended.</Typography>
                )}
              </Box>
            </Box>
          </Grid>
          <Grid item xs={12} sm={smCol(5)}>
            <Box sx={{ p: 2.5, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#f8fafc', height: '100%' }}>
              <Typography variant="body2" fontWeight={800} color="text.secondary" display="block" sx={{ textTransform: 'uppercase', mb: 1 }}>
                Clinical Diagnosis & Remarks
              </Typography>
              <Typography variant="body1" fontWeight={700}>
                {diagnosis?.primary || 'Compound Myopic Astigmatism'}
              </Typography>
              <Typography variant="body2" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                {diagnosis?.remarks || 'Wear glasses for distance vision and computer monitor usage.'}
              </Typography>
            </Box>
          </Grid>
        </Grid>

        {/* Doctor's Advice, Medical History & Next Review */}
        <Grid container spacing={3} sx={{ mb: 4 }}>
          <Grid item xs={12} sm={smCol(7)}>
            <Box sx={{ p: 2.5, border: '1px solid #e2e8f0', borderRadius: 2, bgcolor: '#f8fafc', height: '100%' }}>
              <Typography variant="body2" fontWeight={800} color="text.secondary" display="block" sx={{ textTransform: 'uppercase', mb: 1 }}>
                Doctor's Advice & Ergonomics
              </Typography>
              <Typography variant="body1">
                {diagnosis?.advice || 'Take regular breaks during near work; maintain adequate lighting while reading.'}
              </Typography>
              {medicalHistory?.complaints ? (
                <Typography variant="body2" color="text.secondary" display="block" sx={{ mt: 1 }}>
                  Chief Complaints: {medicalHistory.complaints}
                </Typography>
              ) : null}
            </Box>
          </Grid>
          <Grid item xs={12} sm={smCol(5)}>
            <Box sx={{ p: 2.5, border: '1px solid #bfdbfe', borderRadius: 2, bgcolor: '#eff6ff', height: '100%' }}>
              <Typography variant="body2" fontWeight={800} color="text.secondary" display="block" sx={{ textTransform: 'uppercase', mb: 1 }}>
                Next Review Date
              </Typography>
              <Typography variant="h6" fontWeight={800} color="#2563eb">
                {diagnosis?.nextReviewDate || 'To be advised at next visit'}
              </Typography>
            </Box>
          </Grid>
        </Grid>

        {/* Footer Signature & Doctor Information */}
        <Grid container spacing={2} alignItems="flex-end" sx={{ pt: 4, borderTop: '2px dashed #e2e8f0' }}>
          <Grid item xs={6}>
            <Typography variant="body2" color="text.secondary" display="block">
              Refraction Card Barcode Signature
            </Typography>
            <BarcodeIcon sx={{ fontSize: 56, color: '#475569' }} />
            <Typography variant="caption" display="block" sx={{ fontSize: '0.7rem', color: '#64748b' }}>
              Greensol Optical ERP Certified Refraction System
            </Typography>
          </Grid>

          <Grid item xs={6} sx={{ textAlign: 'right' }}>
            <Box sx={{ display: 'inline-block', textAlign: 'center' }}>
              <Typography variant="h6" fontWeight={800} sx={{ fontStyle: 'italic', textDecoration: 'underline black' }}>
                {patientData?.assignedOptometrist || 'Dr. Sarah Connor, M.Optom'}
              </Typography>
              <Typography variant="body2" color="text.secondary" display="block">
                Senior Consultant Optometrist
              </Typography>
              <Chip icon={<VerifiedIcon sx={{ fontSize: '16px !important' }} />} label="Digitally Signed & Verified" color="success" sx={{ mt: 1, height: 26, fontSize: '0.75rem' }} />
            </Box>
          </Grid>
        </Grid>
      </Box>
      </Box>
    </Card>
  );
}
