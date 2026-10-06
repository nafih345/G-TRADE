import React, { useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Grid,
  Stack, Typography, Table, TableHead, TableRow, TableCell, TableBody, Chip,
  Box, Divider, MenuItem, Checkbox, Paper, IconButton, Alert, InputAdornment
} from '@mui/material';
import {
  Print as PrintIcon, PictureAsPdf as PdfIcon, WhatsApp as WhatsAppIcon,
  CheckCircle as CheckedIcon, Add as AddIcon, UploadFile as UploadFileIcon,
  Download as DownloadIcon, ContentCopy as DuplicateIcon, Replay as ReorderIcon,
  Visibility as ViewIcon, Search as SearchIcon, Payment as PaymentIcon
} from '@mui/icons-material';
import { ORDER_STATUS_COLORS, SCHEME_TYPES, PRICE_LIST_OPTIONS, fmtINR } from './wholesaleConstants';
import { navDialogProps } from './keyboardNav';

// ---------------------------------------------------------------------------
// New Dealer
// ---------------------------------------------------------------------------
export function NewDealerDialog({ open, value, onChange, onClose, onSave, saving }) {
  return (
    // Keyboard-only entry: Enter / ArrowDown → next field, ArrowUp → previous; the last field's
    // Enter lands on "Register Dealer" (a second Enter saves) so nothing submits prematurely.
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth {...navDialogProps}>
      <DialogTitle sx={{ fontWeight: 850 }}>Register New Wholesale Dealer</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField fullWidth size="small" autoFocus label="Dealer Code" placeholder="Auto-generated e.g. DL-00104" value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value })} />
          <TextField fullWidth size="small" label="Business / Dealer Name *" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
          <TextField fullWidth size="small" label="Contact Person Name" value={value.contactPerson} onChange={(e) => onChange({ ...value, contactPerson: e.target.value })} />
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField fullWidth size="small" label="Mobile Number *" value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth size="small" label="Email Address" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} />
            </Grid>
          </Grid>
          <TextField fullWidth size="small" label="GSTIN Number" value={value.gstin} onChange={(e) => onChange({ ...value, gstin: e.target.value })} />
          <TextField fullWidth size="small" multiline minRows={2} label="Billing Address" value={value.billingAddress} onChange={(e) => onChange({ ...value, billingAddress: e.target.value, shippingAddress: value.shippingAddress || e.target.value })} />
          <TextField fullWidth size="small" multiline minRows={2} label="Shipping Address" value={value.shippingAddress} onChange={(e) => onChange({ ...value, shippingAddress: e.target.value })} />
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField select fullWidth size="small" label="Price List" value={value.priceList} onChange={(e) => onChange({ ...value, priceList: e.target.value })}>
                {PRICE_LIST_OPTIONS.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth size="small" type="number" label="Dealer Discount %" value={value.dealerDiscountPercent} onChange={(e) => onChange({ ...value, dealerDiscountPercent: e.target.value })} />
            </Grid>
          </Grid>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField fullWidth size="small" type="number" label="Credit Limit (INR)" value={value.creditLimit} onChange={(e) => onChange({ ...value, creditLimit: e.target.value })} />
            </Grid>
            <Grid item xs={6}>
              <TextField fullWidth size="small" type="number" label="Payment Terms (Days)" value={value.creditDays} onChange={(e) => onChange({ ...value, creditDays: e.target.value })} />
            </Grid>
          </Grid>
          <TextField fullWidth size="small" label="Sales Representative" value={value.salesExec} onChange={(e) => onChange({ ...value, salesExec: e.target.value })} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto' }}>
          Enter / ↓ next field &middot; ↑ previous &middot; Shift+Enter new line &middot; Space opens a list
        </Typography>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" data-nav-stop disabled={saving} onClick={onSave} sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}>
          {saving ? 'Saving…' : 'Register Dealer'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dealer Profile (read-only)
// ---------------------------------------------------------------------------
function ProfileRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <Stack direction="row" justifyContent="space-between" sx={{ py: 0.5, borderBottom: '1px solid #f1f5f9' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={700} sx={{ textAlign: 'right', maxWidth: '60%' }}>{value}</Typography>
    </Stack>
  );
}

export function DealerProfileDialog({ open, dealer, onClose }) {
  if (!dealer) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>Dealer Profile</DialogTitle>
      <DialogContent dividers>
        <ProfileRow label="Dealer Name" value={dealer.name} />
        <ProfileRow label="Dealer Code" value={dealer.code} />
        <ProfileRow label="Contact Person" value={dealer.contactPerson} />
        <ProfileRow label="Phone" value={dealer.phone} />
        <ProfileRow label="Email" value={dealer.email} />
        <ProfileRow label="GSTIN" value={dealer.gstin} />
        <ProfileRow label="Billing Address" value={dealer.billingAddress} />
        <ProfileRow label="Shipping Address" value={dealer.shippingAddress} />
        <ProfileRow label="Price List" value={PRICE_LIST_OPTIONS.find(p => p.value === dealer.priceList)?.label} />
        <ProfileRow label="Payment Terms" value={`Net ${dealer.creditDays || 30}`} />
        <ProfileRow label="Sales Representative" value={dealer.salesExec} />
        <ProfileRow label="Credit Limit" value={fmtINR(dealer.creditLimit)} />
        <ProfileRow label="Opening Balance" value={fmtINR(dealer.openingBalance)} />
        <ProfileRow label="Current Outstanding" value={fmtINR(dealer.outstanding)} />
        <ProfileRow label="Status" value={dealer.status} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dealer Ledger
// ---------------------------------------------------------------------------
export function LedgerDialog({ open, dealer, ledger, onClose, onRecordPayment, onDownload, onPrint }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 850, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Dealer Ledger — {dealer?.name}</span>
        <Chip label={`Outstanding: ${fmtINR(dealer?.outstanding)}`} size="small" sx={{ fontWeight: 700, bgcolor: '#eef2ff', color: '#4f46e5' }} />
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {ledger.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4 }}>
            No transactions recorded for this dealer yet.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead sx={{ '& th': { fontWeight: 700, bgcolor: '#f8fafc' } }}>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Ref</TableCell>
                <TableCell align="right">Debit</TableCell>
                <TableCell align="right">Credit</TableCell>
                <TableCell align="right">Balance</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ledger.map((row, idx) => (
                <TableRow key={idx} hover sx={{ bgcolor: row.isOpening ? '#f8fafc' : 'inherit' }}>
                  <TableCell>{row.date}</TableCell>
                  <TableCell sx={{ fontWeight: row.isOpening ? 700 : 400 }}>{row.type}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{row.ref}</TableCell>
                  <TableCell align="right">{row.debit ? fmtINR(row.debit) : ''}</TableCell>
                  <TableCell align="right" sx={{ color: '#059669' }}>{row.credit ? fmtINR(row.credit) : ''}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: row.balance > 0 ? '#dc2626' : '#059669' }}>{fmtINR(row.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button size="small" startIcon={<PaymentIcon />} onClick={onRecordPayment} sx={{ fontWeight: 700, textTransform: 'none', mr: 'auto' }}>Record Payment</Button>
        <Button size="small" startIcon={<DownloadIcon />} onClick={onDownload} sx={{ fontWeight: 700, textTransform: 'none' }}>Download Statement</Button>
        <Button size="small" startIcon={<PrintIcon />} onClick={onPrint} sx={{ fontWeight: 700, textTransform: 'none' }}>Print</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Record Payment (against dealer ledger)
// ---------------------------------------------------------------------------
export function RecordPaymentDialog({ open, dealer, onClose, onRecord }) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('Cash');
  const [refNo, setRefNo] = useState('');

  React.useEffect(() => { if (open) { setAmount(''); setMode('Cash'); setRefNo(''); } }, [open]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth {...navDialogProps}>
      <DialogTitle sx={{ fontWeight: 850 }}>Record Payment — {dealer?.name}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">Current Outstanding: <b>{fmtINR(dealer?.outstanding)}</b></Typography>
          <TextField fullWidth size="small" autoFocus type="number" label="Amount Received (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TextField select fullWidth size="small" label="Payment Mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            {['Cash', 'UPI', 'Card', 'Bank Transfer'].map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
          </TextField>
          <TextField fullWidth size="small" label="Reference / Note" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          data-nav-stop
          disabled={!amount || parseFloat(amount) <= 0}
          onClick={() => onRecord({ amount: parseFloat(amount) || 0, mode, refNo })}
          sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}
        >
          Record Payment
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Previous Orders
// ---------------------------------------------------------------------------
export function PreviousOrdersDialog({ open, dealer, orders, onClose, onView, onDuplicate, onReorder }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>Previous Orders — {dealer?.name}</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {orders.length === 0 ? (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4 }}>
            No previous orders for this dealer.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead sx={{ '& th': { fontWeight: 700, bgcolor: '#f8fafc' } }}>
              <TableRow>
                <TableCell>Invoice #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell align="center">Payment</TableCell>
                <TableCell align="center">Order Status</TableCell>
                <TableCell align="right">Total</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orders.map((o) => {
                const st = ORDER_STATUS_COLORS[o.orderStatus || 'Confirmed'] || ORDER_STATUS_COLORS.Confirmed;
                const paid = (o.dueAmount || 0) <= 0.009;
                return (
                  <TableRow key={o.invoiceNo} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{o.invoiceNo}</TableCell>
                    <TableCell>{o.date}</TableCell>
                    <TableCell align="center">
                      <Chip label={o.status || (paid ? 'Paid' : 'Credit')} size="small" sx={{ height: 20, fontSize: '0.68rem', fontWeight: 700, bgcolor: paid ? '#dcfce7' : '#fef3c7', color: paid ? '#15803d' : '#a16207' }} />
                    </TableCell>
                    <TableCell align="center">
                      <Chip label={o.orderStatus || 'Confirmed'} size="small" sx={{ bgcolor: st.bg, color: st.color, fontWeight: 700, height: 20, fontSize: '0.68rem' }} />
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>{fmtINR(o.summary?.grandTotal)}</TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.5} justifyContent="center">
                        <IconButton size="small" onClick={() => onView(o)} title="View Order"><ViewIcon sx={{ fontSize: 18 }} /></IconButton>
                        <IconButton size="small" onClick={() => onDuplicate(o)} title="Duplicate Order"><DuplicateIcon sx={{ fontSize: 17 }} /></IconButton>
                        <IconButton size="small" onClick={() => onReorder(o)} title="Reorder"><ReorderIcon sx={{ fontSize: 18 }} /></IconButton>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk Add Products
// ---------------------------------------------------------------------------
export function BulkAddDialog({ open, products, onClose, onAdd }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState({}); // id -> qty

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products.slice(0, 200);
    return products.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.code || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.brand || '').toLowerCase().includes(q)
    ).slice(0, 200);
  }, [products, search]);

  const toggle = (p) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[p.id]) delete next[p.id];
      else next[p.id] = 1;
      return next;
    });
  };

  const setQty = (id, qty) => setSelected(prev => ({ ...prev, [id]: Math.max(1, parseInt(qty) || 1) }));

  const handleAdd = () => {
    const items = products.filter(p => selected[p.id]).map(p => ({ product: p, qty: selected[p.id] }));
    onAdd(items);
    setSelected({});
    setSearch('');
  };

  const selectedCount = Object.keys(selected).length;

  return (
    // Keyboard: type to filter → Enter / ↓ walks the rows; Enter on a row's checkbox ticks it and
    // jumps to its Qty, Enter in Qty goes to the next row; the chain ends on "Add Selected".
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth {...navDialogProps}>
      <DialogTitle sx={{ fontWeight: 850 }}>Bulk Add Products</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ p: 2, pb: 1 }}>
          <TextField
            fullWidth size="small" autoFocus placeholder="Search products to multi-select..."
            value={search} onChange={(e) => setSearch(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: '#94a3b8' }} /></InputAdornment> }}
          />
        </Box>
        <Table size="small" stickyHeader>
          <TableHead sx={{ '& th': { fontWeight: 700, bgcolor: '#f8fafc' } }}>
            <TableRow>
              <TableCell padding="checkbox" />
              <TableCell>Product</TableCell>
              <TableCell>Brand</TableCell>
              <TableCell align="right">Stock</TableCell>
              <TableCell align="right">Qty</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((p) => {
              const stock = parseFloat(p.availableStock ?? p.stock ?? 0);
              const isSel = Boolean(selected[p.id]);
              return (
                <TableRow key={p.id} hover selected={isSel}>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={isSel} onChange={() => toggle(p)} disabled={stock <= 0} inputProps={{ 'data-nav-stop': '' }} />
                  </TableCell>
                  <TableCell onClick={() => stock > 0 && toggle(p)} sx={{ cursor: stock > 0 ? 'pointer' : 'default' }}>
                    <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{p.code}</Typography>
                  </TableCell>
                  <TableCell>{p.brand}</TableCell>
                  <TableCell align="right" sx={{ color: stock > 5 ? '#059669' : stock > 0 ? '#d97706' : '#dc2626', fontWeight: 700 }}>
                    {stock > 0 ? stock : 'Out'}
                  </TableCell>
                  <TableCell align="right">
                    <TextField
                      size="small" type="number" disabled={!isSel} value={selected[p.id] || 1}
                      onChange={(e) => setQty(p.id, e.target.value)}
                      sx={{ width: 64, '& .MuiInputBase-input': { py: 0.25, textAlign: 'right' } }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto' }}>{selectedCount} product(s) selected</Typography>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" data-nav-stop disabled={selectedCount === 0} onClick={handleAdd} startIcon={<AddIcon />} sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}>
          Add Selected to Cart
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Excel / CSV Import
// ---------------------------------------------------------------------------
export function ExcelImportDialog({ open, onClose, onImport }) {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');

  const parseCsv = (text) => {
    const lines = text.split(/\r\n|\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    const barcodeIdx = headers.findIndex(h => h.includes('barcode'));
    const skuIdx = headers.findIndex(h => h.includes('sku') || h.includes('code'));
    const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('product'));
    const qtyIdx = headers.findIndex(h => h.includes('qty') || h.includes('quantity'));
    return lines.slice(1).map(line => {
      const cells = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      return {
        barcode: barcodeIdx >= 0 ? cells[barcodeIdx] : '',
        sku: skuIdx >= 0 ? cells[skuIdx] : '',
        name: nameIdx >= 0 ? cells[nameIdx] : '',
        qty: qtyIdx >= 0 ? parseInt(cells[qtyIdx]) || 1 : 1,
      };
    }).filter(r => r.barcode || r.sku || r.name);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseCsv(String(ev.target.result || ''));
        if (parsed.length === 0) setError('No matching rows found — check the file has Barcode/SKU/Name and Qty columns.');
        setRows(parsed);
      } catch (e) {
        setError('Could not read the file. Please use the CSV template.');
      }
    };
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    const csv = 'Barcode,SKU,Name,Qty\n805289602057,OPT-RAY-001,Ray-Ban Aviator Classic,10\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'Wholesale_Bulk_Import_Template.csv';
    link.click();
  };

  const handleClose = () => { setRows([]); setFileName(''); setError(''); onClose(); };
  const handleImport = () => { onImport(rows); handleClose(); };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>Excel / CSV Import</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info" sx={{ borderRadius: 2 }}>
            Upload a CSV/Excel sheet with columns Barcode, SKU, Name, Qty. Rows are matched against
            live inventory by barcode, SKU or product name.
          </Alert>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" component="label" startIcon={<UploadFileIcon />} sx={{ fontWeight: 700, textTransform: 'none' }}>
              Choose File
              <input type="file" hidden accept=".csv,.xlsx,.xls,.tsv,.txt" onChange={handleFile} />
            </Button>
            <Button variant="text" startIcon={<DownloadIcon />} onClick={downloadTemplate} sx={{ fontWeight: 700, textTransform: 'none' }}>
              Download Template
            </Button>
          </Stack>
          {fileName && <Typography variant="caption" color="text.secondary">Loaded: {fileName} — {rows.length} row(s) parsed</Typography>}
          {error && <Alert severity="warning" sx={{ borderRadius: 2 }}>{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="contained" disabled={rows.length === 0} onClick={handleImport} sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}>
          Import {rows.length > 0 ? `${rows.length} Row(s)` : ''}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Discounts & Schemes (F7)
// ---------------------------------------------------------------------------
export function SchemeDialog({ open, onClose, dealer, schemes, products, invoiceDiscount, onApply }) {
  const [type, setType] = useState(invoiceDiscount?.type || 'PERCENT');
  const [value, setValue] = useState(invoiceDiscount?.value ?? '');
  const [target, setTarget] = useState(invoiceDiscount?.target ?? '');
  const [startDate, setStartDate] = useState(invoiceDiscount?.startDate ?? '');
  const [endDate, setEndDate] = useState(invoiceDiscount?.endDate ?? '');
  const [schemeId, setSchemeId] = useState(invoiceDiscount?.schemeId || '');
  const [buyProduct, setBuyProduct] = useState(null);
  const [buyQty, setBuyQty] = useState(1);
  const [getProduct, setGetProduct] = useState(null);
  const [getQty, setGetQty] = useState(1);

  const handleApply = () => {
    if (type === 'BOGO') {
      onApply({ type: 'BOGO', buyProduct, buyQty: parseInt(buyQty) || 1, getProduct, getQty: parseInt(getQty) || 1 });
    } else if (type === 'SCHEME') {
      const scheme = schemes.find(s => s.id === schemeId);
      onApply({ type: 'SCHEME', schemeId, label: scheme?.name, value: parseFloat(scheme?.value) || 0, valueKind: scheme?.type === 'FIXED' ? 'FIXED' : 'PERCENT' });
    } else if (type === 'BRAND' || type === 'CATEGORY' || type === 'PRODUCT') {
      onApply({ type, value: parseFloat(value) || 0, target, startDate, endDate });
    } else {
      onApply({ type, value: parseFloat(value) || 0, startDate, endDate });
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth {...navDialogProps}>
      <DialogTitle sx={{ fontWeight: 850 }}>Discounts & Schemes</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField select fullWidth size="small" autoFocus label="Discount Type" value={type} onChange={(e) => setType(e.target.value)}>
            {SCHEME_TYPES.filter(t => t.value !== 'DEALER').map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>

          {(type === 'PERCENT' || type === 'FIXED' || type === 'PROMO') && (
            <TextField
              fullWidth size="small" type="number" value={value} onChange={(e) => setValue(e.target.value)}
              label={type === 'FIXED' ? 'Discount Amount (₹)' : 'Discount %'}
            />
          )}

          {(type === 'BRAND' || type === 'CATEGORY' || type === 'PRODUCT') && (
            <Stack spacing={1.5}>
              <TextField
                fullWidth size="small" value={target} onChange={(e) => setTarget(e.target.value)}
                label={type === 'BRAND' ? 'Brand Name' : type === 'CATEGORY' ? 'Category Name' : 'Product Name Contains'}
                placeholder={type === 'BRAND' ? 'e.g. Ray-Ban' : type === 'CATEGORY' ? 'e.g. Sunglasses' : 'e.g. Crizal'}
              />
              <TextField fullWidth size="small" type="number" label="Discount %" value={value} onChange={(e) => setValue(e.target.value)} />
            </Stack>
          )}

          {(type === 'PERCENT' || type === 'FIXED' || type === 'PROMO' || type === 'BRAND' || type === 'CATEGORY' || type === 'PRODUCT') && (
            <Grid container spacing={1.5}>
              <Grid item xs={6}>
                <TextField fullWidth size="small" type="date" label="Start Date" InputLabelProps={{ shrink: true }} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Grid>
              <Grid item xs={6}>
                <TextField fullWidth size="small" type="date" label="End Date" InputLabelProps={{ shrink: true }} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Grid>
            </Grid>
          )}

          {type === 'SCHEME' && (
            <TextField select fullWidth size="small" label="Select Scheme" value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
              {schemes.map(s => (
                <MenuItem key={s.id} value={s.id}>{s.name} ({s.type === 'FIXED' ? `₹${s.value}` : `${s.value}%`})</MenuItem>
              ))}
            </TextField>
          )}

          {type === 'BOGO' && (
            <Stack spacing={1.5}>
              <TextField
                select fullWidth size="small" label="Buy Product"
                value={buyProduct?.id || ''}
                onChange={(e) => setBuyProduct(products.find(p => p.id === e.target.value) || null)}
              >
                {products.slice(0, 100).map(p => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
              </TextField>
              <TextField fullWidth size="small" type="number" label="Buy Qty" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} />
              <Divider />
              <TextField
                select fullWidth size="small" label="Get Product (Free)"
                value={getProduct?.id || ''}
                onChange={(e) => setGetProduct(products.find(p => p.id === e.target.value) || null)}
              >
                {products.slice(0, 100).map(p => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
              </TextField>
              <TextField fullWidth size="small" type="number" label="Get Qty (Free)" value={getQty} onChange={(e) => setGetQty(e.target.value)} />
            </Stack>
          )}

          {dealer?.dealerDiscountPercent > 0 && (
            <Alert severity="info" sx={{ borderRadius: 2, py: 0.25 }}>
              Dealer discount of {dealer.dealerDiscountPercent}% is already applied automatically via this dealer's price list.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={
            type === 'BOGO' ? (!buyProduct || !getProduct)
            : type === 'SCHEME' ? !schemeId
            : (type === 'BRAND' || type === 'CATEGORY' || type === 'PRODUCT') ? (!target || !value)
            : !value
          }
          data-nav-stop
          onClick={handleApply}
          sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}
        >
          Apply Discount
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create Credit Note (against last invoice)
// ---------------------------------------------------------------------------
export function CreditNoteDialog({ open, invoice, onClose, onCreate }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  React.useEffect(() => {
    if (open) { setAmount(invoice?.summary?.grandTotal || ''); setReason(''); }
  }, [open, invoice]);

  if (!invoice) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth {...navDialogProps}>
      <DialogTitle sx={{ fontWeight: 850 }}>Create Credit Note</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Against Invoice <b>{invoice.invoiceNo}</b> — {invoice.customer?.name}
          </Typography>
          <TextField fullWidth size="small" autoFocus type="number" label="Credit Note Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TextField fullWidth size="small" multiline minRows={2} label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          data-nav-stop
          disabled={!amount || parseFloat(amount) <= 0}
          onClick={() => onCreate({ amount: parseFloat(amount) || 0, reason })}
          sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}
        >
          Create Credit Note
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sale Completion — success state
// ---------------------------------------------------------------------------
export function CompletionDialog({ open, invoice, onPrint, onDownloadPdf, onSend, onView, onNewSale }) {
  if (!invoice) return null;
  const isPaid = (invoice.dueAmount || 0) <= 0.009;
  return (
    <Dialog open={open} onClose={onNewSale} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
      <DialogContent sx={{ textAlign: 'center', py: 4 }}>
        <CheckedIcon sx={{ fontSize: 56, color: '#059669', mb: 1 }} />
        <Typography variant="h6" fontWeight={850} color="#0f172a">Wholesale Invoice Created</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Invoice has been posted successfully</Typography>

        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, textAlign: 'left', bgcolor: '#f8fafc' }}>
          <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">Invoice Number</Typography>
            <Typography variant="body2" fontWeight={800} sx={{ fontFamily: 'monospace' }}>{invoice.invoiceNo}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">Grand Total</Typography>
            <Typography variant="body2" fontWeight={800} color="#4f46e5">{fmtINR(invoice.summary?.grandTotal)}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" sx={{ mb: isPaid ? 0 : 0.5 }}>
            <Typography variant="caption" color="text.secondary">Payment</Typography>
            <Chip
              label={isPaid ? `Paid (${invoice.payMode})` : invoice.payMode}
              size="small"
              sx={{ height: 20, fontSize: '0.68rem', fontWeight: 700, bgcolor: isPaid ? '#dcfce7' : '#fef3c7', color: isPaid ? '#15803d' : '#a16207' }}
            />
          </Stack>
          {!isPaid && (
            <>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">Due Amount</Typography>
                <Typography variant="body2" fontWeight={800} color="#dc2626">{fmtINR(invoice.dueAmount)}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary">Due Date</Typography>
                <Typography variant="body2" fontWeight={700}>{invoice.dueDate || '—'}</Typography>
              </Stack>
            </>
          )}
        </Paper>

        <Stack direction="row" spacing={1} sx={{ mt: 2.5 }} flexWrap="wrap" useFlexGap justifyContent="center">
          <Button size="small" variant="outlined" startIcon={<PrintIcon />} onClick={onPrint} sx={{ fontWeight: 700, textTransform: 'none' }}>Print Invoice</Button>
          <Button size="small" variant="outlined" startIcon={<PdfIcon />} onClick={onDownloadPdf} sx={{ fontWeight: 700, textTransform: 'none' }}>Download PDF</Button>
          <Button size="small" variant="outlined" startIcon={<WhatsAppIcon />} onClick={onSend} sx={{ fontWeight: 700, textTransform: 'none' }}>Send to Dealer</Button>
          <Button size="small" variant="outlined" startIcon={<ViewIcon />} onClick={onView} sx={{ fontWeight: 700, textTransform: 'none' }}>View Invoice</Button>
        </Stack>
        <Button fullWidth variant="contained" onClick={onNewSale} sx={{ mt: 1.5, backgroundColor: '#4f46e5', fontWeight: 800, py: 1 }}>
          New Wholesale Sale
        </Button>
      </DialogContent>
    </Dialog>
  );
}
