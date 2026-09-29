import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Grid, Button, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Paper, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Stack, Chip, IconButton, Divider,
  Alert, Autocomplete, Tooltip, ToggleButton, ToggleButtonGroup,
  Menu, Collapse, CircularProgress
} from '@mui/material';
import {
  Search as SearchIcon,
  Delete as DeleteIcon,
  Print as PrintIcon,
  QrCodeScanner as QrCodeScannerIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  CheckCircle as CheckedIcon,
  Warning as WarningIcon,
  PauseCircle as HoldIcon,
  PlayCircle as ResumeIcon,
  WhatsApp as WhatsAppIcon,
  PictureAsPdf as PdfIcon,
  Save as SaveIcon,
  PersonAdd as PersonAddIcon,
  LocalOffer as DiscountIcon,
  CleaningServices as ClearIcon,
  Inventory2 as InventoryIcon,
  MoreVert as MoreVertIcon,
  AccountBalanceWallet as LedgerIcon,
  History as HistoryIcon,
  PlaylistAdd as BulkAddIconMui,
  UploadFile as UploadFileIcon,
  Replay as ReorderIcon,
  LocalShipping as DeliveryIcon,
  Note as NoteIcon,
  Lock as LockIcon,
  Undo as ReturnIcon,
  Cancel as CancelInvoiceIcon,
  ReceiptLong as CreditNoteIcon,
  ContentCopy as DuplicateIcon,
  Send as SendIcon,
  Visibility as ViewIcon,
  Badge as ProfileIcon,
  SwapHoriz as ChangeDealerIcon,
  Inventory as PackingIcon,
  AttachFile as AttachFileIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  EventBusy as ExpiryIcon,
  SyncAlt as ReplacementIcon,
  Description as DocumentIcon,
} from '@mui/icons-material';
import axios from 'axios';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import BillPreview from '../billing/BillPreview';
import { printBill } from '../billing/printBill';
import { downloadPdfInvoice } from '../utils/printInvoice';
import { useAuth } from '../context/AuthContext';
import {
  LS_KEYS, PRICE_LIST_OPTIONS, PRICE_TIER_LABEL, DELIVERY_TYPES, ORDER_STATUSES, ORDER_STATUS_COLORS,
  DEFAULT_SCHEMES, DEMO_SALES_REPS, INITIAL_DEMO_PRODUCTS, INITIAL_DEMO_CUSTOMERS,
  ADDITIONAL_CHARGE_TYPES, NOTE_TEMPLATES, SPLIT_PAYMENT_MODES, WHOLESALE_API,
  uid, readLS, writeLS, resolvePriceForDealer, computeLineTotals, buildDealerLedger,
  fmtINR, canOverridePrice, isUuid, fetchAllPages, mapDealerFromApi, mapDealerToApi,
} from './wholesale/wholesaleConstants';
import {
  NewDealerDialog, LedgerDialog, RecordPaymentDialog, DealerProfileDialog, PreviousOrdersDialog, BulkAddDialog,
  ExcelImportDialog, SchemeDialog, CreditNoteDialog, CompletionDialog,
} from './wholesale/WholesaleDialogs';

// One "label: value" row used across the compact invoice summary / credit panel.
function SummaryLine({ label, value, valueColor, dense }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={dense ? { py: 0.15 } : undefined}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: dense ? '0.78rem' : undefined }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700} sx={{ color: valueColor || '#0f172a', fontSize: dense ? '0.78rem' : undefined }}>{value}</Typography>
    </Stack>
  );
}

// A single field in the selected-dealer info card (only rendered when it has a value).
function CustomerBit({ label, value, valueColor }) {
  return (
    <Grid item xs={6} sm={4}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.3 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700} sx={{ color: valueColor || '#0f172a', wordBreak: 'break-word' }}>{value}</Typography>
    </Grid>
  );
}

