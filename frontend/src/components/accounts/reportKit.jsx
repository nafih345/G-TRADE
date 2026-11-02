// Shared pieces of the Accounts → Reports screens (Expense, Customer / Supplier Outstanding,
// Accounts Activity): date presets, CSV download, the printable page shell and the summary card.
// The voucher reports (VoucherReport.jsx) predate this and keep their own copies.
import React from 'react';
import { Box, Button, Card, Paper, Typography } from '@mui/material';
import {
  FilterAlt as ApplyIcon, RestartAlt as ResetIcon, Print as PrintIcon, FileDownload as CsvIcon,
} from '@mui/icons-material';
import { getBusinessPrefs, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';

export const NAVY = '#0f1e3d';
export const MODE_COLORS = { Cash: '#15803d', UPI: '#7c3aed', Card: '#0369a1', Bank: '#1d4ed8', Cheque: '#a16207', Credit: '#64748b', Mixed: '#475569' };
export const head = { color: '#3730a3', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', bgcolor: '#eef2ff', borderBottom: '1px solid #c7d2fe', py: 1.25 };

export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayYmd = () => ymd(new Date());
export const monthStart = () => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth(), 1)); };
/** First day of the current financial year (business pref fiscal_year_start_month, default April). */
export const fyStart = () => {
  const m = Number(getBusinessPrefs()?.fiscal_year_start_month) || 4;
  const d = new Date();
  const year = d.getMonth() + 1 >= m ? d.getFullYear() : d.getFullYear() - 1;
  return ymd(new Date(year, m - 1, 1));
};
export const money = (v) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function downloadCsv(filename, header, lines) {
  const csv = [header, ...lines].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** Opens the print window first (so it isn't blocked as a pop-up), then fills it with build()'s HTML. */
export async function printReport(build, onError) {
  const win = window.open('', '_blank', 'width=1100,height=900');
  if (!win) { notify('Allow pop-ups to print the report.', 'warning'); return; }
  try {
    const html = await build();
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (e) {
    win.close();
    onError?.(e);
  }
}

/** A complete printable page: store header, title, filter line, then `body` (tables). */
export function printShell({ title, company, logo, meta = [], body, landscape = true, footNote = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 10.5px; margin: 0; }
  .hdr { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${NAVY}; padding-bottom: 8px; margin-bottom: 10px; }
  .hdr img { max-height: 54px; max-width: 140px; object-fit: contain; }
  .hdr h1 { font-size: 18px; margin: 0; } .hdr p { margin: 2px 0 0; color: #475569; }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: .3px; }
  h3 { font-size: 12px; margin: 12px 0 4px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 22px; margin-bottom: 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; text-align: left; padding: 5px 6px; font-size: 10px; }
  td { padding: 4px 6px; vertical-align: top; border-top: 1px solid #cbd5e1; }
  tr { page-break-inside: avoid; } tr.off td { color: #94a3b8; } tr.sub td { background: #f8fafc; font-size: 9.5px; }
  .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; } .neg { color: #b91c1c; }
  .tot td { border-top: 2px solid ${NAVY}; font-weight: 800; padding-top: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 6px 0 10px; }
  .cards div { border: 1px dashed #cbd5e1; border-radius: 6px; padding: 5px 8px; }
  .cards small { display: block; color: #64748b; font-weight: 700; }
  .foot { margin-top: 10px; color: #64748b; font-size: 9.5px; display: flex; justify-content: space-between; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><h1>${esc(company?.name || title)}</h1>
      <p>${esc(company?.address)}${company?.phone ? ` · Ph: ${esc(company.phone)}` : ''}${company?.gstin ? ` · GSTIN: ${esc(company.gstin)}` : ''}</p></div>
  </div>
  <h2>${esc(title.toUpperCase())}</h2>
  <div class="meta">${meta.filter(Boolean).map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>
  ${body}
  <div class="foot"><span>${esc(footNote)}</span><span>Generated ${esc(new Date().toLocaleString())}</span></div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body></html>`;
}

export const printCards = (cards) => `<div class="cards">${cards.map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join('')}</div>`;

export function SummaryCard({ label, value, color = NAVY, accent = '#64748b', plain, hint, onClick, active }) {
  return (
    <Paper variant="outlined" onClick={onClick}
      sx={{ p: 2, borderRadius: 2, borderLeft: `4px solid ${accent}`, height: '100%', cursor: onClick ? 'pointer' : 'default',
        outline: active ? `2px solid ${accent}` : 'none', '&:hover': onClick ? { bgcolor: '#f8fafc' } : undefined }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color, mt: 0.5 }}>{plain ? value ?? 0 : formatMoney(value || 0)}</Typography>
      {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
    </Paper>
  );
}

export function ReportCard({ title, subtitle, children }) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="h6" fontWeight={850} sx={{ letterSpacing: 0.3, color: NAVY }}>{title.toUpperCase()}</Typography>
        <Typography variant="body2" color="text.secondary">{subtitle}</Typography>
      </Box>
      <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>{children}</Box>
    </Card>
  );
}

/** Apply / Reset / Print / CSV, the tail of every filter bar. */
export function FilterActions({ dirty, onReset, onPrint, onCsv, busy, ready }) {
  return (
    <>
      <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />}
        sx={{ fontWeight: 700, whiteSpace: 'nowrap', ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
      <Button variant="outlined" startIcon={<ResetIcon />} onClick={onReset} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Reset</Button>
      <Button variant="outlined" startIcon={<PrintIcon />} onClick={onPrint} disabled={!ready || busy} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Print</Button>
      <Button variant="text" startIcon={<CsvIcon />} onClick={onCsv} disabled={!ready} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>CSV</Button>
    </>
  );
}

export const filterBarSx = { display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2, '& .MuiButton-root': { flexShrink: 0 } };
export const fieldSx = { bgcolor: '#fff' };
