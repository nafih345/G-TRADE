import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Grid, Button, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Paper, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Stack, Chip, IconButton, Divider,
  Alert, Autocomplete, Tooltip, ToggleButton, ToggleButtonGroup,
  Menu, Collapse, CircularProgress, Avatar, InputAdornment
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
  Keyboard as KeyboardIcon,
  Tune as DetailsIcon,
  Receipt as BillIcon,
  ImageOutlined as NoImageIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import axios from 'axios';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import { navScopeProps, focusField, enterOpensSelectProps, selectOnFocusProps, zeroAsBlank, typedNumber } from './wholesale/keyboardNav';
import { ensureEditAccess } from '../utils/editPermissions';
import { useWholesaleShortcuts } from './wholesale/posShortcuts';
import useBarcodeScanner from '../hooks/useBarcodeScanner';
import ProductMasterDialog from '../components/inventory/ProductMasterDialog';
import ServiceMasterDialog from '../components/sales/ServiceMasterDialog';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import BillPreview from '../billing/BillPreview';
import { printBill } from '../billing/printBill';
import PaymentModeDetails from '../components/common/PaymentModeDetails';
import useBankAccounts, { bankName as bankNameOf } from '../hooks/useBankAccounts';
import { CASH_PAID, CASH_UNPAID, needsBank } from '../utils/paymentModes';
import { downloadPdfInvoice } from '../utils/printInvoice';
import { useAuth } from '../context/AuthContext';
import { describeApiError } from '../utils/apiWriteGuard';
import {
  LS_KEYS, PRICE_LIST_OPTIONS, PRICE_TIER_LABEL, DELIVERY_TYPES, ORDER_STATUSES, ORDER_STATUS_COLORS,
  DEFAULT_SCHEMES, DEMO_SALES_REPS, INITIAL_DEMO_CUSTOMERS,
  ADDITIONAL_CHARGE_TYPES, NOTE_TEMPLATES, SPLIT_PAYMENT_MODES, WHOLESALE_API,
  uid, readLS, writeLS, resolvePriceForDealer, computeLineTotals, buildDealerLedger,
  fmtINR, canOverridePrice, isUuid, fetchAllPages, mapDealerFromApi, mapDealerToApi,
  saveInvoiceToBackend, cacheInvoice, syncWholesaleInvoices, newInvoiceNo, invoiceFromApi,
} from './wholesale/wholesaleConstants';
import {
  NewDealerDialog, LedgerDialog, RecordPaymentDialog, DealerProfileDialog, PreviousOrdersDialog, BulkAddDialog,
  ExcelImportDialog, SchemeDialog, CreditNoteDialog, CompletionDialog, ShortcutHelpDialog, Kbd,
} from './wholesale/WholesaleDialogs';
import {
  parseTaxPercent, productPriceTiers, shownPrice, setLinePrice, setLineTax, setLineTaxMode, pricedLine,
  zeroTaxLabel, lineMargin, priceChoices, taxBreakup, round2,
} from '../utils/wholesalePricing';
import { reconcileLocalInventory } from '../utils/inventoryCache';
import { useCanViewCost } from '../utils/costVisibility';

// One "label: value" row used in the credit panel.
function SummaryLine({ label, value, valueColor, dense }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={dense ? { py: 0.15 } : undefined}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: dense ? '0.78rem' : undefined }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700} sx={{ color: valueColor || '#0f172a', fontSize: dense ? '0.78rem' : undefined }}>{value}</Typography>
    </Stack>
  );
}

// New Sale footer style: caption label on the left, bold figure on the right.
function SumRow({ label, value, color, strong }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.2 }}>
      <Typography variant="caption" fontWeight={strong ? 900 : 700} sx={{ color: strong ? (color || 'primary.main') : 'text.secondary' }}>{label}</Typography>
      <Typography variant="body2" fontWeight={900} sx={{ color: color || '#0f172a', fontSize: strong ? '0.95rem' : '0.8rem' }}>{value}</Typography>
    </Stack>
  );
}

// One field in the selected-dealer card (skipped when empty).
function DealerField({ label, value, color }) {
  if (value == null || value === '') return null;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.2, fontSize: '0.66rem', fontWeight: 700 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={800} sx={{ color: color || '#0f172a', fontSize: '0.78rem', wordBreak: 'break-word' }}>{value}</Typography>
    </Box>
  );
}

// Section heading with an optional shortcut badge.
function SectionTitle({ icon, title, kbd, right }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
      <Stack direction="row" alignItems="center" spacing={0.75}>
        {icon}
        <Typography variant="subtitle2" fontWeight={900} color="#0f172a" sx={{ fontSize: '0.82rem' }}>{title}</Typography>
        {kbd && <Kbd>{kbd}</Kbd>}
      </Stack>
      {right}
    </Stack>
  );
}