// Due / Change tiles under the cash amount field.
function MiniStat({ label, value, color }) {
  return (
    <Box sx={{ flex: 1, p: 1, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="body2" fontWeight={800} sx={{ color }}>{value}</Typography>
    </Box>
  );
}

// Treat inventory placeholder dashes as "no value" so empty columns stay blank.
const cellText = (v) => (v == null || v === '' || v === '—' || v === '-' ? '' : v);

const NEW_DEALER_DEFAULTS = {
  code: '', name: '', contactPerson: '', phone: '', email: '', gstin: '', billingAddress: '', shippingAddress: '',
  priceList: 'WHOLESALE', dealerDiscountPercent: 0, creditLimit: 100000, creditDays: 30, salesExec: 'Default Exec',
};

// FEFO-style expiry check: block adding/selling an already-expired line unless the user
// is authorized to override (mirrors the price-override role gate).
const isExpired = (dateStr) => Boolean(dateStr) && new Date(dateStr) < new Date(new Date().toDateString());
const isNearExpiry = (dateStr) => {
  if (!dateStr) return false;
  const days = (new Date(dateStr) - new Date(new Date().toDateString())) / 86400000;
  return days >= 0 && days <= 30;
};

export default function WholesaleSales() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canOverride = canOverridePrice(user);

  // --- REFS FOR KEYBOARD SHORTCUTS ---
  const customerSearchInputRef = useRef(null);
  const barcodeSearchInputRef = useRef(null);

  // --- CORE MASTER DATA ---
  const [customers, setCustomers] = useState([]);
  const [dealersLoading, setDealersLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('');
  const [stockByWarehouse, setStockByWarehouse] = useState({}); // productId -> { warehouseId: qty }
  const [schemes, setSchemes] = useState(DEFAULT_SCHEMES);
  const [specialPrices, setSpecialPrices] = useState({});
  const [priceListRows, setPriceListRows] = useState([]); // WholesalePriceList — real per-dealer/brand/category overrides

  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [cartItems, setCartItems] = useState([]);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState(-1);
  const [notesOpenIdx, setNotesOpenIdx] = useState(-1);
  // Cosmetic running invoice number shown in the header (the posted invoice keeps its own no.)
  const [headerInvoiceNo] = useState(() => `WS-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`);

  // Order Information
  const [referenceNo, setReferenceNo] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [invoicePriceList, setInvoicePriceList] = useState(''); // overrides the dealer's default price list for this sale
  const [salesRep, setSalesRep] = useState('');
  const [orderStatus, setOrderStatus] = useState('Confirmed');

  // Invoice-level discount / scheme (F6) — kept separate from each line's own % discount.
  const [invoiceDiscount, setInvoiceDiscount] = useState(null);

  // Delivery + Packing/Dispatch
  const [delivery, setDelivery] = useState({ type: 'Pickup', address: '', expectedDate: '', courierName: '', trackingNo: '', notes: '' });
  const [packing, setPacking] = useState({ packages: '', weight: '', packedBy: '', packingDate: '' });
  const [packingOpen, setPackingOpen] = useState(false);
  const [addressEditUnlocked, setAddressEditUnlocked] = useState(false);

  // Notes + Attachments
  const [notesState, setNotesState] = useState({ customer: '', internal: '' });
  const [attachments, setAttachments] = useState([]); // [{name, size, dataUrl, category}]

  // Additional Charges (typed: Delivery/Transport/Packing/Other, each with a taxable flag)
  const [chargesList, setChargesList] = useState(ADDITIONAL_CHARGE_TYPES.map(name => ({ name, amount: '', taxable: false })));
  const [chargesOpen, setChargesOpen] = useState(false);

  // Payment Panel States
  const [payMode, setPayMode] = useState('Cash'); // Cash, UPI, Card, Bank Transfer, Credit Sale, Split Payment
  const [amountReceived, setAmountReceived] = useState('');
  const [creditDays, setCreditDays] = useState(30);
  const [refNo, setRefNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [splitPayments, setSplitPayments] = useState([{ mode: 'Cash', amount: '' }]);

  // Modals & Confirmation Dialogs
  const [newDealerOpen, setNewDealerOpen] = useState(false);
  const [newDealer, setNewDealer] = useState(NEW_DEALER_DEFAULTS);
  const [savingDealer, setSavingDealer] = useState(false);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [heldInvoices, setHeldInvoices] = useState([]);
  const [heldModalOpen, setHeldModalOpen] = useState(false);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printableInvoice, setPrintableInvoice] = useState(null); // last completed invoice — also used by More Actions
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [dealerProfileOpen, setDealerProfileOpen] = useState(false);
  const [prevOrdersOpen, setPrevOrdersOpen] = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
  const [excelImportOpen, setExcelImportOpen] = useState(false);
  const [schemeOpen, setSchemeOpen] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [creditNoteOpen, setCreditNoteOpen] = useState(false);
  const [moreActionsAnchor, setMoreActionsAnchor] = useState(null);

  const [clearCartConfirmOpen, setClearCartConfirmOpen] = useState(false);
  const [creditLimitConfirmOpen, setCreditLimitConfirmOpen] = useState(false);
  const [cancelInvoiceConfirmOpen, setCancelInvoiceConfirmOpen] = useState(false);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [replacementConfirmOpen, setReplacementConfirmOpen] = useState(false);

  // Toast Alert Notification
  const [toast, setToast] = useState({ open: false, message: '', severity: 'info' });
  const showToast = (msg, severity = 'info') => {
    setToast({ open: true, message: msg, severity });
    setTimeout(() => setToast({ open: false, message: '', severity: 'info' }), 4000);
  };

  // --- Load Master Data (dealers, held invoices, schemes, special prices) ---
  // Dealers are backed by the real apps.sales.Dealer model (GET /api/sales/wholesale/dealers/) —
  // a full CRUD REST resource that already existed but no frontend ever called it. localStorage
  // is only the offline cache/fallback, same posture as the live product sync below.
  useEffect(() => {
    let cancelled = false;

    const loadDealers = async () => {
      setDealersLoading(true);
      const cached = readLS(LS_KEYS.customers, []);
      if (cached.length) setCustomers(cached);
      try {
        const rows = await fetchAllPages(axios, `${WHOLESALE_API}/dealers/`);
        if (cancelled) return;
        if (rows.length) {
          const mapped = rows.map(mapDealerFromApi);
          setCustomers(mapped);
          writeLS(LS_KEYS.customers, mapped);
        } else if (cached.length === 0) {
          setCustomers(INITIAL_DEMO_CUSTOMERS);
          writeLS(LS_KEYS.customers, INITIAL_DEMO_CUSTOMERS);
        }
      } catch (e) {
        if (cancelled) return;
        if (cached.length === 0) {
          setCustomers(INITIAL_DEMO_CUSTOMERS);
          writeLS(LS_KEYS.customers, INITIAL_DEMO_CUSTOMERS);
        }
      } finally {
        if (!cancelled) setDealersLoading(false);
      }
    };

    const loadPriceLists = async () => {
      try {
        const rows = await fetchAllPages(axios, `${WHOLESALE_API}/price-lists/`);
        if (!cancelled) setPriceListRows(rows);
      } catch (e) {}
    };

    loadDealers();
    loadPriceLists();
    setHeldInvoices(readLS(LS_KEYS.held, []));
    const savedSchemes = readLS(LS_KEYS.schemes, []);
    setSchemes(savedSchemes.length ? savedSchemes : DEFAULT_SCHEMES);
    if (!savedSchemes.length) writeLS(LS_KEYS.schemes, DEFAULT_SCHEMES);
    setSpecialPrices(readLS(LS_KEYS.specialPrices, {}));

    return () => { cancelled = true; };
  }, []);

  // --- Live Inventory sync ---
  // The wholesale catalogue and on-hand stock are pulled from the SAME backend Product list
  // as the Inventory > Products screen, so a Purchase Entry, stock adjustment or retail sale
  // is reflected here immediately. localStorage is only a fallback for offline use / demo data.
  useEffect(() => {
    let cancelled = false;

    const mapBackendProduct = (p) => {
      const stock = parseInt(p.stock ?? p.quantity ?? 0) || 0;
      const gstNum = parseFloat(String(p.gst ?? p.tax_rate ?? '').replace('%', '').trim());
      const extra = p.extra_data && typeof p.extra_data === 'object' ? p.extra_data : {};
      return {
        id: String(p.id),
        code: p.product_code || p.sku || p.code || '',
        sku: p.sku || p.product_code || '',
        name: p.name || 'Unnamed',
        brand: p.brand || 'Generic',
        category: p.category || 'General',
        modelNo: p.model_no || extra.model_no || extra.model || '—',
        color: p.colour || p.color || extra.color || '—',
        size: p.size || extra.size || '—',
        power: p.power || extra.power || '—',
        lensType: extra.lens_type || extra.lensType || '—',
        cylinder: extra.cylinder || extra.cyl || '—',
        axis: extra.axis || '—',
        batch: extra.batch || extra.batch_number || '—',
        availableStock: stock,
        stock,
        minStock: parseInt(p.minimum_stock ?? 5) || 5,
        retailPrice: parseFloat(p.retail_price || p.price || 0) || 0,
        wholesalePrice: parseFloat(p.wholesale_price || p.price || p.retail_price || 0) || 0,
        price: parseFloat(p.price || p.retail_price || 0) || 0,
        gst: Number.isFinite(gstNum) ? gstNum : 18,
        unit: p.unit || 'Pcs',
        barcode: p.barcode || '',
      };
    };

    const keyOf = (p) => String(p.barcode || p.code || p.sku || p.id || p.name || '').toLowerCase();

    const readLocalProducts = () => readLS(LS_KEYS.inventory, []);

    const syncInventory = async () => {
      let local = readLocalProducts();

      let backend = [];
      try {
        const res = await axios.get('/api/products/products/');
        const raw = res.data?.results || res.data || [];
        if (Array.isArray(raw)) backend = raw.map(mapBackendProduct);
      } catch (e) {}

      if (cancelled) return;

      if (backend.length === 0) {
        if (local.length === 0) {
          setProducts(INITIAL_DEMO_PRODUCTS);
          writeLS(LS_KEYS.inventory, INITIAL_DEMO_PRODUCTS);
        } else {
          setProducts(local);
        }
        return;
      }

      const backendKeys = new Set(backend.map(keyOf));
      const backendIds = new Set(backend.map(p => String(p.id)));
      const localOnly = local.filter(p => !backendKeys.has(keyOf(p)) && !backendIds.has(String(p.id)));

      setProducts([...backend, ...localOnly]);
    };

    const loadWarehouses = async () => {
      try {
        const res = await axios.get('/api/company/warehouses/');
        const list = res.data?.results || res.data || [];
        if (!cancelled && Array.isArray(list)) {
          setWarehouses(list);
          setSelectedWarehouseId(prev => prev || (list.length ? String(list[0].id) : ''));
        }
      } catch (e) {}
    };

    // Best-effort warehouse-wise on-hand stock, derived from the stock ledger so no new
    // backend endpoint is needed. Falls back gracefully when unreachable/empty.
    const loadLedger = async () => {
      try {
        const res = await axios.get('/api/inventory/ledger/');
        const raw = res.data?.results || res.data || [];
        const map = {};
        (Array.isArray(raw) ? raw : []).forEach(row => {
          const pid = String(row.product);
          const wid = String(row.warehouse);
          const qty = parseFloat(row.quantity) || 0;
          if (!map[pid]) map[pid] = {};
          map[pid][wid] = (map[pid][wid] || 0) + qty;
        });
        if (!cancelled) setStockByWarehouse(map);
      } catch (e) {}
    };

    const initialLocal = readLocalProducts();
    if (initialLocal.length) setProducts(initialLocal);

    syncInventory();
    loadWarehouses();
    loadLedger();
    window.addEventListener('optical_stock_updated', syncInventory);
    window.addEventListener('focus', syncInventory);
    return () => {
      cancelled = true;
      window.removeEventListener('optical_stock_updated', syncInventory);
      window.removeEventListener('focus', syncInventory);
    };
  }, []);

  const warehouseName = (id) => warehouses.find(w => String(w.id) === String(id))?.name || 'Main Warehouse';

  const getWarehouseStockText = (product) => {
    const map = stockByWarehouse[String(product.id)];
    if (map && Object.keys(map).length) {
      return Object.entries(map)
        .filter(([, q]) => q !== 0)
        .map(([wid, q]) => `${warehouseName(wid)}: ${q}`)
        .join(' • ');
    }
    return selectedWarehouseId ? `${warehouseName(selectedWarehouseId)}: ${product.availableStock ?? product.stock ?? 0}` : '';
  };

  // --- Dealer's previous wholesale invoices (for Recent Orders / Previous Orders / Reorder) ---
  const dealerOrders = useMemo(() => {
    if (!selectedCustomer) return [];
    const all = readLS(LS_KEYS.invoices, []);
    return all
      .filter(inv => inv.customer?.id === selectedCustomer.id || inv.customer?.code === selectedCustomer.code)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [selectedCustomer, printableInvoice]);

  const dealerLedger = useMemo(() => {
    if (!selectedCustomer) return [];
    return buildDealerLedger(selectedCustomer, readLS(LS_KEYS.invoices, []), readLS(LS_KEYS.returns, []).concat(readLS(LS_KEYS.creditNotes, [])), readLS(LS_KEYS.payments, []));
  }, [selectedCustomer, printableInvoice]);

  // A time-boxed scheme (startDate/endDate) is only live "today" — outside that window it's
  // treated as inactive rather than silently discounting the invoice.
  const isSchemeActive = (d) => {
    if (!d) return true;
    const today = new Date().toISOString().split('T')[0];
    if (d.startDate && today < d.startDate) return false;
    if (d.endDate && today > d.endDate) return false;
    return true;
  };

  // --- Real-Time Invoice Calculations ---
  const summary = useMemo(() => {
    const totalItems = cartItems.length;
    const totalQty = cartItems.reduce((acc, item) => acc + (parseFloat(item.qty) || 0), 0);
    const totalFreeQty = cartItems.reduce((acc, item) => acc + (parseFloat(item.freeQty) || 0), 0);
    const subtotal = cartItems.reduce((acc, item) => acc + ((parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0)), 0);
    const productDiscount = cartItems.reduce((acc, item) => acc + computeLineTotals(item).lineDiscount, 0);
    const netAfterProductDiscount = subtotal - productDiscount;

    let schemeDiscount = 0;
    let schemeLabel = '';
    let schemeActive = true;
    if (invoiceDiscount) {
      schemeActive = isSchemeActive(invoiceDiscount);
      const targetedType = ['BRAND', 'CATEGORY', 'PRODUCT'].includes(invoiceDiscount.type);
      if (schemeActive && targetedType) {
        // Brand/Category/Product discounts only apply to matching lines, not the whole cart.
        const target = (invoiceDiscount.target || '').toLowerCase();
        const matchesLine = (item) => {
          if (invoiceDiscount.type === 'BRAND') return (item.brand || '').toLowerCase() === target;
          if (invoiceDiscount.type === 'CATEGORY') return (item.category || '').toLowerCase() === target;
          return (item.name || '').toLowerCase().includes(target);
        };
        const matchedBase = cartItems.filter(matchesLine).reduce((a, i) => a + computeLineTotals(i).gross, 0);
        schemeDiscount = matchedBase * ((parseFloat(invoiceDiscount.value) || 0) / 100);
        schemeLabel = `${invoiceDiscount.type === 'BRAND' ? 'Brand' : invoiceDiscount.type === 'CATEGORY' ? 'Category' : 'Product'} Discount — ${invoiceDiscount.target} (${invoiceDiscount.value}%)`;
      } else if (schemeActive && invoiceDiscount.type === 'PERCENT') {
        schemeDiscount = netAfterProductDiscount * ((parseFloat(invoiceDiscount.value) || 0) / 100);
        schemeLabel = `${invoiceDiscount.value}% Off`;
      } else if (schemeActive && invoiceDiscount.type === 'PROMO') {
        schemeDiscount = netAfterProductDiscount * ((parseFloat(invoiceDiscount.value) || 0) / 100);
        schemeLabel = `Promo ${invoiceDiscount.value}%`;
      } else if (schemeActive && invoiceDiscount.type === 'FIXED') {
        schemeDiscount = Math.min(netAfterProductDiscount, parseFloat(invoiceDiscount.value) || 0);
        schemeLabel = `Flat ₹${invoiceDiscount.value}`;
      } else if (invoiceDiscount.type === 'SCHEME') {
        schemeDiscount = invoiceDiscount.valueKind === 'FIXED'
          ? Math.min(netAfterProductDiscount, parseFloat(invoiceDiscount.value) || 0)
          : netAfterProductDiscount * ((parseFloat(invoiceDiscount.value) || 0) / 100);
        schemeLabel = invoiceDiscount.label || 'Scheme Discount';
      } else if (invoiceDiscount.type === 'BOGO') {
        schemeLabel = 'Buy X Get Y';
      }
      if (!schemeActive && !targetedType && invoiceDiscount.type !== 'SCHEME' && invoiceDiscount.type !== 'BOGO') {
        schemeLabel = `${schemeLabel || 'Discount'} (not active — outside date range)`;
      }
    }
    // Free (BOGO) lines carry their own 100% line discount already, but their full value
    // is reported as Scheme Discount so the breakdown stays meaningful.
    const bogoValue = cartItems.filter(i => i.isFreeGift).reduce((a, i) => a + ((parseFloat(i.rate) || 0) * (parseFloat(i.qty) || 0)), 0);
    schemeDiscount += bogoValue;

    const netAfterSchemeDiscount = Math.max(0, netAfterProductDiscount - schemeDiscount);

    // Typed additional charges: taxable ones join the taxable base (GST applies to them too);
    // non-taxable ones are added straight to the grand total afterwards.
    const taxableCharges = chargesList.filter(c => c.taxable).reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
    const nonTaxableCharges = chargesList.filter(c => !c.taxable).reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
    const totalCharges = taxableCharges + nonTaxableCharges;

    const taxableAmount = netAfterSchemeDiscount + taxableCharges;
    // Scheme discount is spread pro-rata across lines (by value) so each line's own GST%
    // still applies correctly to the reduced taxable base.
    const factor = netAfterProductDiscount > 0 ? netAfterSchemeDiscount / netAfterProductDiscount : 0;
    const productGst = cartItems.reduce((acc, item) => {
      const t = computeLineTotals(item);
      const lineTaxable = t.gross * factor;
      return acc + (lineTaxable * ((parseFloat(item.gst) || 0) / 100));
    }, 0);
    // Taxable additional charges are assumed GST-18% (matches the rest of this module's default rate).
    const chargesGst = taxableCharges * 0.18;
    const totalGst = productGst + chargesGst;

    const rawTotal = taxableAmount + totalGst + nonTaxableCharges;
    const grandTotal = Math.round(rawTotal);
    const roundOff = (grandTotal - rawTotal);

    return {
      totalItems, totalQty, totalFreeQty, subtotal, productDiscount, schemeDiscount, schemeLabel, schemeActive,
      totalDiscount: productDiscount + schemeDiscount, // kept for WholesaleReports.jsx parity
      taxableAmount, totalGst, additionalCharges: totalCharges, taxableCharges, nonTaxableCharges, roundOff, grandTotal,
    };
  }, [cartItems, chargesList, invoiceDiscount]);

  // --- DYNAMIC PAYMENT METHOD BEHAVIOR ---
  useEffect(() => {
    if (payMode === 'UPI' || payMode === 'Card') {
      setAmountReceived(summary.grandTotal ? String(summary.grandTotal) : '');
    } else if (payMode === 'Credit Sale' || payMode === 'Bank Transfer') {
      setAmountReceived('');
    }
  }, [payMode, summary.grandTotal]);

  // In Split Payment, a "Credit" row marks that portion as due-later rather than paid now;
  // every other mode counts toward cash received immediately.
  const splitCreditAmount = useMemo(() => splitPayments.filter(s => s.mode === 'Credit').reduce((a, s) => a + (parseFloat(s.amount) || 0), 0), [splitPayments]);
  const splitPaidAmount = useMemo(() => splitPayments.filter(s => s.mode !== 'Credit').reduce((a, s) => a + (parseFloat(s.amount) || 0), 0), [splitPayments]);
  const splitTotal = splitPaidAmount + splitCreditAmount;

  // Payment Calculation
  const paymentCalc = useMemo(() => {
    if (payMode === 'Split Payment') {
      const shortfall = Math.max(0, summary.grandTotal - splitTotal);
      const dueAmount = splitCreditAmount + shortfall;
      const balanceAmount = Math.max(0, splitTotal - summary.grandTotal);
      return { dueAmount, balanceAmount, paidNow: splitPaidAmount };
    }
    const received = parseFloat(amountReceived) || (payMode === 'UPI' || payMode === 'Card' ? summary.grandTotal : 0);
    if (payMode === 'Credit Sale' || payMode === 'Bank Transfer') {
      return { dueAmount: summary.grandTotal, balanceAmount: 0, paidNow: 0 };
    }
    const dueAmount = Math.max(0, summary.grandTotal - received);
    const balanceAmount = Math.max(0, received - summary.grandTotal);
    return { dueAmount, balanceAmount, paidNow: received };
  }, [payMode, amountReceived, summary.grandTotal, splitTotal, splitCreditAmount, splitPaidAmount]);

  const dueDate = useMemo(() => {
    if (paymentCalc.dueAmount <= 0.009) return '';
    const base = new Date();
    base.setDate(base.getDate() + (parseInt(creditDays) || 0));
    return base.toISOString().split('T')[0];
  }, [paymentCalc.dueAmount, creditDays]);

  // Outstanding Balance warning color logic
  const outstandingColor = useMemo(() => {
    if (!selectedCustomer || !selectedCustomer.creditLimit) return '#475569';
    const out = parseFloat(selectedCustomer.outstanding || 0);
    const limit = parseFloat(selectedCustomer.creditLimit || 1);
    const ratio = out / limit;
    if (ratio >= 0.9) return '#dc2626';
    if (ratio >= 0.6) return '#d97706';
    return '#059669';
  }, [selectedCustomer]);

  // Credit Limit Warning Check
  const isCreditExceeded = useMemo(() => {
    if (!selectedCustomer || !selectedCustomer.creditLimit) return false;
    const currOutstanding = parseFloat(selectedCustomer.outstanding || 0);
    const limit = parseFloat(selectedCustomer.creditLimit || 0);
    const creditPortion = payMode === 'Credit Sale' ? summary.grandTotal : payMode === 'Split Payment' ? splitCreditAmount : 0;
    const newTotalOut = currOutstanding + creditPortion;
    return limit > 0 && creditPortion > 0 && newTotalOut > limit;
  }, [selectedCustomer, summary.grandTotal, payMode, splitCreditAmount]);

  const anyDialogOpen = newDealerOpen || heldModalOpen || printModalOpen || creditLimitConfirmOpen || clearCartConfirmOpen
    || ledgerOpen || prevOrdersOpen || bulkAddOpen || excelImportOpen || schemeOpen || completionOpen || creditNoteOpen
    || cancelInvoiceConfirmOpen || returnConfirmOpen || recordPaymentOpen || dealerProfileOpen || replacementConfirmOpen;

  // --- KEYBOARD SHORTCUTS SCOPED TO THIS SCREEN ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (anyDialogOpen) return;
      const tag = (e.target?.tagName || '').toUpperCase();
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';

      if (e.key === 'F2') {
        e.preventDefault();
        customerSearchInputRef.current?.focus();
      } else if (e.key === 'F3') {
        e.preventDefault();
        barcodeSearchInputRef.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setBulkAddOpen(true);
      } else if (e.key === 'F6') {
        e.preventDefault();
        setSchemeOpen(true);
      } else if (e.key === 'F7') {
        e.preventDefault();
        handleHoldInvoice();
      } else if (e.key === 'F8') {
        e.preventDefault();
        handleSaveDraft();
      } else if (e.key === 'F9') {
        e.preventDefault();
        if (selectedCustomer && cartItems.length > 0) {
          handleAttemptCompleteSale();
        } else {
          showToast('Cannot submit: Select a dealer and add products to cart.', 'warning');
        }
      } else if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        if (printableInvoice) setPrintModalOpen(true);
        else showToast('Complete a sale first to print an invoice.', 'warning');
      } else if (e.key === 'Escape') {
        if (!inField) {
          setBarcodeInput('');
          barcodeSearchInputRef.current?.blur();
        } else if (tag === 'INPUT') {
          e.target.blur();
        }
      } else if (e.key === 'Delete' && !inField) {
        if (selectedRowIndex >= 0 && selectedRowIndex < cartItems.length) {
          e.preventDefault();
          handleRemoveItem(selectedRowIndex);
          setSelectedRowIndex(-1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyDialogOpen, selectedCustomer, cartItems, selectedRowIndex, printableInvoice]);

  // Park the cursor in the barcode field on load so a scanner works without a click.
  useEffect(() => {
    const t = setTimeout(() => barcodeSearchInputRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  // --- Handlers ---
  // The Order Information "Price List" selector overrides the dealer's own default for
  // just this invoice, without touching the dealer's stored record.
  const effectiveDealer = useMemo(() => {
    if (!selectedCustomer) return null;
    return invoicePriceList ? { ...selectedCustomer, priceList: invoicePriceList } : selectedCustomer;
  }, [selectedCustomer, invoicePriceList]);

  const priceForProduct = (prod, qty = 1) => resolvePriceForDealer(prod, effectiveDealer, specialPrices, qty, priceListRows);

  const buildCartLine = (prod, qty = 1) => {
    const avail = parseFloat(prod.availableStock ?? prod.stock ?? 0);
    const { rate, tier } = priceForProduct(prod, qty);
    return {
      id: prod.id || prod.code,
      barcode: prod.barcode || prod.code,
      code: prod.code || prod.sku,
      sku: prod.sku || prod.code,
      name: prod.name,
      brand: prod.brand || 'Generic',
      category: prod.category || 'Optical',
      modelNo: prod.modelNo || prod.model_no || prod.model || '',
      color: prod.color || prod.colour || '',
      size: prod.size || '',
      power: prod.power || '',
      lensType: prod.lensType || '',
      cylinder: prod.cylinder || '',
      axis: prod.axis || '',
      batch: prod.batch && prod.batch !== '—' ? prod.batch : '',
      expiry: '',
      unit: prod.unit || 'Pcs',
      availableStock: avail,
      qty,
      freeQty: 0,
      rate,
      priceTier: tier,
      discount: 0,
      gst: parseFloat(prod.gst || 18),
      notes: '',
      isFreeGift: false,
    };
  };

  const handleAddProductToCart = (prod, qty = 1) => {
    if (!prod) return;
    const avail = parseFloat(prod.availableStock ?? prod.stock ?? 0);
    if (avail <= 0) {
      showToast(`Out of Stock: ${prod.name} has 0 available inventory.`, 'error');
      return;
    }

    setCartItems(prev => {
      const existingIdx = prev.findIndex(item => (item.id === prod.id || item.code === prod.code) && !item.isFreeGift);
      if (existingIdx !== -1) {
        const next = [...prev];
        next[existingIdx] = { ...next[existingIdx], qty: next[existingIdx].qty + qty };
        return next;
      }
      return [...prev, buildCartLine(prod, qty)];
    });
  };

  const handleBarcodeScan = (e) => {
    if (e.key === 'Enter' && barcodeInput.trim()) {
      const code = barcodeInput.trim().toLowerCase();
      const matched = products.find(p =>
        (p.barcode && p.barcode.toLowerCase() === code) ||
        (p.code && p.code.toLowerCase() === code) ||
        (p.sku && p.sku.toLowerCase() === code)
      );
      if (matched) {
        e.preventDefault();
        e.stopPropagation();
        handleAddProductToCart(matched);
        setBarcodeInput('');
        showToast(`Added: ${matched.name}`, 'success');
        setTimeout(() => barcodeSearchInputRef.current?.focus(), 0);
      } else if (/^\d{6,}$/.test(code)) {
        showToast(`No product found matching barcode "${barcodeInput}"`, 'error');
      }
    }
  };

  const handleUpdateItemQty = (index, deltaOrVal, isDirectValue = false) => {
    setCartItems(prev => {
      const next = [...prev];
      const target = next[index];
      let newQty = isDirectValue ? parseInt(deltaOrVal) || 1 : target.qty + deltaOrVal;
      if (newQty < 1) newQty = 1;
      next[index] = { ...target, qty: newQty };
      return next;
    });
  };

  const handleUpdateItemField = (index, field, value) => {
    setCartItems(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      if (field === 'rate') next[index].priceTier = 'CUSTOM';
      return next;
    });
  };

  const handleRemoveItem = (index) => {
    setCartItems(prev => prev.filter((_, i) => i !== index));
  };

  const resetSaleForm = () => {
    setCartItems([]);
    setAmountReceived('');
    setChargesList(ADDITIONAL_CHARGE_TYPES.map(name => ({ name, amount: '', taxable: false })));
    setRefNo('');
    setBankName('');
    setInvoiceDiscount(null);
    setReferenceNo('');
    setPoNumber('');
    setInvoicePriceList('');
    setDelivery({ type: 'Pickup', address: selectedCustomer?.shippingAddress || '', expectedDate: '', courierName: '', trackingNo: '', notes: '' });
    setPacking({ packages: '', weight: '', packedBy: '', packingDate: '' });
    setPackingOpen(false);
    setNotesState({ customer: '', internal: '' });
    setAttachments([]);
    setSplitPayments([{ mode: 'Cash', amount: '' }]);
    setOrderStatus('Confirmed');
  };

  const handleClearCart = () => {
    resetSaleForm();
    showToast('POS Cart cleared.', 'info');
  };

  const handleHoldInvoice = () => {
    if (cartItems.length === 0) {
      showToast('Cannot hold an empty invoice cart.', 'warning');
      return;
    }
    const heldItem = {
      id: `HOLD-${Date.now()}`,
      customer: selectedCustomer,
      cartItems,
      chargesList,
      delivery,
      notes: notesState,
      salesRep,
      referenceNo,
      poNumber,
      heldAt: new Date().toLocaleTimeString(),
      totalAmount: summary.grandTotal,
    };
    const updatedHeld = [...heldInvoices, heldItem];
    setHeldInvoices(updatedHeld);
    writeLS(LS_KEYS.held, updatedHeld);
    resetSaleForm();
    showToast(`Invoice held successfully (${heldItem.id})`, 'success');
  };

  const handleResumeHeldInvoice = (heldItem) => {
    setSelectedCustomer(heldItem.customer);
    setCartItems(heldItem.cartItems);
    setChargesList(heldItem.chargesList || ADDITIONAL_CHARGE_TYPES.map(name => ({ name, amount: '', taxable: false })));
    if (heldItem.delivery) setDelivery(heldItem.delivery);
    if (heldItem.notes) setNotesState(heldItem.notes);
    if (heldItem.salesRep) setSalesRep(heldItem.salesRep);
    setReferenceNo(heldItem.referenceNo || '');
    setPoNumber(heldItem.poNumber || '');

    const updatedHeld = heldInvoices.filter(h => h.id !== heldItem.id);
    setHeldInvoices(updatedHeld);
    writeLS(LS_KEYS.held, updatedHeld);
    setHeldModalOpen(false);
    showToast(`Resumed held invoice ${heldItem.id}`, 'info');
  };

  // Registers the dealer against the real backend Dealer model (POST /api/sales/wholesale/dealers/).
  // Falls back to a local-only record (no backend id) if the API is unreachable, so the POS
  // keeps working offline — that record is simply never patched to the server afterwards.
  const handleSaveNewDealer = async () => {
    if (!newDealer.name || !newDealer.phone) {
      showToast('Please provide Business Name and Phone number.', 'error');
      return;
    }
    setSavingDealer(true);
    // The real Dealer model requires a unique dealer_code with no server-side auto-numbering,
    // so the POS mints one client-side when the user leaves it blank.
    const code = newDealer.code || `DL-${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      const payload = mapDealerToApi({ ...newDealer, code, outstanding: 0 });
      const res = await axios.post(`${WHOLESALE_API}/dealers/`, payload);
      const createdCust = mapDealerFromApi(res.data);
      createdCust.billingAddress = newDealer.billingAddress || createdCust.billingAddress;
      createdCust.shippingAddress = newDealer.shippingAddress || createdCust.shippingAddress;
      const updated = [createdCust, ...customers];
      setCustomers(updated);
      writeLS(LS_KEYS.customers, updated);
      handleSelectCustomer(createdCust);
      setNewDealerOpen(false);
      setNewDealer(NEW_DEALER_DEFAULTS);
      showToast(`Wholesale Dealer registered: ${createdCust.name}`, 'success');
    } catch (e) {
      const createdCust = {
        id: uid('c'), code,
        name: newDealer.name, contactPerson: newDealer.contactPerson || newDealer.name, phone: newDealer.phone,
        email: newDealer.email || '', gstin: newDealer.gstin || '',
        billingAddress: newDealer.billingAddress || '', shippingAddress: newDealer.shippingAddress || newDealer.billingAddress || '',
        priceList: newDealer.priceList || 'WHOLESALE', category: newDealer.priceList || 'Wholesale',
        dealerDiscountPercent: parseFloat(newDealer.dealerDiscountPercent) || 0,
        creditLimit: parseFloat(newDealer.creditLimit) || 100000, outstanding: 0, openingBalance: 0,
        creditDays: parseInt(newDealer.creditDays) || 30, salesExec: newDealer.salesExec || 'Default Exec',
        lastPurchaseDate: new Date().toISOString().split('T')[0], totalPurchases: '₹ 0',
      };
      const updated = [createdCust, ...customers];
      setCustomers(updated);
      writeLS(LS_KEYS.customers, updated);
      handleSelectCustomer(createdCust);
      setNewDealerOpen(false);
      setNewDealer(NEW_DEALER_DEFAULTS);
      showToast(`Dealer saved locally (offline) — will not sync until the server is reachable.`, 'warning');
    } finally {
      setSavingDealer(false);
    }
  };

  // Dealer selection also seeds Sales Rep + delivery address (auto-filled from the dealer's own
  // shipping address, editable only by authorized users) + resets any per-invoice price-list override.
  const handleSelectCustomer = (val) => {
    setSelectedCustomer(val);
    setSalesRep(val?.salesExec || '');
    setInvoicePriceList('');
    setAddressEditUnlocked(false);
    setDelivery(prev => ({ ...prev, address: val?.shippingAddress || prev.address }));
  };

  // --- Discount / Scheme (F6) ---
  const handleApplyScheme = (payload) => {
    if (payload.type === 'BOGO') {
      const { buyProduct, buyQty, getProduct, getQty } = payload;
      const buyLine = cartItems.find(i => i.id === buyProduct.id && !i.isFreeGift);
      if (!buyLine || buyLine.qty < buyQty) {
        showToast(`Add at least ${buyQty} x ${buyProduct.name} to the cart to qualify for this offer.`, 'warning');
        return;
      }
      const freeLine = { ...buildCartLine(getProduct, getQty), rate: buildCartLine(getProduct, 1).rate, discount: 100, isFreeGift: true, priceTier: 'CUSTOM', notes: 'FREE — Buy X Get Y scheme' };
      setCartItems(prev => [...prev.filter(i => !(i.isFreeGift && i.id === getProduct.id)), freeLine]);
      setInvoiceDiscount(payload);
      showToast(`Scheme applied: Buy ${buyQty} ${buyProduct.name} → Get ${getQty} ${getProduct.name} free.`, 'success');
    } else {
      setInvoiceDiscount(payload);
      showToast('Discount / scheme applied to invoice.', 'success');
    }
  };

  // --- Bulk Add / Excel Import / Reorder ---
  const handleBulkAdd = (items) => {
    items.forEach(({ product, qty }) => handleAddProductToCart(product, qty));
    showToast(`${items.length} product(s) added to cart.`, 'success');
  };

  const handleExcelImport = (rows) => {
    let matched = 0;
    rows.forEach(row => {
      const found = products.find(p =>
        (row.barcode && p.barcode && p.barcode.toLowerCase() === row.barcode.toLowerCase()) ||
        (row.sku && p.code && p.code.toLowerCase() === row.sku.toLowerCase()) ||
        (row.sku && p.sku && p.sku.toLowerCase() === row.sku.toLowerCase()) ||
        (row.name && p.name && p.name.toLowerCase() === row.name.toLowerCase())
      );
      if (found) { handleAddProductToCart(found, row.qty || 1); matched += 1; }
    });
    showToast(matched > 0 ? `Imported ${matched} of ${rows.length} row(s) into cart.` : 'No matching products found for the imported rows.', matched > 0 ? 'success' : 'warning');
  };

  const applyOrderToCart = (order, mode) => {
    const restored = order.items.map(it => {
      const live = products.find(p => p.id === it.id || p.code === it.code);
      return live ? { ...buildCartLine(live, it.qty), discount: it.discount || 0 } : { ...it };
    });
    if (mode === 'duplicate') {
      setSelectedCustomer(order.customer);
      setSalesRep(order.customer?.salesExec || '');
      setCartItems(restored);
      showToast(`Duplicated order ${order.invoiceNo} into a new draft.`, 'success');
    } else {
      setCartItems(prev => {
        const next = [...prev];
        restored.forEach(r => {
          const idx = next.findIndex(i => i.id === r.id && !i.isFreeGift);
          if (idx !== -1) next[idx] = { ...next[idx], qty: next[idx].qty + r.qty };
          else next.push(r);
        });
        return next;
      });
      showToast(`Reordered items from ${order.invoiceNo}.`, 'success');
    }
    setPrevOrdersOpen(false);
  };

  const handleViewOrder = (order) => { setPrintableInvoice(order); setPrintModalOpen(true); };

  // Trigger Completion or Open Confirmation Dialog if Credit Exceeded
  function handleAttemptCompleteSale() {
    if (!selectedCustomer) {
      showToast('Please select a wholesale dealer first.', 'error');
      return;
    }
    if (cartItems.length === 0) {
      showToast('POS cart is empty. Add products to complete sale.', 'error');
      return;
    }
    if (cartItems.some(i => !(parseFloat(i.qty) > 0))) {
      showToast('Every line item needs a quantity greater than 0.', 'error');
      return;
    }
    if (cartItems.some(i => !i.isFreeGift && (parseFloat(i.discount) < 0 || parseFloat(i.discount) > 100))) {
      showToast('Line discount must be between 0% and 100%.', 'error');
      return;
    }
    if (!selectedWarehouseId && warehouses.length > 0) {
      showToast('Please select a warehouse before completing the sale.', 'error');
      return;
    }
    const overStock = cartItems.find(i => !i.isFreeGift && (i.qty + (parseFloat(i.freeQty) || 0)) > i.availableStock);
    if (overStock && !canOverride) {
      showToast(`${overStock.name}: quantity exceeds available stock (${overStock.availableStock}). Only Managers/Admins can override.`, 'error');
      return;
    }
    const expiredLine = cartItems.find(i => isExpired(i.expiry));
    if (expiredLine && !canOverride) {
      showToast(`${expiredLine.name} has expired stock (batch ${expiredLine.batch || '—'}). Only Managers/Admins can override an expired sale.`, 'error');
      return;
    }
    if (delivery.type !== 'Pickup' && !delivery.address) {
      showToast('Please provide a shipping address for this delivery method.', 'error');
      return;
    }
    if (payMode === 'Split Payment' && Math.abs(splitTotal - summary.grandTotal) > 0.5) {
      showToast(`Split payment total (₹${splitTotal.toFixed(2)}) must equal the Grand Total (₹${summary.grandTotal.toFixed(2)}).`, 'error');
      return;
    }
    if (isCreditExceeded) {
      setCreditLimitConfirmOpen(true);
    } else {
      executeCompleteSale();
    }
  }

  function buildInvoiceObject(status) {
    const invoiceNo = `WINV-${Math.floor(100000 + Math.random() * 900000)}`;
    const invoiceDate = new Date().toISOString().split('T')[0];
    const paid = paymentCalc.paidNow;

    return {
      id: invoiceNo,
      invoiceNo,
      date: invoiceDate,
      dueDate: paymentCalc.dueAmount > 0.009 ? dueDate : '',
      customer: selectedCustomer,
      items: cartItems.map(it => ({ ...it, taxPercent: it.gst, total: computeLineTotals(it).total })),
      summary,
      payMode,
      splitPayments: payMode === 'Split Payment' ? splitPayments : undefined,
      refNo,
      bankName,
      amountReceived: paid,
      dueAmount: paymentCalc.dueAmount,
      creditDays,
      status: status === 'Draft' ? 'Draft' : (paymentCalc.dueAmount > 0.009 ? 'Partial' : 'Paid'),
      orderStatus: status,
      referenceNo,
      poNumber,
      warehouseId: selectedWarehouseId,
      warehouseName: warehouseName(selectedWarehouseId),
      priceList: invoicePriceList || selectedCustomer?.priceList,
      delivery,
      packing,
      attachments,
      notes: notesState,
      salesExecutive: salesRep,
      invoiceDiscount,
    };
  }

  // Save Draft (F8) — persists the invoice as a Draft without touching stock, dealer
  // outstanding or the financial ledger. The cart is left as-is so work can continue.
  function handleSaveDraft() {
    if (cartItems.length === 0) {
      showToast('Cannot save an empty invoice as draft.', 'warning');
      return;
    }
    const draft = buildInvoiceObject('Draft');
    const savedInvoices = readLS(LS_KEYS.invoices, []);
    writeLS(LS_KEYS.invoices, [draft, ...savedInvoices]);
    showToast(`Draft saved as ${draft.invoiceNo}.`, 'success');
  }

  // Complete Sale Execution
  async function executeCompleteSale() {
    setCreditLimitConfirmOpen(false);
    setSavingInvoice(true);
    const completedInvoice = buildInvoiceObject(orderStatus === 'Draft' ? 'Confirmed' : orderStatus);
    const invoiceNo = completedInvoice.invoiceNo;
    const invoiceDate = completedInvoice.date;

    // 1. Decrement Inventory Stock — free quantity leaves the warehouse too, even though it
    // never adds to the billed amount (localStorage view first, for instant feedback).
    const updatedProducts = products.map(p => {
      const matchInCart = cartItems.find(item => item.id === p.id || item.code === p.code);
      if (matchInCart) {
        const units = computeLineTotals(matchInCart).stockUnits;
        const newStock = Math.max(0, (parseFloat(p.availableStock ?? p.stock ?? 0) - units));
        return { ...p, availableStock: newStock, stock: newStock };
      }
      return p;
    });
    setProducts(updatedProducts);
    writeLS(LS_KEYS.inventory, updatedProducts);

    // Push the same decrement to the backend inventory, attributed to the selected
    // warehouse, so Inventory > Products and the retail POS all agree.
    if (selectedWarehouseId) {
      await Promise.all(cartItems.map(async (item) => {
        const prod = products.find(p => p.id === item.id || p.code === item.code);
        const units = computeLineTotals(item).stockUnits;
        if (!prod || !isUuid(prod.id) || !(units > 0)) return;
        try {
          await axios.post('/api/inventory/adjustments/', {
            product: prod.id,
            warehouse: selectedWarehouseId,
            quantity: Math.round(units),
            adjustment_type: 'SUB',
            reason: `Wholesale POS sale ${invoiceNo}`,
          });
        } catch (e) {}
      }));
      window.dispatchEvent(new Event('optical_stock_updated'));
    }

    // 2. Update Dealer Ledger — locally for instant UI feedback, and best-effort against the
    // real Dealer record (PATCH outstanding_balance) so it stays correct system-wide.
    const newOutstanding = parseFloat(selectedCustomer.outstanding || 0) + completedInvoice.dueAmount;
    const updatedCustomers = customers.map(c => {
      if (c.id === selectedCustomer.id || c.code === selectedCustomer.code) {
        return { ...c, outstanding: newOutstanding, lastPurchaseDate: invoiceDate };
      }
      return c;
    });
    setCustomers(updatedCustomers);
    writeLS(LS_KEYS.customers, updatedCustomers);
    const currentUpdatedCust = updatedCustomers.find(c => c.id === selectedCustomer.id || c.code === selectedCustomer.code);
    if (currentUpdatedCust) setSelectedCustomer(currentUpdatedCust);
    if (isUuid(selectedCustomer.id)) {
      try { await axios.patch(`${WHOLESALE_API}/dealers/${selectedCustomer.id}/`, { outstanding_balance: newOutstanding }); } catch (e) {}
    }

    // 3. Post Financial Journal Entry
    try {
      const existingJournals = readLS(LS_KEYS.journals, []);
      const journalNo = `JV-W-${Math.floor(1000 + Math.random() * 9000)}`;
      const newJournal = {
        id: journalNo,
        voucherNo: journalNo,
        date: invoiceDate,
        voucherType: 'JOURNAL',
        narration: `Wholesale POS Invoice #${invoiceNo} - ${selectedCustomer.name} (${payMode})`,
        entries: [
          { accountCode: payMode === 'Credit Sale' ? '1100' : '1001', accountName: payMode === 'Credit Sale' ? `Accounts Receivable (${selectedCustomer.name})` : `Cash/Bank Account (${payMode})`, debit: summary.grandTotal, credit: 0 },
          { accountCode: '4001', accountName: 'Wholesale Sales Income', debit: 0, credit: summary.subtotal - summary.totalDiscount },
          { accountCode: '2100', accountName: 'Output GST Payable (18%)', debit: 0, credit: summary.totalGst },
        ],
      };
      writeLS(LS_KEYS.journals, [newJournal, ...existingJournals]);
    } catch (e) {}

    // 4. Best-effort secondary index rows on the real backend — a lightweight cross-module
    // record (no line items) other ERP screens could query; the full invoice (items, delivery,
    // schemes, notes) stays in optical_wholesale_invoices, same as before.
    if (isUuid(selectedCustomer.id)) {
      try {
        await axios.post(`${WHOLESALE_API}/invoices/`, {
          invoice_number: invoiceNo, dealer: selectedCustomer.id, order_ref: referenceNo || '',
          invoice_date: invoiceDate, due_date: completedInvoice.dueDate || invoiceDate,
          grand_total: summary.grandTotal, paid_amount: completedInvoice.amountReceived,
          due_amount: completedInvoice.dueAmount, status: completedInvoice.status,
        });
      } catch (e) {}
      if (completedInvoice.amountReceived > 0) {
        try {
          await axios.post(`${WHOLESALE_API}/collections/`, {
            receipt_number: `RCPT-${Math.floor(100000 + Math.random() * 900000)}`, dealer: selectedCustomer.id,
            invoice_number: invoiceNo, payment_date: invoiceDate, payment_method: payMode,
            amount_paid: completedInvoice.amountReceived, reference_note: refNo || '',
          });
        } catch (e) {}
      }
    }

    // 5. Save Invoice & Open Completion / Print
    const savedInvoices = readLS(LS_KEYS.invoices, []);
    writeLS(LS_KEYS.invoices, [completedInvoice, ...savedInvoices]);

    setPrintableInvoice(completedInvoice);
    setCompletionOpen(true);
    setSavingInvoice(false);
    resetSaleForm();
    showToast(`Wholesale Sale Completed! Invoice #${invoiceNo} posted.`, 'success');
  }

  // --- More Actions: Cancel / Return / Replacement / Credit Note (operate on the last completed invoice) ---
  async function restockInvoiceItems(invoice, reason) {
    const updatedProducts = products.map(p => {
      const match = invoice.items.find(item => item.id === p.id || item.code === p.code);
      if (match) {
        const newStock = (parseFloat(p.availableStock ?? p.stock ?? 0) + match.qty);
        return { ...p, availableStock: newStock, stock: newStock };
      }
      return p;
    });
    setProducts(updatedProducts);
    writeLS(LS_KEYS.inventory, updatedProducts);

    if (selectedWarehouseId) {
      await Promise.all(invoice.items.map(async (item) => {
        const prod = products.find(p => p.id === item.id || p.code === item.code);
        if (!prod || !isUuid(prod.id) || !(item.qty > 0)) return;
        try {
          await axios.post('/api/inventory/adjustments/', {
            product: prod.id, warehouse: selectedWarehouseId, quantity: Math.round(item.qty),
            adjustment_type: 'ADD', reason: `${reason} ${invoice.invoiceNo}`,
          });
        } catch (e) {}
      }));
      window.dispatchEvent(new Event('optical_stock_updated'));
    }
  }

  function updateInvoiceInStorage(invoiceNo, patch) {
    const all = readLS(LS_KEYS.invoices, []);
    const updated = all.map(inv => inv.invoiceNo === invoiceNo ? { ...inv, ...patch } : inv);
    writeLS(LS_KEYS.invoices, updated);
  }

  // Reduces/increases a dealer's outstanding locally (instant UI) and best-effort against
  // the real Dealer record (PATCH outstanding_balance) — same posture as the sale-completion path.
  function adjustDealerOutstanding(dealerRef, delta) {
    let next = 0;
    const updated = customers.map(c => {
      if (c.id === dealerRef.id || c.code === dealerRef.code) {
        next = Math.max(0, parseFloat(c.outstanding || 0) + delta);
        return { ...c, outstanding: next };
      }
      return c;
    });
    setCustomers(updated);
    writeLS(LS_KEYS.customers, updated);
    if (selectedCustomer && (selectedCustomer.id === dealerRef.id || selectedCustomer.code === dealerRef.code)) {
      setSelectedCustomer(prev => ({ ...prev, outstanding: next }));
    }
    if (isUuid(dealerRef.id)) {
      axios.patch(`${WHOLESALE_API}/dealers/${dealerRef.id}/`, { outstanding_balance: next }).catch(() => {});
    }
  }

  // Posts to the real WholesaleReturn model — action_taken differentiates a plain sales
  // return, a replacement, or a credit note, so Cancel/Return/Replacement/Credit-Note all
  // share one backend record instead of three parallel ones.
  async function postWholesaleReturn(invoice, amount, reason, actionTaken) {
    const returnNo = `WRET-${Math.floor(100000 + Math.random() * 900000)}`;
    const record = { id: returnNo, returnNo, date: new Date().toISOString().split('T')[0], invoiceNo: invoice.invoiceNo, customer: invoice.customer, items: invoice.items, amount, reason: reason || actionTaken };
    const returns = readLS(LS_KEYS.returns, []);
    writeLS(LS_KEYS.returns, [record, ...returns]);
    if (isUuid(invoice.customer?.id)) {
      try {
        await axios.post(`${WHOLESALE_API}/returns/`, {
          return_number: returnNo, invoice_number: invoice.invoiceNo, dealer: invoice.customer.id,
          return_date: record.date, reason: reason || actionTaken, return_amount: amount, action_taken: actionTaken,
        });
      } catch (e) {}
    }
    return record;
  }

  async function handleCancelInvoice() {
    if (!printableInvoice) return;
    await restockInvoiceItems(printableInvoice, 'Cancelled wholesale invoice');
    if (printableInvoice.dueAmount > 0) adjustDealerOutstanding(printableInvoice.customer, -printableInvoice.dueAmount);
    updateInvoiceInStorage(printableInvoice.invoiceNo, { orderStatus: 'Cancelled', status: 'Cancelled' });
    setCancelInvoiceConfirmOpen(false);
    showToast(`Invoice ${printableInvoice.invoiceNo} cancelled and stock restored.`, 'success');
  }

  async function handleSalesReturn() {
    if (!printableInvoice) return;
    await restockInvoiceItems(printableInvoice, 'Sales return for');
    if (printableInvoice.dueAmount > 0) adjustDealerOutstanding(printableInvoice.customer, -printableInvoice.dueAmount);
    const record = await postWholesaleReturn(printableInvoice, printableInvoice.summary?.grandTotal, '', 'Stock Return');
    setReturnConfirmOpen(false);
    showToast(`Sales return ${record.returnNo} processed for invoice ${printableInvoice.invoiceNo}.`, 'success');
  }

  // Replacement: restock the original invoice's items (same as a return) and immediately open
  // a fresh cart for the same dealer so the replacement products can be picked and billed.
  async function handleReplacement() {
    if (!printableInvoice) return;
    await restockInvoiceItems(printableInvoice, 'Replacement for');
    await postWholesaleReturn(printableInvoice, printableInvoice.summary?.grandTotal, 'Replacement requested', 'Replacement Issued');
    setReplacementConfirmOpen(false);
    setSelectedCustomer(printableInvoice.customer);
    setCartItems([]);
    showToast(`Original items restocked — build the replacement order for ${printableInvoice.customer?.name}.`, 'success');
  }

  async function handleCreateCreditNote({ amount, reason }) {
    if (!printableInvoice) return;
    const record = await postWholesaleReturn(printableInvoice, amount, reason, 'Credit Note Issued');
    const notes = readLS(LS_KEYS.creditNotes, []);
    writeLS(LS_KEYS.creditNotes, [{ id: record.returnNo, noteNo: record.returnNo, date: record.date, invoiceNo: printableInvoice.invoiceNo, customer: printableInvoice.customer, amount, reason }, ...notes]);
    adjustDealerOutstanding(printableInvoice.customer, -amount);
    setCreditNoteOpen(false);
    showToast(`Credit note ${record.returnNo} created for ₹${amount.toLocaleString('en-IN')}.`, 'success');
  }

  // Record Payment (dealer ledger) — posts a real WholesalePaymentCollection row and reduces
  // the dealer's outstanding balance both locally and on the backend.
  async function handleRecordPayment({ amount, mode, refNo: recRef }) {
    if (!selectedCustomer) return;
    const receiptNo = `RCPT-${Math.floor(100000 + Math.random() * 900000)}`;
    const date = new Date().toISOString().split('T')[0];
    const payments = readLS(LS_KEYS.payments, []);
    writeLS(LS_KEYS.payments, [{ id: receiptNo, receiptNo, date, customer: selectedCustomer, amount, mode, refNo: recRef }, ...payments]);
    if (isUuid(selectedCustomer.id)) {
      try {
        await axios.post(`${WHOLESALE_API}/collections/`, {
          receipt_number: receiptNo, dealer: selectedCustomer.id, payment_date: date,
          payment_method: mode, amount_paid: amount, reference_note: recRef || '',
        });
      } catch (e) {}
    }
    adjustDealerOutstanding(selectedCustomer, -amount);
    setRecordPaymentOpen(false);
    showToast(`Payment of ₹${amount.toLocaleString('en-IN')} recorded (${receiptNo}).`, 'success');
  }

  const dealerSearchFilter = (opts, state) => {
    const q = state.inputValue.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.code || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.gstin || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    );
  };

  // Frequently Purchased (Quick Reorder) — tallies this dealer's past invoice line items by
  // qty, using the existing sales history already in optical_wholesale_invoices.
  const frequentlyPurchased = useMemo(() => {
    if (!dealerOrders.length) return [];
    const byProduct = new Map();
    dealerOrders.forEach(order => {
      (order.items || []).forEach(it => {
        if (it.isFreeGift) return;
        const key = it.id || it.code;
        const prev = byProduct.get(key);
        if (!prev || new Date(order.date) > new Date(prev.date)) {
          byProduct.set(key, { ...it, date: order.date, totalQty: (prev?.totalQty || 0) + (parseFloat(it.qty) || 0) });
        } else {
          byProduct.set(key, { ...prev, totalQty: (prev.totalQty || 0) + (parseFloat(it.qty) || 0) });
        }
      });
    });
    return Array.from(byProduct.values()).sort((a, b) => b.totalQty - a.totalQty).slice(0, 4);
  }, [dealerOrders]);

  const availableCredit = selectedCustomer ? Math.max(0, (parseFloat(selectedCustomer.creditLimit) || 0) - (parseFloat(selectedCustomer.outstanding) || 0)) : 0;

  // Attachments (Dealer PO / Delivery / Transport / Other) — no generic attachment backend
  // exists yet (the only file-upload model in the app is PurchaseInvoice.attachment, a single
  // FileField scoped to Purchasing), so these stay inline on the invoice record as small
  // base64 files. Capped at 3 MB/file so the localStorage invoice never gets unreasonably large.
  const handleAttachFile = (e, category) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      showToast('Attachment too large — please keep files under 3 MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setAttachments(prev => [...prev, { name: file.name, size: file.size, category, dataUrl: String(ev.target.result || '') }]);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  const handleRemoveAttachment = (idx) => setAttachments(prev => prev.filter((_, i) => i !== idx));

  const applyNoteTemplate = (text) => setNotesState(prev => ({ ...prev, internal: prev.internal ? `${prev.internal}; ${text}` : text }));

  return (
    <Box sx={{ p: 2.5, bgcolor: '#f8fafc', minHeight: '100vh' }}>
      {/* HEADER */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={1.5}
        sx={{ mb: 2 }}
      >
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6" fontWeight={800} color="#0f172a">
              Wholesale Sale
            </Typography>
            <Chip
              label={`Invoice #${headerInvoiceNo}`}
              size="small"
              sx={{ height: 20, fontSize: '0.7rem', fontWeight: 700, bgcolor: '#eef2ff', color: '#4f46e5' }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Create a wholesale invoice
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {heldInvoices.length > 0 && (
            <Button variant="outlined" color="warning" size="small" startIcon={<ResumeIcon />} onClick={() => setHeldModalOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>
              Held ({heldInvoices.length})
            </Button>
          )}
          <Button variant="outlined" size="small" startIcon={<PersonAddIcon />} onClick={() => setNewDealerOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>
            New Dealer
          </Button>
          <Button variant="outlined" size="small" color="error" startIcon={<ClearIcon />} disabled={cartItems.length === 0} onClick={() => setClearCartConfirmOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>
            Clear Cart
          </Button>
          <Tooltip title="More Actions">
            <span>
              <IconButton size="small" onClick={(e) => setMoreActionsAnchor(e.currentTarget)} sx={{ border: '1px solid #e2e8f0', borderRadius: 2 }}>
                <MoreVertIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {/* MORE ACTIONS MENU — every entry already respects role/permission where it matters
          (Cancel/Credit Note/Replacement need the Manager+/override role, same as price override). */}
      <Menu anchorEl={moreActionsAnchor} open={Boolean(moreActionsAnchor)} onClose={() => setMoreActionsAnchor(null)}>
        <MenuItem disabled={cartItems.length === 0} onClick={() => { setMoreActionsAnchor(null); handleSaveDraft(); }}><SaveIcon fontSize="small" sx={{ mr: 1 }} /> Save Draft</MenuItem>
        <MenuItem disabled={cartItems.length === 0} onClick={() => { setMoreActionsAnchor(null); handleHoldInvoice(); }}><HoldIcon fontSize="small" sx={{ mr: 1 }} /> Hold Invoice</MenuItem>
        <Divider />
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); setPrintModalOpen(true); }}><PrintIcon fontSize="small" sx={{ mr: 1 }} /> Print Preview</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: printableInvoice, documentType: 'WHOLESALE_BILL' }); }}><PrintIcon fontSize="small" sx={{ mr: 1 }} /> Print Invoice</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); downloadPdfInvoice(printableInvoice, 'WHOLESALE_BILL'); }}><PdfIcon fontSize="small" sx={{ mr: 1 }} /> Download PDF</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); showToast(`Invoice ${printableInvoice.invoiceNo} queued for sending.`, 'success'); }}><SendIcon fontSize="small" sx={{ mr: 1 }} /> Send Invoice</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: { ...printableInvoice, __title: 'DELIVERY NOTE' }, documentType: 'WHOLESALE_BILL' }); }}><DocumentIcon fontSize="small" sx={{ mr: 1 }} /> Delivery Note</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: { ...printableInvoice, __title: 'PACKING SLIP' }, documentType: 'WHOLESALE_BILL' }); }}><PackingIcon fontSize="small" sx={{ mr: 1 }} /> Packing Slip</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: { ...printableInvoice, __title: 'PAYMENT RECEIPT' }, documentType: 'WHOLESALE_BILL' }); }}><DocumentIcon fontSize="small" sx={{ mr: 1 }} /> Payment Receipt</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); setPrevOrdersOpen(true); }}><HistoryIcon fontSize="small" sx={{ mr: 1 }} /> Previous Orders</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); applyOrderToCart(printableInvoice, 'duplicate'); }}><DuplicateIcon fontSize="small" sx={{ mr: 1 }} /> Duplicate Invoice</MenuItem>
        <Divider />
        <Tooltip title={!canOverride ? 'Only Managers/Admins can process returns' : ''}>
          <span><MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setReturnConfirmOpen(true); }}><ReturnIcon fontSize="small" sx={{ mr: 1 }} /> Sales Return</MenuItem></span>
        </Tooltip>
        <Tooltip title={!canOverride ? 'Only Managers/Admins can process replacements' : ''}>
          <span><MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setReplacementConfirmOpen(true); }}><ReplacementIcon fontSize="small" sx={{ mr: 1 }} /> Replacement</MenuItem></span>
        </Tooltip>
        <Tooltip title={!canOverride ? 'Only Managers/Admins can issue credit notes' : ''}>
          <span><MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setCreditNoteOpen(true); }}><CreditNoteIcon fontSize="small" sx={{ mr: 1 }} /> Create Credit Note</MenuItem></span>
        </Tooltip>
        <Tooltip title={!canOverride ? 'Only Managers/Admins can cancel invoices' : ''}>
          <span><MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setCancelInvoiceConfirmOpen(true); }}><CancelInvoiceIcon fontSize="small" sx={{ mr: 1 }} /> Cancel Invoice</MenuItem></span>
        </Tooltip>
        <Divider />
        <MenuItem disabled={!selectedCustomer} onClick={() => { setMoreActionsAnchor(null); setLedgerOpen(true); }}><LedgerIcon fontSize="small" sx={{ mr: 1 }} /> View Customer Ledger</MenuItem>
      </Menu>

      {/* TOAST ALERT */}
      {toast.open && (
        <Alert severity={toast.severity} sx={{ mb: 2, borderRadius: 2, fontWeight: 600 }}>
          {toast.message}
        </Alert>
      )}

      <Grid container spacing={2.5} alignItems="flex-start">
        {/* ================= LEFT: DEALER + PRODUCTS ================= */}
        <Grid item xs={12} lg={8}>
          <Stack spacing={2.5}>
            {/* DEALER */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Wholesale Dealer</Typography>
                <Chip label="F2" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b' }} />
              </Stack>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                <Autocomplete
                  fullWidth
                  options={customers}
                  filterOptions={dealerSearchFilter}
                  getOptionLabel={(o) => (o ? `${o.name}${o.code ? ` (${o.code})` : ''}` : '')}
                  isOptionEqualToValue={(o, v) => o.id === v.id}
                  value={selectedCustomer}
                  onChange={(e, newVal) => handleSelectCustomer(newVal)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      inputRef={customerSearchInputRef}
                      size="small"
                      placeholder="Search dealer by name, code, phone, GSTIN or email..."
                      InputProps={{
                        ...params.InputProps,
                        startAdornment: (<><SearchIcon sx={{ color: '#94a3b8', mr: 0.5, fontSize: 18 }} />{params.InputProps.startAdornment}</>),
                        endAdornment: (<>{dealersLoading && <CircularProgress size={14} sx={{ mr: 1 }} />}{params.InputProps.endAdornment}</>),
                      }}
                    />
                  )}
                />
                <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={() => setNewDealerOpen(true)} sx={{ fontWeight: 700, textTransform: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  New Dealer
                </Button>
              </Stack>
              {dealersLoading && customers.length === 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Loading dealers…</Typography>
              )}

              {selectedCustomer && (
                <>
                  <Box sx={{ mt: 1.5, p: 1.5, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="subtitle2" fontWeight={800} color="#0f172a">{selectedCustomer.name}</Typography>
                      <Chip label={PRICE_TIER_LABEL[selectedCustomer.priceList] || 'Wholesale'} size="small" sx={{ height: 20, fontSize: '0.68rem', fontWeight: 700, bgcolor: '#eef2ff', color: '#4f46e5' }} />
                    </Stack>
                    <Grid container spacing={1} sx={{ mt: 0.25 }}>
                      {selectedCustomer.code ? <CustomerBit label="Dealer Code" value={selectedCustomer.code} /> : null}
                      {selectedCustomer.contactPerson ? <CustomerBit label="Contact Person" value={selectedCustomer.contactPerson} /> : null}
                      {selectedCustomer.phone ? <CustomerBit label="Phone" value={selectedCustomer.phone} /> : null}
                      {selectedCustomer.email ? <CustomerBit label="Email" value={selectedCustomer.email} /> : null}
                      {selectedCustomer.gstin ? <CustomerBit label="GSTIN" value={selectedCustomer.gstin} /> : null}
                      {selectedCustomer.salesExec ? <CustomerBit label="Sales Representative" value={selectedCustomer.salesExec} /> : null}
                      {selectedCustomer.billingAddress ? <CustomerBit label="Billing Address" value={selectedCustomer.billingAddress} /> : null}
                      {selectedCustomer.shippingAddress ? <CustomerBit label="Shipping Address" value={selectedCustomer.shippingAddress} /> : null}
                    </Grid>
                    <Divider sx={{ my: 1 }} />
                    <Grid container spacing={1}>
                      <CustomerBit label="Credit Limit" value={fmtINR(selectedCustomer.creditLimit)} />
                      <CustomerBit label="Current Outstanding" value={fmtINR(selectedCustomer.outstanding)} valueColor={outstandingColor} />
                      <CustomerBit label="Available Credit" value={fmtINR(availableCredit)} valueColor="#059669" />
                      <CustomerBit label="Payment Terms" value={`Net ${selectedCustomer.creditDays || 30}`} />
                      <CustomerBit label="Last Purchase" value={selectedCustomer.lastPurchaseDate || '—'} />
                    </Grid>
                    <Stack direction="row" spacing={1} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap>
                      <Button size="small" variant="outlined" startIcon={<LedgerIcon />} onClick={() => setLedgerOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>View Ledger</Button>
                      <Button size="small" variant="outlined" startIcon={<HistoryIcon />} onClick={() => setPrevOrdersOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>Previous Orders {dealerOrders.length ? `(${dealerOrders.length})` : ''}</Button>
                      <Button size="small" variant="outlined" startIcon={<ProfileIcon />} onClick={() => setDealerProfileOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>View Profile</Button>
                      <Button size="small" variant="text" color="inherit" startIcon={<ChangeDealerIcon />} onClick={() => handleSelectCustomer(null)} sx={{ fontWeight: 700, textTransform: 'none' }}>Change Dealer</Button>
                    </Stack>
                  </Box>

                  {dealerOrders.length > 0 && (
                    <Box sx={{ mt: 1.25, overflowX: 'auto' }}>
                      <Stack direction="row" spacing={1}>
                        {dealerOrders.slice(0, 4).map(o => {
                          const st = ORDER_STATUS_COLORS[o.orderStatus || 'Confirmed'] || ORDER_STATUS_COLORS.Confirmed;
                          return (
                            <Paper key={o.invoiceNo} variant="outlined" sx={{ p: 1, borderRadius: 2, minWidth: 150, flexShrink: 0 }}>
                              <Typography variant="caption" fontWeight={800} sx={{ fontFamily: 'monospace' }}>{o.invoiceNo}</Typography>
                              <Typography variant="caption" color="text.secondary" display="block">{o.date} • {fmtINR(o.summary?.grandTotal)}</Typography>
                              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}>
                                <Chip label={o.orderStatus || 'Confirmed'} size="small" sx={{ height: 16, fontSize: '0.6rem', fontWeight: 700, bgcolor: st.bg, color: st.color }} />
                                <Stack direction="row">
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleViewOrder(o)}><ViewIcon sx={{ fontSize: 14 }} /></IconButton>
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => applyOrderToCart(o, 'reorder')}><ReorderIcon sx={{ fontSize: 14 }} /></IconButton>
                                </Stack>
                              </Stack>
                            </Paper>
                          );
                        })}
                      </Stack>
                    </Box>
                  )}
                </>
              )}

              {isCreditExceeded && (
                <Alert severity="warning" icon={<WarningIcon />} sx={{ mt: 1.5, borderRadius: 2, fontWeight: 600, py: 0.25 }}>
                  Outstanding ({fmtINR(selectedCustomer.outstanding)}) + this bill exceeds the credit limit of {fmtINR(selectedCustomer.creditLimit)}.
                </Alert>
              )}
            </Card>

            {/* ORDER INFORMATION */}
            {selectedCustomer && (
              <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
                <Typography variant="subtitle2" fontWeight={800} color="#0f172a" sx={{ mb: 1.5 }}>Order Information</Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField fullWidth size="small" label="Reference Number" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField fullWidth size="small" label="Customer PO Number" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField
                      select fullWidth size="small" label="Warehouse" value={selectedWarehouseId}
                      onChange={(e) => setSelectedWarehouseId(e.target.value)}
                    >
                      {warehouses.length === 0 && <MenuItem value="">Main Warehouse</MenuItem>}
                      {warehouses.map(w => <MenuItem key={w.id} value={String(w.id)}>{w.name}</MenuItem>)}
                    </TextField>
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField select fullWidth size="small" label="Order Status" value={orderStatus} onChange={(e) => setOrderStatus(e.target.value)}>
                      {ORDER_STATUSES.filter(s => s !== 'Cancelled').map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                    </TextField>
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField
                      select fullWidth size="small" label="Price List" value={invoicePriceList || selectedCustomer.priceList}
                      onChange={(e) => setInvoicePriceList(e.target.value)}
                    >
                      {PRICE_LIST_OPTIONS.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
                    </TextField>
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField
                      select fullWidth size="small" label="Sales Representative" value={salesRep}
                      onChange={(e) => setSalesRep(e.target.value)}
                    >
                      {Array.from(new Set([...DEMO_SALES_REPS, ...customers.map(c => c.salesExec).filter(Boolean)])).map(r => (
                        <MenuItem key={r} value={r}>{r}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                </Grid>
              </Card>
            )}

            {/* PRODUCTS */}
            <Card variant="outlined" sx={{ borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0', overflow: 'hidden' }}>
              <Box sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                  <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Products</Typography>
                  <Chip label="F3" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b' }} />
                </Stack>

                <Autocomplete
                  freeSolo
                  fullWidth
                  options={products}
                  value={null}
                  inputValue={barcodeInput}
                  onInputChange={(e, v, reason) => { if (reason === 'input' || reason === 'clear') setBarcodeInput(v); }}
                  getOptionLabel={(p) => (typeof p === 'string' ? p : p.name || '')}
                  filterOptions={(opts, state) => {
                    const q = state.inputValue.trim().toLowerCase();
                    if (!q) return opts.slice(0, 50);
                    return opts
                      .filter((p) =>
                        (p.name || '').toLowerCase().includes(q) ||
                        (p.code || '').toLowerCase().includes(q) ||
                        (p.sku || '').toLowerCase().includes(q) ||
                        (p.barcode || '').toLowerCase().includes(q) ||
                        (p.brand || '').toLowerCase().includes(q) ||
                        (p.modelNo || '').toLowerCase().includes(q)
                      )
                      .slice(0, 50);
                  }}
                  onChange={(e, val) => {
                    if (val && typeof val !== 'string') {
                      handleAddProductToCart(val);
                      setBarcodeInput('');
                      showToast(`Added: ${val.name}`, 'success');
                      setTimeout(() => barcodeSearchInputRef.current?.focus(), 0);
                    }
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      inputRef={barcodeSearchInputRef}
                      size="small"
                      placeholder="Scan barcode or search by name, SKU, model, brand..."
                      onKeyDownCapture={handleBarcodeScan}
                      InputProps={{
                        ...params.InputProps,
                        startAdornment: (<><QrCodeScannerIcon sx={{ color: '#4f46e5', mr: 0.5, fontSize: 20 }} />{params.InputProps.startAdornment}</>),
                        endAdornment: (<><Chip label="F3" size="small" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b', mr: 0.5 }} />{params.InputProps.endAdornment}</>),
                      }}
                    />
                  )}
                  renderOption={(props, p) => {
                    const stock = parseFloat(p.availableStock ?? p.stock ?? 0);
                    const attrs = [cellText(p.brand), cellText(p.modelNo), cellText(p.color), cellText(p.size), cellText(p.power)].filter(Boolean).join(' • ');
                    return (
                      <li {...props} key={p.id || p.code}>
                        <Box sx={{ width: '100%' }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                            <Typography variant="caption" sx={{ fontWeight: 700, color: stock > 5 ? '#059669' : stock > 0 ? '#d97706' : '#dc2626' }}>
                              {stock > 0 ? `Stock: ${stock}` : 'Out of stock'}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary" display="block">
                            {[cellText(p.code), attrs, `₹${(p.wholesalePrice || p.price || 0).toFixed(2)}`].filter(Boolean).join('  •  ')}
                          </Typography>
                          {getWarehouseStockText(p) && (
                            <Typography variant="caption" sx={{ color: '#94a3b8' }}>{getWarehouseStockText(p)}</Typography>
                          )}
                        </Box>
                      </li>
                    );
                  }}
                />

                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                  <Button size="small" variant="outlined" startIcon={<BulkAddIconMui />} onClick={() => setBulkAddOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>
                    Bulk Add <Chip label="F4" size="small" sx={{ ml: 0.75, height: 16, fontSize: '0.6rem', bgcolor: '#f1f5f9', color: '#64748b' }} />
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setExcelImportOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>
                    Excel Import
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<DiscountIcon />} onClick={() => setSchemeOpen(true)} sx={{ fontWeight: 700, textTransform: 'none' }}>
                    Discounts / Schemes <Chip label="F6" size="small" sx={{ ml: 0.75, height: 16, fontSize: '0.6rem', bgcolor: '#f1f5f9', color: '#64748b' }} />
                  </Button>
                  {dealerOrders.length > 0 && (
                    <Button size="small" variant="outlined" startIcon={<ReorderIcon />} onClick={() => applyOrderToCart(dealerOrders[0], 'reorder')} sx={{ fontWeight: 700, textTransform: 'none' }}>
                      Reorder Last Invoice
                    </Button>
                  )}
                </Stack>

                {invoiceDiscount && (
                  <Alert severity={summary.schemeActive === false ? 'warning' : 'success'} sx={{ mt: 1.5, borderRadius: 2, py: 0.25 }} onClose={() => setInvoiceDiscount(null)}>
                    {invoiceDiscount.type === 'BOGO' ? `Scheme: Buy ${invoiceDiscount.buyQty} ${invoiceDiscount.buyProduct?.name} → Get ${invoiceDiscount.getQty} ${invoiceDiscount.getProduct?.name} free` : `${summary.schemeLabel}${summary.schemeActive === false ? '' : ` applied — ${fmtINR(summary.schemeDiscount - cartItems.filter(i => i.isFreeGift).reduce((a, i) => a + (parseFloat(i.rate) || 0) * (parseFloat(i.qty) || 0), 0))} off`}`}
                  </Alert>
                )}

                {frequentlyPurchased.length > 0 && cartItems.length === 0 && (
                  <Box sx={{ mt: 1.5 }}>
                    <Typography variant="caption" fontWeight={700} color="text.secondary" display="block" sx={{ mb: 0.5 }}>Frequently Purchased</Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {frequentlyPurchased.map(fp => {
                        const live = products.find(p => p.id === fp.id || p.code === fp.code);
                        return (
                          <Paper key={fp.id || fp.code} variant="outlined" sx={{ p: 1, borderRadius: 2, minWidth: 160 }}>
                            <Typography variant="caption" fontWeight={700} display="block" noWrap sx={{ maxWidth: 150 }}>{fp.name}</Typography>
                            <Typography variant="caption" color="text.secondary">Last Qty: {fp.qty}</Typography>
                            <Button size="small" fullWidth disabled={!live} onClick={() => live && handleAddProductToCart(live, fp.qty)} sx={{ mt: 0.5, textTransform: 'none', fontWeight: 700, py: 0.25 }}>Add</Button>
                          </Paper>
                        );
                      })}
                      <Button
                        size="small" variant="outlined"
                        onClick={() => frequentlyPurchased.forEach(fp => {
                          const live = products.find(p => p.id === fp.id || p.code === fp.code);
                          if (live) handleAddProductToCart(live, fp.qty);
                        })}
                        sx={{ fontWeight: 700, textTransform: 'none', alignSelf: 'center' }}
                      >
                        Add All
                      </Button>
                    </Stack>
                  </Box>
                )}
              </Box>

              {cartItems.length === 0 ? (
                <Box sx={{ py: 6, px: 2, textAlign: 'center', borderTop: '1px solid #e2e8f0' }}>
                  <InventoryIcon sx={{ fontSize: 30, color: '#cbd5e1', mb: 0.5 }} />
                  <Typography variant="body2" fontWeight={700} color="#475569">Start adding products</Typography>
                  <Typography variant="caption" color="text.secondary">Scan a barcode or search for a product</Typography>
                </Box>
              ) : (
                <TableContainer sx={{ overflowX: 'auto', borderTop: '1px solid #e2e8f0' }}>
                  <Table size="small" sx={{ minWidth: 860 }}>
                    <TableHead sx={{ '& th': { bgcolor: '#f8fafc', color: '#475569', fontWeight: 700, fontSize: '0.72rem', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap', py: 1 } }}>
                      <TableRow>
                        <TableCell>Product</TableCell>
                        <TableCell>SKU</TableCell>
                        <TableCell>Barcode</TableCell>
                        <TableCell>Warehouse</TableCell>
                        <TableCell align="center">Stock</TableCell>
                        <TableCell>Batch / Expiry</TableCell>
                        <TableCell align="center">Qty</TableCell>
                        <TableCell align="center">Free Qty</TableCell>
                        <TableCell align="right">Rate</TableCell>
                        <TableCell align="right">Disc %</TableCell>
                        <TableCell align="right">GST</TableCell>
                        <TableCell align="right">Total</TableCell>
                        <TableCell align="center" padding="checkbox" />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {cartItems.map((item, idx) => {
                        const isStockExceeded = !item.isFreeGift && (item.qty + (parseFloat(item.freeQty) || 0)) > item.availableStock;
                        const isOutOfStock = !item.isFreeGift && item.availableStock <= 0;
                        const isLowStock = !item.isFreeGift && item.availableStock > 0 && item.availableStock <= 5;
                        const t = computeLineTotals(item);
                        const expired = isExpired(item.expiry);
                        const nearExpiry = !expired && isNearExpiry(item.expiry);
                        const attrs = [
                          cellText(item.modelNo), cellText(item.color), cellText(item.size), cellText(item.power),
                          cellText(item.lensType),
                          cellText(item.cylinder) ? `Cyl ${item.cylinder}` : '',
                          cellText(item.axis) ? `Axis ${item.axis}` : '',
                        ].filter(v => cellText(v)).join(' • ');
                        const rowSelected = selectedRowIndex === idx;

                        return (
                          <React.Fragment key={`${item.id}-${idx}`}>
                            <TableRow
                              hover
                              onClick={() => setSelectedRowIndex(idx)}
                              sx={{
                                bgcolor: rowSelected ? '#eef2ff' : (isStockExceeded ? '#fef2f2' : (item.isFreeGift ? '#f0fdf4' : 'inherit')),
                                cursor: 'pointer',
                                '& td': { py: 0.75, fontSize: '0.8rem', whiteSpace: 'nowrap', borderBottom: '1px solid #f1f5f9' },
                              }}
                            >
                              <TableCell sx={{ whiteSpace: 'normal', minWidth: 180 }}>
                                <Stack direction="row" spacing={0.5} alignItems="center">
                                  <Typography variant="body2" fontWeight={700} sx={{ fontSize: '0.82rem' }}>{item.name}</Typography>
                                  {item.isFreeGift && <Chip label="FREE" size="small" sx={{ height: 16, fontSize: '0.6rem', fontWeight: 800, bgcolor: '#dcfce7', color: '#15803d' }} />}
                                  <Chip label={PRICE_TIER_LABEL[item.priceTier] || 'Wholesale'} size="small" sx={{ height: 16, fontSize: '0.6rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b' }} />
                                </Stack>
                                {attrs && <Typography variant="caption" color="text.secondary">{attrs}</Typography>}
                              </TableCell>
                              <TableCell sx={{ color: '#475569', fontFamily: 'monospace', fontSize: '0.72rem' }}>{cellText(item.sku) || cellText(item.code)}</TableCell>
                              <TableCell sx={{ fontFamily: 'monospace', color: '#64748b' }}>{cellText(item.barcode)}</TableCell>
                              <TableCell sx={{ color: '#475569' }}>{warehouseName(selectedWarehouseId)}</TableCell>
                              <TableCell align="center" sx={{ color: isOutOfStock ? '#dc2626' : isLowStock ? '#d97706' : '#475569', fontWeight: isLowStock || isOutOfStock ? 700 : 400 }}>
                                {item.isFreeGift ? '—' : (isOutOfStock ? 'Out' : item.availableStock)}
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <Stack direction="row" spacing={0.5} alignItems="center">
                                  <TextField
                                    size="small" placeholder="Batch" value={item.batch}
                                    onChange={(e) => handleUpdateItemField(idx, 'batch', e.target.value)}
                                    sx={{ width: 70, '& .MuiInputBase-input': { py: 0.25, px: 0.5, fontSize: '0.72rem' } }}
                                  />
                                  <TextField
                                    size="small" type="date" value={item.expiry} error={expired}
                                    onChange={(e) => handleUpdateItemField(idx, 'expiry', e.target.value)}
                                    sx={{ width: 128, '& .MuiInputBase-input': { py: 0.25, px: 0.5, fontSize: '0.72rem' } }}
                                  />
                                  {expired && <Tooltip title="Expired stock — requires Manager/Admin override to sell"><ExpiryIcon sx={{ fontSize: 16, color: '#dc2626' }} /></Tooltip>}
                                  {nearExpiry && <Tooltip title="Expires within 30 days"><WarningIcon sx={{ fontSize: 15, color: '#d97706' }} /></Tooltip>}
                                </Stack>
                              </TableCell>
                              <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                                <Stack direction="row" alignItems="center" justifyContent="center" spacing={0.25}>
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleUpdateItemQty(idx, -1)}><RemoveIcon sx={{ fontSize: 15 }} /></IconButton>
                                  <TextField
                                    size="small" type="number" error={isStockExceeded} value={item.qty}
                                    onChange={(e) => handleUpdateItemQty(idx, e.target.value, true)}
                                    sx={{ width: 46, '& .MuiInputBase-input': { py: 0.25, px: 0.25, textAlign: 'center', fontWeight: 700, fontSize: '0.8rem' } }}
                                  />
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleUpdateItemQty(idx, 1)}><AddIcon sx={{ fontSize: 15 }} /></IconButton>
                                </Stack>
                              </TableCell>
                              <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                                <TextField
                                  size="small" type="number" value={item.freeQty} disabled={item.isFreeGift}
                                  onChange={(e) => handleUpdateItemField(idx, 'freeQty', Math.max(0, parseInt(e.target.value) || 0))}
                                  sx={{ width: 52, '& .MuiInputBase-input': { py: 0.25, px: 0.25, textAlign: 'center', fontSize: '0.8rem' } }}
                                />
                              </TableCell>
                              <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                {canOverride || item.isFreeGift ? (
                                  <TextField
                                    size="small" type="number" value={item.rate} disabled={item.isFreeGift}
                                    onChange={(e) => handleUpdateItemField(idx, 'rate', parseFloat(e.target.value) || 0)}
                                    sx={{ width: 76, '& .MuiInputBase-input': { py: 0.25, px: 0.5, textAlign: 'right', fontSize: '0.8rem' } }}
                                  />
                                ) : (
                                  <Tooltip title="Only Managers/Admins can override price">
                                    <Stack direction="row" spacing={0.25} alignItems="center" justifyContent="flex-end">
                                      <LockIcon sx={{ fontSize: 12, color: '#cbd5e1' }} />
                                      <Typography variant="body2" fontWeight={700}>₹{(parseFloat(item.rate) || 0).toFixed(2)}</Typography>
                                    </Stack>
                                  </Tooltip>
                                )}
                              </TableCell>
                              <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                                <TextField
                                  size="small" type="number" value={item.discount} disabled={item.isFreeGift}
                                  onChange={(e) => handleUpdateItemField(idx, 'discount', parseFloat(e.target.value) || 0)}
                                  sx={{ width: 52, '& .MuiInputBase-input': { py: 0.25, px: 0.5, textAlign: 'right', fontSize: '0.8rem' } }}
                                />
                              </TableCell>
                              <TableCell align="right" sx={{ color: '#64748b' }}>{(parseFloat(item.gst) || 0)}%</TableCell>
                              <TableCell align="right" sx={{ fontWeight: 800, color: '#0f172a' }}>₹{t.total.toFixed(2)}</TableCell>
                              <TableCell align="center" padding="checkbox" onClick={(e) => e.stopPropagation()}>
                                <Stack direction="row">
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => setNotesOpenIdx(notesOpenIdx === idx ? -1 : idx)}>
                                    <NoteIcon sx={{ fontSize: 15, color: item.notes ? '#4f46e5' : '#cbd5e1' }} />
                                  </IconButton>
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleRemoveItem(idx)}>
                                    <DeleteIcon sx={{ fontSize: 16, color: '#94a3b8' }} />
                                  </IconButton>
                                </Stack>
                              </TableCell>
                            </TableRow>
                            {notesOpenIdx === idx && (
                              <TableRow>
                                <TableCell colSpan={13} sx={{ bgcolor: '#f8fafc', py: 1 }}>
                                  <TextField
                                    fullWidth size="small" autoFocus placeholder="Add a note for this line item..."
                                    value={item.notes} onChange={(e) => handleUpdateItemField(idx, 'notes', e.target.value)}
                                  />
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}

              {cartItems.length > 0 && (
                <Box sx={{ px: 2, py: 1, borderTop: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
                  <Typography variant="caption" fontWeight={700} color="#475569">
                    Total Items: {summary.totalItems} product{summary.totalItems === 1 ? '' : 's'} ({summary.totalQty} unit{summary.totalQty === 1 ? '' : 's'})
                  </Typography>
                </Box>
              )}
            </Card>

            {/* DELIVERY — a compact segmented control (not four oversized buttons) */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <DeliveryIcon sx={{ fontSize: 18, color: '#4f46e5' }} />
                  <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Delivery</Typography>
                </Stack>
                <ToggleButtonGroup
                  value={delivery.type} exclusive size="small"
                  onChange={(e, v) => { if (v) setDelivery({ ...delivery, type: v }); }}
                  sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 700, fontSize: '0.7rem', py: 0.25, px: 1, border: '1px solid #e2e8f0 !important', '&.Mui-selected': { bgcolor: '#4f46e5', color: '#fff', '&:hover': { bgcolor: '#4338ca' } } } }}
                >
                  {DELIVERY_TYPES.map(t => <ToggleButton key={t} value={t}>{t}</ToggleButton>)}
                </ToggleButtonGroup>
              </Stack>
              <Grid container spacing={1.5}>
                <Grid item xs={12} sm={delivery.type === 'Pickup' ? 12 : 6}>
                  <TextField
                    fullWidth size="small" multiline minRows={1} label="Shipping Address" value={delivery.address}
                    onChange={(e) => setDelivery({ ...delivery, address: e.target.value })}
                    disabled={delivery.type === 'Pickup' || (!addressEditUnlocked && !canOverride)}
                    helperText={selectedCustomer?.shippingAddress && delivery.type !== 'Pickup' ? 'Auto-filled from dealer shipping address' : ' '}
                    InputProps={canOverride && delivery.type !== 'Pickup' ? {
                      endAdornment: <IconButton size="small" onClick={() => setAddressEditUnlocked(v => !v)}><LockIcon sx={{ fontSize: 14, color: addressEditUnlocked ? '#4f46e5' : '#cbd5e1' }} /></IconButton>,
                    } : undefined}
                  />
                </Grid>
                {delivery.type !== 'Pickup' && (
                  <Grid item xs={12} sm={6}>
                    <QuickDatePickerField label="Expected Delivery Date" value={delivery.expectedDate} onChange={(v) => setDelivery({ ...delivery, expectedDate: v })} />
                  </Grid>
                )}
                {(delivery.type === 'Courier' || delivery.type === 'Transport') && (
                  <>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label={delivery.type === 'Courier' ? 'Courier Name' : 'Transport Name'} value={delivery.courierName} onChange={(e) => setDelivery({ ...delivery, courierName: e.target.value })} />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="Tracking / LR Number" value={delivery.trackingNo} onChange={(e) => setDelivery({ ...delivery, trackingNo: e.target.value })} />
                    </Grid>
                  </>
                )}
                <Grid item xs={12}>
                  <TextField fullWidth size="small" multiline minRows={1} label="Delivery Notes" value={delivery.notes} onChange={(e) => setDelivery({ ...delivery, notes: e.target.value })} />
                </Grid>
              </Grid>
            </Card>

            {/* PACKING & DISPATCH — progressive disclosure: collapsed until needed */}
            <Card variant="outlined" sx={{ borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0', overflow: 'hidden' }}>
              <Stack
                direction="row" spacing={1} alignItems="center" justifyContent="space-between"
                sx={{ p: 2, cursor: 'pointer' }} onClick={() => setPackingOpen(v => !v)}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <PackingIcon sx={{ fontSize: 18, color: '#4f46e5' }} />
                  <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Packing & Dispatch</Typography>
                  <Chip label={orderStatus} size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700, bgcolor: (ORDER_STATUS_COLORS[orderStatus] || ORDER_STATUS_COLORS.Confirmed).bg, color: (ORDER_STATUS_COLORS[orderStatus] || ORDER_STATUS_COLORS.Confirmed).color }} />
                </Stack>
                <IconButton size="small">{packingOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}</IconButton>
              </Stack>
              <Collapse in={packingOpen}>
                <Box sx={{ px: 2, pb: 2 }}>
                  <Grid container spacing={1.5}>
                    <Grid item xs={6} sm={3}>
                      <TextField fullWidth size="small" type="number" label="No. of Packages" value={packing.packages} onChange={(e) => setPacking({ ...packing, packages: e.target.value })} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField fullWidth size="small" type="number" label="Total Weight (kg)" value={packing.weight} onChange={(e) => setPacking({ ...packing, weight: e.target.value })} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField fullWidth size="small" label="Packed By" value={packing.packedBy} onChange={(e) => setPacking({ ...packing, packedBy: e.target.value })} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <QuickDatePickerField label="Packing Date" value={packing.packingDate} onChange={(v) => setPacking({ ...packing, packingDate: v })} />
                    </Grid>
                  </Grid>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    Dispatch details (courier/transport, tracking/LR number) are captured above under Delivery.
                  </Typography>
                </Box>
              </Collapse>
            </Card>

            {/* NOTES */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle2" fontWeight={800} color="#0f172a" sx={{ mb: 1.5 }}>Notes</Typography>
              <Grid container spacing={1.5}>
                <Grid item xs={12} sm={6}>
                  <TextField fullWidth size="small" multiline minRows={2} label="Customer Note (printed on invoice)" value={notesState.customer} onChange={(e) => setNotesState({ ...notesState, customer: e.target.value })} />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField fullWidth size="small" multiline minRows={2} label="Internal Note (not printed)" value={notesState.internal} onChange={(e) => setNotesState({ ...notesState, internal: e.target.value })} />
                </Grid>
                <Grid item xs={12}>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {NOTE_TEMPLATES.map(t => (
                      <Chip key={t} label={t} size="small" clickable onClick={() => applyNoteTemplate(t)} sx={{ fontWeight: 600 }} />
                    ))}
                  </Stack>
                </Grid>
              </Grid>
            </Card>

            {/* ATTACHMENTS — small, session-local files (Dealer PO, Delivery/Transport docs);
                no generic attachment backend exists yet, so these travel with the saved invoice. */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                <AttachFileIcon sx={{ fontSize: 18, color: '#4f46e5' }} />
                <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Attachments</Typography>
              </Stack>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: attachments.length ? 1.5 : 0 }}>
                {['Dealer PO', 'Delivery Document', 'Transport Document', 'Other'].map(cat => (
                  <Button key={cat} size="small" variant="outlined" component="label" startIcon={<AttachFileIcon sx={{ fontSize: 15 }} />} sx={{ fontWeight: 700, textTransform: 'none' }}>
                    {cat}
                    <input type="file" hidden onChange={(e) => handleAttachFile(e, cat)} />
                  </Button>
                ))}
              </Stack>
              {attachments.length > 0 && (
                <Stack spacing={0.5}>
                  {attachments.map((a, idx) => (
                    <Stack key={idx} direction="row" alignItems="center" justifyContent="space-between" sx={{ p: 0.75, borderRadius: 1.5, bgcolor: '#f8fafc' }}>
                      <Typography variant="caption" noWrap sx={{ maxWidth: 220 }}>{a.category}: {a.name}</Typography>
                      <IconButton size="small" onClick={() => handleRemoveAttachment(idx)}><DeleteIcon sx={{ fontSize: 15 }} /></IconButton>
                    </Stack>
                  ))}
                </Stack>
              )}
            </Card>
          </Stack>
        </Grid>

        {/* ================= RIGHT: SUMMARY + PAYMENT + ACTIONS ================= */}
        <Grid item xs={12} lg={4}>
          <Stack spacing={2.5} sx={{ position: { lg: 'sticky' }, top: 16 }}>
            {/* INVOICE SUMMARY */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle2" fontWeight={800} color="#0f172a" sx={{ mb: 1.5 }}>Invoice Summary</Typography>
              <Stack spacing={0.85}>
                <SummaryLine label="Items" value={summary.totalItems} dense />
                <SummaryLine label="Total Quantity" value={summary.totalQty} dense />
                <SummaryLine label="Subtotal" value={`₹${summary.subtotal.toFixed(2)}`} />
                <SummaryLine label="Product Discount" value={`-₹${summary.productDiscount.toFixed(2)}`} valueColor="#059669" />
                <SummaryLine label="Scheme Discount" value={`-₹${summary.schemeDiscount.toFixed(2)}`} valueColor="#059669" />
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ cursor: 'pointer' }} onClick={() => setChargesOpen(v => !v)}>
                  <Stack direction="row" alignItems="center" spacing={0.25}>
                    <Typography variant="body2" color="text.secondary">Additional Charges</Typography>
                    {chargesOpen ? <ExpandLessIcon sx={{ fontSize: 16, color: '#94a3b8' }} /> : <ExpandMoreIcon sx={{ fontSize: 16, color: '#94a3b8' }} />}
                  </Stack>
                  <Typography variant="body2" fontWeight={700}>₹{summary.additionalCharges.toFixed(2)}</Typography>
                </Stack>
                <Collapse in={chargesOpen}>
                  <Stack spacing={0.75} sx={{ pl: 1, py: 0.5 }}>
                    {chargesList.map((c, idx) => (
                      <Stack direction="row" spacing={1} alignItems="center" key={c.name}>
                        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{c.name}</Typography>
                        <Chip
                          label={c.taxable ? 'Taxable' : 'Non-taxable'} size="small" clickable
                          onClick={() => setChargesList(prev => prev.map((p, pi) => pi === idx ? { ...p, taxable: !p.taxable } : p))}
                          sx={{ height: 18, fontSize: '0.6rem', fontWeight: 700, bgcolor: c.taxable ? '#eef2ff' : '#f1f5f9', color: c.taxable ? '#4f46e5' : '#64748b' }}
                        />
                        <TextField
                          size="small" type="number" placeholder="0" value={c.amount}
                          onChange={(e) => setChargesList(prev => prev.map((p, pi) => pi === idx ? { ...p, amount: e.target.value } : p))}
                          sx={{ width: 84, '& .MuiInputBase-input': { py: 0.25, px: 0.5, textAlign: 'right', fontSize: '0.78rem' } }}
                        />
                      </Stack>
                    ))}
                  </Stack>
                </Collapse>
                <Divider sx={{ my: 0.25 }} />
                <SummaryLine label="Taxable Amount" value={`₹${summary.taxableAmount.toFixed(2)}`} />
                <SummaryLine label="GST" value={`₹${summary.totalGst.toFixed(2)}`} />
                <SummaryLine label="Round Off" value={`${summary.roundOff >= 0 ? '+' : '-'}₹${Math.abs(summary.roundOff).toFixed(2)}`} />
              </Stack>
              <Divider sx={{ my: 1.25 }} />
              <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Grand Total</Typography>
                <Typography variant="h6" fontWeight={900} color="#4f46e5">₹{summary.grandTotal.toLocaleString('en-IN')}</Typography>
              </Stack>
            </Card>

            {/* PAYMENT */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle2" fontWeight={800} color="#0f172a" sx={{ mb: 1.5 }}>Payment Method</Typography>

              <ToggleButtonGroup
                value={payMode} exclusive onChange={(e, v) => { if (v) setPayMode(v); }} fullWidth size="small"
                sx={{ mb: 1.5, flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButton-root': { flex: '1 0 auto', textTransform: 'none', fontWeight: 700, fontSize: '0.75rem', py: 0.5, border: '1px solid #e2e8f0 !important', borderRadius: '8px !important', '&.Mui-selected': { bgcolor: '#4f46e5', color: '#fff', '&:hover': { bgcolor: '#4338ca' } } } }}
              >
                {[['Cash', 'Cash'], ['UPI', 'UPI'], ['Card', 'Card'], ['Bank Transfer', 'Bank'], ['Credit Sale', 'Credit'], ['Split Payment', 'Split']].map(([val, label]) => (
                  <ToggleButton key={val} value={val}>{label}</ToggleButton>
                ))}
              </ToggleButtonGroup>

              {payMode === 'Cash' && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" type="number" label="Amount Received (₹)" InputLabelProps={{ shrink: true }} placeholder={String(summary.grandTotal)} value={amountReceived} onChange={(e) => setAmountReceived(e.target.value)} />
                  <Stack direction="row" spacing={1}>
                    <MiniStat label="Due Amount" value={fmtINR(paymentCalc.dueAmount)} color={paymentCalc.dueAmount > 0 ? '#dc2626' : '#059669'} />
                    <MiniStat label="Change" value={fmtINR(paymentCalc.balanceAmount)} color="#4f46e5" />
                  </Stack>
                </Stack>
              )}

              {(payMode === 'UPI' || payMode === 'Card') && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" label="Amount Received (₹)" InputLabelProps={{ shrink: true }} value={summary.grandTotal} InputProps={{ readOnly: true }} sx={{ bgcolor: '#f8fafc' }} />
                  <TextField fullWidth size="small" label="Reference / Txn ID" InputLabelProps={{ shrink: true }} placeholder="UPI Ref / Approval Code" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
                </Stack>
              )}

              {payMode === 'Bank Transfer' && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" label="Reference / Cheque No" InputLabelProps={{ shrink: true }} placeholder="NEFT / RTGS Ref" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
                  <TextField fullWidth size="small" label="Bank Name / Account" InputLabelProps={{ shrink: true }} placeholder="e.g. HDFC Bank" value={bankName} onChange={(e) => setBankName(e.target.value)} />
                </Stack>
              )}

              {payMode === 'Split Payment' && (
                <Stack spacing={1}>
                  {splitPayments.map((sp, i) => (
                    <Stack direction="row" spacing={1} key={i}>
                      <TextField select size="small" value={sp.mode} onChange={(e) => setSplitPayments(prev => prev.map((p, pi) => pi === i ? { ...p, mode: e.target.value } : p))} sx={{ width: 120 }}>
                        {SPLIT_PAYMENT_MODES.map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
                      </TextField>
                      <TextField fullWidth size="small" type="number" placeholder="Amount" value={sp.amount} onChange={(e) => setSplitPayments(prev => prev.map((p, pi) => pi === i ? { ...p, amount: e.target.value } : p))} />
                      <IconButton size="small" disabled={splitPayments.length <= 1} onClick={() => setSplitPayments(prev => prev.filter((_, pi) => pi !== i))}><DeleteIcon sx={{ fontSize: 16 }} /></IconButton>
                    </Stack>
                  ))}
                  <Button size="small" onClick={() => setSplitPayments(prev => [...prev, { mode: 'Cash', amount: '' }])} sx={{ alignSelf: 'flex-start', textTransform: 'none', fontWeight: 700 }}>+ Add Payment Mode</Button>
                  <Stack direction="row" spacing={1}>
                    <MiniStat label="Split Total" value={fmtINR(splitTotal)} color="#4f46e5" />
                    <MiniStat label="Remaining" value={fmtINR(Math.max(0, summary.grandTotal - splitTotal))} color={splitTotal >= summary.grandTotal ? '#059669' : '#dc2626'} />
                  </Stack>
                  {splitCreditAmount > 0 && <Typography variant="caption" color="text.secondary">₹{splitCreditAmount.toLocaleString('en-IN')} marked as Credit will be added to the dealer's outstanding.</Typography>}
                </Stack>
              )}

              {payMode === 'Credit Sale' && (
                <Stack spacing={1}>
                  <TextField select fullWidth size="small" label="Payment Terms" InputLabelProps={{ shrink: true }} value={creditDays} onChange={(e) => setCreditDays(e.target.value)}>
                    <MenuItem value={15}>15 Days</MenuItem>
                    <MenuItem value={30}>30 Days</MenuItem>
                    <MenuItem value={45}>45 Days</MenuItem>
                    <MenuItem value={60}>60 Days</MenuItem>
                  </TextField>

                  <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                    <SummaryLine label="Invoice Amount" value={fmtINR(summary.grandTotal)} dense />
                    <SummaryLine label="Amount Paid" value={fmtINR(0)} dense />
                    <SummaryLine label="Credit Amount" value={fmtINR(summary.grandTotal)} valueColor="#dc2626" dense />
                    <SummaryLine label="Due Date" value={dueDate || '—'} dense />
                  </Box>

                  {selectedCustomer ? (
                    <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                      <SummaryLine label="Previous Outstanding" value={fmtINR(selectedCustomer.outstanding)} dense />
                      <SummaryLine label="New Outstanding" value={fmtINR((parseFloat(selectedCustomer.outstanding) || 0) + summary.grandTotal)} valueColor="#dc2626" dense />
                      <SummaryLine label="Credit Limit" value={fmtINR(selectedCustomer.creditLimit)} dense />
                      <SummaryLine label="Available Credit" value={fmtINR(availableCredit)} valueColor="#059669" dense />
                    </Box>
                  ) : (
                    <Typography variant="caption" color="text.secondary">Select a dealer to see available credit.</Typography>
                  )}

                  {selectedCustomer && summary.grandTotal > availableCredit && (
                    <Alert severity="warning" sx={{ borderRadius: 2, py: 0.25, fontSize: '0.75rem', fontWeight: 600 }}>
                      This invoice exceeds available credit by {fmtINR(summary.grandTotal - availableCredit)}.
                    </Alert>
                  )}
                </Stack>
              )}
            </Card>

            {/* ACTIONS */}
            <Stack spacing={1}>
              <Button
                variant="contained" fullWidth size="large"
                disabled={Boolean(!selectedCustomer || cartItems.length === 0 || savingInvoice)}
                onClick={handleAttemptCompleteSale}
                startIcon={savingInvoice ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : <CheckedIcon />}
                endIcon={<Chip label="F9" size="small" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700, bgcolor: 'rgba(255,255,255,0.25)', color: '#fff' }} />}
                sx={{ bgcolor: '#4f46e5', fontWeight: 800, py: 1.1, textTransform: 'none', '&:hover': { bgcolor: '#4338ca' } }}
              >
                {savingInvoice ? 'Processing…' : 'Complete Sale'}
              </Button>
              <Stack direction="row" spacing={1}>
                <Button fullWidth size="small" variant="outlined" disabled={cartItems.length === 0} onClick={handleSaveDraft} startIcon={<SaveIcon />} sx={{ fontWeight: 700, textTransform: 'none' }}>
                  Save Draft <Chip label="F8" size="small" sx={{ ml: 0.5, height: 16, fontSize: '0.58rem', bgcolor: '#f1f5f9', color: '#64748b' }} />
                </Button>
                <Button fullWidth size="small" variant="outlined" color="warning" disabled={cartItems.length === 0} onClick={handleHoldInvoice} startIcon={<HoldIcon />} sx={{ fontWeight: 700, textTransform: 'none' }}>
                  Hold <Chip label="F7" size="small" sx={{ ml: 0.5, height: 16, fontSize: '0.58rem', bgcolor: '#f1f5f9', color: '#64748b' }} />
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', mt: 0.25 }}>
                F2 Dealer &middot; F3 Product &middot; F4 Bulk Add &middot; F6 Discount &middot; F7 Hold &middot; F8 Draft &middot; F9 Complete &middot; Ctrl+P Print &middot; Esc Clear Search &middot; Del Remove Row
              </Typography>
            </Stack>
          </Stack>
        </Grid>
      </Grid>

      {/* DIALOGS */}
      <NewDealerDialog open={newDealerOpen} value={newDealer} onChange={setNewDealer} onClose={() => setNewDealerOpen(false)} onSave={handleSaveNewDealer} saving={savingDealer} />
      <DealerProfileDialog open={dealerProfileOpen} dealer={selectedCustomer} onClose={() => setDealerProfileOpen(false)} />
      <LedgerDialog
        open={ledgerOpen} dealer={selectedCustomer} ledger={dealerLedger} onClose={() => setLedgerOpen(false)}
        onRecordPayment={() => { setLedgerOpen(false); setRecordPaymentOpen(true); }}
        onDownload={() => {
          const rows = dealerLedger.map(r => [r.date, r.type, r.ref, r.debit || '', r.credit || '', r.balance]);
          const csv = ['Date,Type,Ref,Debit,Credit,Balance', ...rows.map(r => r.join(','))].join('\n');
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `${selectedCustomer?.code || 'dealer'}_statement.csv`;
          link.click();
        }}
        onPrint={() => window.print()}
      />
      <RecordPaymentDialog open={recordPaymentOpen} dealer={selectedCustomer} onClose={() => setRecordPaymentOpen(false)} onRecord={handleRecordPayment} />
      <PreviousOrdersDialog
        open={prevOrdersOpen} dealer={selectedCustomer} orders={dealerOrders}
        onClose={() => setPrevOrdersOpen(false)}
        onView={handleViewOrder}
        onDuplicate={(o) => applyOrderToCart(o, 'duplicate')}
        onReorder={(o) => applyOrderToCart(o, 'reorder')}
      />
      <BulkAddDialog open={bulkAddOpen} products={products} onClose={() => setBulkAddOpen(false)} onAdd={handleBulkAdd} />
      <ExcelImportDialog open={excelImportOpen} onClose={() => setExcelImportOpen(false)} onImport={handleExcelImport} />
      <SchemeDialog open={schemeOpen} onClose={() => setSchemeOpen(false)} dealer={selectedCustomer} schemes={schemes} products={products} invoiceDiscount={invoiceDiscount} onApply={handleApplyScheme} />
      <CreditNoteDialog open={creditNoteOpen} invoice={printableInvoice} onClose={() => setCreditNoteOpen(false)} onCreate={handleCreateCreditNote} />
      <CompletionDialog
        open={completionOpen} invoice={printableInvoice}
        onPrint={() => setPrintModalOpen(true)}
        onDownloadPdf={() => downloadPdfInvoice(printableInvoice, 'WHOLESALE_BILL')}
        onSend={() => showToast(`Invoice ${printableInvoice?.invoiceNo} queued for sending.`, 'success')}
        onView={() => setPrintModalOpen(true)}
        onNewSale={() => { setCompletionOpen(false); setSelectedCustomer(null); }}
      />

      {/* DIALOG: HELD INVOICES RESUME */}
      <Dialog open={heldModalOpen} onClose={() => setHeldModalOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 850 }}>Resume Held Wholesale Invoices</DialogTitle>
        <DialogContent dividers>
          {heldInvoices.length === 0 ? (
            <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 3 }}>No held invoices available.</Typography>
          ) : (
            <Stack spacing={1.5}>
              {heldInvoices.map((held) => (
                <Paper key={held.id} variant="outlined" sx={{ p: 2, borderRadius: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Typography variant="subtitle2" fontWeight={800}>{held.customer?.name || 'Dealer'}</Typography>
                    <Typography variant="caption" color="text.secondary">Held at {held.heldAt} • {held.cartItems.length} Items • Total: ₹{held.totalAmount}</Typography>
                  </Box>
                  <Button variant="contained" size="small" onClick={() => handleResumeHeldInvoice(held)} sx={{ fontWeight: 700 }}>Resume</Button>
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => setHeldModalOpen(false)}>Close</Button></DialogActions>
      </Dialog>

      {/* CONFIRM ACTION DIALOGS */}
      <ConfirmActionDialog
        open={clearCartConfirmOpen} title="Clear Wholesale POS Cart?"
        message="Are you sure you want to clear all products from the current POS cart?"
        type="warning" confirmText="Yes, Clear Cart"
        onClose={() => setClearCartConfirmOpen(false)}
        onConfirm={() => { setClearCartConfirmOpen(false); handleClearCart(); }}
      />
      <ConfirmActionDialog
        open={creditLimitConfirmOpen} title="Credit Limit Override Confirmation"
        message={`Completing this Credit Sale for ${selectedCustomer?.name} will push their total outstanding balance (${fmtINR((parseFloat(selectedCustomer?.outstanding || 0) + summary.grandTotal))}) over their assigned Credit Limit (${fmtINR(selectedCustomer?.creditLimit || 0)}). Do you wish to override and complete this sale?`}
        type="warning" confirmText="Override & Complete Sale"
        onClose={() => setCreditLimitConfirmOpen(false)}
        onConfirm={executeCompleteSale}
      />
      <ConfirmActionDialog
        open={cancelInvoiceConfirmOpen} title="Cancel Invoice?"
        message={`Cancel invoice ${printableInvoice?.invoiceNo}? Stock will be restored and the dealer's outstanding balance will be adjusted.`}
        type="danger" confirmText="Yes, Cancel Invoice"
        onClose={() => setCancelInvoiceConfirmOpen(false)}
        onConfirm={handleCancelInvoice}
      />
      <ConfirmActionDialog
        open={returnConfirmOpen} title="Process Sales Return?"
        message={`Process a full sales return for invoice ${printableInvoice?.invoiceNo}? All items will be restocked and the dealer's outstanding balance adjusted.`}
        type="warning" confirmText="Process Return"
        onClose={() => setReturnConfirmOpen(false)}
        onConfirm={handleSalesReturn}
      />
      <ConfirmActionDialog
        open={replacementConfirmOpen} title="Process Replacement?"
        message={`Restock all items from invoice ${printableInvoice?.invoiceNo} and start a new replacement order for ${printableInvoice?.customer?.name}?`}
        type="warning" confirmText="Process Replacement"
        onClose={() => setReplacementConfirmOpen(false)}
        onConfirm={handleReplacement}
      />

      {/* DIALOG: PRINT GST TAX INVOICE — rendered by the shared Bill Rendering Engine
          (template assigned to WHOLESALE_BILL in Settings → Bill & Invoice Designer). */}
      <Dialog open={printModalOpen} onClose={() => setPrintModalOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 850, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Wholesale Tax Invoice #{printableInvoice?.invoiceNo}</span>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" startIcon={<WhatsAppIcon />} onClick={() => showToast('Shared via WhatsApp', 'success')}>WhatsApp</Button>
            <Button size="small" variant="outlined" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(printableInvoice, 'WHOLESALE_BILL')}>PDF</Button>
            <Button size="small" variant="contained" startIcon={<PrintIcon />} onClick={() => printBill({ doc: printableInvoice, documentType: 'WHOLESALE_BILL' })}>Print</Button>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#eef2f7', py: 3 }}>
          {printableInvoice && (<BillPreview doc={printableInvoice} documentType="WHOLESALE_BILL" maxWidth={720} />)}
        </DialogContent>
        <DialogActions><Button onClick={() => setPrintModalOpen(false)}>Close</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
