import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import {
  Box, Grid, Card, Typography, TextField, Button, MenuItem,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, IconButton, Stack, Divider, Chip, Autocomplete, Alert, Tooltip,
  Dialog, DialogTitle, DialogContent, DialogActions, Badge,
  Menu, Checkbox, FormControlLabel
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Search as SearchIcon,
  Business as SupplierIcon,
  Print as PrintIcon,
  Save as SaveIcon,
  Close as CloseIcon,
  AttachFile as AttachFileIcon,
  Inbox as EmptyIcon,
  NoteAdd as DraftIcon,
  ListAlt as ListAltIcon,
  ViewColumn as ViewColumnIcon
} from '@mui/icons-material';
import QuickDatePickerField from '../common/QuickDatePickerField';
import ProductMasterDialog from '../inventory/ProductMasterDialog';
import { useDebounce } from '../../hooks/useDebounce';
import useBarcodeScanner from '../../hooks/useBarcodeScanner';
import { printPurchaseReceipt } from '../../utils/printPurchase';
import { barcodeMatchesProduct } from '../../utils/barcodeMatch';

const todayStr = () => new Date().toISOString().split('T')[0];
const genInvoiceNumber = () => `PINV-${Date.now().toString().slice(-8)}`;

// Backend product PKs are UUIDs. Products that only ever lived in the browser's
// localStorage inventory carry throwaway ids ("102", a timestamp, a barcode) that
// the API rejects as a foreign key — those rows need a real Product created first.
const isBackendId = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

const EDIT_ORDER = ['batchNumber', 'hsnCode', 'expiryDate', 'quantity', 'freeQuantity', 'purchaseRate', 'discountPercent', 'discountAmount', 'gstPercent', 'cessPercent', 'vatPercent', 'mrp', 'sellingPrice'];

// First two digits of a GSTIN are the state code. Comparing the company's and the
// supplier's tells us whether a purchase is intra-state (CGST+SGST) or inter-state (IGST).
const gstinStateCode = (gstin) => {
  const clean = (gstin || '').trim();
  return clean.length >= 2 ? clean.slice(0, 2) : null;
};