const PANEL_SX = { p: 1.5, borderRadius: 1, bgcolor: '#ffffff', borderColor: '#cbd5e1' };
const NAVY = '#0f172a';
const HEAD_CELL_SX = { bgcolor: NAVY, color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.72rem', whiteSpace: 'nowrap' };
const NO_SPIN_SX = { '& input[type=number]': { MozAppearance: 'textfield' }, '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': { WebkitAppearance: 'none', margin: 0 } };
const cellInputSx = (width, align = 'center') => ({
  width, ...NO_SPIN_SX,
  '& .MuiInputBase-input': { py: 0.35, px: 0.5, textAlign: align, fontWeight: 800, fontSize: '0.8rem' },
});
const ITEM_MODES = [
  { key: 'product', label: '📦 Product', kbd: 'F4' },
];
const PAY_MODE_BUTTONS = [['Cash', 'Cash'], ['UPI', 'UPI'], ['Card', 'Card'], ['Bank Transfer', 'Bank'], ['Credit Sale', 'Credit'], ['Split Payment', 'Split']];
const isServiceLine = (item) => item?.itemType === 'SERVICE';
const isLensProduct = (p) => /lens/i.test(String(p?.category || ''));
const GRID_COLS = ['qty', 'rate', 'disc', 'gst'];

// Treat inventory placeholder dashes as "no value" so empty columns stay blank.
const cellText = (v) => (v == null || v === '' || v === '—' || v === '-' ? '' : v);

// Units of each product a saved, active invoice already holds out of stock — while it is being
// edited those count as available again (the server only moves the difference on save).
const heldUnitsOf = (inv) => {
  const held = {};
  if (!inv || inv.status === 'Draft' || inv.orderStatus === 'Draft' || inv.status === 'Cancelled' || inv.stockReturned) return held;
  (inv.items || []).forEach((it) => {
    if (isServiceLine(it) || !it.id) return;
    held[it.id] = (held[it.id] || 0) + computeLineTotals(it).stockUnits;
  });
  return held;
};

// What the POS remembers about the saved invoice open for editing.
const editStateOf = (inv) => {
  const isDraft = inv.status === 'Draft' || inv.orderStatus === 'Draft';
  return {
    backendId: inv.backendId || null,
    invoiceNo: inv.invoiceNo,
    date: inv.date,
    isDraft,
    originalPaid: parseFloat(inv.amountReceived) || 0,
    originalDue: isDraft ? 0 : (parseFloat(inv.dueAmount) || 0),
    originalTotal: parseFloat(inv.summary?.grandTotal) || 0,
    payMode: inv.payMode || 'Cash',
    heldUnits: heldUnitsOf(inv),
  };
};

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
  const viewCost = useCanViewCost();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canOverride = canOverridePrice(user);


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
  // The number this invoice will be posted under (shown in the header; renumbered by
  // saveInvoiceToBackend only if the server reports a clash). A fresh one after each save.
  const [invoiceNo, setInvoiceNo] = useState(newInvoiceNo);
  // A saved invoice re-opened for correction (editStateOf), or null for a new sale. Saving
  // PATCHes that invoice in place: the server moves only the stock difference and re-posts
  // its journal; the dealer's balance moves by the change in what is due.
  const [editing, setEditing] = useState(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  // Confirmed (non-draft) bills keep the payments already recorded against them.
  const paymentLocked = Boolean(editing && !editing.isDraft);
  const heldFor = (id) => (editing?.heldUnits?.[id] || 0);

  // Product entry row (Product / Lens / Services tabs) — search, pick, adjust, Add Item.
  const rootRef = useRef(null);
  const [itemMode, setItemMode] = useState('product');
  const [searchOpen, setSearchOpen] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [services, setServices] = useState([]);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const pendingNewItemRef = useRef(null); // product created via New Item, picked once the catalogue reloads
  const lastAddRef = useRef({ at: 0, key: '' }); // scanner double-Enter guard
  const submittingRef = useRef(false); // duplicate-submission guard for Complete
  const [couponInput, setCouponInput] = useState('');
  const [couponError, setCouponError] = useState('');
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);
  const [removeConfirmIdx, setRemoveConfirmIdx] = useState(-1);
  const [helpOpen, setHelpOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null); // unsaved "Show Bill" preview of the cart

  // Order Information
  const [referenceNo, setReferenceNo] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [invoicePriceList, setInvoicePriceList] = useState(''); // overrides the dealer's default price list for this sale
  const [salesRep, setSalesRep] = useState('');
  const [orderStatus, setOrderStatus] = useState('Confirmed');

  // Invoice-level discount / scheme (F7) — kept separate from each line's own % discount.
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
  // UPI / Bank Transfer: the bank ledger the money lands in. Cash: handed over now, or owed.
  const [payBankAccount, setPayBankAccount] = useState('');
  const [cashStatus, setCashStatus] = useState(CASH_PAID);
  const cashUnpaid = payMode === 'Cash' && cashStatus === CASH_UNPAID;
  const { banks } = useBankAccounts();
  const [splitPayments, setSplitPayments] = useState([{ mode: 'Cash', amount: '' }]);

  // Modals & Confirmation Dialogs
  const [newDealerOpen, setNewDealerOpen] = useState(false);
  const [newDealer, setNewDealer] = useState(NEW_DEALER_DEFAULTS);
  const [savingDealer, setSavingDealer] = useState(false);
  const [savingInvoice, setSavingInvoice] = useState(false);
  // Bumped whenever the invoice cache changes (server sync, save, status change) so the
  // dealer history / ledger memos re-read it.
  const [invoicesVersion, setInvoicesVersion] = useState(0);
  // F10 / Ctrl+S = Complete & Print: set by that hotkey, consumed once the invoice is saved (also
  // across the credit-limit override confirm); a plain Complete Sale click clears it.
  const printAfterSaveRef = useRef(false);
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
  const [priceMenu, setPriceMenu] = useState(null); // { anchor, idx } — Unit Price choice menu

  const [clearCartConfirmOpen, setClearCartConfirmOpen] = useState(false);
  const [cancelInvoiceConfirmOpen, setCancelInvoiceConfirmOpen] = useState(false);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [replacementConfirmOpen, setReplacementConfirmOpen] = useState(false);

  // Toast Alert Notification
  const [toast, setToast] = useState({ open: false, message: '', severity: 'info' });
  const toastTimerRef = useRef(null);
  const showToast = (msg, severity = 'info') => {
    setToast({ open: true, message: msg, severity });
    // Restart the timer so an earlier toast's timeout can't hide this newer message early.
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast({ open: false, message: '', severity: 'info' }), 4000);
  };
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

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
          syncWholesaleInvoices(axios, mapped).then(() => { if (!cancelled) setInvoicesVersion(v => v + 1); });
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

  // Service Master (apps.sales.Service) — billed on the Services tab, same as New Sale.
  useEffect(() => {
    let cancelled = false;
    axios.get('/api/sales/services/').then((res) => {
      const rows = Array.isArray(res.data) ? res.data : (res.data?.results || []);
      if (cancelled) return;
      setServices(rows.filter(r => r.is_active !== false).map(r => ({
        id: String(r.id),
        code: r.service_code || '',
        name: r.name || 'Service',
        description: r.description || '',
        price: parseFloat(r.default_price || 0) || 0,
        gst: parseFloat(r.tax_percentage || 0) || 0,
      })));
    }).catch(() => {});
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
      // tax_rate is the numeric resolver output; 0 is a real (zero-tax) rate, only an
      // unknown rate falls back to the 18% default slab.
      const gstNum = parseTaxPercent(p.tax_rate, p.gst);
      const tiers = productPriceTiers(p);
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
        retailPrice: tiers.retailPrice,
        // Base for the dealer-tier resolver: wholesale tier → MRP → retail sale price.
        wholesalePrice: tiers.wholesaleBase,
        wholesaleRate: tiers.wholesaleRate,
        mrp: tiers.mrp,
        costPrice: tiers.costPrice,
        price: parseFloat(p.price || p.retail_price || 0) || 0,
        gst: gstNum ?? 18,
        taxInclusive: p.tax_treatment === 'INCLUSIVE',
        taxCategory: p.tax_category || '',
        unit: p.unit || 'Pcs',
        barcode: p.barcode || '',
        hsn: p.hsn_code || extra.hsn_code || '',
        image: p.image || extra.image || '',
      };
    };

    const readLocalProducts = () => readLS(LS_KEYS.inventory, []);

    const syncInventory = async () => {
      const local = readLocalProducts();

      let backend = [];
      let answered = false;
      try {
        // Every page — the first page alone (20) left most products with stale stock here.
        const raw = await fetchAllPages(axios, '/api/products/products/');
        if (Array.isArray(raw)) {
          backend = raw.map(mapBackendProduct);
          answered = true;
          reconcileLocalInventory(raw);
        }
      } catch (e) {}

      if (cancelled) return;

      // The server answered: sell only its products. Cached / demo rows it doesn't have carried
      // ids the server can't move stock for — those sales saved without touching inventory.
      if (answered) {
        setProducts(backend);
        return;
      }

      // Server unreachable: show the last cached copy. Never seed demo products — they were
      // written into the shared product cache and then offered by every picker.
      setProducts(local);
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
  }, [selectedCustomer, printableInvoice, invoicesVersion]);

  const dealerLedger = useMemo(() => {
    if (!selectedCustomer) return [];
    return buildDealerLedger(selectedCustomer, readLS(LS_KEYS.invoices, []), readLS(LS_KEYS.returns, []).concat(readLS(LS_KEYS.creditNotes, [])), readLS(LS_KEYS.payments, []));
  }, [selectedCustomer, printableInvoice, invoicesVersion]);

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
    // Per-slab view (0% / exempt lines included) for the GST tooltip and the zero-tax row.
    const { slabs: gstBreakup, zeroTaxValue } = taxBreakup(cartItems, factor, computeLineTotals);

    const rawTotal = taxableAmount + totalGst + nonTaxableCharges;
    const grandTotal = Math.round(rawTotal);
    const roundOff = (grandTotal - rawTotal);

    return {
      totalItems, totalQty, totalFreeQty, subtotal, productDiscount, schemeDiscount, schemeLabel, schemeActive,
      totalDiscount: productDiscount + schemeDiscount, // kept for WholesaleReports.jsx parity
      taxableAmount, totalGst, additionalCharges: totalCharges, taxableCharges, nonTaxableCharges, roundOff, grandTotal,
      gstBreakup: gstBreakup.map(b => ({ rate: b.rate, taxable: round2(b.taxable), tax: round2(b.tax) })),
      zeroTaxValue: round2(zeroTaxValue),
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
    if (paymentLocked) {
      // Editing a confirmed bill: what was received stays as recorded (receipts are their own
      // documents); a higher total leaves more due, a lower one can leave the dealer in credit.
      const paid = editing.originalPaid;
      return { dueAmount: Math.max(0, summary.grandTotal - paid), balanceAmount: Math.max(0, paid - summary.grandTotal), paidNow: paid };
    }
    if (payMode === 'Split Payment') {
      const shortfall = Math.max(0, summary.grandTotal - splitTotal);
      const dueAmount = splitCreditAmount + shortfall;
      const balanceAmount = Math.max(0, splitTotal - summary.grandTotal);
      return { dueAmount, balanceAmount, paidNow: splitPaidAmount };
    }
    const received = cashUnpaid ? 0 : (parseFloat(amountReceived) || (payMode === 'UPI' || payMode === 'Card' ? summary.grandTotal : 0));
    if (payMode === 'Credit Sale' || payMode === 'Bank Transfer') {
      return { dueAmount: summary.grandTotal, balanceAmount: 0, paidNow: 0 };
    }
    const dueAmount = Math.max(0, summary.grandTotal - received);
    const balanceAmount = Math.max(0, received - summary.grandTotal);
    return { dueAmount, balanceAmount, paidNow: received };
  }, [payMode, amountReceived, summary.grandTotal, splitTotal, splitCreditAmount, splitPaidAmount, cashUnpaid, paymentLocked, editing]);

  const dueDate = useMemo(() => {
    if (paymentCalc.dueAmount <= 0.009) return '';
    const base = editing?.date ? new Date(editing.date) : new Date();
    base.setDate(base.getDate() + (parseInt(creditDays) || 0));
    return base.toISOString().split('T')[0];
  }, [paymentCalc.dueAmount, creditDays, editing]);

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
    const creditPortion = paymentLocked
      ? Math.max(0, summary.grandTotal - editing.originalPaid) - editing.originalDue // only the extra the edit adds
      : payMode === 'Credit Sale' ? summary.grandTotal : payMode === 'Split Payment' ? splitCreditAmount : 0;
    const newTotalOut = currOutstanding + creditPortion;
    return limit > 0 && creditPortion > 0 && newTotalOut > limit;
  }, [selectedCustomer, summary.grandTotal, payMode, splitCreditAmount, paymentLocked, editing]);

  // Alt+L — Wholesale → Retail → Special → Wholesale for this invoice (the dropdown still offers every
  // list). Like the dropdown, it prices lines added from now on.
  const cyclePriceList = () => {
    if (!selectedCustomer) { showToast('Select a dealer first.', 'warning'); return; }
    const cycle = ['WHOLESALE', 'RETAIL', 'SPECIAL'];
    const current = invoicePriceList || selectedCustomer.priceList;
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    setInvoicePriceList(next);
    showToast(`Price list: ${PRICE_LIST_OPTIONS.find(o => o.value === next)?.label || next}`, 'info');
  };

  // Delete (row selected, cursor not in a text field) / Ctrl+Delete (cursor in the row's cells) /
  // the row's bin button — all ask first.
  const requestRemoveRow = (idx) => {
    if (!(idx >= 0 && idx < cartItems.length)) {
      showToast('Select a line first (click it, or put the cursor in one of its cells).', 'warning');
      return;
    }
    setRemoveConfirmIdx(idx);
  };

  const confirmRemoveRow = () => {
    const idx = removeConfirmIdx;
    setRemoveConfirmIdx(-1);
    if (!(idx >= 0 && idx < cartItems.length)) return;
    handleRemoveItem(idx);
    setSelectedRowIndex(-1);
    const focusIdx = Math.min(idx, cartItems.length - 2);
    // After the confirm dialog hands focus back: the row that moved up, else the search.
    setTimeout(() => {
      if (!focusField(document.querySelector(`input[data-cell-row="${focusIdx}"][data-cell-col="qty"]`))) focusSearch();
    }, 80);
  };

  const focusById = (id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return focusField(el);
  };
  const focusSearch = () => focusById('ws-product-search');

  // Park the cursor in the barcode field on load so a scanner works without a click.
  useEffect(() => {
    const t = setTimeout(() => focusSearch(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const avail = parseFloat(prod.availableStock ?? prod.stock ?? 0) + heldFor(prod.id);
    const { rate, tier } = priceForProduct(prod, qty);
    const line = {
      itemType: 'PRODUCT',
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
      hsn: prod.hsn || '',
      image: prod.image || '',
      unit: prod.unit || 'Pcs',
      availableStock: avail,
      qty,
      freeQty: 0,
      priceTier: tier,
      discount: 0,
      // `prod.gst || 18` turned every 0% (zero-tax) product into 18%.
      gst: parseTaxPercent(prod.gst) ?? 18,
      taxCategory: prod.taxCategory || '',
      // Price hierarchy snapshot (reference only — never billed): cost for margin, MRP benchmark.
      costPrice: parseFloat(prod.costPrice ?? prod.purchasePrice ?? 0) || 0,
      mrp: parseFloat(prod.mrp ?? 0) || null,
      wholesaleRate: prod.wholesaleRate ?? null,
      notes: '',
      isFreeGift: false,
    };
    // List prices follow the product's tax treatment (Tax master Inclusive / Exclusive).
    return pricedLine(line, rate, Boolean(prod.taxInclusive));
  };

  // Typed price / tax from the bulk entry: tax first so an inclusive price is split on the
  // final slab; a price different from the list price marks the line CUSTOM.
  const applyLineOverrides = (line, overrides) => {
    if (!overrides) return line;
    const { rate, gst, ...rest } = overrides;
    let next = { ...line, ...rest };
    if (gst !== undefined) next = setLineTax(next, gst);
    if (rate !== undefined && rate !== shownPrice(line)) next = { ...setLinePrice(next, rate), priceTier: 'CUSTOM' };
    return next;
  };

  // Adds `qty` of a product. `overrides` ({ rate, discount, gst }) come from the entry row; a
  // product already in the cart gets the qty added (and any typed price/disc/tax applied) rather
  // than a second line, so stock and reorder logic keep one line per product.
  const handleAddProductToCart = (prod, qty = 1, overrides = null) => {
    if (!prod) return false;
    const avail = parseFloat(prod.availableStock ?? prod.stock ?? 0) + heldFor(prod.id);
    if (avail <= 0) {
      showToast(`Out of Stock: ${prod.name} has 0 available inventory.`, 'error');
      return false;
    }
    const addQty = parseFloat(qty) || 1;
    setCartItems(prev => {
      const existingIdx = prev.findIndex(item => !isServiceLine(item) && (item.id === prod.id || item.code === prod.code) && !item.isFreeGift);
      if (existingIdx !== -1) {
        const next = [...prev];
        const line = next[existingIdx];
        next[existingIdx] = applyLineOverrides({ ...line, qty: (parseFloat(line.qty) || 0) + addQty }, overrides);
        return next;
      }
      return [...prev, applyLineOverrides(buildCartLine(prod, addQty), overrides)];
    });
    return true;
  };

  // A Service Master line — no stock, no batch; billed through the same grid / totals.
  const addServiceToCart = (svc, qty, overrides) => {
    setCartItems(prev => [...prev, {
      itemType: 'SERVICE',
      id: svc.id, barcode: svc.code, code: svc.code, sku: svc.code,
      name: svc.name, brand: '', category: 'SERVICE', modelNo: '', color: '', size: '', power: '',
      lensType: '', cylinder: '', axis: '', batch: '', expiry: '', hsn: '', image: '', unit: 'Nos',
      availableStock: null, qty: parseFloat(qty) || 1, freeQty: 0,
      rate: svc.price, priceTier: 'CUSTOM', discount: 0, gst: svc.gst,
      notes: svc.description || '', isFreeGift: false,
      ...overrides,
    }]);
  };

  // --- Product search ---------------------------------------------------------------------
  // Matches show inside the billing grid itself (in place of the cart lines while typing);
  // ↑/↓ moves the highlight and Enter adds the highlighted item to the bill (qty 1, list
  // price, master tax). Qty / price / disc / tax are then edited in the grid cells.
  const modeProducts = useMemo(() => {
    if (itemMode === 'service') return services;
    // No separate Lens tab on wholesale: the Product search covers every product, lenses included.
    if (itemMode === 'product') return products;
    return products.filter(p => (itemMode === 'lens' ? isLensProduct(p) : !isLensProduct(p)));
  }, [itemMode, products, services]);

  const searchMatches = useMemo(() => {
    const q = barcodeInput.trim().toLowerCase();
    if (!q) return [];
    return modeProducts.filter(p => [p.name, p.code, p.sku, p.barcode, p.brand, p.modelNo, p.color, p.size, p.category, p.description]
      .some(v => cellText(v) && String(v).toLowerCase().includes(q))).slice(0, 50);
  }, [barcodeInput, modeProducts]);

  const showSearchResults = searchOpen && Boolean(barcodeInput.trim());

  useEffect(() => { setMatchIndex(0); }, [barcodeInput, itemMode]);

  // Keep the highlighted result scrolled into view inside the grid (not the page) while arrowing.
  useEffect(() => {
    if (!showSearchResults) return;
    const row = document.querySelector(`[data-search-idx="${matchIndex}"]`);
    const box = row?.closest('.MuiTableContainer-root');
    if (!row || !box) return;
    const head = box.querySelector('thead')?.offsetHeight || 0;
    if (row.offsetTop - head < box.scrollTop) box.scrollTop = row.offsetTop - head;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [matchIndex, showSearchResults]);

  const clearSearch = () => {
    setBarcodeInput('');
    setSearchOpen(false);
  };

  // Enter-from-scanner guard: a scanner that sends CR+LF (or a bounced key) fires two Enters a few
  // ms apart for one scan. Two genuine scans of the same code are always further apart than this.
  // Times are the keypress's own event.timeStamp (same clock as performance.now()), so a slow
  // re-render that delays handling of the queued second Enter can't stretch the gap.
  const isDuplicateFire = (key, stamp = performance.now()) => {
    const now = stamp;
    const dup = lastAddRef.current.key === key && now - lastAddRef.current.at < 150;
    lastAddRef.current = { at: now, key };
    return dup;
  };

  // Adds one of the picked item to the bill. A pick from the search results puts the cursor
  // straight into that line's Qty cell; an exact barcode scan (toQty=false) stays in the
  // search box so the next code can be scanned at once.
  const addPickedItem = (item, mode = itemMode, stamp, toQty = true) => {
    if (!item) return;
    clearSearch();
    if (isDuplicateFire(`pick:${item.id}`, stamp)) return;
    // Row the item will land on: a product already in the cart gets its qty bumped in place.
    const existingIdx = mode === 'service' ? -1
      : cartItems.findIndex(line => !isServiceLine(line) && (line.id === item.id || line.code === item.code) && !line.isFreeGift);
    const rowIdx = existingIdx !== -1 ? existingIdx : cartItems.length;
    const added = mode === 'service' ? (addServiceToCart(item, 1, {}), true) : handleAddProductToCart(item, 1);
    if (added) showToast(`Added: ${item.name}`, 'success');
    setTimeout(() => {
      if (!(added && toQty && focusField(document.querySelector(`input[data-cell-row="${rowIdx}"][data-cell-col="qty"]`)))) focusSearch();
    }, 50);
  };

  const switchItemMode = (mode) => {
    setItemMode(mode);
    clearSearch();
    setTimeout(() => focusSearch(), 20);
  };

  const codeMatches = (p, c) => [p.barcode, p.code, p.sku].some(v => cellText(v) && String(v).toLowerCase() === c);
  const modeNoun = itemMode === 'service' ? 'service' : itemMode === 'lens' ? 'lens' : 'product';

  // "+ Add Item" — adds the highlighted search result (or an exact code typed in the box).
  const handleAddHighlighted = () => {
    const q = barcodeInput.trim();
    if (!q) { showToast('Type or scan in the search box first, then pick with ↑ / ↓.', 'info'); focusSearch(); return; }
    const c = q.toLowerCase();
    const exact = itemMode === 'service' ? services.find(p => codeMatches(p, c)) : products.find(p => codeMatches(p, c));
    const pick = exact || searchMatches[Math.min(matchIndex, searchMatches.length - 1)];
    if (pick) addPickedItem(pick, itemMode, undefined, !exact);
    else { showToast(`No ${modeNoun} matches "${q}".`, 'error'); focusSearch(); }
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Nothing to pick: ↓ drops into the last grid line's Qty cell.
      if (!barcodeInput.trim() && e.key === 'ArrowDown' && cartItems.length) {
        e.preventDefault();
        focusField(document.querySelector(`input[data-cell-row="${cartItems.length - 1}"][data-cell-col="qty"]`));
        return;
      }
      if (!searchMatches.length) return;
      e.preventDefault();
      if (!searchOpen) { setSearchOpen(true); return; }
      setMatchIndex(i => (e.key === 'ArrowDown' ? (i + 1) % searchMatches.length : (i - 1 + searchMatches.length) % searchMatches.length));
      return;
    }
    // PageUp / PageDown jump 8 results; Ctrl+Home / Ctrl+End go to the first / last one.
    const jump = { PageDown: 8, PageUp: -8 }[e.key] ?? (e.ctrlKey && e.key === 'Home' ? -Infinity : e.ctrlKey && e.key === 'End' ? Infinity : 0);
    if (jump && showSearchResults && searchMatches.length) {
      e.preventDefault();
      setMatchIndex(i => Math.max(0, Math.min(searchMatches.length - 1, i + jump)));
      return;
    }
    if (e.key === 'Escape') {
      if (searchOpen && barcodeInput) { e.preventDefault(); setSearchOpen(false); return; }
      if (barcodeInput) { e.preventDefault(); setBarcodeInput(''); }
      return; // nothing typed: the global Escape leaves the field
    }
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (e.repeat) return;
    const q = barcodeInput.trim();
    if (!q) {
      // The second half of a scanner's CR+LF (the code was already added) — stay put.
      if (e.timeStamp - lastAddRef.current.at < 400) return;
      if (cartItems.length) focusPayment();
      return;
    }
    const c = q.toLowerCase();
    // Exact barcode / SKU / code — add straight away and stay here so the next code can be
    // scanned at once. Checked across every product, not just this tab, so a scan never
    // depends on which tab happens to be open.
    const exact = itemMode === 'service' ? services.find(p => codeMatches(p, c)) : products.find(p => codeMatches(p, c));
    if (exact) { addPickedItem(exact, itemMode, e.timeStamp, false); return; }
    if (searchMatches.length) {
      if (!searchOpen) { setSearchOpen(true); return; } // results were hidden with Esc — show them again first
      addPickedItem(searchMatches[Math.min(matchIndex, searchMatches.length - 1)], itemMode, e.timeStamp);
      return;
    }
    showToast(`No ${modeNoun} matches "${q}".`, 'error');
  };

  // A scan that lands while the cursor is outside any text field (a button, the grid row, the
  // page) — same exact-code add as the search box, then the cursor goes back there.
  const handleOutOfFieldScan = (code) => {
    if (document.querySelector('.MuiModal-root:not(.MuiModal-hidden)')) return;
    if (!rootRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
    const c = code.toLowerCase();
    const hit = itemMode === 'service' ? services.find(p => codeMatches(p, c)) : products.find(p => codeMatches(p, c));
    focusSearch();
    if (!hit) { setBarcodeInput(code); setSearchOpen(true); return; }
    if (isDuplicateFire(`scan:${hit.id}`)) return;
    const added = itemMode === 'service' ? (addServiceToCart(hit, 1, {}), true) : handleAddProductToCart(hit, 1);
    if (added) showToast(`Added: ${hit.name}`, 'success');
  };
  useBarcodeScanner(handleOutOfFieldScan, { capture: true });

  // Re-pick the product created from "New Item" once the live catalogue includes it.
  useEffect(() => {
    const want = pendingNewItemRef.current;
    if (!want) return;
    const hit = products.find(p => (want.barcode && p.barcode === want.barcode) || (want.code && p.code === want.code));
    if (hit) { pendingNewItemRef.current = null; addPickedItem(hit, isLensProduct(hit) ? 'lens' : 'product'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  const handleUpdateItemQty = (index, deltaOrVal, isDirectValue = false) => {
    setCartItems(prev => {
      const next = [...prev];
      const target = next[index];
      if (!target) return prev;
      if (isDirectValue) {
        // Raw while typing (blank is allowed and flagged red); coerced to ≥ 1 on blur.
        next[index] = { ...target, qty: deltaOrVal === '' ? '' : Number(deltaOrVal) };
      } else {
        next[index] = { ...target, qty: Math.max(1, (parseFloat(target.qty) || 0) + deltaOrVal) };
      }
      return next;
    });
  };

  const tidyItemQty = (index) => {
    setCartItems(prev => prev.map((it, i) => (i === index && !(parseFloat(it.qty) >= 1) ? { ...it, qty: 1 } : it)));
  };

  // Per-line validation shown in the grid (red cell + tooltip) and enforced on Complete.
  const lineErrors = useMemo(() => cartItems.map(it => {
    const e = {};
    const qty = Number(it.qty);
    if (it.qty === '' || !Number.isFinite(qty) || qty < 1) e.qty = 'Quantity must be at least 1';
    const price = shownPrice(it);
    if (price === '' || price === undefined || !Number.isFinite(Number(price)) || Number(price) < 0) e.rate = 'Price must be 0 or more';
    const d = Number(it.discount);
    if (!it.isFreeGift && (!Number.isFinite(d) || d < 0 || d > 100)) e.disc = 'Discount must be 0 – 100%';
    const g = Number(it.gst);
    if (!Number.isFinite(g) || g < 0 || g > 100) e.gst = 'Tax must be 0 – 100%';
    return e;
  }), [cartItems]);

  const handleUpdateItemField = (index, field, value) => {
    setCartItems(prev => {
      const next = [...prev];
      const line = next[index];
      if (field === 'rate') {
        // The Unit Price cell holds the inclusive price on an inclusive line; `rate` is derived.
        next[index] = setLinePrice(line, value);
        if (!isServiceLine(line)) next[index].priceTier = 'CUSTOM';
      } else if (field === 'gst') {
        next[index] = setLineTax(line, value);
      } else {
        next[index] = { ...line, [field]: value };
      }
      return next;
    });
  };

  // Price choice menu: wholesale tier / dealer tier / retail / MRP. MRP is a tax-inclusive
  // figure, so picking it makes the line inclusive at exactly the MRP.
  const applyPriceChoice = (index, choice) => {
    setCartItems(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const moded = choice.inclusive ? setLineTaxMode(line, true) : line;
      return { ...setLinePrice(moded, choice.price), priceTier: choice.tier || 'CUSTOM' };
    }));
  };

  const setItemTaxMode = (index, inclusive) => {
    setCartItems(prev => prev.map((line, i) => (i === index ? setLineTaxMode(line, inclusive) : line)));
  };

  // Bill-level switch: every line's price read as incl. / excl. of tax (service lines too).
  const setAllTaxMode = (inclusive) => {
    setCartItems(prev => prev.map(line => setLineTaxMode(line, inclusive)));
  };

  const handleRemoveItem = (index) => {
    setCartItems(prev => prev.filter((_, i) => i !== index));
  };

  const resetSaleForm = () => {
    setCartItems([]);
    clearSearch();
    setSelectedRowIndex(-1);
    setCouponInput('');
    setCouponError('');
    setPreviewDoc(null);
    setInvoiceNo(newInvoiceNo());
    setAmountReceived('');
    setChargesList(ADDITIONAL_CHARGE_TYPES.map(name => ({ name, amount: '', taxable: false })));
    setRefNo('');
    setBankName('');
    setPayBankAccount('');
    setCashStatus(CASH_PAID);
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
    setEditing(null);
  };

  const handleClearCart = () => {
    resetSaleForm();
    showToast('POS Cart cleared.', 'info');
  };

  const handleHoldInvoice = () => {
    if (editing) {
      showToast(`${editing.invoiceNo} is a saved invoice being edited — save the changes or cancel the edit instead of holding it.`, 'warning');
      return;
    }
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
  // "Add New Dealer" — from the button, the dropdown's last option, "+" in an empty dealer
  // search, or Alt+N. Whatever was typed into the search pre-fills the phone or the name.
  const openNewDealer = (query = '') => {
    const q = String(query || '').trim();
    if (q) {
      const isPhone = /^[+\d][\d\s-]{5,}$/.test(q);
      setNewDealer({ ...NEW_DEALER_DEFAULTS, ...(isPhone ? { phone: q } : { name: q }) });
    }
    setNewDealerOpen(true);
  };

  const handleSelectCustomer = (val) => {
    setSelectedCustomer(val);
    setSalesRep(val?.salesExec || '');
    setInvoicePriceList('');
    setAddressEditUnlocked(false);
    setDelivery(prev => ({ ...prev, address: val?.shippingAddress || prev.address }));
  };

  // --- Discount / Scheme (F7) ---
  const handleApplyScheme = (payload) => {
    if (payload.type === 'BOGO') {
      const { buyProduct, buyQty, getProduct, getQty } = payload;
      const buyLine = cartItems.find(i => i.id === buyProduct.id && !i.isFreeGift);
      if (!buyLine || (parseFloat(buyLine.qty) || 0) < buyQty) {
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
    // Price / discount typed in the bulk grid ride along as line overrides (a changed price marks
    // the line CUSTOM, as in the billing grid).
    items.forEach(({ product, qty, rate, discount }) => {
      const overrides = {};
      if (rate !== undefined && canOverride) overrides.rate = rate;
      if (discount) overrides.discount = discount;
      handleAddProductToCart(product, qty, Object.keys(overrides).length ? overrides : null);
    });
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
      const live = isServiceLine(it) ? null : products.find(p => p.id === it.id || p.code === it.code);
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
          if (idx !== -1) next[idx] = { ...next[idx], qty: (parseFloat(next[idx].qty) || 0) + (parseFloat(r.qty) || 0) };
          else next.push(r);
        });
        return next;
      });
      showToast(`Reordered items from ${order.invoiceNo}.`, 'success');
    }
    setPrevOrdersOpen(false);
  };

  const handleViewOrder = (order) => { setPrintableInvoice(order); setPrintModalOpen(true); };

  // Loads a saved invoice into the POS form for correction. The server copy is read fresh (the
  // cache may be stale), a billed invoice is gated by the module's edit permission (admin
  // approval when Direct Edit is off), and the lines it already holds count as available stock.
  async function startEditInvoice(ref, { preChecked = false } = {}) {
    const number = typeof ref === 'string' ? ref : ref?.invoiceNo;
    if (!number || loadingEdit) return;
    if (editing?.invoiceNo === number) { showToast(`${number} is already open for editing.`, 'info'); return; }
    if (cartItems.length && !window.confirm(`Discard ${editing ? `the unsaved changes to ${editing.invoiceNo}` : 'the current cart'} and open ${number} for editing?`)) return;
    setLoadingEdit(true);
    try {
      let inv = null;
      try {
        const { data } = await axios.get(`${WHOLESALE_API}/invoices/`, { params: { invoice_number: number }, __silentError: true });
        const row = (Array.isArray(data) ? data : data?.results || [])[0];
        if (row) {
          inv = invoiceFromApi(row, Object.fromEntries(customers.filter(c => c?.id).map(c => [c.id, c])));
          const cached = readLS(LS_KEYS.invoices, []).find(x => x.invoiceNo === number);
          if (cached?.attachments?.some(a => a.dataUrl)) inv.attachments = cached.attachments;
          cacheInvoice(inv);
          setInvoicesVersion(v => v + 1);
        }
      } catch (e) {
        showToast(`Could not load ${number} from the server — saved invoices can only be edited online.`, 'error');
        return;
      }
      if (!inv) { showToast(`Invoice ${number} was not found on the server.`, 'error'); return; }
      if (inv.status === 'Cancelled' || inv.orderStatus === 'Cancelled') { showToast(`${number} is cancelled and can't be edited.`, 'warning'); return; }
      if (inv.stockReturned) { showToast(`${number} was ${String(inv.stockReturned).toLowerCase()} — its stock is back on the shelf, so it can't be edited.`, 'warning'); return; }
      if (!(inv.items || []).length) { showToast(`${number} has no saved line items (an old record) — it can't be edited here.`, 'warning'); return; }
      const ed = editStateOf(inv);
      // preChecked: the caller (Wholesale Reports) already ran the same check; the server
      // re-checks on save either way.
      if (!ed.isDraft && !preChecked) {
        const allowed = await ensureEditAccess({ module: 'wholesale', recordId: inv.backendId, recordRef: number });
        if (!allowed) return;
      }
      applyInvoiceToForm(inv, ed);
    } finally {
      setLoadingEdit(false);
    }
  }

  function applyInvoiceToForm(inv, ed) {
    const dealer = customers.find(c => c.id === inv.customer?.id || (inv.customer?.code && c.code === inv.customer.code)) || inv.customer;
    setSelectedCustomer(dealer);
    setSalesRep(inv.salesExecutive || dealer?.salesExec || '');
    setInvoicePriceList(inv.priceList && inv.priceList !== dealer?.priceList ? inv.priceList : '');
    setAddressEditUnlocked(false);
    setCartItems(inv.items.map(({ taxPercent, total, ...line }) => {
      if (isServiceLine(line)) return line;
      const live = products.find(p => p.id === line.id || (line.code && p.code === line.code));
      const stock = live ? parseFloat(live.availableStock ?? live.stock ?? 0) + (ed.heldUnits[line.id] || 0) : line.availableStock;
      return { ...line, availableStock: stock };
    }));
    clearSearch();
    setSelectedRowIndex(-1);
    setNotesOpenIdx(-1);
    setPreviewDoc(null);
    setInvoiceNo(inv.invoiceNo);
    const blankCharges = ADDITIONAL_CHARGE_TYPES.map(name => ({ name, amount: '', taxable: false }));
    if (Array.isArray(inv.chargesList)) {
      setChargesList(blankCharges.map(c => ({ ...c, ...(inv.chargesList.find(x => x.name === c.name) || {}) })));
    } else {
      // Invoices saved before the charge rows were kept only carry the taxable / untaxed totals.
      const taxable = parseFloat(inv.summary?.taxableCharges) || 0;
      const untaxed = parseFloat(inv.summary?.nonTaxableCharges) || 0;
      setChargesList(blankCharges.map(c => {
        if (c.name === 'Other Charge' && (taxable || untaxed)) return taxable ? { ...c, amount: String(taxable), taxable: true } : { ...c, amount: String(untaxed) };
        if (c.name === 'Delivery Charge' && taxable && untaxed) return { ...c, amount: String(untaxed) };
        return c;
      }));
    }
    setInvoiceDiscount(inv.invoiceDiscount || null);
    setCouponInput(inv.invoiceDiscount?.couponCode || '');
    setCouponError('');
    setReferenceNo(inv.referenceNo || '');
    setPoNumber(inv.poNumber || '');
    if (inv.warehouseId) setSelectedWarehouseId(String(inv.warehouseId));
    setDelivery({ type: 'Pickup', address: '', expectedDate: '', courierName: '', trackingNo: '', notes: '', ...(inv.delivery || {}) });
    setPacking({ packages: '', weight: '', packedBy: '', packingDate: '', ...(inv.packing || {}) });
    setNotesState({ customer: '', internal: '', ...(inv.notes && typeof inv.notes === 'object' ? inv.notes : {}) });
    setAttachments(inv.attachments || []);
    setOrderStatus(ed.isDraft ? 'Confirmed' : (inv.orderStatus || 'Confirmed'));
    setPayMode(PAY_MODE_BUTTONS.some(([v]) => v === inv.payMode) ? inv.payMode : 'Cash');
    setCreditDays(inv.creditDays || 30);
    setRefNo(inv.refNo || '');
    setBankName(inv.bankName || '');
    setPayBankAccount(inv.bankAccount || '');
    setCashStatus(inv.cashStatus || CASH_PAID);
    setSplitPayments(inv.splitPayments?.length ? inv.splitPayments : [{ mode: 'Cash', amount: '' }]);
    setAmountReceived(ed.isDraft ? '' : String(ed.originalPaid || ''));
    setEditing(ed);
    setPrevOrdersOpen(false);
    setPrintModalOpen(false);
    showToast(ed.isDraft ? `Draft ${inv.invoiceNo} opened — complete it to bill it.` : `Editing ${inv.invoiceNo} — change lines, quantities or prices, then save with Ctrl+Enter.`, 'info');
    setTimeout(() => focusGrid(), 120);
  }

  const cancelEdit = () => {
    if (!editing) return;
    const no = editing.invoiceNo;
    resetSaleForm();
    showToast(`Edit of ${no} cancelled — nothing was changed.`, 'info');
    setTimeout(() => focusSearch(), 60);
  };

  // While editing, keep each line's "available" figure = live stock + what this invoice holds.
  useEffect(() => {
    if (!editing || !products.length) return;
    setCartItems(prev => {
      let changed = false;
      const next = prev.map(line => {
        if (isServiceLine(line)) return line;
        const live = products.find(p => p.id === line.id || (line.code && p.code === line.code));
        if (!live) return line;
        const avail = parseFloat(live.availableStock ?? live.stock ?? 0) + heldFor(line.id);
        if (avail === line.availableStock) return line;
        changed = true;
        return { ...line, availableStock: avail };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, editing]);

  // Deep links: ?edit=<invoice no> (Wholesale Reports → Edit Bill) and ?dealer=<id> (Dealers
  // master → New Sale). Read once the dealer list is in, then dropped from the URL.
  const deepLinkDoneRef = useRef('');
  useEffect(() => {
    if (dealersLoading) return;
    const params = new URLSearchParams(location.search);
    const editNo = params.get('edit');
    const dealerId = params.get('dealer');
    if (!editNo && !dealerId) return;
    const key = location.search;
    if (deepLinkDoneRef.current === key) return;
    deepLinkDoneRef.current = key;
    navigate(location.pathname, { replace: true });
    if (editNo) { startEditInvoice(editNo, { preChecked: params.get('checked') === '1' }); return; }
    const d = customers.find(c => String(c.id) === dealerId);
    if (d && !editing) { handleSelectCustomer(d); setTimeout(() => focusSearch(), 60); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, dealersLoading]);

  // Ctrl+Enter / "Complete Wholesale Invoice": validate everything, then ask to confirm (the
  // confirm dialog also carries the credit-limit override). Never runs twice at once.
  function validateForCompletion() {
    if (!selectedCustomer) return { msg: 'Please select a wholesale dealer first (F1).', focus: 'ws-dealer-search' };
    if (cartItems.length === 0) return { msg: 'The cart is empty. Add products to complete the invoice.', focus: 'ws-product-search' };
    const badIdx = lineErrors.findIndex(e => Object.keys(e).length > 0);
    if (badIdx !== -1) {
      const [col, msg] = Object.entries(lineErrors[badIdx])[0];
      return { msg: `Line ${badIdx + 1} (${cartItems[badIdx].name}): ${msg}.`, cell: { row: badIdx, col } };
    }
    if (!selectedWarehouseId && warehouses.length > 0) return { msg: 'Please select a warehouse before completing the sale.', focus: 'ws-warehouse' };
    const overStock = cartItems.find(i => !isServiceLine(i) && !i.isFreeGift && ((parseFloat(i.qty) || 0) + (parseFloat(i.freeQty) || 0)) > (parseFloat(i.availableStock) || 0));
    if (overStock && !canOverride) return { msg: `${overStock.name}: quantity exceeds available stock (${overStock.availableStock}). Only Managers/Admins can override.` };
    const expiredLine = cartItems.find(i => isExpired(i.expiry));
    if (expiredLine && !canOverride) return { msg: `${expiredLine.name} has expired stock (batch ${expiredLine.batch || '—'}). Only Managers/Admins can override an expired sale.` };
    if (delivery.type !== 'Pickup' && !String(delivery.address || '').trim()) return { msg: 'Please provide a shipping address for this delivery method (Alt+D).', focus: 'ws-ship-address' };
    if (payMode === 'Split Payment' && Math.abs(splitTotal - summary.grandTotal) > 0.5) {
      return { msg: `Split payment total (₹${splitTotal.toFixed(2)}) must equal the Net Payable (₹${summary.grandTotal.toFixed(2)}).`, focus: 'ws-pay-mode' };
    }
    if (payMode === 'Cash' && amountReceived !== '' && !(parseFloat(amountReceived) >= 0)) return { msg: 'Amount Paid must be a number of 0 or more.', focus: 'ws-amount-paid' };
    return null;
  }

  function handleAttemptCompleteSale(opts) {
    if (submittingRef.current || savingInvoice || completeConfirmOpen) return;
    printAfterSaveRef.current = opts?.print === true;
    const problem = validateForCompletion();
    if (problem) {
      showToast(problem.msg, 'error');
      if (problem.cell) setTimeout(() => focusField(document.querySelector(`input[data-cell-row="${problem.cell.row}"][data-cell-col="${problem.cell.col}"]`)), 30);
      else if (problem.focus) setTimeout(() => focusById(problem.focus), 30);
      return;
    }
    setCompleteConfirmOpen(true);
  }

  function buildInvoiceObject(status) {
    // An edited invoice keeps its own date (and server row); a new one is dated today.
    const invoiceDate = editing?.date || new Date().toISOString().split('T')[0];
    const paid = paymentCalc.paidNow;

    return {
      ...(editing?.backendId ? { backendId: editing.backendId } : {}),
      id: invoiceNo,
      invoiceNo,
      date: invoiceDate,
      dueDate: paymentCalc.dueAmount > 0.009 ? dueDate : '',
      customer: selectedCustomer,
      // Cells may still hold half-typed text ("12."); the saved line always carries numbers.
      items: cartItems.map(it => {
        const line = { ...it };
        ['rate', 'inclRate', 'discount', 'gst'].forEach(k => { if (typeof line[k] === 'string' && line[k] !== '') line[k] = Number(line[k]) || 0; });
        return { ...line, taxPercent: line.gst, total: computeLineTotals(line).total };
      }),
      summary,
      payMode,
      splitPayments: payMode === 'Split Payment' ? splitPayments : undefined,
      refNo,
      bankName: needsBank(payMode) ? (bankNameOf(banks, payBankAccount) || bankName) : bankName,
      bankAccount: needsBank(payMode) ? (payBankAccount || null) : null,
      cashStatus: payMode === 'Cash' ? cashStatus : undefined,
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
      // The typed charge rows, so an edit reopens them as entered (summary only has the totals).
      chargesList: chargesList.filter(c => parseFloat(c.amount) > 0),
    };
  }

  // Ctrl+P / "Show Bill": preview the cart as it stands (not saved), or — with an empty cart —
  // the last completed invoice.
  function handleShowBill() {
    if (cartItems.length) {
      setPreviewDoc({ ...buildInvoiceObject('Draft'), status: 'Preview' });
      setPrintModalOpen(true);
    } else if (printableInvoice) {
      setPreviewDoc(null);
      setPrintModalOpen(true);
    } else {
      showToast('Add items to preview the bill.', 'warning');
    }
  }

  // Save Draft (Ctrl+S) — persists the invoice as a Draft without touching stock, dealer
  // outstanding or the financial ledger. The cart is left as-is so work can continue.
  async function handleSaveDraft() {
    if (cartItems.length === 0) {
      showToast('Cannot save an empty invoice as draft.', 'warning');
      return;
    }
    if (paymentLocked) {
      // Turning a billed invoice back into a draft would reverse its stock and accounts.
      showToast(`${editing.invoiceNo} is already billed — save the changes with Complete (Ctrl+Enter), or cancel the edit.`, 'warning');
      return;
    }
    const dealer = await ensureBackendDealer(selectedCustomer);
    const draft = { ...buildInvoiceObject('Draft'), customer: dealer };
    const { invoice, synced, refused } = await persistInvoice(draft);
    if (refused) { showToast(`Draft not saved: ${refused}`, 'error'); return; }
    if (synced && invoice.backendId) {
      // Carry on in that draft: a later Save Draft / Complete updates it rather than adding a
      // second invoice next to it.
      setEditing(editStateOf(invoice));
    } else {
      setInvoiceNo(newInvoiceNo()); // offline: the draft keeps its number; the live cart gets a fresh one
    }
    showToast(synced ? `Draft saved as ${invoice.invoiceNo}.` : `Draft ${invoice.invoiceNo} saved on this device only — the server could not be reached; it will upload automatically.`, synced ? 'success' : 'warning');
  }

  // A dealer picked from the offline cache / demo list has no server id, and an invoice row
  // needs a real Dealer FK — register it first. Returns the (possibly re-keyed) dealer, or the
  // original one if the server is unreachable.
  async function ensureBackendDealer(dealer) {
    if (!dealer || isUuid(dealer.id)) return dealer;
    try {
      const res = await axios.post(`${WHOLESALE_API}/dealers/`, mapDealerToApi({ ...dealer, code: dealer.code || `DL-${Math.floor(1000 + Math.random() * 9000)}` }));
      const registered = { ...dealer, ...mapDealerFromApi(res.data), billingAddress: dealer.billingAddress, shippingAddress: dealer.shippingAddress, outstanding: parseFloat(dealer.outstanding) || 0 };
      setCustomers(prev => {
        const next = prev.map(c => (c.id === dealer.id ? registered : c));
        writeLS(LS_KEYS.customers, next);
        return next;
      });
      setSelectedCustomer(prev => (prev && prev.id === dealer.id ? registered : prev));
      return registered;
    } catch (e) {
      return dealer;
    }
  }

  // Saves the invoice to the database (WholesaleInvoice + details) and the local cache. When the
  // server is unreachable it is cached with pendingSync and uploaded on the next sync. A save the
  // server refuses (e.g. not enough stock) comes back as `refused` and is NOT cached — retrying
  // it offline would only be refused again. The server moves the stock on every save.
  async function persistInvoice(inv) {
    let invoice = inv;
    let synced = false;
    try {
      invoice = await saveInvoiceToBackend(axios, inv);
      synced = true;
    } catch (e) {
      const status = e?.response?.status;
      if (status >= 400 && status < 500) {
        const d = e.response.data;
        return { invoice: inv, synced: false, refused: (typeof d?.detail === 'string' && d.detail) || describeApiError(e, 'The server refused this invoice.') };
      }
      // A change to an invoice already on the server can't wait offline: the next sync takes the
      // server's copy, which would silently drop the edit.
      if (inv.backendId) {
        return { invoice: inv, synced: false, refused: 'the server could not be reached, so the changes were not saved. Try again when the connection is back.' };
      }
      invoice = { ...inv, pendingSync: true };
    }
    cacheInvoice(invoice, inv.invoiceNo);
    setInvoicesVersion(v => v + 1);
    return { invoice, synced };
  }

  // Complete Sale Execution
  async function executeCompleteSale() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setCompleteConfirmOpen(false);
    setSavingInvoice(true);
    try {
      await runCompleteSale();
    } finally {
      submittingRef.current = false;
      setSavingInvoice(false);
    }
  }

  // Saving an edited (already billed) invoice: PATCH it in place. The server re-checks the edit
  // permission, moves only the stock difference and re-posts the invoice journal; receipts
  // already recorded stay as they are, so the dealer's balance moves by the change in what's due.
  async function runSaveEdit() {
    const dealer = selectedCustomer;
    const built = { ...buildInvoiceObject(orderStatus === 'Draft' ? 'Confirmed' : orderStatus), customer: dealer };
    const overStock = cartItems.some(i => !isServiceLine(i) && ((parseFloat(i.qty) || 0) + (parseFloat(i.freeQty) || 0)) > (parseFloat(i.availableStock) || 0));
    if (overStock && canOverride) built.overrideNegativeStock = true;
    const { invoice: saved, refused } = await persistInvoice(built);
    if (refused) {
      showToast(`Changes to ${built.invoiceNo} not saved: ${refused}`, 'error');
      return;
    }
    window.dispatchEvent(new Event('optical_stock_updated'));
    const dueDelta = (parseFloat(saved.dueAmount) || 0) - editing.originalDue;
    if (Math.abs(dueDelta) > 0.009) adjustDealerOutstanding(dealer, dueDelta);
    setPrintableInvoice(saved);
    setCompletionOpen(true);
    if (printAfterSaveRef.current) {
      printAfterSaveRef.current = false;
      printBill({ doc: saved, documentType: 'WHOLESALE_BILL' }).then((opened) => {
        if (!opened) { showToast('Print pop-up was blocked — opening the print preview instead.', 'warning'); setPrintModalOpen(true); }
      });
    }
    resetSaleForm();
    const totalDelta = (parseFloat(saved.summary?.grandTotal) || 0) - editing.originalTotal;
    showToast(`Invoice ${saved.invoiceNo} updated${Math.abs(totalDelta) > 0.009 ? ` — total ${totalDelta > 0 ? 'up' : 'down'} ${fmtINR(Math.abs(totalDelta))}` : ''}.`, 'success');
  }

  async function runCompleteSale() {
    if (paymentLocked) { await runSaveEdit(); return; }
    const dealer = await ensureBackendDealer(selectedCustomer);
    const built = { ...buildInvoiceObject(orderStatus === 'Draft' ? 'Confirmed' : orderStatus), customer: dealer };
    // A Manager/Admin may knowingly sell past the stock on hand (validateForCompletion).
    const overStock = cartItems.some(i => !isServiceLine(i) && ((parseFloat(i.qty) || 0) + (parseFloat(i.freeQty) || 0)) > (parseFloat(i.availableStock) || 0));
    if (overStock && canOverride) built.overrideNegativeStock = true;

    // Save the invoice itself first, so its number is final (a clash is renumbered) before the
    // receipt below references it. Saving it also deducts the stock on the server.
    const { invoice: completedInvoice, synced, refused } = await persistInvoice(built);
    if (refused) {
      showToast(`Sale not completed: ${refused}`, 'error');
      return;
    }
    const invoiceNo = completedInvoice.invoiceNo;
    const invoiceDate = completedInvoice.date;

    // 1. Inventory: the server deducted qty + free qty when the invoice saved (or will, when an
    // offline save uploads). Mirror it locally for instant feedback, then reload live stock.
    const stockLines = cartItems.filter(item => !isServiceLine(item));
    const updatedProducts = products.map(p => {
      const matchInCart = stockLines.find(item => item.id === p.id || item.code === p.code);
      if (matchInCart) {
        const units = computeLineTotals(matchInCart).stockUnits;
        const newStock = Math.max(0, (parseFloat(p.availableStock ?? p.stock ?? 0) - units));
        return { ...p, availableStock: newStock, stock: newStock };
      }
      return p;
    });
    setProducts(updatedProducts);
    writeLS(LS_KEYS.inventory, updatedProducts);

    if (synced) window.dispatchEvent(new Event('optical_stock_updated'));

    // 2. Update Dealer Ledger — locally for instant UI feedback, and best-effort against the
    // real Dealer record (PATCH outstanding_balance) so it stays correct system-wide.
    const newOutstanding = parseFloat(dealer.outstanding || 0) + completedInvoice.dueAmount;
    const updatedCustomers = customers.map(c => {
      if (c.id === dealer.id || c.code === dealer.code) {
        // `customers` predates ensureBackendDealer's re-keying, so carry the server id over.
        return { ...c, id: dealer.id, outstanding: newOutstanding, lastPurchaseDate: invoiceDate };
      }
      return c;
    });
    setCustomers(updatedCustomers);
    writeLS(LS_KEYS.customers, updatedCustomers);
    const currentUpdatedCust = updatedCustomers.find(c => c.id === dealer.id || c.code === dealer.code);
    if (currentUpdatedCust) setSelectedCustomer(currentUpdatedCust);
    if (isUuid(dealer.id)) {
      try { await axios.patch(`${WHOLESALE_API}/dealers/${dealer.id}/`, { outstanding_balance: newOutstanding }); } catch (e) {}
    }

    // 3. Accounting: nothing to do here. The backend books the saved WholesaleInvoice, the
    // collection below and the stock it moved (COGS / Inventory) into the ledger (apps/financial).

    // 4. Receipt for the amount collected at the counter (the invoice row itself was saved above).
    // A split is one receipt per mode (each posted to its own Cash / Bank / UPI account; Credit
    // rows are owed, not collected); any other mode is a single receipt.
    if (isUuid(dealer.id) && completedInvoice.amountReceived > 0) {
      const receipts = payMode === 'Split Payment'
        ? (completedInvoice.splitPayments || [])
            .filter(sp => sp.mode !== 'Credit' && (parseFloat(sp.amount) || 0) > 0)
            .map(sp => ({ mode: sp.mode, amount: parseFloat(sp.amount), bank: needsBank(sp.mode) ? (sp.bankAccount || null) : null }))
        : [{ mode: payMode, amount: completedInvoice.amountReceived, bank: completedInvoice.bankAccount || null }];
      for (const r of receipts) {
        try {
          await axios.post(`${WHOLESALE_API}/collections/`, {
            receipt_number: `RCPT-${Math.floor(100000 + Math.random() * 900000)}`, dealer: dealer.id,
            invoice_number: invoiceNo, payment_date: invoiceDate, payment_method: r.mode,
            amount_paid: r.amount, reference_note: refNo || '', bank_account: r.bank,
          });
        } catch (e) {}
      }
    }

    // 5. Open Completion / Print

    setPrintableInvoice(completedInvoice);
    setCompletionOpen(true);
    if (printAfterSaveRef.current) {
      printAfterSaveRef.current = false;
      printBill({ doc: completedInvoice, documentType: 'WHOLESALE_BILL' }).then((opened) => {
        if (!opened) {
          showToast('Print pop-up was blocked — opening the print preview instead.', 'warning');
          setPrintModalOpen(true);
        }
      });
    }
    resetSaleForm();
    if (synced) showToast(`Wholesale Sale Completed! Invoice #${invoiceNo} posted.`, 'success');
    else showToast(`Invoice #${invoiceNo} completed but saved on this device only — the server could not be reached; it will upload automatically.`, 'warning');
  }

  // --- More Actions: Cancel / Return / Replacement / Credit Note (operate on the last completed invoice) ---
  // The server restores the stock when the invoice is saved as Cancelled / stockReturned
  // (apps/sales/wholesale_stock.py); this only mirrors it locally for instant feedback.
  function restockInvoiceItems(invoice) {
    const stockItems = (invoice.items || []).filter(item => !isServiceLine(item));
    const updatedProducts = products.map(p => {
      const match = stockItems.find(item => item.id === p.id || item.code === p.code);
      if (match) {
        const newStock = (parseFloat(p.availableStock ?? p.stock ?? 0) + computeLineTotals(match).stockUnits);
        return { ...p, availableStock: newStock, stock: newStock };
      }
      return p;
    });
    setProducts(updatedProducts);
    writeLS(LS_KEYS.inventory, updatedProducts);
    window.dispatchEvent(new Event('optical_stock_updated'));
  }

  // Returns false when the server refused the change (the caller should stop).
  async function updateInvoiceInStorage(invoiceNo, patch) {
    const all = readLS(LS_KEYS.invoices, []);
    const current = all.find(inv => inv.invoiceNo === invoiceNo) || (printableInvoice?.invoiceNo === invoiceNo ? printableInvoice : null);
    if (!current) return true;
    const { synced, refused } = await persistInvoice({ ...current, ...patch });
    if (refused) { showToast(`Invoice ${invoiceNo} was not updated: ${refused}`, 'error'); return false; }
    if (!synced) showToast(`Invoice ${invoiceNo} updated on this device only — it will upload when the server is reachable.`, 'warning');
    return true;
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

  // Prints the latest return / credit note recorded against this invoice with the template
  // assigned to SALES_RETURN (Settings → Bill & Invoice Designer). Uses the record as stored.
  function printLastReturn() {
    if (!printableInvoice) return;
    const rec = readLS(LS_KEYS.returns, []).find((r) => r.invoiceNo === printableInvoice.invoiceNo);
    if (!rec) { showToast(`No return or credit note has been recorded for ${printableInvoice.invoiceNo} on this device.`, 'info'); return; }
    printBill({
      documentType: 'SALES_RETURN',
      doc: { ...rec, invoiceNo: rec.invoiceNo, summary: { grandTotal: rec.amount }, action_taken: rec.reason },
    }).then((opened) => { if (!opened) showToast('Allow pop-ups to print the credit note.', 'warning'); });
  }

  async function handleCancelInvoice() {
    if (!printableInvoice) return;
    setCancelInvoiceConfirmOpen(false);
    if (!await updateInvoiceInStorage(printableInvoice.invoiceNo, { orderStatus: 'Cancelled', status: 'Cancelled' })) return;
    restockInvoiceItems(printableInvoice);
    if (printableInvoice.dueAmount > 0) adjustDealerOutstanding(printableInvoice.customer, -printableInvoice.dueAmount);
    showToast(`Invoice ${printableInvoice.invoiceNo} cancelled and stock restored.`, 'success');
  }

  async function handleSalesReturn() {
    if (!printableInvoice) return;
    if (!await updateInvoiceInStorage(printableInvoice.invoiceNo, { stockReturned: 'Returned' })) return;
    restockInvoiceItems(printableInvoice);
    if (printableInvoice.dueAmount > 0) adjustDealerOutstanding(printableInvoice.customer, -printableInvoice.dueAmount);
    const record = await postWholesaleReturn(printableInvoice, printableInvoice.summary?.grandTotal, '', 'Stock Return');
    setReturnConfirmOpen(false);
    showToast(`Sales return ${record.returnNo} processed for invoice ${printableInvoice.invoiceNo}.`, 'success');
  }

  // Replacement: restock the original invoice's items (same as a return) and immediately open
  // a fresh cart for the same dealer so the replacement products can be picked and billed.
  async function handleReplacement() {
    if (!printableInvoice) return;
    if (!await updateInvoiceInStorage(printableInvoice.invoiceNo, { stockReturned: 'Replaced' })) return;
    restockInvoiceItems(printableInvoice);
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
  async function handleRecordPayment({ amount, mode, refNo: recRef, bankAccount }) {
    if (!selectedCustomer) return;
    const receiptNo = `RCPT-${Math.floor(100000 + Math.random() * 900000)}`;
    const date = new Date().toISOString().split('T')[0];
    let offline = false;
    if (isUuid(selectedCustomer.id)) {
      try {
        await axios.post(`${WHOLESALE_API}/collections/`, {
          receipt_number: receiptNo, dealer: selectedCustomer.id, payment_date: date,
          payment_method: mode, amount_paid: amount, reference_note: recRef || '', bank_account: bankAccount || null,
        }, { __silentError: true });
      } catch (e) {
        if (e?.response) {
          // The server refused it (validation, permission…): nothing was recorded anywhere.
          showToast(`Payment was NOT recorded: ${describeApiError(e)}`, 'error');
          return;
        }
        offline = true;  // unreachable: keep the local receipt, as this screen does offline
      }
    }
    const payments = readLS(LS_KEYS.payments, []);
    writeLS(LS_KEYS.payments, [{ id: receiptNo, receiptNo, date, customer: selectedCustomer, amount, mode, refNo: recRef }, ...payments]);
    adjustDealerOutstanding(selectedCustomer, -amount);
    setRecordPaymentOpen(false);
    showToast(offline
      ? `Payment of ₹${amount.toLocaleString('en-IN')} kept on this device only (${receiptNo}) — the server could not be reached.`
      : `Payment of ₹${amount.toLocaleString('en-IN')} recorded (${receiptNo}).`, offline ? 'warning' : 'success');
  }

  // The trailing "Add New Dealer" row keeps dealer creation reachable with ArrowDown + Enter.
  const dealerSearchFilter = (opts, state) => {
    const addNew = { __addNew: true, query: state.inputValue.trim() };
    const q = state.inputValue.trim().toLowerCase();
    if (!q) return [...opts, addNew];
    return [...opts.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.code || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.gstin || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    ), addNew];
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

  // Coupon Code — there is no coupon master in the backend; a code is matched against the
  // configured Discounts / Schemes (by code, name or id) and applied as that scheme.
  const handleApplyCoupon = () => {
    const code = couponInput.trim().toLowerCase();
    if (!code) { setCouponError('Enter a coupon code'); return; }
    const scheme = schemes.find(sc => [sc.code, sc.name, sc.id].some(v => v && String(v).trim().toLowerCase() === code));
    if (!scheme) { setCouponError('No scheme matches this code'); showToast(`Coupon "${couponInput.trim()}" doesn't match any configured scheme (Ctrl+D lists them).`, 'error'); return; }
    if (!isSchemeActive(scheme)) { setCouponError('Scheme is outside its date range'); return; }
    setCouponError('');
    setInvoiceDiscount({ type: 'SCHEME', schemeId: scheme.id, couponCode: couponInput.trim(), label: `Coupon ${couponInput.trim()} — ${scheme.name}`, value: parseFloat(scheme.value) || 0, valueKind: scheme.type === 'FIXED' ? 'FIXED' : 'PERCENT' });
    showToast(`Coupon applied: ${scheme.name}.`, 'success');
  };

  const focusPayment = () => {
    const btn = document.querySelector('#ws-pay-mode button[aria-pressed="true"]');
    btn?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    btn?.focus({ preventScroll: true });
  };
  const focusDelivery = () => {
    const btn = document.querySelector('[data-delivery-type][data-nav-stop]');
    btn?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    btn?.focus({ preventScroll: true });
  };
  const focusGrid = () => {
    if (!cartItems.length) { showToast('The bill is empty — search or scan an item first.', 'info'); focusSearch(); return; }
    const row = selectedRowIndex >= 0 && selectedRowIndex < cartItems.length ? selectedRowIndex : cartItems.length - 1;
    focusField(document.querySelector(`input[data-cell-row="${row}"][data-cell-col="qty"]`));
  };

  // --- Centralized keyboard shortcuts (map + help text: wholesale/posShortcuts.js) ---
  useWholesaleShortcuts(rootRef, {
    dealerSearch: () => focusById('ws-dealer-search'),
    newDealer: () => openNewDealer(),
    changeDealer: () => {
      if (paymentLocked) { showToast("The dealer of a billed invoice can't be changed while editing it.", 'warning'); return; }
      focusById('ws-dealer-search');
      // Open the dealer list (ArrowDown is how the Autocomplete opens from the keyboard).
      setTimeout(() => document.getElementById('ws-dealer-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })), 30);
    },
    tabProduct: () => switchItemMode('product'),
    productSearch: () => focusSearch(),
    grid: () => focusGrid(),
    bulkAdd: () => setBulkAddOpen(true),
    excelImport: () => setExcelImportOpen(true),
    schemes: () => setSchemeOpen(true),
    reorderLast: () => {
      if (dealerOrders.length > 0) applyOrderToCart(dealerOrders[0], 'reorder');
      else showToast(selectedCustomer ? 'This dealer has no previous invoice to reorder.' : 'Select a dealer first.', 'warning');
    },
    cyclePriceList: () => cyclePriceList(),
    removeRow: () => {
      if (!(selectedRowIndex >= 0)) return false; // nothing selected — let Delete do its normal thing
      requestRemoveRow(selectedRowIndex);
      return true;
    },
    coupon: () => focusById('ws-coupon'),
    payment: () => focusPayment(),
    preview: () => handleShowBill(),
    complete: () => handleAttemptCompleteSale(),
    saveDraft: () => handleSaveDraft(),
    hold: () => handleHoldInvoice(),
    delivery: () => focusDelivery(),
    packing: () => {
      setPackingOpen(true);
      setTimeout(() => focusById('ws-pack-packages'), 260); // after the Collapse opens
    },
    escape: (e) => {
      // Esc in a grid cell leaves the cell but keeps its line selected, so Delete can remove it;
      // a second Esc clears the selection.
      if (e.target?.hasAttribute?.('data-cell-col')) { e.target.blur(); return true; }
      if (selectedRowIndex >= 0) { setSelectedRowIndex(-1); return true; }
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') { e.target.blur(); return true; }
      return false;
    },
    help: () => setHelpOpen(true),
  });

  // Billing grid cells: Enter → next editable cell (last one → back to the search),
  // Shift+Enter → previous, ↑/↓ → same column in the row above/below, +/− in Qty steps the
  // quantity, Ctrl+Delete removes the line.
  const handleGridKeyDown = (e) => {
    const el = e.target;
    const row = Number(el.getAttribute?.('data-cell-row'));
    const col = el.getAttribute?.('data-cell-col');
    if (!col || !(row >= 0)) return;
    const cell = (r, c) => {
      const t = document.querySelector(`input[data-cell-row="${r}"][data-cell-col="${c}"]`);
      return t && !t.disabled ? t : null;
    };
    if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); requestRemoveRow(row); return; }
    if (col === 'qty' && !e.ctrlKey && !e.altKey && ['+', '=', '-', '_'].includes(e.key)) {
      e.preventDefault();
      handleUpdateItemQty(row, e.key === '+' || e.key === '=' ? 1 : -1);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const target = cell(row + (e.key === 'ArrowDown' ? 1 : -1), col);
      if (target) focusField(target);
      else if (e.key === 'ArrowUp') focusSearch();
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (e.repeat) return;
      const cols = GRID_COLS.filter(c => cell(row, c));
      const i = cols.indexOf(col);
      if (e.shiftKey) {
        if (i > 0) focusField(cell(row, cols[i - 1]));
        else if (row > 0) { const prevCols = GRID_COLS.filter(c => cell(row - 1, c)); focusField(cell(row - 1, prevCols[prevCols.length - 1])); }
        else focusSearch();
      } else if (i < cols.length - 1) focusField(cell(row, cols[i + 1]));
      else focusSearch();
    }
  };

  const dealerLocation = selectedCustomer
    ? ([selectedCustomer.city, selectedCustomer.state, selectedCustomer.pincode].filter(Boolean).join(', ') || selectedCustomer.shippingAddress || selectedCustomer.billingAddress || '')
    : '';
  const showPowerCol = cartItems.some(i => cellText(i.power));
  const gridColCount = showPowerCol ? 17 : 16;
  const totalPaid = paymentCalc.paidNow;
  const balanceDue = paymentCalc.dueAmount;
  const changeDue = paymentCalc.balanceAmount;
  const paymentStatusLabel = !cartItems.length ? 'No items yet'
    : balanceDue <= 0.009 ? 'Fully paid'
      : totalPaid > 0 ? 'Part paid — balance on dealer credit' : 'Unpaid — full amount on dealer credit';
  const searchLabel = itemMode === 'service' ? 'Service search' : itemMode === 'lens' ? 'Lens barcode / search' : 'Barcode / product search';
  const freeGiftValue = cartItems.filter(i => i.isFreeGift).reduce((a, i) => a + (parseFloat(i.rate) || 0) * (parseFloat(i.qty) || 0), 0);
  const billDoc = previewDoc || printableInvoice;

  // Item details panel: the highlighted search result while searching, otherwise the selected
  // grid line (or the last one added). Stock is read from the live catalogue.
  const detailFromSearch = showSearchResults && searchMatches.length > 0;
  const detailIdx = selectedRowIndex >= 0 && selectedRowIndex < cartItems.length ? selectedRowIndex : cartItems.length - 1;
  const detailItem = detailFromSearch ? searchMatches[Math.min(matchIndex, searchMatches.length - 1)] : (showSearchResults ? null : cartItems[detailIdx]);
  const detailIsService = Boolean(detailItem) && (isServiceLine(detailItem) || itemMode === 'service');
  const detailLive = detailItem && !detailIsService
    ? (products.find(p => p.id === detailItem.id || (cellText(detailItem.code) && p.code === detailItem.code)) || detailItem)
    : null;
  const detailStock = detailLive ? parseFloat(detailLive.availableStock ?? detailLive.stock ?? 0) : null;
  const detailInBill = detailItem && !detailFromSearch ? (parseFloat(detailItem.qty) || 0) : (detailItem ? (cartItems.find(it => !it.isFreeGift && !isServiceLine(it) && it.id === detailItem.id)?.qty || 0) : 0);

  return (
    <Box ref={rootRef} {...navScopeProps} sx={{ p: { xs: 1.5, md: 2 }, bgcolor: '#ffffff', minHeight: '100vh' }}>
      {/* ============ HEADER ============ */}
      <Card variant="outlined" sx={{ ...PANEL_SX, mb: 1.5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Avatar sx={{ bgcolor: '#2563eb', width: 40, height: 40 }}><InventoryIcon /></Avatar>
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h6" fontWeight={900} color="primary.main" sx={{ lineHeight: 1.2 }}>{paymentLocked ? 'Edit Wholesale Invoice' : 'Wholesale Sale'}</Typography>
                <Paper elevation={0} sx={{ px: 1.2, py: 0.25, bgcolor: NAVY, color: '#facc15', fontWeight: 900, borderRadius: 1.5, fontSize: '0.8rem', fontFamily: 'monospace' }} title="Invoice number this sale will be saved under">
                  {invoiceNo}
                </Paper>
              </Stack>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                {paymentLocked ? `Correcting a saved invoice dated ${editing.date} — Ctrl+Enter saves the changes` : editing?.isDraft ? 'Continuing a saved draft' : 'Create a wholesale invoice'}
              </Typography>
            </Box>
          </Box>

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {loadingEdit && <CircularProgress size={18} />}
            {editing && (
              <Chip
                icon={<EditIcon sx={{ fontSize: 15 }} />} color={paymentLocked ? 'warning' : 'default'} variant="outlined"
                label={`${paymentLocked ? 'Editing' : 'Draft'} ${editing.invoiceNo}`} sx={{ fontWeight: 900, borderRadius: 1 }}
              />
            )}
            {editing && (
              <Button variant="outlined" size="small" color="inherit" onClick={cancelEdit} sx={{ fontWeight: 800, textTransform: 'none', borderColor: '#cbd5e1' }}>
                {paymentLocked ? 'Cancel Edit' : 'Close Draft'}
              </Button>
            )}
            {heldInvoices.length > 0 && (
              <Button variant="outlined" color="warning" size="small" startIcon={<ResumeIcon />} onClick={() => setHeldModalOpen(true)} sx={{ fontWeight: 800, textTransform: 'none' }}>
                Held ({heldInvoices.length})
              </Button>
            )}
            <Button variant="outlined" size="small" startIcon={<PersonAddIcon />} onClick={() => openNewDealer()} sx={{ fontWeight: 800, textTransform: 'none' }}>
              New Dealer&nbsp;<Kbd>F2</Kbd>
            </Button>
            <Button variant="outlined" size="small" color="error" startIcon={<ClearIcon />} disabled={cartItems.length === 0} onClick={() => setClearCartConfirmOpen(true)} sx={{ fontWeight: 800, textTransform: 'none' }}>
              Clear Cart
            </Button>
            <Button variant="outlined" size="small" color="inherit" startIcon={<KeyboardIcon />} onClick={() => setHelpOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', borderColor: '#cbd5e1', color: '#475569' }}>
              Shortcuts&nbsp;<Kbd>Ctrl+/</Kbd>
            </Button>
            <Tooltip title="More Actions">
              <IconButton size="small" aria-label="More actions" onClick={(e) => setMoreActionsAnchor(e.currentTarget)} sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}>
                <MoreVertIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>
      </Card>

      {/* MORE ACTIONS MENU — Cancel/Credit Note/Replacement/Return need the Manager+/override role. */}
      {/* Unit Price choice: the pricing hierarchy for the line (wholesale tier / dealer tier /
          retail / MRP) — typing in the cell instead sets a custom agreed price. */}
      {(() => {
        const line = priceMenu ? cartItems[priceMenu.idx] : null;
        if (!line) return null;
        const live = products.find(p => p.id === line.id || (line.code && p.code === line.code));
        const prod = live || { wholesaleRate: line.wholesaleRate, wholesalePrice: line.wholesaleRate || line.mrp, mrp: line.mrp, retailPrice: 0 };
        const choices = priceChoices(prod, live ? priceForProduct(live, parseFloat(line.qty) || 1) : {});
        const current = round2(parseFloat(shownPrice(line)) || 0);
        const close = () => setPriceMenu(null);
        return (
          <Menu anchorEl={priceMenu.anchor} open onClose={close} MenuListProps={{ dense: true, 'aria-label': `Price options for ${line.name}` }}>
            <Box sx={{ px: 2, py: 0.5 }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary" display="block">
                {line.name}
              </Typography>
              {viewCost && (line.costPrice > 0) && (
                <Typography variant="caption" color="text.secondary" display="block">
                  Cost {fmtINR(line.costPrice)}
                </Typography>
              )}
            </Box>
            <Divider />
            {choices.map(c => {
              const selected = Math.abs(c.price - current) < 0.005 && (!c.inclusive || line.taxInclusive);
              return (
                <MenuItem key={c.key} selected={selected} data-price-choice={c.key} onClick={() => { applyPriceChoice(priceMenu.idx, c); close(); }}>
                  <Box sx={{ flex: 1, pr: 3 }}>
                    <Typography variant="body2" fontWeight={700}>{c.label}</Typography>
                    {viewCost && line.costPrice > 0 && (
                      <Typography variant="caption" color={c.price < line.costPrice ? 'error' : 'text.secondary'}>
                        {c.price < line.costPrice ? 'Below cost' : `Margin ${(((c.inclusive ? c.price / (1 + (parseFloat(line.gst) || 0) / 100) : c.price) - line.costPrice) / line.costPrice * 100).toFixed(1)}%`}
                      </Typography>
                    )}
                  </Box>
                  <Typography variant="body2" fontWeight={900}>{fmtINR(c.price)}</Typography>
                </MenuItem>
              );
            })}
            {!choices.length && <MenuItem disabled>No master prices on file</MenuItem>}
            <Divider />
            <MenuItem onClick={() => { close(); setTimeout(() => focusField(document.querySelector(`input[data-cell-row="${priceMenu.idx}"][data-cell-col="rate"]`)), 30); }}>
              <Typography variant="body2" color="primary" fontWeight={700}>Custom agreed price… (type in the cell)</Typography>
            </MenuItem>
          </Menu>
        );
      })()}

      <Menu anchorEl={moreActionsAnchor} open={Boolean(moreActionsAnchor)} onClose={() => setMoreActionsAnchor(null)}>
        <MenuItem disabled={cartItems.length === 0} onClick={() => { setMoreActionsAnchor(null); handleSaveDraft(); }}><SaveIcon fontSize="small" sx={{ mr: 1 }} /> Save Draft <Box sx={{ ml: 'auto', pl: 2 }}><Kbd>Alt+S</Kbd></Box></MenuItem>
        <MenuItem disabled={cartItems.length === 0} onClick={() => { setMoreActionsAnchor(null); handleHoldInvoice(); }}><HoldIcon fontSize="small" sx={{ mr: 1 }} /> Hold Invoice <Box sx={{ ml: 'auto', pl: 2 }}><Kbd>Alt+H</Kbd></Box></MenuItem>
        <Divider />
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); setPreviewDoc(null); setPrintModalOpen(true); }}><PrintIcon fontSize="small" sx={{ mr: 1 }} /> Print Preview (last invoice)</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: printableInvoice, documentType: 'WHOLESALE_BILL' }); }}><PrintIcon fontSize="small" sx={{ mr: 1 }} /> Print Invoice</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); downloadPdfInvoice(printableInvoice, 'WHOLESALE_BILL'); }}><PdfIcon fontSize="small" sx={{ mr: 1 }} /> Download PDF</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); showToast(`Invoice ${printableInvoice.invoiceNo} queued for sending.`, 'success'); }}><SendIcon fontSize="small" sx={{ mr: 1 }} /> Send Invoice</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: { ...printableInvoice, __title: 'DELIVERY NOTE' }, documentType: 'WHOLESALE_BILL' }); }}><DocumentIcon fontSize="small" sx={{ mr: 1 }} /> Delivery Note</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: { ...printableInvoice, __title: 'PACKING SLIP' }, documentType: 'WHOLESALE_BILL' }); }}><PackingIcon fontSize="small" sx={{ mr: 1 }} /> Packing Slip</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printBill({ doc: { ...printableInvoice, __title: 'PAYMENT RECEIPT' }, documentType: 'WHOLESALE_BILL' }); }}><DocumentIcon fontSize="small" sx={{ mr: 1 }} /> Payment Receipt</MenuItem>
        <MenuItem disabled={!selectedCustomer} onClick={() => { setMoreActionsAnchor(null); setPrevOrdersOpen(true); }}><HistoryIcon fontSize="small" sx={{ mr: 1 }} /> Previous Orders</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); applyOrderToCart(printableInvoice, 'duplicate'); }}><DuplicateIcon fontSize="small" sx={{ mr: 1 }} /> Duplicate Invoice</MenuItem>
        <MenuItem disabled={!printableInvoice || loadingEdit} onClick={() => { setMoreActionsAnchor(null); startEditInvoice(printableInvoice); }}><EditIcon fontSize="small" sx={{ mr: 1 }} /> Edit Invoice{printableInvoice ? ` ${printableInvoice.invoiceNo}` : ''}</MenuItem>
        <Divider />
        <MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setReturnConfirmOpen(true); }}><ReturnIcon fontSize="small" sx={{ mr: 1 }} /> Sales Return{!canOverride ? ' (Manager/Admin)' : ''}</MenuItem>
        <MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setReplacementConfirmOpen(true); }}><ReplacementIcon fontSize="small" sx={{ mr: 1 }} /> Replacement{!canOverride ? ' (Manager/Admin)' : ''}</MenuItem>
        <MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setCreditNoteOpen(true); }}><CreditNoteIcon fontSize="small" sx={{ mr: 1 }} /> Create Credit Note{!canOverride ? ' (Manager/Admin)' : ''}</MenuItem>
        <MenuItem disabled={!printableInvoice || !canOverride} onClick={() => { setMoreActionsAnchor(null); setCancelInvoiceConfirmOpen(true); }}><CancelInvoiceIcon fontSize="small" sx={{ mr: 1 }} /> Cancel Invoice{!canOverride ? ' (Manager/Admin)' : ''}</MenuItem>
        <MenuItem disabled={!printableInvoice} onClick={() => { setMoreActionsAnchor(null); printLastReturn(); }}><PrintIcon fontSize="small" sx={{ mr: 1 }} /> Print Return / Credit Note</MenuItem>
        <Divider />
        <MenuItem disabled={!selectedCustomer} onClick={() => { setMoreActionsAnchor(null); setLedgerOpen(true); }}><LedgerIcon fontSize="small" sx={{ mr: 1 }} /> View Dealer Ledger</MenuItem>
      </Menu>

      {/* TOAST — floats so the layout never jumps under the cursor */}
      {toast.open && (
        <Alert severity={toast.severity} role="status" sx={{ position: 'fixed', top: 76, right: 16, zIndex: 1400, maxWidth: 440, borderRadius: 2, fontWeight: 700, boxShadow: '0 8px 24px rgba(15,23,42,0.18)' }}>
          {toast.message}
        </Alert>
      )}

      {/* ============ WHOLESALE DEALER ============ */}
      <Paper variant="outlined" sx={{ ...PANEL_SX, mb: 1.5 }}>
        <Grid container spacing={1.5} alignItems="flex-start">
          <Grid item xs={12} md={4}>
            <SectionTitle title="Wholesale Dealer" kbd="F1" right={<Typography variant="caption" color="text.secondary"><Kbd>F3</Kbd> change</Typography>} />
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <Autocomplete
                fullWidth
                autoHighlight
                id="ws-dealer-search"
                disabled={paymentLocked}
                options={customers}
                filterOptions={dealerSearchFilter}
                getOptionLabel={(o) => (o?.__addNew ? '' : o ? `${o.name}${o.code ? ` (${o.code})` : ''}` : '')}
                isOptionEqualToValue={(o, v) => o.id === v.id}
                value={selectedCustomer}
                onChange={(e, newVal) => {
                  if (newVal?.__addNew) { openNewDealer(newVal.query); return; }
                  handleSelectCustomer(newVal);
                  // Dealer picked → straight on to scanning products.
                  if (newVal) setTimeout(() => focusSearch(), 30);
                }}
                renderOption={(props, o) => (o.__addNew ? (
                  <li {...props} key="__add_new_dealer">
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', color: '#4f46e5' }}>
                      <AddIcon sx={{ fontSize: 18 }} />
                      <Typography variant="body2" fontWeight={800} sx={{ flex: 1 }}>Add New Dealer{o.query ? ` "${o.query}"` : ''}</Typography>
                      <Kbd>F2</Kbd>
                    </Stack>
                  </li>
                ) : (
                  <li {...props} key={o.id || o.code}>
                    <Box sx={{ width: '100%' }}>
                      <Typography variant="body2" fontWeight={800}>{o.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{[o.code, o.phone, o.gstin, o.email].filter(Boolean).join(' • ')}</Typography>
                    </Box>
                  </li>
                ))}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    placeholder="Search name, code, phone, GSTIN, email…"
                    onKeyDown={(e) => {
                      // "+" on an empty search = Add New Dealer ("+91..." can still be typed after a digit).
                      if (e.key === '+' && !e.target.value) { e.preventDefault(); openNewDealer(); }
                    }}
                    InputProps={{
                      ...params.InputProps,
                      startAdornment: (<><SearchIcon sx={{ color: '#94a3b8', mr: 0.5, fontSize: 18 }} />{params.InputProps.startAdornment}</>),
                      endAdornment: (<>{dealersLoading && <CircularProgress size={14} sx={{ mr: 1 }} />}{params.InputProps.endAdornment}</>),
                    }}
                  />
                )}
              />
              <Tooltip title="New Dealer (F2)">
                <Button variant="outlined" size="small" onClick={() => openNewDealer()} aria-label="New dealer" sx={{ minWidth: 0, px: 1, py: 0.9 }}><PersonAddIcon fontSize="small" /></Button>
              </Tooltip>
            </Stack>
            {/* Order information — compact, right under the dealer search */}
            <Grid container spacing={1} sx={{ mt: 0.5 }}>
              <Grid item xs={6}>
                <TextField fullWidth size="small" id="ws-ref-no" label="Reference No." value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
              </Grid>
              <Grid item xs={6}>
                <TextField fullWidth size="small" label="Dealer PO No." value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
              </Grid>
              <Grid item xs={4}>
                <TextField
                  select fullWidth size="small" label="Warehouse" value={selectedWarehouseId}
                  onChange={(e) => setSelectedWarehouseId(e.target.value)}
                  SelectProps={{ ...enterOpensSelectProps, SelectDisplayProps: { ...enterOpensSelectProps.SelectDisplayProps, id: 'ws-warehouse' } }}
                >
                  {warehouses.length === 0 && <MenuItem value="">Main Warehouse</MenuItem>}
                  {warehouses.map(w => <MenuItem key={w.id} value={String(w.id)}>{w.name}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={4}>
                <TextField
                  select fullWidth size="small" label="Price List" value={selectedCustomer ? (invoicePriceList || selectedCustomer.priceList) : ''}
                  disabled={!selectedCustomer} onChange={(e) => setInvoicePriceList(e.target.value)}
                  SelectProps={enterOpensSelectProps}
                >
                  {!selectedCustomer && <MenuItem value="">—</MenuItem>}
                  {PRICE_LIST_OPTIONS.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={4}>
                <TextField select fullWidth size="small" label="Sales Rep" value={salesRep} onChange={(e) => setSalesRep(e.target.value)} SelectProps={enterOpensSelectProps}>
                  <MenuItem value="">—</MenuItem>
                  {Array.from(new Set([...DEMO_SALES_REPS, ...customers.map(c => c.salesExec).filter(Boolean)])).map(r => (
                    <MenuItem key={r} value={r}>{r}</MenuItem>
                  ))}
                </TextField>
              </Grid>
            </Grid>
          </Grid>

          <Grid item xs={12} md={8}>
            {selectedCustomer ? (
              <Box sx={{ p: 1.25, borderRadius: 1, bgcolor: '#ffffff', border: '1px solid #e2e8f0', height: '100%' }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap spacing={1} sx={{ mb: 0.75 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle2" fontWeight={900} color={NAVY}>{selectedCustomer.name}</Typography>
                    <Chip label={PRICE_TIER_LABEL[invoicePriceList || selectedCustomer.priceList] || 'Wholesale'} size="small" sx={{ height: 20, fontSize: '0.66rem', fontWeight: 800, bgcolor: '#eef2ff', color: '#4f46e5' }} />
                    {selectedCustomer.status && selectedCustomer.status !== 'Active' && (
                      <Chip label={selectedCustomer.status} size="small" color="error" variant="outlined" sx={{ height: 20, fontSize: '0.66rem', fontWeight: 800 }} />
                    )}
                  </Stack>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    <Button size="small" variant="outlined" startIcon={<ProfileIcon />} onClick={() => setDealerProfileOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', py: 0.1 }}>View Dealer Details</Button>
                    <Button size="small" variant="outlined" startIcon={<LedgerIcon />} onClick={() => setLedgerOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', py: 0.1 }}>Ledger</Button>
                    <Button size="small" variant="outlined" startIcon={<HistoryIcon />} onClick={() => setPrevOrdersOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', py: 0.1 }}>Orders{dealerOrders.length ? ` (${dealerOrders.length})` : ''}</Button>
                    <Tooltip title={paymentLocked ? "A billed invoice stays with its dealer — cancel it and bill the right dealer instead" : ''}>
                      <span>
                        <Button size="small" variant="text" color="inherit" disabled={paymentLocked} startIcon={<ChangeDealerIcon />} onClick={() => { handleSelectCustomer(null); setTimeout(() => focusById('ws-dealer-search'), 30); }} sx={{ fontWeight: 800, textTransform: 'none', py: 0.1 }}>Change</Button>
                      </span>
                    </Tooltip>
                  </Stack>
                </Stack>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 1 }}>
                  <DealerField label="Dealer Code" value={selectedCustomer.code} />
                  <DealerField label="Phone" value={selectedCustomer.phone} />
                  <DealerField label="Email" value={selectedCustomer.email} />
                  <DealerField label="Location" value={dealerLocation} />
                  <DealerField label="GSTIN" value={selectedCustomer.gstin} />
                  <DealerField label="Credit Limit" value={fmtINR(selectedCustomer.creditLimit)} />
                  <DealerField label="Outstanding" value={fmtINR(selectedCustomer.outstanding)} color={outstandingColor} />
                  <DealerField label="Available Credit" value={fmtINR(availableCredit)} color="#059669" />
                  <DealerField label="Payment Terms" value={`Net ${selectedCustomer.creditDays || 30} days`} />
                </Box>
                {isCreditExceeded && (
                  <Alert severity="warning" icon={<WarningIcon />} sx={{ mt: 1, borderRadius: 2, fontWeight: 700, py: 0 }}>
                    Outstanding ({fmtINR(selectedCustomer.outstanding)}) + the credit on this bill exceeds the limit of {fmtINR(selectedCustomer.creditLimit)} — completing will need an override.
                  </Alert>
                )}
              </Box>
            ) : (
              <Box sx={{ p: 2, borderRadius: 2, border: '1px dashed #cbd5e1', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 96 }}>
                <Typography variant="body2" color="text.secondary" fontWeight={600} textAlign="center">
                  {dealersLoading && customers.length === 0 ? 'Loading dealers…' : <>No dealer selected — press <Kbd>F1</Kbd> to search, or <Kbd>F2</Kbd> to add a new dealer.</>}
                </Typography>
              </Box>
            )}
          </Grid>
        </Grid>
      </Paper>

      {/* ============ PRODUCT ENTRY ============ */}
      <Paper variant="outlined" data-nav-own sx={{ p: 1.2, mb: 1.5, borderRadius: 1, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', gap: 0.75, mb: 1, flexWrap: 'wrap', alignItems: 'center' }} role="tablist" aria-label="Item type">
          {ITEM_MODES.map(m => (
            <Button
              key={m.key} size="small" role="tab" aria-selected={itemMode === m.key}
              variant={itemMode === m.key ? 'contained' : 'outlined'}
              onClick={() => switchItemMode(m.key)}
              sx={{
                px: 1.5, py: 0.3, fontWeight: 900, fontSize: '0.75rem', borderRadius: 2, textTransform: 'none', gap: 0.75,
                bgcolor: itemMode === m.key ? NAVY : 'transparent', color: itemMode === m.key ? '#facc15' : NAVY, borderColor: NAVY,
                '&:hover': { bgcolor: itemMode === m.key ? '#1e293b' : 'rgba(15,23,42,0.06)', borderColor: NAVY },
              }}
            >
              {m.label} <Kbd dark={itemMode === m.key}>{m.kbd}</Kbd>
            </Button>
          ))}
          <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ ml: 'auto', display: { xs: 'none', md: 'block' } }}>
            Scan or type → results list in the grid → <Kbd>↑</Kbd><Kbd>↓</Kbd> choose → <Kbd>Enter</Kbd> adds &amp; jumps to Qty ·<Kbd>F9</Kbd> edit lines
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: { xs: 'wrap', md: 'nowrap' } }}>
          <TextField
            fullWidth id="ws-product-search" label={searchLabel} autoComplete="off"
            placeholder={itemMode === 'service' ? 'Service name or code…' : 'Scan barcode, or type name / SKU / model / brand / colour…'}
            value={barcodeInput}
            onChange={(e) => { setBarcodeInput(e.target.value); setSearchOpen(true); }}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => { if (barcodeInput) setSearchOpen(true); }}
            onBlur={() => setSearchOpen(false)}
            inputProps={{
              role: 'combobox', 'aria-expanded': showSearchResults && searchMatches.length > 0, 'aria-controls': 'ws-search-results',
              'aria-activedescendant': showSearchResults && searchMatches.length ? `ws-search-opt-${matchIndex}` : undefined,
              style: { fontWeight: 800, fontSize: '1rem', color: NAVY, paddingTop: 13, paddingBottom: 13 },
            }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><QrCodeScannerIcon sx={{ color: '#475569', fontSize: 26 }} /></InputAdornment>,
              endAdornment: (
                <InputAdornment position="end">
                  {showSearchResults && (
                    <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ mr: 1, whiteSpace: 'nowrap' }}>
                      {searchMatches.length ? `${matchIndex + 1} / ${searchMatches.length}${searchMatches.length === 50 ? '+' : ''}` : 'No match'}
                    </Typography>
                  )}
                  <Kbd>F7</Kbd>
                </InputAdornment>
              ),
            }}
            sx={{ bgcolor: '#fff', flex: 1, minWidth: 260, '& .MuiOutlinedInput-root': { borderRadius: 1 } }}
          />
          <Button
            variant="contained" onClick={handleAddHighlighted} startIcon={<AddIcon />}
            sx={{ fontWeight: 900, py: 1.3, px: 2.5, borderRadius: 2, textTransform: 'none', fontSize: '0.8rem', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            Add Item
          </Button>
          <Button
            variant="contained" startIcon={<AddIcon />}
            onClick={() => setNewItemOpen(true)}
            sx={{ fontWeight: 900, py: 1.3, px: 2.5, borderRadius: 2, textTransform: 'none', fontSize: '0.8rem', whiteSpace: 'nowrap', flexShrink: 0, bgcolor: NAVY, color: '#facc15', '&:hover': { bgcolor: '#1e293b' } }}
          >
            New {itemMode === 'service' ? 'Service' : itemMode === 'lens' ? 'Lens' : 'Item'}
          </Button>
        </Box>

        {/* Selected item details */}
        <Box
          aria-live="polite"
          sx={{ mt: 1, border: '1px solid #e2e8f0', bgcolor: '#ffffff', display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: '1.1fr 2.2fr 1fr 1fr 1fr 1fr 1.1fr' } }}
        >
          {[
            ['Tag Code', detailItem ? (cellText(detailItem.barcode) || cellText(detailItem.code)) : '', { fontFamily: 'monospace' }],
            ['Item Description', detailItem ? detailItem.name : ''],
            ['Brand', detailItem ? cellText(detailItem.brand) : ''],
            ['Model Number', detailItem ? cellText(detailItem.modelNo) : ''],
            ['Color', detailItem ? cellText(detailItem.color) : ''],
            ['Size', detailItem ? cellText(detailItem.size) : ''],
            ['Available Stock', detailIsService ? 'Service' : detailStock == null ? '' : `${detailStock}${detailInBill ? ` · ${detailInBill} in bill` : ''}`,
              { color: detailStock == null ? undefined : detailStock > 5 ? '#15803d' : detailStock > 0 ? '#b45309' : '#dc2626' }],
          ].map(([label, value, extra], i) => (
            <Box key={label} sx={{ px: 1, py: 0.6, borderLeft: i ? '1px solid #e2e8f0' : 'none', minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: '0.64rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</Typography>
              <Typography variant="body2" fontWeight={800} noWrap title={value ? String(value) : undefined} sx={{ fontSize: '0.8rem', color: NAVY, ...(extra || {}) }}>{value || '—'}</Typography>
            </Box>
          ))}
        </Box>
        {!detailItem && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            {showSearchResults ? 'No match to show.' : 'Search a product (or click a bill line) to see its full details here.'}
          </Typography>
        )}

        <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
          <Button size="small" variant="outlined" startIcon={<BulkAddIconMui />} onClick={() => setBulkAddOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', bgcolor: '#fff', py: 0.25 }}>
            Bulk Add&nbsp;<Kbd>Ctrl+B</Kbd>
          </Button>
          <Button size="small" variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setExcelImportOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', bgcolor: '#fff', py: 0.25 }}>
            Excel Import&nbsp;<Kbd>Ctrl+I</Kbd>
          </Button>
          <Button size="small" variant="outlined" startIcon={<DiscountIcon />} onClick={() => setSchemeOpen(true)} sx={{ fontWeight: 800, textTransform: 'none', bgcolor: '#fff', py: 0.25 }}>
            Discounts / Schemes&nbsp;<Kbd>Ctrl+D</Kbd>
          </Button>
          {dealerOrders.length > 0 && (
            <Button size="small" variant="outlined" startIcon={<ReorderIcon />} onClick={() => applyOrderToCart(dealerOrders[0], 'reorder')} sx={{ fontWeight: 800, textTransform: 'none', bgcolor: '#fff', py: 0.25 }}>
              Reorder Last&nbsp;<Kbd>Alt+R</Kbd>
            </Button>
          )}
          {invoiceDiscount && (
            <Chip
              color={summary.schemeActive === false ? 'warning' : 'success'} onDelete={() => setInvoiceDiscount(null)}
              label={invoiceDiscount.type === 'BOGO'
                ? `Scheme: Buy ${invoiceDiscount.buyQty} ${invoiceDiscount.buyProduct?.name} → Get ${invoiceDiscount.getQty} ${invoiceDiscount.getProduct?.name} free`
                : `${summary.schemeLabel}${summary.schemeActive === false ? '' : ` — ${fmtINR(summary.schemeDiscount - freeGiftValue)} off`}`}
              sx={{ fontWeight: 800, fontSize: '0.72rem' }}
            />
          )}
        </Stack>
      </Paper>

      {/* ============ BILLING GRID ============ */}
      <Card variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden', mb: 1.5, borderColor: '#cbd5e1' }}>
        <TableContainer data-nav-own onKeyDown={handleGridKeyDown} sx={{ maxHeight: 360 }}>
          <Table size="small" stickyHeader sx={{ minWidth: 1180 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ ...HEAD_CELL_SX, width: 30 }}>#</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Barcode / Tag</TableCell>
                <TableCell sx={{ ...HEAD_CELL_SX, width: 38 }}>Img</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Item Description</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Model No</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Color</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Size</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Brand</TableCell>
                <TableCell sx={HEAD_CELL_SX}>Category</TableCell>
                {showPowerCol && <TableCell sx={HEAD_CELL_SX}>Power</TableCell>}
                <TableCell align="center" sx={HEAD_CELL_SX}>Qty</TableCell>
                <TableCell align="right" sx={HEAD_CELL_SX}>MRP</TableCell>
                <TableCell align="center" sx={HEAD_CELL_SX}>Unit Price</TableCell>
                <TableCell align="center" sx={HEAD_CELL_SX}>Disc %</TableCell>
                <TableCell align="center" sx={HEAD_CELL_SX}>Tax %</TableCell>
                <TableCell align="right" sx={HEAD_CELL_SX}>Line Total</TableCell>
                <TableCell align="center" sx={HEAD_CELL_SX}>Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody id="ws-search-results">
              {/* Search results — shown in the grid in place of the bill lines while the search box
                  has text. ↑/↓ highlight, Enter or click adds one to the bill; Esc returns to the bill. */}
              {showSearchResults && (
                <TableRow>
                  <TableCell colSpan={gridColCount} sx={{ py: 0.6, bgcolor: '#ffffff', borderBottom: '1px solid #cbd5e1' }}>
                    <Typography variant="caption" fontWeight={800} color="#334155">
                      {searchMatches.length
                        ? <>{searchMatches.length}{searchMatches.length === 50 ? '+' : ''} {modeNoun} match{searchMatches.length === 1 ? '' : 'es'} for “{barcodeInput.trim()}” — <Kbd>↑</Kbd><Kbd>↓</Kbd> choose · <Kbd>Enter</Kbd> add to bill · <Kbd>Esc</Kbd> back to the bill{cartItems.length ? ` (${cartItems.length} line${cartItems.length === 1 ? '' : 's'})` : ''}</>
                        : <>No {modeNoun} matches “{barcodeInput.trim()}”. An exact barcode still adds on <Kbd>Enter</Kbd> · <Kbd>Esc</Kbd> back to the bill</>}
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {showSearchResults && searchMatches.map((p, i) => {
                const active = i === matchIndex;
                const svc = itemMode === 'service';
                const stock = svc ? null : parseFloat(p.availableStock ?? p.stock ?? 0);
                const price = svc ? (parseFloat(p.price) || 0) : priceForProduct(p).rate;
                const tax = parseTaxPercent(p.gst) ?? 0;
                const previewLine = pricedLine({ qty: 1, discount: 0, gst: tax }, price, Boolean(p.taxInclusive));
                const inBill = cartItems.find(it => !it.isFreeGift && (svc ? isServiceLine(it) : !isServiceLine(it)) && it.id === p.id);
                return (
                  <TableRow
                    key={p.id || p.code} id={`ws-search-opt-${i}`} data-search-idx={i} role="option" aria-selected={active}
                    // mousedown would blur the search box (and hide the results) before the click lands
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setMatchIndex(i)} onClick={() => addPickedItem(p)}
                    sx={{
                      cursor: 'pointer',
                      bgcolor: '#fff',
                      outline: active ? '1px solid #0f172a' : 'none', outlineOffset: -1,
                      '& > td:first-of-type': { borderLeft: active ? `3px solid ${NAVY}` : '3px solid transparent' },
                      '& td': { py: 0.5, fontSize: '0.78rem', whiteSpace: 'nowrap', borderBottom: '1px solid #e2e8f0' },
                    }}
                  >
                    <TableCell sx={{ color: active ? NAVY : '#64748b', fontWeight: 900 }}>{active ? '▶' : i + 1}</TableCell>
                    <TableCell sx={{ fontWeight: 800, color: svc ? '#b45309' : 'primary.main', fontFamily: 'monospace' }}>{cellText(p.barcode) || cellText(p.code)}</TableCell>
                    <TableCell>
                      <Avatar variant="rounded" src={p.image || undefined} alt="" sx={{ width: 28, height: 28, bgcolor: '#f1f5f9', color: '#94a3b8' }}>
                        <NoImageIcon sx={{ fontSize: 16 }} />
                      </Avatar>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'normal !important', minWidth: 180 }}>
                      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="body2" fontWeight={800} sx={{ fontSize: '0.8rem' }}>{p.name}</Typography>
                        {inBill && <Chip label={`IN BILL × ${inBill.qty}`} size="small" color="primary" variant="outlined" sx={{ height: 16, fontSize: '0.58rem', fontWeight: 900 }} />}
                      </Stack>
                      {stock != null && (
                        <Typography variant="caption" sx={{ fontSize: '0.64rem', fontWeight: 700, color: stock > 5 ? '#059669' : stock > 0 ? '#d97706' : '#dc2626' }}>
                          {stock > 0 ? `Stock: ${stock}` : 'Out of stock'}{getWarehouseStockText(p) ? ` · ${getWarehouseStockText(p)}` : ''}
                        </Typography>
                      )}
                      {svc && cellText(p.description) && <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.64rem' }}>{p.description}</Typography>}
                    </TableCell>
                    <TableCell>{cellText(p.modelNo)}</TableCell>
                    <TableCell>{cellText(p.color)}</TableCell>
                    <TableCell>{cellText(p.size)}</TableCell>
                    <TableCell>{cellText(p.brand)}</TableCell>
                    <TableCell>
                      <Chip label={svc ? 'SERVICE' : (cellText(p.category) || '—')} size="small" color={svc ? 'warning' : 'primary'} variant="outlined" sx={{ fontWeight: 800, height: 20, fontSize: '0.62rem' }} />
                    </TableCell>
                    {showPowerCol && <TableCell sx={{ color: '#2563eb', fontWeight: 700 }}>{cellText(p.power)}</TableCell>}
                    <TableCell align="center" sx={{ fontWeight: 900 }}>1</TableCell>
                    <TableCell align="right" sx={{ color: '#64748b', fontWeight: 700 }}>{p.mrp ? fmtINR(p.mrp) : ''}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800 }}>
                      {fmtINR(price)}
                      {!svc && p.taxInclusive && <Typography component="span" sx={{ fontSize: '0.58rem', color: '#64748b', ml: 0.3 }}>incl.</Typography>}
                    </TableCell>
                    <TableCell align="center" sx={{ color: '#94a3b8' }}>0%</TableCell>
                    <TableCell align="center" sx={{ color: '#0f766e', fontWeight: 700 }}>
                      {tax}%{tax === 0 && <Typography component="span" sx={{ fontSize: '0.58rem', color: '#64748b', ml: 0.3 }}>{zeroTaxLabel(0, p.taxCategory)}</Typography>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 900, color: '#2563eb' }}>{fmtINR(computeLineTotals(previewLine).total)}</TableCell>
                    <TableCell align="center">
                      {active
                        ? <Chip label="Enter ↵ add" size="small" color="primary" sx={{ height: 20, fontSize: '0.62rem', fontWeight: 900 }} />
                        : <AddIcon sx={{ fontSize: 17, color: '#94a3b8' }} />}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!showSearchResults && cartItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={gridColCount} align="center" sx={{ py: 4 }}>
                    <Typography variant="body2" color="text.secondary" fontWeight={600}>
                      Billing grid is empty — scan a barcode or press <Kbd>F7</Kbd> to search products, then <Kbd>Enter</Kbd> to add.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {!showSearchResults && cartItems.map((item, idx) => {
                const svc = isServiceLine(item);
                const avail = parseFloat(item.availableStock) || 0;
                const isStockExceeded = !svc && !item.isFreeGift && ((parseFloat(item.qty) || 0) + (parseFloat(item.freeQty) || 0)) > avail;
                const t = computeLineTotals(item);
                const m = svc ? null : lineMargin(item);
                const zeroTag = zeroTaxLabel(item.gst, item.taxCategory);
                const expired = isExpired(item.expiry);
                const nearExpiry = !expired && isNearExpiry(item.expiry);
                const rowSelected = selectedRowIndex === idx;
                const errs = lineErrors[idx] || {};
                const cellProps = (col, extra = {}) => ({
                  'data-cell-row': idx, 'data-cell-col': col, 'aria-label': `${{ qty: 'Quantity', rate: 'Unit price', disc: 'Discount %', gst: 'Tax %' }[col]} for ${item.name}`, ...extra,
                });
                return (
                  <React.Fragment key={`${item.id}-${idx}`}>
                    <TableRow
                      hover
                      selected={rowSelected}
                      onClick={() => setSelectedRowIndex(idx)}
                      onFocus={() => setSelectedRowIndex(idx)}
                      sx={{
                        cursor: 'pointer',
                        bgcolor: isStockExceeded ? '#fef2f2' : item.isFreeGift ? '#f0fdf4' : svc ? '#fffbeb' : '#fff',
                        // The focused / selected line is marked by its left bar, not a blue wash.
                        '&.Mui-selected, &.Mui-selected:hover': { bgcolor: isStockExceeded ? '#fef2f2' : '#ffffff' },
                        '& > td:first-of-type': { borderLeft: rowSelected ? `3px solid ${NAVY}` : '3px solid transparent' },
                        '& td': { py: 0.5, fontSize: '0.78rem', whiteSpace: 'nowrap', borderBottom: '1px solid #e2e8f0' },
                      }}
                    >
                      <TableCell sx={{ color: '#64748b', fontWeight: 800 }}>{idx + 1}</TableCell>
                      <TableCell sx={{ fontWeight: 800, color: svc ? '#b45309' : 'primary.main', fontFamily: 'monospace' }}>{cellText(item.barcode) || cellText(item.code)}</TableCell>
                      <TableCell>
                        <Avatar variant="rounded" src={item.image || undefined} alt="" sx={{ width: 28, height: 28, bgcolor: '#f1f5f9', color: '#94a3b8' }}>
                          <NoImageIcon sx={{ fontSize: 16 }} />
                        </Avatar>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'normal !important', minWidth: 180 }}>
                        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="body2" fontWeight={800} sx={{ fontSize: '0.8rem' }}>{item.name}</Typography>
                          {item.isFreeGift && <Chip label="FREE" size="small" sx={{ height: 16, fontSize: '0.58rem', fontWeight: 900, bgcolor: '#dcfce7', color: '#15803d' }} />}
                          {!svc && <Chip label={PRICE_TIER_LABEL[item.priceTier] || 'Wholesale'} size="small" sx={{ height: 16, fontSize: '0.58rem', fontWeight: 800, bgcolor: '#f1f5f9', color: '#64748b' }} />}
                          {expired && <Tooltip title="Expired stock — requires Manager/Admin override to sell"><ExpiryIcon sx={{ fontSize: 15, color: '#dc2626' }} /></Tooltip>}
                          {nearExpiry && <Tooltip title="Expires within 30 days"><WarningIcon sx={{ fontSize: 14, color: '#d97706' }} /></Tooltip>}
                        </Stack>
                        {!svc && (
                          <Typography variant="caption" sx={{ fontSize: '0.64rem', fontWeight: 700, color: isStockExceeded || avail <= 0 ? '#dc2626' : avail <= 5 ? '#d97706' : '#64748b' }}>
                            {isStockExceeded ? `Exceeds stock (${avail} available)` : `Stock: ${avail}`}
                            {(parseFloat(item.freeQty) || 0) > 0 ? ` · Free ${item.freeQty}` : ''}
                            {cellText(item.batch) ? ` · Batch ${item.batch}` : ''}
                          </Typography>
                        )}
                        {svc && cellText(item.notes) && <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.64rem' }}>{item.notes}</Typography>}
                      </TableCell>
                      <TableCell>{cellText(item.modelNo)}</TableCell>
                      <TableCell>{cellText(item.color)}</TableCell>
                      <TableCell>{cellText(item.size)}</TableCell>
                      <TableCell>{cellText(item.brand)}</TableCell>
                      <TableCell>
                        <Chip label={svc ? 'SERVICE' : (cellText(item.category) || '—')} size="small" color={svc ? 'warning' : 'primary'} variant="outlined" sx={{ fontWeight: 800, height: 20, fontSize: '0.62rem' }} />
                      </TableCell>
                      {showPowerCol && <TableCell sx={{ color: '#2563eb', fontWeight: 700 }}>{cellText(item.power)}</TableCell>}
                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" alignItems="center" justifyContent="center" spacing={0.25}>
                          <IconButton size="small" tabIndex={-1} aria-label={`Decrease quantity of ${item.name}`} sx={{ p: 0.2 }} onClick={() => handleUpdateItemQty(idx, -1)}><RemoveIcon sx={{ fontSize: 15 }} /></IconButton>
                          <Tooltip title={errs.qty || (isStockExceeded ? `Only ${avail} in stock` : '')} placement="top">
                            <TextField
                              size="small" type="number" value={item.qty} error={Boolean(errs.qty) || isStockExceeded}
                              onChange={(e) => handleUpdateItemQty(idx, e.target.value, true)} onBlur={() => tidyItemQty(idx)}
                              inputProps={cellProps('qty', { min: 1, step: 1, ...selectOnFocusProps })}
                              sx={cellInputSx(48, 'center')}
                            />
                          </Tooltip>
                          <IconButton size="small" tabIndex={-1} aria-label={`Increase quantity of ${item.name}`} sx={{ p: 0.2 }} onClick={() => handleUpdateItemQty(idx, 1)}><AddIcon sx={{ fontSize: 15 }} /></IconButton>
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ color: '#64748b', fontWeight: 700 }}>{item.mrp ? fmtINR(item.mrp) : ''}</TableCell>
                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        {canOverride && !item.isFreeGift ? (
                          <Stack direction="row" spacing={0.25} alignItems="center" justifyContent="center">
                            <Tooltip title={errs.rate || (item.taxInclusive ? `Price incl. ${parseFloat(item.gst) || 0}% tax · taxable ${fmtINR(item.rate)}` : '')} placement="top">
                              <TextField
                                size="small" type="number" value={zeroAsBlank(shownPrice(item))} placeholder="0" error={Boolean(errs.rate)}
                                onChange={(e) => handleUpdateItemField(idx, 'rate', typedNumber(e.target.value))}
                                inputProps={cellProps('rate', { min: 0, step: '0.01', ...selectOnFocusProps })}
                                sx={cellInputSx(82)}
                              />
                            </Tooltip>
                            {!svc && (
                              <Tooltip title="Choose price: wholesale / dealer / retail / MRP">
                                <IconButton
                                  size="small" tabIndex={-1} aria-label={`Price options for ${item.name}`} data-testid="ws-price-choice"
                                  sx={{ p: 0.1 }} onClick={(e) => setPriceMenu({ anchor: e.currentTarget, idx })}
                                >
                                  <ExpandMoreIcon sx={{ fontSize: 16, color: '#64748b' }} />
                                </IconButton>
                              </Tooltip>
                            )}
                          </Stack>
                        ) : (
                          <Tooltip title={item.isFreeGift ? 'Free line' : 'Only Managers/Admins can override price'}>
                            <Stack direction="row" spacing={0.25} alignItems="center" justifyContent="center">
                              <LockIcon sx={{ fontSize: 11, color: '#cbd5e1' }} />
                              <Typography variant="body2" fontWeight={800} sx={{ fontSize: '0.8rem' }}>{fmtINR(shownPrice(item))}</Typography>
                            </Stack>
                          </Tooltip>
                        )}
                        {m && (m.aboveMrp || (canOverride && (m.belowCost || m.marginPct !== null))) && (
                          <Typography
                            variant="caption" display="block" data-testid="ws-price-hint"
                            sx={{ fontSize: '0.6rem', fontWeight: 700, lineHeight: 1.2, color: m.aboveMrp || m.belowCost ? '#dc2626' : '#64748b' }}
                          >
                            {m.aboveMrp ? 'Above MRP' : m.belowCost ? `Below cost ${fmtINR(m.cost)}` : `Margin ${m.marginPct.toFixed(1)}%`}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        <Tooltip title={errs.disc || (t.lineDiscount > 0 ? `−${fmtINR(t.lineDiscount)}` : '')} placement="top">
                          <TextField
                            size="small" type="number" value={item.isFreeGift ? item.discount : zeroAsBlank(item.discount)} placeholder="0" disabled={item.isFreeGift} error={Boolean(errs.disc)}
                            onChange={(e) => handleUpdateItemField(idx, 'discount', typedNumber(e.target.value))}
                            inputProps={cellProps('disc', { min: 0, max: 100, ...selectOnFocusProps })}
                            sx={{ ...cellInputSx(54), '& .MuiInputBase-input': { ...cellInputSx(54)['& .MuiInputBase-input'], color: '#dc2626' } }}
                          />
                        </Tooltip>
                      </TableCell>
                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        {canOverride ? (
                          <Tooltip title={errs.gst || (zeroTag ? `${zeroTag} — no GST on this line` : `GST ${fmtINR(t.gst)}`)} placement="top">
                            <TextField
                              size="small" type="number" value={zeroAsBlank(item.gst)} placeholder="0" error={Boolean(errs.gst)}
                              onChange={(e) => handleUpdateItemField(idx, 'gst', typedNumber(e.target.value))}
                              inputProps={cellProps('gst', { min: 0, max: 100, ...selectOnFocusProps })}
                              sx={cellInputSx(50)}
                            />
                          </Tooltip>
                        ) : (
                          <Typography variant="body2" sx={{ fontSize: '0.78rem', color: '#0f766e', fontWeight: 700 }}>{parseFloat(item.gst) || 0}%</Typography>
                        )}
                        <Stack direction="row" spacing={0.4} justifyContent="center" alignItems="center">
                          {zeroTag && <Typography variant="caption" data-testid="ws-zero-tax" sx={{ fontSize: '0.58rem', fontWeight: 800, color: '#0f766e' }}>{zeroTag}</Typography>}
                          <Box
                            component={canOverride ? 'button' : 'span'} type={canOverride ? 'button' : undefined} tabIndex={-1}
                            data-testid="ws-tax-mode" aria-label={`${item.taxInclusive ? 'Price includes tax' : 'Tax added on price'}${canOverride ? ' — click to switch' : ''}`}
                            onClick={canOverride ? () => setItemTaxMode(idx, !item.taxInclusive) : undefined}
                            sx={{ fontSize: '0.58rem', fontWeight: 800, color: item.taxInclusive ? '#7c3aed' : '#94a3b8', border: 0, bgcolor: 'transparent', p: 0, cursor: canOverride ? 'pointer' : 'default', fontFamily: 'inherit' }}
                          >
                            {item.taxInclusive ? 'incl.' : 'excl.'}
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: '900 !important', color: 'primary.main' }}>{fmtINR(t.total)}</TableCell>
                      <TableCell align="center" onClick={(e) => e.stopPropagation()} sx={{ whiteSpace: 'nowrap' }}>
                        <Tooltip title="Line details — free qty, batch, expiry, note">
                          <IconButton size="small" aria-label={`Details for ${item.name}`} aria-expanded={notesOpenIdx === idx} sx={{ p: 0.4 }} onClick={() => setNotesOpenIdx(notesOpenIdx === idx ? -1 : idx)}>
                            <DetailsIcon sx={{ fontSize: 16, color: notesOpenIdx === idx || item.notes || item.batch || item.expiry || parseFloat(item.freeQty) ? '#2563eb' : '#94a3b8' }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Remove line (Delete / Ctrl+Delete)">
                          <IconButton size="small" aria-label={`Remove ${item.name}`} sx={{ p: 0.4 }} onClick={() => requestRemoveRow(idx)}>
                            <DeleteIcon sx={{ fontSize: 16, color: '#dc2626' }} />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                    {notesOpenIdx === idx && (
                      <TableRow>
                        <TableCell colSpan={gridColCount} sx={{ bgcolor: '#ffffff', py: 1 }}>
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                            {!svc && (
                              <>
                                <TextField
                                  size="small" type="number" label="Free Qty" value={zeroAsBlank(item.freeQty)} placeholder="0" disabled={item.isFreeGift}
                                  onChange={(e) => handleUpdateItemField(idx, 'freeQty', Math.max(0, parseInt(e.target.value) || 0))}
                                  inputProps={{ ...selectOnFocusProps, style: { textAlign: 'center' } }}
                                  sx={{ width: 90, ...NO_SPIN_SX }}
                                />
                                <TextField size="small" label="Batch" value={item.batch} onChange={(e) => handleUpdateItemField(idx, 'batch', e.target.value)} sx={{ width: 120 }} />
                                <TextField
                                  size="small" type="date" label="Expiry" InputLabelProps={{ shrink: true }} value={item.expiry} error={expired}
                                  helperText={expired ? 'Expired' : nearExpiry ? 'Expires within 30 days' : ''}
                                  onChange={(e) => handleUpdateItemField(idx, 'expiry', e.target.value)} sx={{ width: 160 }}
                                />
                              </>
                            )}
                            <TextField size="small" label="Line note" placeholder="Printed with this line" value={item.notes} onChange={(e) => handleUpdateItemField(idx, 'notes', e.target.value)} sx={{ flex: 1, minWidth: 220 }} />
                            {!svc && getWarehouseStockText(item) && <Typography variant="caption" color="text.secondary">{getWarehouseStockText(item)}</Typography>}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        <Box sx={{ px: 1.5, py: 0.6, borderTop: '1px solid #e2e8f0', bgcolor: '#ffffff', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="caption" fontWeight={800} color="#475569">
            {summary.totalItems} line{summary.totalItems === 1 ? '' : 's'} · {summary.totalQty} unit{summary.totalQty === 1 ? '' : 's'}{summary.totalFreeQty ? ` + ${summary.totalFreeQty} free` : ''}
          </Typography>
          {cartItems.length > 0 && (() => {
            const allIncl = cartItems.every(it => it.taxInclusive);
            const allExcl = cartItems.every(it => !it.taxInclusive);
            return (
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Typography variant="caption" fontWeight={800} color="#475569">Rates</Typography>
                <ToggleButtonGroup
                  size="small" exclusive value={allIncl ? 'INCL' : allExcl ? 'EXCL' : null}
                  onChange={(_, v) => { if (v) setAllTaxMode(v === 'INCL'); }}
                  disabled={!canOverride} aria-label="Line prices include or exclude tax"
                  sx={{ '& .MuiToggleButton-root': { py: 0, px: 0.8, fontSize: '0.62rem', fontWeight: 800, textTransform: 'none' } }}
                >
                  <ToggleButton value="EXCL" data-testid="ws-rates-excl">Excl. tax</ToggleButton>
                  <ToggleButton value="INCL" data-testid="ws-rates-incl">Incl. tax</ToggleButton>
                </ToggleButtonGroup>
                {!allIncl && !allExcl && <Typography variant="caption" color="text.secondary">mixed</Typography>}
              </Stack>
            );
          })()}
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            <Kbd>Enter</Kbd> next cell · <Kbd>↑</Kbd><Kbd>↓</Kbd> rows · <Kbd>+</Kbd><Kbd>−</Kbd> qty · <Kbd>Ctrl+Del</Kbd> remove
          </Typography>
        </Box>
      </Card>

      {/* ============ SUMMARY · COUPON · PAYMENT · COMPLETE ============ */}
      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1, bgcolor: '#ffffff', borderColor: '#cbd5e1', mb: 1.5 }}>
        <Grid container spacing={1.5} alignItems="stretch">
          {/* Box 1: billing summary */}
          <Grid item xs={12} sm={6} md={2.4}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 0, bgcolor: '#ffffff', height: '100%' }}>
              <SumRow label="Total Quantity" value={`${summary.totalQty}${summary.totalFreeQty ? ` + ${summary.totalFreeQty}` : ''}`} />
              <SumRow label="Item Price (Gross)" value={fmtINR(summary.subtotal)} />
              <SumRow label="Item Discount" value={`−${fmtINR(summary.productDiscount)}`} color="#dc2626" />
              <SumRow label="Scheme Discount" value={`−${fmtINR(summary.schemeDiscount)}`} color="#dc2626" />
              <SumRow label="Taxable Amount" value={fmtINR(summary.taxableAmount)} />
              {summary.zeroTaxValue > 0 && <SumRow label="incl. 0% / Exempt Value" value={fmtINR(summary.zeroTaxValue)} color="#64748b" />}
              <Tooltip
                placement="right"
                title={summary.gstBreakup.length ? (
                  <Box sx={{ fontSize: '0.72rem' }}>
                    {summary.gstBreakup.map(b => (
                      <div key={b.rate}>{b.rate}%: {fmtINR(b.tax)} on {fmtINR(b.taxable)}{b.rate === 0 ? ' (zero tax)' : ''}</div>
                    ))}
                    {summary.taxableCharges > 0 && <div>Charges 18%: {fmtINR(summary.taxableCharges * 0.18)}</div>}
                  </Box>
                ) : ''}
              >
                <Box data-testid="ws-gst-row"><SumRow label="GST" value={fmtINR(summary.totalGst)} color="#0f766e" /></Box>
              </Tooltip>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.2 }}>
                <Button
                  size="small" onClick={() => setChargesOpen(v => !v)} aria-expanded={chargesOpen}
                  endIcon={chargesOpen ? <ExpandLessIcon sx={{ fontSize: 14 }} /> : <ExpandMoreIcon sx={{ fontSize: 14 }} />}
                  sx={{ p: 0, minWidth: 0, textTransform: 'none', fontSize: '0.72rem', fontWeight: 700, color: 'text.secondary' }}
                >
                  Additional Charges
                </Button>
                <Typography variant="body2" fontWeight={900} sx={{ fontSize: '0.8rem' }}>{fmtINR(summary.additionalCharges)}</Typography>
              </Stack>
              <Collapse in={chargesOpen}>
                <Stack spacing={0.5} sx={{ py: 0.5 }}>
                  {chargesList.map((c, idx) => (
                    <Stack direction="row" spacing={0.5} alignItems="center" key={c.name}>
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontSize: '0.66rem' }}>{c.name.replace(' Charge', '')}</Typography>
                      <Chip
                        label={c.taxable ? 'GST' : 'No GST'} size="small" clickable
                        onClick={() => setChargesList(prev => prev.map((p, pi) => pi === idx ? { ...p, taxable: !p.taxable } : p))}
                        sx={{ height: 18, fontSize: '0.58rem', fontWeight: 800, bgcolor: c.taxable ? '#eef2ff' : '#f1f5f9', color: c.taxable ? '#4f46e5' : '#64748b' }}
                      />
                      <TextField
                        size="small" type="number" placeholder="0" value={c.amount}
                        onChange={(e) => setChargesList(prev => prev.map((p, pi) => pi === idx ? { ...p, amount: e.target.value } : p))}
                        inputProps={{ 'aria-label': `${c.name} amount`, min: 0, ...selectOnFocusProps }}
                        sx={cellInputSx(72)}
                      />
                    </Stack>
                  ))}
                </Stack>
              </Collapse>
              <SumRow label="Round Off" value={`${summary.roundOff >= 0 ? '+' : '−'}${fmtINR(Math.abs(summary.roundOff))}`} />
            </Paper>
          </Grid>

          {/* Box 2: Net Payable / Advance Paid / Balance */}
          <Grid item xs={12} sm={6} md={2.2}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 0, bgcolor: '#ffffff', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <Typography variant="caption" fontWeight={900} color="primary.main">Net Payable</Typography>
              <Typography variant="h5" fontWeight={900} color="primary.main" sx={{ lineHeight: 1.2, mb: 1 }}>{fmtINR(summary.grandTotal)}</Typography>
              <SumRow label="Advance Paid" value={fmtINR(totalPaid)} color="#15803d" />
              <SumRow label="Balance Due" value={fmtINR(balanceDue)} color={balanceDue > 0.009 ? '#dc2626' : '#15803d'} />
              {balanceDue > 0.009 && dueDate && <SumRow label="Due Date" value={dueDate} color="#b45309" />}
              <Chip
                size="small" label={paymentStatusLabel}
                sx={{ mt: 0.75, alignSelf: 'flex-start', height: 20, fontSize: '0.64rem', fontWeight: 800, bgcolor: balanceDue <= 0.009 && cartItems.length ? '#dcfce7' : '#fef2f2', color: balanceDue <= 0.009 && cartItems.length ? '#15803d' : '#b91c1c' }}
              />
            </Paper>
          </Grid>

          {/* Box 3: Coupon + Payment Mode */}
          <Grid item xs={12} sm={6} md={2.6}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 0, bgcolor: '#ffffff', height: '100%' }}>
              <Stack direction="row" spacing={0.75} alignItems="flex-start" data-nav-own>
                <TextField
                  fullWidth size="small" id="ws-coupon" label="Coupon Code" placeholder="Scheme code / name"
                  value={couponInput} error={Boolean(couponError)} helperText={couponError || ''}
                  onChange={(e) => { setCouponInput(e.target.value); setCouponError(''); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (!e.repeat) handleApplyCoupon(); }
                    else if (e.key === 'ArrowDown') { e.preventDefault(); focusPayment(); }
                  }}
                  InputProps={{ endAdornment: <InputAdornment position="end"><Kbd>Ctrl+U</Kbd></InputAdornment> }}
                  inputProps={{ style: { fontWeight: 800, fontSize: '0.8rem' } }}
                  FormHelperTextProps={{ sx: { mx: 0, fontSize: '0.62rem' } }}
                />
                <Button variant="contained" size="small" onClick={handleApplyCoupon} sx={{ bgcolor: NAVY, color: '#facc15', fontWeight: 900, textTransform: 'none', py: 0.85, '&:hover': { bgcolor: '#1e293b' } }}>
                  Apply
                </Button>
              </Stack>
              <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 1, mb: 0.5 }}>
                <Typography variant="caption" fontWeight={900} color="text.secondary">Payment Mode</Typography>
                <Kbd>Ctrl+M</Kbd>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.62rem' }}>← → to switch</Typography>
              </Stack>
              <ToggleButtonGroup
                id="ws-pay-mode" value={payMode} exclusive fullWidth size="small" disabled={paymentLocked}
                onChange={(e, v) => { if (v) setPayMode(v); }}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  const modes = PAY_MODE_BUTTONS.map(([v]) => v);
                  const i = modes.indexOf(payMode);
                  const next = modes[(i + (e.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length];
                  setPayMode(next);
                  setTimeout(() => document.querySelector(`#ws-pay-mode [data-pay-mode="${next}"]`)?.focus(), 0);
                }}
                sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5, '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 800, fontSize: '0.72rem', py: 0.4, border: '1px solid #cbd5e1 !important', borderRadius: '8px !important', '&.Mui-selected': { bgcolor: '#2563eb', color: '#fff', '&:hover': { bgcolor: '#1d4ed8' } } } }}
              >
                {PAY_MODE_BUTTONS.map(([val, label]) => (
                  <ToggleButton key={val} value={val} data-pay-mode={val} {...(val === payMode ? { 'data-nav-stop': 'advance' } : { tabIndex: -1 })}>{label}</ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Paper>
          </Grid>

          {/* Box 4: details for the chosen payment mode */}
          <Grid item xs={12} sm={6} md={2.6}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 0, bgcolor: '#ffffff', height: '100%' }}>
              {paymentLocked && (
                <Stack spacing={0.5}>
                  <Typography variant="caption" fontWeight={900} color="text.secondary">Payment on this invoice ({editing.payMode})</Typography>
                  <SummaryLine label="Already received" value={fmtINR(editing.originalPaid)} valueColor="#15803d" dense />
                  <SummaryLine label="Due before edit" value={fmtINR(editing.originalDue)} dense />
                  <SummaryLine label="Due after edit" value={fmtINR(balanceDue)} valueColor={balanceDue > 0.009 ? '#dc2626' : '#15803d'} dense />
                  {changeDue > 0.009 && <SummaryLine label="Received over new total" value={fmtINR(changeDue)} valueColor="#b45309" dense />}
                  <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
                    Receipts already recorded stay as they are. Collect any extra with Ledger → Record Payment{changeDue > 0.009 ? '; refund the excess from Accounts' : ''}.
                  </Typography>
                </Stack>
              )}
              {!paymentLocked && payMode === 'Cash' && (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={0.75} alignItems="flex-start">
                    <TextField
                      fullWidth size="small" id="ws-amount-paid" type="number" label="Amount Paid (Cash) ₹" InputLabelProps={{ shrink: true }}
                      disabled={cashUnpaid}
                      placeholder={String(summary.grandTotal)} value={cashUnpaid ? '' : amountReceived} onChange={(e) => setAmountReceived(e.target.value)}
                      error={amountReceived !== '' && !(parseFloat(amountReceived) >= 0)}
                      inputProps={{ min: 0, ...selectOnFocusProps, style: { fontWeight: 900, color: '#15803d', textAlign: 'center' } }} sx={NO_SPIN_SX}
                    />
                    <Button size="small" variant="outlined" disabled={cashUnpaid} onClick={() => setAmountReceived(String(summary.grandTotal))} sx={{ textTransform: 'none', fontWeight: 800, py: 0.85, whiteSpace: 'nowrap' }}>Full</Button>
                  </Stack>
                  <PaymentModeDetails method="Cash" cashStatus={cashStatus} onCashStatusChange={setCashStatus} />
                  <Typography variant="caption" color="text.secondary">{cashUnpaid ? "Cash not received — the full amount goes on the dealer's credit." : "Leave blank or part-pay to put the balance on the dealer's credit."}</Typography>
                </Stack>
              )}
              {!paymentLocked && (payMode === 'UPI' || payMode === 'Card') && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" label="Amount Paid ₹" InputLabelProps={{ shrink: true }} value={summary.grandTotal} InputProps={{ readOnly: true }} inputProps={{ tabIndex: -1, style: { textAlign: 'center' } }} />
                  <TextField fullWidth size="small" label="Reference / Txn ID" InputLabelProps={{ shrink: true }} placeholder={payMode === 'UPI' ? 'UPI ref' : 'Approval code'} value={refNo} onChange={(e) => setRefNo(e.target.value)} />
                  {payMode === 'UPI' && <PaymentModeDetails method="UPI" bankAccount={payBankAccount} onBankAccountChange={(id) => setPayBankAccount(id || '')} />}
                </Stack>
              )}
              {!paymentLocked && payMode === 'Bank Transfer' && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" label="Reference / Cheque No" InputLabelProps={{ shrink: true }} placeholder="NEFT / RTGS ref" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
                  <PaymentModeDetails method="Bank Transfer" bankAccount={payBankAccount} onBankAccountChange={(id) => setPayBankAccount(id || '')} />
                  <Typography variant="caption" color="text.secondary">Bank transfers stay due until the receipt is recorded against the dealer.</Typography>
                </Stack>
              )}
              {!paymentLocked && payMode === 'Split Payment' && (
                <Stack spacing={0.75}>
                  {splitPayments.map((sp, i) => (
                    <Stack direction="row" spacing={0.5} key={i} alignItems="center">
                      <TextField select size="small" value={sp.mode} onChange={(e) => setSplitPayments(prev => prev.map((p, pi) => pi === i ? { ...p, mode: e.target.value } : p))} SelectProps={enterOpensSelectProps} sx={{ width: 108, '& .MuiSelect-select': { fontSize: '0.75rem', py: 0.6 } }}>
                        {SPLIT_PAYMENT_MODES.map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
                      </TextField>
                      <TextField fullWidth size="small" type="number" placeholder="Amount" value={sp.amount} onChange={(e) => setSplitPayments(prev => prev.map((p, pi) => pi === i ? { ...p, amount: e.target.value } : p))} inputProps={{ 'aria-label': `Split ${i + 1} amount`, min: 0, ...selectOnFocusProps }} sx={cellInputSx('100%')} />
                      <IconButton size="small" aria-label="Remove split row" disabled={splitPayments.length <= 1} onClick={() => setSplitPayments(prev => prev.filter((_, pi) => pi !== i))}><DeleteIcon sx={{ fontSize: 15 }} /></IconButton>
                    </Stack>
                  ))}
                  {splitPayments.map((sp, i) => needsBank(sp.mode) && (
                    <Stack direction="row" spacing={0.5} key={`bank-${i}`} alignItems="center">
                      <Typography variant="caption" fontWeight={700} sx={{ width: 108, flexShrink: 0 }}>{sp.mode === 'UPI' ? 'UPI bank' : 'Bank'} (row {i + 1})</Typography>
                      <PaymentModeDetails compact method={sp.mode} bankAccount={sp.bankAccount || ''}
                        onBankAccountChange={(id) => setSplitPayments(prev => prev.map((p, pi) => pi === i ? { ...p, bankAccount: id || '' } : p))}
                        sx={{ flex: 1 }} />
                    </Stack>
                  ))}
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Button size="small" onClick={() => setSplitPayments(prev => [...prev, { mode: 'Cash', amount: '' }])} sx={{ textTransform: 'none', fontWeight: 800, p: 0 }}>+ Add mode</Button>
                    <Typography variant="caption" fontWeight={800} sx={{ color: Math.abs(splitTotal - summary.grandTotal) <= 0.5 ? '#15803d' : '#dc2626' }}>
                      {fmtINR(splitTotal)} / {fmtINR(summary.grandTotal)}
                    </Typography>
                  </Stack>
                  {splitCreditAmount > 0 && <Typography variant="caption" color="text.secondary">{fmtINR(splitCreditAmount)} as Credit goes to the dealer's outstanding.</Typography>}
                </Stack>
              )}
              {!paymentLocked && payMode === 'Credit Sale' && (
                <Stack spacing={0.75}>
                  <TextField select fullWidth size="small" label="Payment Terms" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} SelectProps={enterOpensSelectProps}>
                    {[15, 30, 45, 60].map(d => <MenuItem key={d} value={d}>{d} Days</MenuItem>)}
                  </TextField>
                  {selectedCustomer ? (
                    <Box sx={{ p: 0.75, borderRadius: 0, bgcolor: '#ffffff', border: '1px solid #e2e8f0' }}>
                      <SummaryLine label="Previous Outstanding" value={fmtINR(selectedCustomer.outstanding)} dense />
                      <SummaryLine label="New Outstanding" value={fmtINR((parseFloat(selectedCustomer.outstanding) || 0) + summary.grandTotal)} valueColor="#dc2626" dense />
                      <SummaryLine label="Credit Limit" value={fmtINR(selectedCustomer.creditLimit)} dense />
                      <SummaryLine label="Available Credit" value={fmtINR(availableCredit)} valueColor="#059669" dense />
                    </Box>
                  ) : (
                    <Typography variant="caption" color="text.secondary">Select a dealer to see available credit.</Typography>
                  )}
                  {selectedCustomer && summary.grandTotal > availableCredit && (
                    <Alert severity="warning" sx={{ borderRadius: 2, py: 0, fontSize: '0.7rem', fontWeight: 700 }}>
                      Exceeds available credit by {fmtINR(summary.grandTotal - availableCredit)}.
                    </Alert>
                  )}
                </Stack>
              )}
            </Paper>
          </Grid>

          {/* Box 5: totals + Show Bill + Complete */}
          <Grid item xs={12} sm={12} md={2.2}>
            <Stack spacing={0.75} sx={{ height: '100%', justifyContent: 'space-between' }}>
              <Box sx={{ px: 0.5 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="caption" fontWeight={900}>Total Paid</Typography>
                  <Typography variant="subtitle1" fontWeight={900} color="success.main">{fmtINR(totalPaid)}</Typography>
                </Stack>
                {changeDue > 0.009 ? (
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="caption" fontWeight={900} color="warning.dark">Change Due</Typography>
                    <Typography variant="subtitle1" fontWeight={900} color="warning.dark">{fmtINR(changeDue)}</Typography>
                  </Stack>
                ) : (
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="caption" fontWeight={900} color={balanceDue > 0.009 ? 'error.main' : 'success.main'}>Balance Due</Typography>
                    <Typography variant="subtitle1" fontWeight={900} color={balanceDue > 0.009 ? 'error.main' : 'success.main'}>{fmtINR(balanceDue)}</Typography>
                  </Stack>
                )}
              </Box>
              <Button
                fullWidth variant="outlined" size="small" onClick={handleShowBill} startIcon={<BillIcon />}
                sx={{ fontWeight: 900, py: 0.6, borderRadius: 1, textTransform: 'none', bgcolor: '#fff' }}
              >
                Show Bill&nbsp;<Kbd>Ctrl+P</Kbd>
              </Button>
              <Button
                fullWidth variant="contained" color="success" size="medium" id="ws-complete-sale"
                disabled={savingInvoice || cartItems.length === 0}
                onClick={() => handleAttemptCompleteSale()}
                startIcon={savingInvoice ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : <CheckedIcon />}
                sx={{ fontWeight: 900, py: 0.9, borderRadius: 1, textTransform: 'none', lineHeight: 1.2 }}
              >
                <Box sx={{ textAlign: 'left' }}>
                  {savingInvoice ? 'Saving…' : paymentLocked ? `Save Changes to ${editing.invoiceNo}` : 'Complete Wholesale Invoice'}
                  <Box sx={{ mt: 0.25 }}><Kbd dark>Ctrl+Enter</Kbd></Box>
                </Box>
              </Button>
              <Stack direction="row" spacing={0.75}>
                <Button fullWidth size="small" variant="outlined" disabled={cartItems.length === 0} onClick={handleSaveDraft} sx={{ fontWeight: 800, textTransform: 'none', bgcolor: '#fff', px: 0.5 }}>
                  Draft&nbsp;<Kbd>Alt+S</Kbd>
                </Button>
                <Button fullWidth size="small" variant="outlined" color="warning" disabled={cartItems.length === 0} onClick={handleHoldInvoice} sx={{ fontWeight: 800, textTransform: 'none', bgcolor: '#fff', px: 0.5 }}>
                  Hold&nbsp;<Kbd>Alt+H</Kbd>
                </Button>
              </Stack>
            </Stack>
          </Grid>
        </Grid>
      </Paper>

      {/* ============ DELIVERY · PACKING & DISPATCH · NOTES ============ */}
      <Grid container spacing={1.5} alignItems="flex-start">
        <Grid item xs={12} md={5}>
          <Paper variant="outlined" sx={PANEL_SX}>
            <SectionTitle
              icon={<DeliveryIcon sx={{ fontSize: 18, color: '#2563eb' }} />} title="Delivery" kbd="Alt+D"
              right={<Chip label={`Status: ${orderStatus}`} size="small" sx={{ height: 20, fontSize: '0.64rem', fontWeight: 800, bgcolor: (ORDER_STATUS_COLORS[orderStatus] || ORDER_STATUS_COLORS.Confirmed).bg, color: (ORDER_STATUS_COLORS[orderStatus] || ORDER_STATUS_COLORS.Confirmed).color }} />}
            />
            <ToggleButtonGroup
              value={delivery.type} exclusive size="small" fullWidth
              onChange={(e, v) => { if (v) setDelivery({ ...delivery, type: v }); }}
              // The selected option is one stop in the Enter / arrow chain; Left/Right switch type.
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const i = DELIVERY_TYPES.indexOf(delivery.type);
                const next = DELIVERY_TYPES[(i + (e.key === 'ArrowRight' ? 1 : -1) + DELIVERY_TYPES.length) % DELIVERY_TYPES.length];
                setDelivery({ ...delivery, type: next });
                setTimeout(() => document.querySelector(`[data-delivery-type="${next}"]`)?.focus(), 0);
              }}
              sx={{ mb: 1.25, '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 800, fontSize: '0.72rem', py: 0.35, border: '1px solid #cbd5e1 !important', '&.Mui-selected': { bgcolor: '#2563eb', color: '#fff', '&:hover': { bgcolor: '#1d4ed8' } } } }}
            >
              {DELIVERY_TYPES.map(t => (
                <ToggleButton key={t} value={t} data-delivery-type={t} {...(t === delivery.type ? { 'data-nav-stop': 'advance' } : { tabIndex: -1 })}>{t}</ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Grid container spacing={1}>
              {delivery.type !== 'Pickup' && (
                <Grid item xs={12} sm={6}>
                  <QuickDatePickerField label="Expected Delivery Date" value={delivery.expectedDate} onChange={(v) => setDelivery({ ...delivery, expectedDate: v })} />
                </Grid>
              )}
              <Grid item xs={12} sm={delivery.type === 'Pickup' ? 12 : 6}>
                <TextField
                  fullWidth size="small" multiline minRows={1} id="ws-ship-address" label="Shipping Address" value={delivery.address}
                  onChange={(e) => setDelivery({ ...delivery, address: e.target.value })}
                  disabled={delivery.type === 'Pickup' || (!addressEditUnlocked && !canOverride)}
                  error={delivery.type !== 'Pickup' && !String(delivery.address || '').trim()}
                  helperText={delivery.type === 'Pickup' ? 'Not needed for pickup' : (selectedCustomer?.shippingAddress ? 'Auto-filled from dealer shipping address' : 'Required for delivery')}
                  InputProps={canOverride && delivery.type !== 'Pickup' ? {
                    endAdornment: <IconButton size="small" aria-label="Unlock address" onClick={() => setAddressEditUnlocked(v => !v)}><LockIcon sx={{ fontSize: 14, color: addressEditUnlocked ? '#4f46e5' : '#cbd5e1' }} /></IconButton>,
                  } : undefined}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField fullWidth size="small" multiline minRows={1} label="Delivery Notes" value={delivery.notes} onChange={(e) => setDelivery({ ...delivery, notes: e.target.value })} />
              </Grid>
            </Grid>
          </Paper>
        </Grid>

        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ ...PANEL_SX, p: 0, overflow: 'hidden' }}>
            <Button
              fullWidth onClick={() => setPackingOpen(v => !v)} aria-expanded={packingOpen} aria-controls="ws-packing-panel"
              sx={{ justifyContent: 'space-between', textTransform: 'none', px: 1.5, py: 1.1, color: NAVY, borderRadius: 0 }}
              endIcon={packingOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            >
              <Stack direction="row" spacing={0.75} alignItems="center">
                <PackingIcon sx={{ fontSize: 18, color: '#2563eb' }} />
                <Typography variant="subtitle2" fontWeight={900} sx={{ fontSize: '0.82rem' }}>Packing &amp; Dispatch</Typography>
                <Kbd>Alt+P</Kbd>
                <Chip label={orderStatus} size="small" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 800, bgcolor: (ORDER_STATUS_COLORS[orderStatus] || ORDER_STATUS_COLORS.Confirmed).bg, color: (ORDER_STATUS_COLORS[orderStatus] || ORDER_STATUS_COLORS.Confirmed).color }} />
              </Stack>
            </Button>
            <Collapse in={packingOpen} id="ws-packing-panel">
              <Box sx={{ px: 1.5, pb: 1.5 }}>
                <Grid container spacing={1}>
                  <Grid item xs={6}>
                    <TextField fullWidth size="small" type="number" id="ws-pack-packages" label="No. of Packages" value={packing.packages} onChange={(e) => setPacking({ ...packing, packages: e.target.value })} inputProps={{ ...selectOnFocusProps, style: { textAlign: 'center' } }} sx={NO_SPIN_SX} />
                  </Grid>
                  <Grid item xs={6}>
                    <TextField fullWidth size="small" type="number" label="Total Weight (kg)" value={packing.weight} onChange={(e) => setPacking({ ...packing, weight: e.target.value })} inputProps={{ ...selectOnFocusProps, style: { textAlign: 'center' } }} sx={NO_SPIN_SX} />
                  </Grid>
                  <Grid item xs={6}>
                    <TextField fullWidth size="small" label="Packed By" value={packing.packedBy} onChange={(e) => setPacking({ ...packing, packedBy: e.target.value })} />
                  </Grid>
                  <Grid item xs={6}>
                    <QuickDatePickerField label="Packing Date" value={packing.packingDate} onChange={(v) => setPacking({ ...packing, packingDate: v })} />
                  </Grid>
                  <Grid item xs={12}>
                    <TextField select fullWidth size="small" label="Packing / Dispatch Status" value={orderStatus} onChange={(e) => setOrderStatus(e.target.value)} SelectProps={enterOpensSelectProps}>
                      {ORDER_STATUSES.filter(st => st !== 'Cancelled').map(st => <MenuItem key={st} value={st}>{st}</MenuItem>)}
                    </TextField>
                  </Grid>
                  {(delivery.type === 'Courier' || delivery.type === 'Transport') ? (
                    <>
                      <Grid item xs={6}>
                        <TextField fullWidth size="small" label={delivery.type === 'Courier' ? 'Courier Name' : 'Transporter'} value={delivery.courierName} onChange={(e) => setDelivery({ ...delivery, courierName: e.target.value })} />
                      </Grid>
                      <Grid item xs={6}>
                        <TextField fullWidth size="small" label="Tracking / LR No." value={delivery.trackingNo} onChange={(e) => setDelivery({ ...delivery, trackingNo: e.target.value })} />
                      </Grid>
                    </>
                  ) : (
                    <Grid item xs={12}>
                      <Typography variant="caption" color="text.secondary">Courier / transporter and tracking (LR) number appear here for Courier or Transport delivery.</Typography>
                    </Grid>
                  )}
                </Grid>
              </Box>
            </Collapse>
          </Paper>
        </Grid>

        <Grid item xs={12} md={3}>
          <Paper variant="outlined" sx={PANEL_SX}>
            <SectionTitle icon={<NoteIcon sx={{ fontSize: 18, color: '#2563eb' }} />} title="Notes & Attachments" />
            <Stack spacing={1}>
              <TextField fullWidth size="small" multiline minRows={1} label="Dealer note (printed)" value={notesState.customer} onChange={(e) => setNotesState({ ...notesState, customer: e.target.value })} />
              <TextField fullWidth size="small" multiline minRows={1} label="Internal note" value={notesState.internal} onChange={(e) => setNotesState({ ...notesState, internal: e.target.value })} />
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {NOTE_TEMPLATES.map(t => <Chip key={t} label={t} size="small" clickable onClick={() => applyNoteTemplate(t)} sx={{ fontWeight: 600, fontSize: '0.64rem', height: 20 }} />)}
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {['Dealer PO', 'Delivery Document', 'Transport Document', 'Other'].map(cat => (
                  <Button key={cat} size="small" variant="outlined" component="label" startIcon={<AttachFileIcon sx={{ fontSize: 14 }} />} sx={{ fontWeight: 700, textTransform: 'none', fontSize: '0.66rem', py: 0.1 }}>
                    {cat}
                    <input type="file" hidden onChange={(e) => handleAttachFile(e, cat)} />
                  </Button>
                ))}
              </Stack>
              {attachments.map((a, idx) => (
                <Stack key={idx} direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 0.75, border: '1px solid #e2e8f0' }}>
                  <Typography variant="caption" noWrap sx={{ maxWidth: 200 }}>{a.category}: {a.name}</Typography>
                  <IconButton size="small" aria-label={`Remove ${a.name}`} onClick={() => handleRemoveAttachment(idx)}><DeleteIcon sx={{ fontSize: 14 }} /></IconButton>
                </Stack>
              ))}
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      {/* ============ DIALOGS ============ */}
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
        onEdit={(o) => startEditInvoice(o)}
      />
      <BulkAddDialog
        open={bulkAddOpen} products={products} onClose={() => setBulkAddOpen(false)} onAdd={handleBulkAdd}
        priceFor={(p) => priceForProduct(p).rate} canEditPrice={canOverride}
      />
      <ExcelImportDialog open={excelImportOpen} onClose={() => setExcelImportOpen(false)} onImport={handleExcelImport} />
      <SchemeDialog open={schemeOpen} onClose={() => setSchemeOpen(false)} dealer={selectedCustomer} schemes={schemes} products={products} invoiceDiscount={invoiceDiscount} onApply={handleApplyScheme} />
      <CreditNoteDialog open={creditNoteOpen} invoice={printableInvoice} onClose={() => setCreditNoteOpen(false)} onCreate={handleCreateCreditNote} />
      <CompletionDialog
        open={completionOpen} invoice={printableInvoice}
        onPrint={() => { setPreviewDoc(null); setPrintModalOpen(true); }}
        onDownloadPdf={() => downloadPdfInvoice(printableInvoice, 'WHOLESALE_BILL')}
        onSend={() => showToast(`Invoice ${printableInvoice?.invoiceNo} queued for sending.`, 'success')}
        onView={() => { setPreviewDoc(null); setPrintModalOpen(true); }}
        onNewSale={() => { setCompletionOpen(false); setSelectedCustomer(null); setTimeout(() => focusById('ws-dealer-search'), 120); }}
      />
      <ShortcutHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* "New Item" — the Inventory product master (Lens mode on the Lens tab); the saved product
          lands in the live catalogue and is added to the bill automatically. */}
      <ProductMasterDialog
        open={newItemOpen && itemMode !== 'service'}
        onClose={() => { setNewItemOpen(false); setTimeout(() => focusSearch(), 80); }}
        defaultCategory={itemMode === 'lens' ? 'Prescription Lenses' : 'Frames'}
        onCreated={(rec) => { pendingNewItemRef.current = { barcode: rec?.barcode || '', code: rec?.code || rec?.sku || '' }; }}
      />
      <ServiceMasterDialog
        open={newItemOpen && itemMode === 'service'}
        onClose={() => { setNewItemOpen(false); setTimeout(() => focusSearch(), 80); }}
        onSaved={(rec) => {
          const svc = { id: String(rec.id), code: rec.code || '', name: rec.name, description: rec.description || '', price: parseFloat(rec.price ?? rec.defaultPrice ?? 0) || 0, gst: parseFloat(rec.taxRate ?? rec.taxPercentage ?? 0) || 0 };
          setServices(prev => [svc, ...prev.filter(x => x.id !== svc.id)]);
          setTimeout(() => addPickedItem(svc, 'service'), 120);
        }}
      />

      {/* Held invoices */}
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
                    <Typography variant="caption" color="text.secondary">Held at {held.heldAt} • {held.cartItems.length} Items • Total: {fmtINR(held.totalAmount)}</Typography>
                  </Box>
                  <Button variant="contained" size="small" onClick={() => handleResumeHeldInvoice(held)} sx={{ fontWeight: 700 }}>Resume</Button>
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => setHeldModalOpen(false)}>Close</Button></DialogActions>
      </Dialog>

      {/* Complete confirmation — the validation step before anything is saved. Enter confirms
          (the confirm button has focus), Esc cancels. Carries the credit-limit override too. */}
      <Dialog open={completeConfirmOpen} onClose={() => { if (!savingInvoice) { setCompleteConfirmOpen(false); printAfterSaveRef.current = false; } }} maxWidth="xs" fullWidth PaperProps={{ ...navScopeProps, sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 900, pb: 1 }}>{paymentLocked ? `Save changes to ${editing.invoiceNo}?` : 'Complete Wholesale Invoice?'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={0.5}>
            <SummaryLine label="Invoice No." value={invoiceNo} dense />
            <SummaryLine label="Dealer" value={selectedCustomer?.name || '—'} dense />
            <SummaryLine label="Lines / Qty" value={`${summary.totalItems} / ${summary.totalQty}${summary.totalFreeQty ? ` + ${summary.totalFreeQty} free` : ''}`} dense />
            <SummaryLine label="Payment Mode" value={payMode} dense />
            <Divider sx={{ my: 0.5 }} />
            {paymentLocked && <SummaryLine label="Total before edit" value={fmtINR(editing.originalTotal)} dense />}
            <SummaryLine label="Net Payable" value={fmtINR(summary.grandTotal)} valueColor="#2563eb" />
            <SummaryLine label="Paid Now" value={fmtINR(totalPaid)} valueColor="#15803d" />
            <SummaryLine label="Balance Due (dealer credit)" value={fmtINR(balanceDue)} valueColor={balanceDue > 0.009 ? '#dc2626' : '#15803d'} />
            {delivery.type !== 'Pickup' && <SummaryLine label="Delivery" value={delivery.type} dense />}
          </Stack>
          {isCreditExceeded && (
            <Alert severity="warning" sx={{ mt: 1.5, borderRadius: 2, fontWeight: 700 }}>
              This pushes {selectedCustomer?.name}'s outstanding to {fmtINR((parseFloat(selectedCustomer?.outstanding || 0)) + (payMode === 'Split Payment' ? splitCreditAmount : summary.grandTotal))}, over the credit limit of {fmtINR(selectedCustomer?.creditLimit || 0)}. Confirming overrides the limit.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 2, py: 1.5, gap: 1 }}>
          <Button onClick={() => { setCompleteConfirmOpen(false); printAfterSaveRef.current = false; }} disabled={savingInvoice}>Back (Esc)</Button>
          <Button variant="outlined" disabled={savingInvoice} onClick={() => { printAfterSaveRef.current = true; executeCompleteSale(); }} startIcon={<PrintIcon />}>{paymentLocked ? 'Save' : 'Complete'} &amp; Print</Button>
          <Button
            variant="contained" color={isCreditExceeded ? 'warning' : 'success'} autoFocus disabled={savingInvoice}
            onClick={() => executeCompleteSale()} sx={{ fontWeight: 900 }}
          >
            {isCreditExceeded ? (paymentLocked ? 'Override & Save' : 'Override & Complete') : (paymentLocked ? 'Save Changes' : 'Complete')} (Enter)
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmActionDialog
        open={removeConfirmIdx >= 0} title="Remove this line?" type="danger" confirmText="Remove"
        message={removeConfirmIdx >= 0 && cartItems[removeConfirmIdx] ? `Remove "${cartItems[removeConfirmIdx].name}" (qty ${cartItems[removeConfirmIdx].qty}) from the cart?` : ''}
        onClose={() => setRemoveConfirmIdx(-1)}
        onConfirm={confirmRemoveRow}
      />
      <ConfirmActionDialog
        open={clearCartConfirmOpen} title="Clear Wholesale POS Cart?"
        message="Are you sure you want to clear all products from the current POS cart?"
        type="warning" confirmText="Yes, Clear Cart"
        onClose={() => setClearCartConfirmOpen(false)}
        onConfirm={() => { setClearCartConfirmOpen(false); handleClearCart(); setTimeout(() => focusSearch(), 80); }}
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

      {/* Show Bill / print preview — rendered by the shared Bill Rendering Engine (template assigned
          to WHOLESALE_BILL in Settings → Bill & Invoice Designer). An unsaved cart preview has no
          print/share actions: it is not an invoice yet. */}
      <Dialog open={printModalOpen} onClose={() => setPrintModalOpen(false)} maxWidth="md" fullWidth TransitionProps={{ onExited: () => setPreviewDoc(null) }}>
        <DialogTitle sx={{ fontWeight: 850, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <span>{previewDoc ? `Bill Preview — ${previewDoc.invoiceNo} (not saved yet)` : `Wholesale Tax Invoice #${printableInvoice?.invoiceNo || ''}`}</span>
          {!previewDoc && printableInvoice && (
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" startIcon={<WhatsAppIcon />} onClick={() => showToast('Shared via WhatsApp', 'success')}>WhatsApp</Button>
              <Button size="small" variant="outlined" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(printableInvoice, 'WHOLESALE_BILL')}>PDF</Button>
              {printableInvoice.status !== 'Cancelled' && printableInvoice.orderStatus !== 'Cancelled' && (
                <Button size="small" variant="outlined" startIcon={<EditIcon />} disabled={loadingEdit} onClick={() => startEditInvoice(printableInvoice)}>Edit Bill</Button>
              )}
              <Button size="small" variant="contained" startIcon={<PrintIcon />} onClick={() => printBill({ doc: printableInvoice, documentType: 'WHOLESALE_BILL' })}>Print</Button>
            </Stack>
          )}
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#eef2f7', py: 3 }}>
          {billDoc && (<BillPreview doc={billDoc} documentType="WHOLESALE_BILL" maxWidth={720} />)}
        </DialogContent>
        <DialogActions><Button onClick={() => setPrintModalOpen(false)}>Close (Esc)</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