const blankRow = (product, overrides = {}, defaultGstPercent = 18, defaultCessPercent = 0, defaultVatPercent = 0) => {
  const rate = parseFloat(overrides.purchaseRate ?? product.costPrice ?? product.price ?? 0) || 0;
  const gstPercent = parseFloat(overrides.gstPercent ?? product.taxRate) || defaultGstPercent;
  const mrp = +(rate * 1.4).toFixed(2);
  return {
    rowId: `row-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    productId: product.id,
    productName: product.name,
    barcode: product.barcode || product.sku || '',
    currentStock: parseFloat(product.stock) || 0,
    lastRate: null,
    batchNumber: '',
    hsnCode: overrides.hsnCode ?? product.hsnCode ?? product.hsn_code ?? '',
    expiryDate: '',
    quantity: overrides.quantity ?? 1,
    freeQuantity: 0,
    purchaseRate: rate,
    discountPercent: 0,
    discountAmount: 0,
    gstPercent,
    gstAmount: 0,
    cessPercent: parseFloat(overrides.cessPercent ?? defaultCessPercent) || 0,
    cessAmount: 0,
    vatPercent: parseFloat(overrides.vatPercent ?? defaultVatPercent) || 0,
    vatAmount: 0,
    cgstPercent: 0,
    cgstAmount: 0,
    sgstPercent: 0,
    sgstAmount: 0,
    igstPercent: 0,
    igstAmount: 0,
    mrp,
    sellingPrice: mrp,
    marginPercent: rate > 0 ? +(((mrp - rate) / rate) * 100).toFixed(2) : 0,
    lineTotal: 0
  };
};

// Keeps discount/gst/margin/total consistent regardless of which cell was just edited
function recalcRow(row, changedField, gstType, isInterstate) {
  const r = { ...row };
  const qty = parseFloat(r.quantity) || 0;
  const rate = parseFloat(r.purchaseRate) || 0;
  const base = qty * rate;

  if (changedField === 'discountAmount') {
    r.discountPercent = base > 0 ? +((r.discountAmount / base) * 100).toFixed(2) : 0;
  } else {
    r.discountAmount = +((base * (parseFloat(r.discountPercent) || 0)) / 100).toFixed(2);
  }

  const taxable = Math.max(0, base - (parseFloat(r.discountAmount) || 0));
  const gstPercent = parseFloat(r.gstPercent) || 0;

  if (gstType === 'NO_GST') {
    r.gstAmount = 0;
    r.cgstPercent = 0; r.cgstAmount = 0;
    r.sgstPercent = 0; r.sgstAmount = 0;
    r.igstPercent = 0; r.igstAmount = 0;
  } else if (gstType === 'INCLUSIVE') {
    r.gstAmount = +((taxable - taxable / (1 + gstPercent / 100))).toFixed(2);
  } else {
    r.gstAmount = +((taxable * gstPercent) / 100).toFixed(2);
  }

  if (gstType !== 'NO_GST') {
    if (isInterstate) {
      r.igstPercent = gstPercent;
      r.igstAmount = r.gstAmount;
      r.cgstPercent = 0; r.cgstAmount = 0;
      r.sgstPercent = 0; r.sgstAmount = 0;
    } else {
      r.cgstPercent = +(gstPercent / 2).toFixed(2);
      r.sgstPercent = +(gstPercent / 2).toFixed(2);
      r.cgstAmount = +(r.gstAmount / 2).toFixed(2);
      r.sgstAmount = +(r.gstAmount - r.cgstAmount).toFixed(2);
      r.igstPercent = 0; r.igstAmount = 0;
    }
  }

  // Cess and VAT are always additive charges on top of the taxable value, regardless of GST type.
  const cessPercent = parseFloat(r.cessPercent) || 0;
  r.cessAmount = +((taxable * cessPercent) / 100).toFixed(2);

  const vatPercent = parseFloat(r.vatPercent) || 0;
  r.vatAmount = +((taxable * vatPercent) / 100).toFixed(2);

  r.lineTotal = gstType === 'INCLUSIVE'
    ? +(taxable + r.cessAmount + r.vatAmount).toFixed(2)
    : +(taxable + r.gstAmount + r.cessAmount + r.vatAmount).toFixed(2);

  if (changedField === 'marginPercent') {
    r.sellingPrice = rate > 0 ? +(rate * (1 + (parseFloat(r.marginPercent) || 0) / 100)).toFixed(2) : r.sellingPrice;
  } else if (changedField === 'sellingPrice' || changedField === 'purchaseRate' || changedField === 'quantity') {
    r.marginPercent = rate > 0 ? +((((parseFloat(r.sellingPrice) || 0) - rate) / rate) * 100).toFixed(2) : 0;
  }

  return r;
}

// Rebuilds an editable grid row from a saved PurchaseInvoiceItem (snake_case, string
// decimals) exactly as it was stored — the "Edit" flow must not silently alter any line.
const rowFromInvoiceItem = (it) => {
  const num = (v) => parseFloat(v) || 0;
  return {
    rowId: `row-${it.id || Date.now()}-${Math.floor(Math.random() * 10000)}`,
    productId: it.product,
    productName: it.product_name || 'Product',
    barcode: it.barcode || '',
    currentStock: 0,
    lastRate: null,
    batchNumber: it.batch_number || '',
    hsnCode: it.hsn_code || '',
    expiryDate: it.expiry_date || '',
    quantity: num(it.quantity),
    freeQuantity: num(it.free_quantity),
    purchaseRate: num(it.purchase_rate),
    discountPercent: num(it.discount_percent),
    discountAmount: num(it.discount_amount),
    gstPercent: num(it.gst_percent),
    gstAmount: num(it.gst_amount),
    cessPercent: num(it.cess_percent),
    cessAmount: num(it.cess_amount),
    vatPercent: num(it.vat_percent),
    vatAmount: num(it.vat_amount),
    cgstPercent: num(it.cgst_percent),
    cgstAmount: num(it.cgst_amount),
    sgstPercent: num(it.sgst_percent),
    sgstAmount: num(it.sgst_amount),
    igstPercent: num(it.igst_percent),
    igstAmount: num(it.igst_amount),
    mrp: num(it.mrp),
    sellingPrice: num(it.selling_price),
    marginPercent: num(it.margin_percent),
    lineTotal: num(it.line_total)
  };
};

export default function PurchaseEntryView({ suppliers = [], products = [], initialSupplierId = '', initialPurchaseOrderId = '', editInvoiceId = '', onSaveComplete, onRequestAddSupplier }) {
  const supplierInputRef = useRef(null);
  const dateInputRef = useRef(null);
  const productSearchRef = useRef(null);
  const paidAmountRef = useRef(null);
  const cellRefs = useRef({});

  // Header
  // Non-empty only while re-opening a saved entry from Purchase Order Reports → Edit.
  // When set, Save issues a PUT to that record instead of creating a new one.
  const [editingId, setEditingId] = useState('');
  const [editingLabel, setEditingLabel] = useState('');

  const [invoiceNumber, setInvoiceNumber] = useState(genInvoiceNumber());
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('');
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayStr());
  const [dueDate, setDueDate] = useState('');
  const [purchaseType, setPurchaseType] = useState('CASH');
  const [warehouseId, setWarehouseId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [gstType, setGstType] = useState('EXCLUSIVE');
  const [defaultGstPercent, setDefaultGstPercent] = useState(18);
  const [defaultCessPercent, setDefaultCessPercent] = useState(0);
  const [defaultVatPercent, setDefaultVatPercent] = useState(0);
  const [supplierVatNumber, setSupplierVatNumber] = useState('');
  const [status, setStatus] = useState('CONFIRMED');
  const [notes, setNotes] = useState('');
  const [poRef, setPoRef] = useState('');
  const [returnRef, setReturnRef] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [duplicateWarning, setDuplicateWarning] = useState(null);

  const [warehouses, setWarehouses] = useState([]);
  const [branches, setBranches] = useState([]);

  // Purchase Order conversion (PO -> goods received -> Purchase Entry)
  const [openPOs, setOpenPOs] = useState([]);
  const [linkedPO, setLinkedPO] = useState(null);

  // Product search
  const [productSearch, setProductSearch] = useState('');
  const debouncedSearch = useDebounce(productSearch, 150);

  // Grid
  const [rows, setRows] = useState([]);

  // Summary / Payment
  const [otherCharges, setOtherCharges] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [paidAmount, setPaidAmount] = useState(0);

  const [saving, setSaving] = useState(false);
  const [itemsDialogOpen, setItemsDialogOpen] = useState(false);
  const [addProductOpen, setAddProductOpen] = useState(false);

  const DEFAULT_COLUMN_VISIBILITY = {
    batch: true, hsn: true, expiry: true, free: true,
    discPercent: true, discAmt: true,
    gst: true, cess: true, vat: true,
    mrp: true, selling: true, marginPercent: true
  };
  const [columnMenuAnchor, setColumnMenuAnchor] = useState(null);
  const [colVis, setColVis] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('purchaseEntry_colVis'));
      return saved ? { ...DEFAULT_COLUMN_VISIBILITY, ...saved } : DEFAULT_COLUMN_VISIBILITY;
    } catch {
      return DEFAULT_COLUMN_VISIBILITY;
    }
  });
  useEffect(() => {
    try { localStorage.setItem('purchaseEntry_colVis', JSON.stringify(colVis)); } catch {}
  }, [colVis]);
  const toggleCol = (key) => setColVis(prev => ({ ...prev, [key]: !prev[key] }));

  const allSuppliers = useMemo(() => {
    const map = new Map();
    suppliers.forEach(s => map.set(s.id, s));
    return Array.from(map.values());
  }, [suppliers]);

  const selectedSupplier = allSuppliers.find(s => String(s.id) === String(selectedSupplierId));

  const supplierNames = useMemo(
    () => Array.from(new Set(allSuppliers.map(s => s.name || s.company_name).filter(Boolean))),
    [allSuppliers]
  );

  // A product just created through the inline Product Master dialog — drop it straight
  // into the purchase grid so the user can carry on entering the invoice line.
  const handleProductMasterCreated = (p) => {
    if (!p) return;
    addProductToGrid({
      id: String(p.id),
      name: p.name,
      sku: p.code || '',
      barcode: p.barcode || '',
      costPrice: parseFloat(p.purchasePrice) || 0,
      price: parseFloat(p.sellingPrice) || 0,
      stock: parseInt(p.stock) || 0,
      taxRate: parseFloat(p.gst) || defaultGstPercent,
      hsnCode: p.hsnCode || ''
    });
  };

  const companyGstin = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('optical_app_settings') || '{}').gstin || '';
    } catch (e) { return ''; }
  }, []);
  const supplierGstin = selectedSupplier?.gstin || '';
  // Interstate (IGST) vs intra-state (CGST+SGST) is derived from the GSTIN state-code
  // prefix; if either GSTIN is missing we can't tell, so default to intra-state.
  const isInterstate = Boolean(
    gstinStateCode(companyGstin) && gstinStateCode(supplierGstin) &&
    gstinStateCode(companyGstin) !== gstinStateCode(supplierGstin)
  );

  // GST/CGST/SGST/IGST/Cess columns only make sense when GST actually applies to this
  // purchase — hide them entirely for No GST rather than showing empty/zero columns.
  // Also respects the manual per-column tick boxes (colVis) on top of that.
  const showGst = gstType !== 'NO_GST' && colVis.gst;
  const showCess = colVis.cess;
  const showVat = colVis.vat;
  const columnCount = 4 // #, Product, Qty, Rate — always shown
    + (colVis.batch ? 1 : 0) + (colVis.hsn ? 1 : 0) + (colVis.expiry ? 1 : 0) + (colVis.free ? 1 : 0)
    + (colVis.discPercent ? 1 : 0) + (colVis.discAmt ? 1 : 0)
    + (showGst ? 2 + (isInterstate ? 1 : 2) : 0)
    + (showCess ? 2 : 0)
    + (showVat ? 2 : 0)
    + (colVis.mrp ? 1 : 0) + (colVis.selling ? 1 : 0) + (colVis.marginPercent ? 1 : 0)
    + 2; // Line Total + action column

  useEffect(() => {
    if (initialSupplierId) {
      setSelectedSupplierId(initialSupplierId);
      setTimeout(() => productSearchRef.current?.focus(), 50);
    }
  }, [initialSupplierId]);

  // Re-split every existing row's tax whenever the GST Type or the
  // intra/inter-state detection changes (e.g. supplier switched).
  useEffect(() => {
    setRows(prev => prev.map(r => recalcRow(r, null, gstType, isInterstate)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gstType, isInterstate]);

  const fetchOpenPOs = useCallback(() => {
    axios.get('/api/purchase/orders/', { params: { status: 'SENT' } })
      .then(res => setOpenPOs(res.data?.results || res.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchOpenPOs(); }, [fetchOpenPOs]);

  // Pulls in a supplier + item lines from an existing Purchase Order (goods now received);
  // the grid stays fully editable so qty/rate can be corrected against what actually arrived.
  const applyPurchaseOrder = useCallback((po) => {
    if (!po) return;
    setLinkedPO(po);
    setSelectedSupplierId(po.supplier);
    setPoRef(po.order_number);
    const newRows = (po.items || []).map(item => {
      const product = products.find(p => String(p.id) === String(item.product)) || {
        id: item.product, name: 'Unknown Product (removed from catalog)', costPrice: item.unit_price, stock: 0, taxRate: item.tax_rate
      };
      return recalcRow(blankRow(product, { quantity: item.quantity, purchaseRate: item.unit_price, gstPercent: item.tax_rate }), 'quantity', gstType, isInterstate);
    });
    if (newRows.length) setRows(newRows);
  }, [products, gstType, isInterstate]);

  useEffect(() => {
    if (initialPurchaseOrderId) {
      axios.get(`/api/purchase/orders/${initialPurchaseOrderId}/`).then(res => applyPurchaseOrder(res.data)).catch(() => {});
    }
  }, [initialPurchaseOrderId]);

  // "Edit" from Purchase Order Reports: pull the whole saved entry back into the form,
  // header + item grid, byte-for-byte as it was stored.
  useEffect(() => {
    if (!editInvoiceId) return;
    let cancelled = false;
    axios.get(`/api/purchase/invoices/${editInvoiceId}/`).then(res => {
      if (cancelled) return;
      const inv = res.data || {};
      setEditingId(inv.id || editInvoiceId);
      setEditingLabel(inv.invoice_number || '');
      setInvoiceNumber(inv.invoice_number || genInvoiceNumber());
      setSupplierInvoiceNumber(inv.supplier_invoice_number || '');
      setSelectedSupplierId(inv.supplier || '');
      setPurchaseDate(inv.purchase_date || todayStr());
      setDueDate(inv.due_date || '');
      setPurchaseType(inv.purchase_type || 'CASH');
      setWarehouseId(inv.warehouse || '');
      setBranchId(inv.branch || '');
      setGstType(inv.gst_type || 'EXCLUSIVE');
      setStatus(inv.status === 'CANCELLED' ? 'CONFIRMED' : (inv.status || 'CONFIRMED'));
      setNotes(inv.notes || '');
      setPoRef(inv.purchase_order_ref || '');
      setReturnRef(inv.purchase_return_ref || '');
      setSupplierVatNumber(inv.supplier_vat_number || '');
      setOtherCharges(parseFloat(inv.other_charges) || 0);
      setPaymentMethod(inv.payment_method || 'CASH');
      setPaidAmount(parseFloat(inv.paid_amount) || 0);
      const items = Array.isArray(inv.items) ? inv.items : [];
      if (items.length) setDefaultGstPercent(parseFloat(items[0].gst_percent) || 18);
      setRows(items.map(rowFromInvoiceItem));
      cellRefs.current = {};
    }).catch(() => {
      alert('Could not load this purchase entry for editing.');
    });
    return () => { cancelled = true; };
  }, [editInvoiceId]);

  useEffect(() => {
    Promise.all([
      axios.get('/api/company/warehouses/').catch(() => null),
      axios.get('/api/company/branches/').catch(() => null)
    ]).then(([whRes, brRes]) => {
      const wh = whRes?.data?.results || whRes?.data || [];
      const br = brRes?.data?.results || brRes?.data || [];
      if (Array.isArray(wh)) setWarehouses(wh);
      if (Array.isArray(br)) setBranches(br);
    });
  }, []);

  // --- Totals ---
  const totals = useMemo(() => {
    const totalItems = rows.length;
    const totalQty = rows.reduce((s, r) => s + (parseFloat(r.quantity) || 0), 0);
    const gross = rows.reduce((s, r) => s + ((parseFloat(r.quantity) || 0) * (parseFloat(r.purchaseRate) || 0)), 0);
    const discount = rows.reduce((s, r) => s + (parseFloat(r.discountAmount) || 0), 0);
    const tax = rows.reduce((s, r) => s + (parseFloat(r.gstAmount) || 0), 0);
    const cgst = rows.reduce((s, r) => s + (parseFloat(r.cgstAmount) || 0), 0);
    const sgst = rows.reduce((s, r) => s + (parseFloat(r.sgstAmount) || 0), 0);
    const igst = rows.reduce((s, r) => s + (parseFloat(r.igstAmount) || 0), 0);
    const cess = rows.reduce((s, r) => s + (parseFloat(r.cessAmount) || 0), 0);
    const vat = rows.reduce((s, r) => s + (parseFloat(r.vatAmount) || 0), 0);
    const preRound = gross - discount + tax + cess + vat + (parseFloat(otherCharges) || 0);
    const grandTotal = Math.round(preRound);
    const roundOff = +(grandTotal - preRound).toFixed(2);
    return { totalItems, totalQty, gross, discount, tax, cgst, sgst, igst, cess, vat, roundOff, grandTotal };
  }, [rows, otherCharges]);

  const balanceAmount = Math.max(0, +(totals.grandTotal - (parseFloat(paidAmount) || 0)).toFixed(2));
  const dueAmount = purchaseType === 'CREDIT' ? balanceAmount : 0;

  useEffect(() => {
    if (paymentMethod !== 'CREDIT' && purchaseType === 'CASH') {
      setPaidAmount(totals.grandTotal);
    }
  }, [totals.grandTotal, paymentMethod, purchaseType]);

  // --- Product search & add ---
  const filteredProducts = useMemo(() => {
    const q = (debouncedSearch || '').toLowerCase().trim();
    if (!q) return [];
    return products.filter(p =>
      (p.barcode && p.barcode.toLowerCase().includes(q)) ||
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.sku && p.sku.toLowerCase().includes(q))
    ).slice(0, 30);
  }, [products, debouncedSearch]);

  const addProductToGrid = useCallback((product) => {
    if (!product) return;
    setItemsDialogOpen(true);
    const existingIdx = rows.findIndex(r => r.productId === product.id);
    if (existingIdx !== -1) {
      setRows(prev => prev.map((r, i) => i === existingIdx ? recalcRow({ ...r, quantity: (parseFloat(r.quantity) || 0) + 1 }, 'quantity', gstType, isInterstate) : r));
      setTimeout(() => focusCell(existingIdx, 'quantity'), 50);
      return;
    }
    const newRow = recalcRow(blankRow(product, {}, defaultGstPercent, defaultCessPercent, defaultVatPercent), 'quantity', gstType, isInterstate);
    setRows(prev => {
      const next = [...prev, newRow];
      setTimeout(() => focusCell(next.length - 1, 'quantity'), 50);
      return next;
    });

    if (!isBackendId(product.id)) return; // local-only product — no purchase history to look up
    axios.get('/api/purchase/invoices/last-rate/', { params: { product: product.id, supplier: selectedSupplierId || undefined } })
      .then(res => {
        if (res.data?.found) {
          setRows(prev => prev.map(r => r.productId === product.id ? { ...r, lastRate: res.data.purchase_rate } : r));
        }
      }).catch(() => {});
  }, [rows, gstType, selectedSupplierId, defaultGstPercent, defaultCessPercent, defaultVatPercent, isInterstate]);

  const processBarcodeCode = useCallback((codeStr) => {
    const code = (codeStr || '').toLowerCase().trim();
    if (!code) return;
    const matched = products.find(p => barcodeMatchesProduct(p, code) || (p.sku || '').toLowerCase() === code);
    if (matched) addProductToGrid(matched);
    setProductSearch('');
  }, [products, addProductToGrid]);

  // Hardware barcode scanner listener (rapid keystrokes ending in Enter)
  useBarcodeScanner(processBarcodeCode, { minLength: 4, exemptRefs: [productSearchRef] });

  // --- Grid cell helpers ---
  const registerCellRef = (rowIndex, field) => (el) => {
    if (!cellRefs.current[rowIndex]) cellRefs.current[rowIndex] = {};
    cellRefs.current[rowIndex][field] = el;
  };

  const focusCell = (rowIndex, field) => {
    const el = cellRefs.current[rowIndex]?.[field];
    if (el) { el.focus(); if (el.select) el.select(); }
  };

  const updateRowField = (rowIndex, field, value) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== rowIndex) return r;
      const updated = { ...r, [field]: value };
      return recalcRow(updated, field, gstType, isInterstate);
    }));
  };

  const deleteRow = (rowIndex) => {
    setRows(prev => prev.filter((_, i) => i !== rowIndex));
    delete cellRefs.current[rowIndex];
  };

  const handleCellKeyDown = (e, rowIndex, field) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const pos = EDIT_ORDER.indexOf(field);
      const nextField = EDIT_ORDER[pos + 1];
      if (nextField) {
        focusCell(rowIndex, nextField);
      } else if (rows[rowIndex + 1]) {
        focusCell(rowIndex + 1, EDIT_ORDER[0]);
      } else {
        productSearchRef.current?.focus();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rows[rowIndex + 1]) focusCell(rowIndex + 1, field);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows[rowIndex - 1]) focusCell(rowIndex - 1, field);
    }
  };

  // --- Duplicate detection ---
  const checkDuplicate = () => {
    if (!selectedSupplierId || !supplierInvoiceNumber) { setDuplicateWarning(null); return; }
    axios.get('/api/purchase/invoices/check-duplicate/', { params: { supplier: selectedSupplierId, supplier_invoice_number: supplierInvoiceNumber, exclude: editingId || undefined } })
      .then(res => setDuplicateWarning(res.data?.duplicate ? res.data : null))
      .catch(() => {});
  };

  // --- Reset form ---
  const resetForm = () => {
    setEditingId('');
    setEditingLabel('');
    setInvoiceNumber(genInvoiceNumber());
    setSupplierInvoiceNumber('');
    setSelectedSupplierId('');
    setPurchaseDate(todayStr());
    setDueDate('');
    setPurchaseType('CASH');
    setWarehouseId('');
    setBranchId('');
    setGstType('EXCLUSIVE');
    setDefaultGstPercent(18);
    setDefaultCessPercent(0);
    setDefaultVatPercent(0);
    setSupplierVatNumber('');
    setStatus('CONFIRMED');
    setNotes('');
    setPoRef('');
    setReturnRef('');
    setAttachment(null);
    setDuplicateWarning(null);
    setProductSearch('');
    setRows([]);
    setOtherCharges(0);
    setPaymentMethod('CASH');
    setPaidAmount(0);
    setLinkedPO(null);
    cellRefs.current = {};
  };

  // --- Save ---
  // Any grid row whose product only exists in the browser's local inventory is
  // created in the Product Master first, so "Save Purchase" also saves the item.
  const resolveProductIds = async (itemRows) => {
    const idMap = {};
    for (const r of itemRows) {
      if (isBackendId(r.productId) || idMap[r.productId]) continue;

      const nameKey = (r.productName || '').trim().toLowerCase();
      const match = products.find(p => isBackendId(p.id) && (
        (r.barcode && (p.barcode === r.barcode || p.sku === r.barcode)) ||
        (nameKey && (p.name || '').trim().toLowerCase() === nameKey)
      ));
      if (match) { idMap[r.productId] = String(match.id); continue; }

      const res = await axios.post('/api/products/items/', {
        name: r.productName,
        sku: r.barcode || `PRD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        barcode: r.barcode || null,
        hsn_code: r.hsnCode || '',
        cost_price: parseFloat(r.purchaseRate) || 0,
        retail_price: parseFloat(r.sellingPrice) || 0,
        wholesale_price: parseFloat(r.mrp) || 0,
        stock: 0,
        opening_stock: 0,
        extra_data: { gst: r.gstPercent != null ? String(r.gstPercent) : '' }
      });
      idMap[r.productId] = String(res.data.id);
    }
    if (Object.keys(idMap).length === 0) return itemRows;
    return itemRows.map(r => idMap[r.productId] ? { ...r, productId: idMap[r.productId] } : r);
  };

  const buildPayload = (saveStatus, itemRows) => ({
    invoice_number: invoiceNumber,
    supplier_invoice_number: supplierInvoiceNumber || null,
    supplier: selectedSupplierId,
    purchase_date: purchaseDate,
    due_date: dueDate || null,
    purchase_type: purchaseType,
    warehouse: warehouseId || null,
    branch: branchId || null,
    gst_type: gstType,
    status: saveStatus,
    purchase_order_ref: poRef || null,
    purchase_return_ref: returnRef || null,
    notes: notes || null,
    gross_amount: totals.gross,
    discount_amount: totals.discount,
    tax_amount: totals.tax,
    other_charges: parseFloat(otherCharges) || 0,
    round_off: totals.roundOff,
    grand_total: totals.grandTotal,
    payment_method: paymentMethod,
    paid_amount: parseFloat(paidAmount) || 0,
    balance_amount: balanceAmount,
    is_interstate: isInterstate,
    company_gstin: companyGstin || null,
    supplier_gstin: supplierGstin || null,
    cgst_amount: totals.cgst,
    sgst_amount: totals.sgst,
    igst_amount: totals.igst,
    cess_amount: totals.cess,
    supplier_vat_number: supplierVatNumber || null,
    vat_amount: totals.vat,
    items: itemRows.map(r => ({
      product: r.productId,
      barcode: r.barcode,
      batch_number: r.batchNumber || null,
      hsn_code: r.hsnCode || null,
      expiry_date: r.expiryDate || null,
      quantity: r.quantity,
      free_quantity: r.freeQuantity,
      purchase_rate: r.purchaseRate,
      discount_percent: r.discountPercent,
      discount_amount: r.discountAmount,
      gst_percent: r.gstPercent,
      gst_amount: r.gstAmount,
      cgst_percent: r.cgstPercent,
      cgst_amount: r.cgstAmount,
      sgst_percent: r.sgstPercent,
      sgst_amount: r.sgstAmount,
      igst_percent: r.igstPercent,
      igst_amount: r.igstAmount,
      cess_percent: r.cessPercent,
      cess_amount: r.cessAmount,
      vat_percent: r.vatPercent,
      vat_amount: r.vatAmount,
      mrp: r.mrp,
      selling_price: r.sellingPrice,
      margin_percent: r.marginPercent,
      line_total: r.lineTotal
    }))
  });

  const syncLegacyStores = (savedInvoice) => {
    try {
      const existingPOs = JSON.parse(localStorage.getItem('optical_purchase_orders') || '[]');
      const poEntry = {
        id: savedInvoice.invoice_number,
        supplier: selectedSupplier?.name || selectedSupplier?.company_name || 'Supplier',
        item: `${rows.length} item(s)`,
        qty: totals.totalQty,
        total: totals.grandTotal,
        status: status === 'DRAFT' ? 'Draft' : 'Completed',
        paid: balanceAmount <= 0,
        date: purchaseDate
      };
      localStorage.setItem('optical_purchase_orders', JSON.stringify([poEntry, ...existingPOs]));

      if (status !== 'DRAFT') {
        const existingItems = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
        rows.forEach(r => {
          const idx = existingItems.findIndex(i => i.id === r.productId || i.barcode === r.barcode || i.name === r.productName);
          if (idx !== -1) {
            existingItems[idx].stock = (parseInt(existingItems[idx].stock) || 0) + (parseFloat(r.quantity) || 0) + (parseFloat(r.freeQuantity) || 0);
          }
        });
        localStorage.setItem('optical_inventory_items', JSON.stringify(existingItems));
        window.dispatchEvent(new Event('optical_stock_updated'));
      }

      window.dispatchEvent(new Event('optical_accounts_updated'));
    } catch (e) {}
  };

  const doSave = async (saveStatus, { print = false, andNew = false } = {}) => {
    if (!selectedSupplierId) { alert('Please select a supplier.'); supplierInputRef.current?.focus(); return; }
    if (saveStatus !== 'DRAFT' && rows.length === 0) { alert('Please add at least one product line.'); productSearchRef.current?.focus(); return; }

    setSaving(true);
    try {
      let itemRows = rows;
      try {
        itemRows = await resolveProductIds(rows);
        if (itemRows !== rows) setRows(itemRows);
      } catch (e) {
        alert('Failed to save one or more new products to the Product Master. Please add them via "Add New Product" and try again.');
        setSaving(false);
        return;
      }
      const payload = buildPayload(saveStatus, itemRows);
      const res = editingId
        ? await axios.put(`/api/purchase/invoices/${editingId}/`, payload)
        : await axios.post('/api/purchase/invoices/', payload);
      let saved = res.data;

      if (attachment) {
        try {
          const fd = new FormData();
          fd.append('attachment', attachment);
          const patchRes = await axios.patch(`/api/purchase/invoices/${saved.id}/`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
          saved = patchRes.data;
        } catch (e) {}
      }

      syncLegacyStores(saved);

      if (linkedPO && saveStatus !== 'DRAFT') {
        axios.post(`/api/purchase/orders/${linkedPO.id}/mark-converted/`).then(fetchOpenPOs).catch(() => {});
      }

      const printable = {
        ...saved,
        wasEdit: Boolean(editingId),
        supplierName: selectedSupplier?.name || selectedSupplier?.company_name,
        items: rows.map(r => ({ ...r, productName: r.productName }))
      };

      if (print) printPurchaseReceipt(printable);

      onSaveComplete?.(printable);

      alert(`Purchase Entry ${saved.invoice_number} ${editingId ? 'updated' : 'saved'} successfully!${saveStatus === 'DRAFT' ? ' (Draft)' : ''}`);

      if (andNew || saveStatus !== 'DRAFT') resetForm();
    } catch (err) {
      const data = err.response?.data;
      let detail = '';
      if (typeof data === 'string') detail = data;
      else if (data && typeof data === 'object') {
        detail = data.detail || JSON.stringify(data);
      }
      alert(`Failed to save purchase entry. Please check the required fields and try again.${detail ? `\n\n${detail}` : ''}`);
    } finally {
      setSaving(false);
    }
  };

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handleShortcut = (e) => {
      if (e.key === 'F2') { e.preventDefault(); dateInputRef.current?.focus(); }
      else if (e.key === 'F3') { e.preventDefault(); supplierInputRef.current?.focus(); }
      else if (e.key === 'F4') { e.preventDefault(); onRequestAddSupplier?.(); }
      else if (e.key === 'F5') { e.preventDefault(); setProductSearch(''); productSearchRef.current?.focus(); }
      else if (e.key === 'F6') { e.preventDefault(); productSearchRef.current?.focus(); }
      else if (e.key === 'F7') { e.preventDefault(); if (rows.length) focusCell(rows.length - 1, 'batchNumber'); }
      else if (e.key === 'F8') { e.preventDefault(); if (rows.length) focusCell(rows.length - 1, 'discountPercent'); }
      else if (e.key === 'F9') { e.preventDefault(); if (rows.length) focusCell(rows.length - 1, 'gstPercent'); }
      else if (e.key === 'F10') { e.preventDefault(); paidAmountRef.current?.focus(); }
      else if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSave(status); }
      else if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); doSave(status, { print: true }); }
      else if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); resetForm(); }
      else if (e.key === 'Escape') { e.preventDefault(); resetForm(); }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const numCell = (rowIndex, field, opts = {}) => (
    <TextField
      inputRef={registerCellRef(rowIndex, field)}
      size="small"
      type={opts.type || 'number'}
      value={rows[rowIndex][field]}
      onChange={(e) => updateRowField(rowIndex, field, e.target.value)}
      onKeyDown={(e) => handleCellKeyDown(e, rowIndex, field)}
      sx={{ width: opts.width || 80, '& input': { py: 0.6, px: 0.8, fontSize: '0.8rem', textAlign: opts.type === 'text' ? 'left' : 'right' } }}
    />
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h5" sx={{ fontWeight: 800, color: 'primary.main' }}>
              Purchase Entry
            </Typography>
            {editingLabel && (
              <Chip
                size="small"
                color="warning"
                label={`Editing ${editingLabel}`}
                onDelete={resetForm}
                sx={{ fontWeight: 700 }}
              />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {editingLabel
              ? 'Editing an existing purchase entry — items are loaded exactly as saved. Save to update.'
              : 'Single-screen supplier purchase entry with live GST, discount & margin calculation'}
          </Typography>
        </Box>
        {selectedSupplier && (
          <Chip
            icon={<SupplierIcon />}
            label={`Outstanding Balance: ₹${parseFloat(selectedSupplier.balance ?? selectedSupplier.outstanding_balance ?? 0).toFixed(2)}`}
            color={parseFloat(selectedSupplier.balance ?? selectedSupplier.outstanding_balance ?? 0) > 0 ? 'error' : 'success'}
            variant="outlined"
            sx={{ fontWeight: 700 }}
          />
        )}
      </Box>

      {duplicateWarning && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }} onClose={() => setDuplicateWarning(null)}>
          Possible duplicate: Supplier Invoice already recorded as <strong>{duplicateWarning.invoice_number}</strong> on {duplicateWarning.purchase_date} for ₹{duplicateWarning.grand_total}.
        </Alert>
      )}

      {/* 1. Header */}
      <Card variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3 }}>
        <Grid container spacing={1.5}>
          <Grid item xs={12} sm={6} md={3}>
            <Autocomplete
              options={allSuppliers}
              getOptionLabel={(o) => o.name || o.company_name || ''}
              value={selectedSupplier || null}
              onChange={(e, val) => setSelectedSupplierId(val ? val.id : '')}
              renderInput={(params) => (
                <TextField {...params} label="Supplier" size="small" inputRef={supplierInputRef}
                  InputProps={{ ...params.InputProps, endAdornment: (
                    <>
                      <Tooltip title="Add Supplier (F4)">
                        <IconButton size="small" onClick={() => onRequestAddSupplier?.()}><AddIcon fontSize="small" /></IconButton>
                      </Tooltip>
                      {params.InputProps.endAdornment}
                    </>
                  ) }}
                />
              )}
            />
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField fullWidth size="small" label="Invoice No." value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField fullWidth size="small" label="Supplier Inv. No." value={supplierInvoiceNumber}
              onChange={(e) => setSupplierInvoiceNumber(e.target.value)} onBlur={checkDuplicate} />
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <QuickDatePickerField label="Purchase Date" value={purchaseDate} onChange={setPurchaseDate} sx={{}} />
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <QuickDatePickerField label="Due Date" value={dueDate} onChange={setDueDate} />
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField select fullWidth size="small" label="Purchase Type" value={purchaseType} onChange={(e) => setPurchaseType(e.target.value)}>
              <MenuItem value="CASH">Cash</MenuItem>
              <MenuItem value="CREDIT">Credit</MenuItem>
            </TextField>
          </Grid>

          <Grid item xs={6} sm={3} md={1.5}>
            <TextField select fullWidth size="small" label="Warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <MenuItem value="">Default</MenuItem>
              {warehouses.map(w => <MenuItem key={w.id} value={w.id}>{w.name}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField select fullWidth size="small" label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <MenuItem value="">Default</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField select fullWidth size="small" label="GST Type" value={gstType} onChange={(e) => setGstType(e.target.value)}>
              <MenuItem value="EXCLUSIVE">Exclusive</MenuItem>
              <MenuItem value="INCLUSIVE">Inclusive</MenuItem>
              <MenuItem value="NO_GST">No GST</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField
              type="number" fullWidth size="small" label="Default GST %"
              value={defaultGstPercent} onChange={(e) => setDefaultGstPercent(parseFloat(e.target.value) || 0)}
              disabled={gstType === 'NO_GST'}
              helperText="Applied to newly added items"
            />
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField select fullWidth size="small" label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <MenuItem value="CONFIRMED">Confirmed</MenuItem>
              <MenuItem value="DRAFT">Draft</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <Autocomplete
              freeSolo
              options={openPOs}
              getOptionLabel={(o) => (typeof o === 'string' ? o : `${o.order_number} (${o.items?.length || 0} items)`)}
              inputValue={poRef}
              onInputChange={(e, val) => setPoRef(val)}
              onChange={(e, val) => { if (val && typeof val !== 'string') applyPurchaseOrder(val); }}
              renderInput={(params) => <TextField {...params} size="small" label="Convert Purchase Order" placeholder="Select an open PO to convert" />}
            />
            {linkedPO && (
              <Chip size="small" label={`Converting ${linkedPO.order_number}`} onDelete={() => setLinkedPO(null)} color="primary" variant="outlined" sx={{ mt: 0.5, fontWeight: 700 }} />
            )}
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField fullWidth size="small" label="Return Reference" value={returnRef} onChange={(e) => setReturnRef(e.target.value)} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField fullWidth size="small" label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Button component="label" variant="outlined" size="small" startIcon={<AttachFileIcon />} sx={{ height: 40, textTransform: 'none' }}>
              {attachment ? attachment.name.slice(0, 22) : 'Attach Invoice (PDF/Image)'}
              <input type="file" hidden accept=".pdf,image/*" onChange={(e) => setAttachment(e.target.files?.[0] || null)} />
            </Button>
          </Grid>
        </Grid>
      </Card>

      {/* 1b. GST Details master section — only relevant once GST actually applies */}
      {gstType !== 'NO_GST' && (
        <Card variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3, borderColor: '#c7d2fe', bgcolor: '#f5f7ff' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
            <Typography variant="subtitle2" fontWeight={800} color="primary.main">GST Details</Typography>
            <Chip
              size="small"
              label={isInterstate ? 'Inter-State — IGST applies' : 'Intra-State — CGST + SGST applies'}
              color={isInterstate ? 'warning' : 'success'}
              sx={{ fontWeight: 700 }}
            />
          </Stack>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={3} md={2.4}>
              <TextField fullWidth size="small" label="Company GSTIN" value={companyGstin} placeholder="Not set in Settings" InputProps={{ readOnly: true }} />
            </Grid>
            <Grid item xs={6} sm={3} md={2.4}>
              <TextField fullWidth size="small" label="Supplier GSTIN" value={supplierGstin} placeholder="No GSTIN on file" InputProps={{ readOnly: true }} />
            </Grid>
            <Grid item xs={6} sm={3} md={2.4}>
              <TextField fullWidth size="small" label="CGST %" value={isInterstate ? '0.00' : (defaultGstPercent / 2).toFixed(2)} InputProps={{ readOnly: true }} />
            </Grid>
            <Grid item xs={6} sm={3} md={2.4}>
              <TextField fullWidth size="small" label="SGST %" value={isInterstate ? '0.00' : (defaultGstPercent / 2).toFixed(2)} InputProps={{ readOnly: true }} />
            </Grid>
            <Grid item xs={6} sm={3} md={2.4}>
              <TextField fullWidth size="small" label="IGST %" value={isInterstate ? defaultGstPercent : '0.00'} InputProps={{ readOnly: true }} />
            </Grid>
          </Grid>
          <Grid container spacing={2} sx={{ mt: 0.25 }}>
            <Grid item xs={6} sm={3} md={2.4}>
              <TextField
                type="number" fullWidth size="small" label="Default Cess %"
                value={defaultCessPercent} onChange={(e) => setDefaultCessPercent(parseFloat(e.target.value) || 0)}
                helperText="Applied to newly added items"
              />
            </Grid>
          </Grid>

          <Divider sx={{ my: 1.75 }} />
          <Typography variant="subtitle2" fontWeight={800} color="text.secondary" sx={{ mb: 1 }}>VAT Details</Typography>
          <Grid container spacing={2}>
            <Grid item xs={6} sm={4} md={2.4}>
              <TextField
                fullWidth size="small" label="Supplier VAT Number"
                value={supplierVatNumber} onChange={(e) => setSupplierVatNumber(e.target.value)}
                placeholder="If applicable"
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2.4}>
              <TextField
                type="number" fullWidth size="small" label="Default VAT %"
                value={defaultVatPercent} onChange={(e) => setDefaultVatPercent(parseFloat(e.target.value) || 0)}
                helperText="Applied to newly added items"
              />
            </Grid>
          </Grid>
        </Card>
      )}

      {/* 2. Product Search */}
      <Paper elevation={0} sx={{ p: '5px 8px 5px 20px', mb: 2, display: 'flex', alignItems: 'center', gap: 1.5, border: '1px solid', borderColor: '#cbd5e1', borderRadius: '32px', bgcolor: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
        <SearchIcon color="primary" />
        <Autocomplete
          fullWidth
          freeSolo
          options={filteredProducts}
          getOptionLabel={(o) => (typeof o === 'string' ? o : o.name || '')}
          inputValue={productSearch}
          onInputChange={(e, val) => setProductSearch(val)}
          onChange={(e, val) => { if (val && typeof val !== 'string') addProductToGrid(val); }}
          renderOption={(props, option) => (
            <li {...props} key={option.id}>
              <Box>
                <Typography variant="body2" fontWeight={700}>{option.name}</Typography>
                <Typography variant="caption" color="text.secondary">SKU: {option.sku || '-'} | Barcode: {option.barcode || '-'} | Stock: {option.stock ?? 0}</Typography>
              </Box>
            </li>
          )}
          renderInput={(params) => (
            <TextField {...params} inputRef={productSearchRef} variant="standard" placeholder="Scan Barcode or Search Product by Name / SKU / Batch (F6)"
              InputProps={{ ...params.InputProps, disableUnderline: true }} />
          )}
          sx={{ flexGrow: 1 }}
        />
        <Tooltip title="Create a new product in the Product Master">
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setAddProductOpen(true)}
            sx={{ flexShrink: 0, fontWeight: 800, borderRadius: '24px', px: 2, whiteSpace: 'nowrap' }}
          >
            Add New Product
          </Button>
        </Tooltip>
      </Paper>

      {/* 3. Item Grid trigger — the grid itself lives in a popup (see Dialog below) */}
      <Card
        variant="outlined"
        sx={{ borderRadius: 3, p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, cursor: 'pointer' }}
        onClick={() => setItemsDialogOpen(true)}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Badge badgeContent={rows.length} color="primary" showZero>
            <ListAltIcon color="action" />
          </Badge>
          <Box>
            <Typography variant="body2" fontWeight={700}>
              {rows.length === 0 ? 'No items added yet' : `${rows.length} item${rows.length === 1 ? '' : 's'} · Qty ${totals.totalQty}`}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {rows.length === 0 ? 'Scan a barcode or search a product above to add it here.' : 'Click to view or edit the item grid'}
            </Typography>
          </Box>
        </Box>
        <Stack direction="row" spacing={1} onClick={(e) => e.stopPropagation()}>
          <Button variant="outlined" size="small" startIcon={<ListAltIcon />} onClick={() => setItemsDialogOpen(true)}>
            {rows.length === 0 ? 'Add Items' : 'View / Edit Items'}
          </Button>
          <Button
            variant="contained"
            size="small"
            color="primary"
            startIcon={<SaveIcon />}
            disabled={saving || rows.length === 0}
            onClick={() => doSave(status)}
            sx={{ fontWeight: 800 }}
          >
            Save Item
          </Button>
        </Stack>
      </Card>

      <Dialog open={itemsDialogOpen} onClose={() => setItemsDialogOpen(false)} maxWidth="xl" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 800 }}>
          Purchase Items
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Button size="small" startIcon={<ViewColumnIcon fontSize="small" />} onClick={(e) => setColumnMenuAnchor(e.currentTarget)} sx={{ fontWeight: 700, textTransform: 'none' }}>
              Columns
            </Button>
            <IconButton size="small" onClick={() => setItemsDialogOpen(false)}><CloseIcon fontSize="small" /></IconButton>
          </Box>
        </DialogTitle>
        <Menu anchorEl={columnMenuAnchor} open={Boolean(columnMenuAnchor)} onClose={() => setColumnMenuAnchor(null)}>
          {[
            ['batch', 'Batch'], ['hsn', 'HSN/SAC'], ['expiry', 'Expiry'], ['free', 'Free Qty'],
            ['discPercent', 'Disc %'], ['discAmt', 'Disc Amt'],
            ['gst', 'GST % / GST Amt / CGST / SGST / IGST'], ['cess', 'Cess % / Cess Amt'], ['vat', 'VAT % / VAT Amt'],
            ['mrp', 'MRP'], ['selling', 'Selling Price'], ['marginPercent', 'Margin %']
          ].map(([key, label]) => (
            <MenuItem key={key} dense onClick={() => toggleCol(key)} sx={{ py: 0.25 }}>
              <FormControlLabel
                control={<Checkbox size="small" checked={colVis[key]} onChange={() => toggleCol(key)} onClick={(e) => e.stopPropagation()} />}
                label={<Typography variant="body2">{label}</Typography>}
                sx={{ m: 0, width: '100%' }}
              />
            </MenuItem>
          ))}
        </Menu>
        <DialogContent dividers sx={{ p: 0 }}>
          <TableContainer sx={{ maxHeight: '65vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, fontSize: '0.72rem', bgcolor: 'action.hover', whiteSpace: 'nowrap' } }}>
                  <TableCell>#</TableCell>
                  <TableCell>Product</TableCell>
                  {colVis.batch && <TableCell>Batch</TableCell>}
                  {colVis.hsn && <TableCell>HSN/SAC</TableCell>}
                  {colVis.expiry && <TableCell>Expiry</TableCell>}
                  <TableCell align="right">Qty</TableCell>
                  {colVis.free && <TableCell align="right">Free</TableCell>}
                  <TableCell align="right">Rate</TableCell>
                  {colVis.discPercent && <TableCell align="right">Disc %</TableCell>}
                  {colVis.discAmt && <TableCell align="right">Disc Amt</TableCell>}
                  {showGst && (
                    <>
                      <TableCell align="right">GST %</TableCell>
                      <TableCell align="right">GST Amt</TableCell>
                      {isInterstate ? (
                        <TableCell align="right">IGST Amt</TableCell>
                      ) : (
                        <>
                          <TableCell align="right">CGST Amt</TableCell>
                          <TableCell align="right">SGST Amt</TableCell>
                        </>
                      )}
                    </>
                  )}
                  {showCess && (
                    <>
                      <TableCell align="right">Cess %</TableCell>
                      <TableCell align="right">Cess Amt</TableCell>
                    </>
                  )}
                  {showVat && (
                    <>
                      <TableCell align="right">VAT %</TableCell>
                      <TableCell align="right">VAT Amt</TableCell>
                    </>
                  )}
                  {colVis.mrp && <TableCell align="right">MRP</TableCell>}
                  {colVis.selling && <TableCell align="right">Selling</TableCell>}
                  {colVis.marginPercent && <TableCell align="right">Margin %</TableCell>}
                  <TableCell align="right">Line Total</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columnCount} align="center" sx={{ py: 6 }}>
                      <EmptyIcon sx={{ fontSize: 32, color: 'text.disabled', mb: 1 }} />
                      <Typography variant="body2" color="text.secondary">Scan a barcode or search a product above to add it here.</Typography>
                    </TableCell>
                  </TableRow>
                ) : rows.map((row, idx) => (
                  <TableRow key={row.rowId} hover>
                    <TableCell sx={{ fontSize: '0.75rem' }}>{idx + 1}</TableCell>
                    <TableCell sx={{ minWidth: 150 }}>
                      <Typography variant="body2" fontWeight={700} noWrap>{row.productName}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                        Stock: {row.currentStock} → {row.currentStock + (parseFloat(row.quantity) || 0) + (parseFloat(row.freeQuantity) || 0)}
                        {row.lastRate != null && ` | Last Rate: ₹${row.lastRate}`}
                      </Typography>
                    </TableCell>
                    {colVis.batch && <TableCell>{numCell(idx, 'batchNumber', { type: 'text', width: 90 })}</TableCell>}
                    {colVis.hsn && <TableCell>{numCell(idx, 'hsnCode', { type: 'text', width: 85 })}</TableCell>}
                    {colVis.expiry && <TableCell>{numCell(idx, 'expiryDate', { type: 'date', width: 130 })}</TableCell>}
                    <TableCell align="right">{numCell(idx, 'quantity', { width: 65 })}</TableCell>
                    {colVis.free && <TableCell align="right">{numCell(idx, 'freeQuantity', { width: 60 })}</TableCell>}
                    <TableCell align="right">{numCell(idx, 'purchaseRate', { width: 80 })}</TableCell>
                    {colVis.discPercent && <TableCell align="right">{numCell(idx, 'discountPercent', { width: 65 })}</TableCell>}
                    {colVis.discAmt && <TableCell align="right">{numCell(idx, 'discountAmount', { width: 75 })}</TableCell>}
                    {showGst && (
                      <>
                        <TableCell align="right">{numCell(idx, 'gstPercent', { width: 60 })}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.78rem', fontWeight: 600 }}>₹{row.gstAmount}</TableCell>
                        {isInterstate ? (
                          <TableCell align="right" sx={{ fontSize: '0.78rem' }}>₹{row.igstAmount}</TableCell>
                        ) : (
                          <>
                            <TableCell align="right" sx={{ fontSize: '0.78rem' }}>₹{row.cgstAmount}</TableCell>
                            <TableCell align="right" sx={{ fontSize: '0.78rem' }}>₹{row.sgstAmount}</TableCell>
                          </>
                        )}
                      </>
                    )}
                    {showCess && (
                      <>
                        <TableCell align="right">{numCell(idx, 'cessPercent', { width: 60 })}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.78rem' }}>₹{row.cessAmount}</TableCell>
                      </>
                    )}
                    {showVat && (
                      <>
                        <TableCell align="right">{numCell(idx, 'vatPercent', { width: 60 })}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.78rem' }}>₹{row.vatAmount}</TableCell>
                      </>
                    )}
                    {colVis.mrp && <TableCell align="right">{numCell(idx, 'mrp', { width: 75 })}</TableCell>}
                    {colVis.selling && <TableCell align="right">{numCell(idx, 'sellingPrice', { width: 80 })}</TableCell>}
                    {colVis.marginPercent && <TableCell align="right">{numCell(idx, 'marginPercent', { width: 65 })}</TableCell>}
                    <TableCell align="right" sx={{ fontWeight: 800, fontSize: '0.8rem' }}>₹{row.lineTotal}</TableCell>
                    <TableCell>
                      <IconButton size="small" color="error" onClick={() => deleteRow(idx)}><DeleteIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </DialogContent>
        <DialogActions>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto', pl: 1 }}>
            {gstType === 'NO_GST' ? 'GST columns hidden — GST Type is set to No GST' : `GST columns shown — GST Type is ${gstType === 'INCLUSIVE' ? 'Inclusive' : 'Exclusive'}`}
          </Typography>
          <Button variant="contained" color="primary" onClick={() => setItemsDialogOpen(false)} sx={{ fontWeight: 800 }}>Done</Button>
        </DialogActions>
      </Dialog>

      {/* 4 & 5. Summary + Payment — full width, below the item grid */}
      <Card elevation={0} sx={{ mt: 2, p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
        <Grid container spacing={3}>
          {/* Amount breakdown */}
          <Grid item xs={12} md={8}>
            <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1.5 }}>Purchase Summary</Typography>
            <Grid container spacing={2}>
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block">Total Items</Typography>
                <Typography variant="body2" fontWeight={700}>{totals.totalItems}</Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block">Total Qty</Typography>
                <Typography variant="body2" fontWeight={700}>{totals.totalQty}</Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block">Gross Amount</Typography>
                <Typography variant="body2" fontWeight={700}>₹{totals.gross.toFixed(2)}</Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block">Discount</Typography>
                <Typography variant="body2" fontWeight={700} color="error.main">-₹{totals.discount.toFixed(2)}</Typography>
              </Grid>
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block">Tax (GST)</Typography>
                <Typography variant="body2" fontWeight={700}>₹{totals.tax.toFixed(2)}</Typography>
              </Grid>
              {gstType !== 'NO_GST' && (isInterstate ? (
                <Grid item xs={6} sm={4} md={3}>
                  <Typography variant="caption" color="text.secondary" display="block">↳ IGST</Typography>
                  <Typography variant="body2" fontWeight={700}>₹{totals.igst.toFixed(2)}</Typography>
                </Grid>
              ) : (
                <>
                  <Grid item xs={6} sm={4} md={3}>
                    <Typography variant="caption" color="text.secondary" display="block">↳ CGST</Typography>
                    <Typography variant="body2" fontWeight={700}>₹{totals.cgst.toFixed(2)}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={4} md={3}>
                    <Typography variant="caption" color="text.secondary" display="block">↳ SGST</Typography>
                    <Typography variant="body2" fontWeight={700}>₹{totals.sgst.toFixed(2)}</Typography>
                  </Grid>
                </>
              ))}
              {totals.cess > 0 && (
                <Grid item xs={6} sm={4} md={3}>
                  <Typography variant="caption" color="text.secondary" display="block">Cess</Typography>
                  <Typography variant="body2" fontWeight={700}>₹{totals.cess.toFixed(2)}</Typography>
                </Grid>
              )}
              {totals.vat > 0 && (
                <Grid item xs={6} sm={4} md={3}>
                  <Typography variant="caption" color="text.secondary" display="block">VAT</Typography>
                  <Typography variant="body2" fontWeight={700}>₹{totals.vat.toFixed(2)}</Typography>
                </Grid>
              )}
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.4 }}>Other Charges</Typography>
                <TextField size="small" type="number" value={otherCharges} onChange={(e) => setOtherCharges(e.target.value)} sx={{ width: '100%', maxWidth: 120, '& input': { py: 0.4 } }} />
              </Grid>
              <Grid item xs={6} sm={4} md={3}>
                <Typography variant="caption" color="text.secondary" display="block">Round Off</Typography>
                <Typography variant="body2" fontWeight={700}>₹{totals.roundOff.toFixed(2)}</Typography>
              </Grid>
            </Grid>
          </Grid>

          {/* Grand Total + Payment */}
          <Grid item xs={12} md={4} sx={{ borderLeft: { xs: 'none', md: '1px solid' }, borderTop: { xs: '1px solid', md: 'none' }, borderColor: 'divider', pl: { md: 3 }, pt: { xs: 2, md: 0 } }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 2 }}>
              <Typography variant="subtitle1" fontWeight={800}>Grand Total</Typography>
              <Typography variant="h4" fontWeight={900} color="primary.main">₹{totals.grandTotal.toFixed(2)}</Typography>
            </Box>

            <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1 }}>Payment</Typography>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1.5 }}>
              {['CASH', 'BANK', 'UPI', 'CARD', 'CREDIT'].map(m => (
                <Chip key={m} label={m} clickable size="small"
                  color={paymentMethod === m ? 'primary' : 'default'}
                  variant={paymentMethod === m ? 'filled' : 'outlined'}
                  onClick={() => setPaymentMethod(m)}
                  sx={{ fontWeight: paymentMethod === m ? 800 : 500 }}
                />
              ))}
            </Box>
            <TextField fullWidth size="small" type="number" label="Paid Amount" inputRef={paidAmountRef}
              value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} sx={{ mb: 1.5 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body2" color="text.secondary">Balance</Typography>
              <Typography variant="body2" fontWeight={700} color={balanceAmount > 0 ? 'error.main' : 'success.main'}>₹{balanceAmount.toFixed(2)}</Typography>
            </Box>
            {(paymentMethod !== 'CASH' && dueAmount > 0) && (
              <>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Typography variant="body2" color="text.secondary">Due Amount</Typography>
                  <Typography variant="body2" fontWeight={700} color="error.main">₹{dueAmount.toFixed(2)}</Typography>
                </Box>
                <QuickDatePickerField label="Due Date" value={dueDate} onChange={setDueDate} size="small" />
              </>
            )}
          </Grid>
        </Grid>
      </Card>

      {/* 6. Sticky Action Bar */}
      <Box sx={{ position: 'sticky', bottom: 0, mt: 2, py: 1.5, px: 2, bgcolor: 'background.paper', borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 1.5, zIndex: 10 }}>
        <Button variant="outlined" color="inherit" startIcon={<CloseIcon />} onClick={resetForm} disabled={saving}>Cancel (Esc)</Button>
        <Button variant="outlined" startIcon={<DraftIcon />} onClick={() => doSave('DRAFT')} disabled={saving}>Draft</Button>
        <Button variant="outlined" color="primary" startIcon={<SaveIcon />} onClick={() => doSave(status, { andNew: true })} disabled={saving}>Save & New</Button>
        <Button variant="outlined" color="primary" startIcon={<PrintIcon />} onClick={() => doSave(status, { print: true })} disabled={saving}>Save & Print (Ctrl+P)</Button>
        <Button variant="contained" color="primary" startIcon={<SaveIcon />} onClick={() => doSave(status)} disabled={saving} sx={{ fontWeight: 800 }}>{editingId ? 'Update Purchase (Ctrl+S)' : 'Save Purchase (Ctrl+S)'}</Button>
      </Box>

      {/* Inline Product Master — create a brand-new product without leaving Purchase Entry */}
      <ProductMasterDialog
        open={addProductOpen}
        onClose={() => setAddProductOpen(false)}
        suppliers={supplierNames}
        defaultSupplier={selectedSupplier?.name || selectedSupplier?.company_name || ''}
        onCreated={handleProductMasterCreated}
      />
    </Box>
  );
}
