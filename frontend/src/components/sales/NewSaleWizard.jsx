import React, { useState, useEffect } from 'react';
import axios from 'axios';
import useBarcodeScanner from '../../hooks/useBarcodeScanner';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';
import { 
  Box, Card, Typography, Grid, TextField, 
  Button, MenuItem, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, IconButton, 
  Stack, Divider, Dialog, DialogTitle, DialogContent, DialogActions,
  Chip, Step, Stepper, StepLabel, Checkbox, FormControlLabel,
  InputAdornment, Avatar, Tooltip, Alert, Switch, RadioGroup, Radio,
  Autocomplete
} from '@mui/material';
import {
  Person as PersonIcon,
  Search as SearchIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Print as PrintIcon,
  CheckCircle as SuccessIcon,
  QrCodeScanner as ScannerIcon,
  ShoppingCart as CartIcon,
  History as HistoryIcon,
  Payment as PaymentIcon,
  LocalOffer as DiscountIcon,
  AutoAwesome as SparkleIcon,
  MedicalServices as DoctorIcon,
  Inbox as EmptyIcon,
  WhatsApp as WhatsAppIcon,
  Send as SendIcon,
  Speed as SpeedIcon,
  CloudDone as CloudIcon,
  Visibility as EyeIcon
} from '@mui/icons-material';

// Standard Indian GST slabs offered in the Tax % dropdowns.
const TAX_SLABS = [0, 5, 12, 18, 28];

// Resolve a numeric GST % for a product picked from the DB. `taxRate`/`gst` are the
// numeric rates the product loaders derive; `tax` is a Tax-master UUID and must never
// be treated as a rate. Returns 18 only when the product carries no tax information.
const resolveProductTaxPercent = (prod) => {
  if (!prod) return 18;
  const candidates = [prod.taxRate, prod.tax_rate, prod.gst];
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue;
    const n = parseFloat(String(c).replace('%', '').trim());
    if (!isNaN(n)) return n;
  }
  return 18;
};

// Build the <MenuItem> list for a Tax % select, injecting the product's own rate as an
// extra option when it isn't one of the standard slabs (otherwise the select goes blank).
const taxSlabItems = (currentValue) => {
  const val = parseFloat(currentValue);
  const slabs = [...TAX_SLABS];
  if (!isNaN(val) && !slabs.includes(val)) slabs.push(val);
  slabs.sort((a, b) => a - b);
  return slabs.map(rate => (
    <MenuItem key={rate} value={rate}>
      {rate === 0 ? '0% (Exempt)' : `${rate}% GST`}
    </MenuItem>
  ));
};

export default function NewSaleWizard({
  customers = [],
  products = [],
  onCheckoutComplete,
  onNavigateToEyeTest
}) {
  // View Mode Selection: 'single-page' (Easy All-in-One Method) vs 'wizard' (5-Step Guided Wizard)
  const [viewMode, setViewMode] = useState('single-page');
  const [activeStep, setActiveStep] = useState(0);

  // Dynamic Patient List Aggregation (Combines props, API, and Local Storage)
  const [dbCustomers, setDbCustomers] = useState([]);

  useEffect(() => {
    let pool = Array.isArray(customers) ? [...customers] : [];

    try {
      const localCust = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
      const localExams = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
      const localPats = JSON.parse(localStorage.getItem('optical_patients') || '[]');
      pool = [...pool, ...localCust, ...localExams, ...localPats];
    } catch (e) {}

    const buildCustomerMap = (inputPool) => {
      const uniqueMap = new Map();
      inputPool.forEach((c, idx) => {
        if (!c) return;
        const name = c.name || c.patient_name || c.patientName;
        if (!name) return;
        const id = c.id || c.patient_id || c.patientId || `P-${1001 + idx}`;
        const phone = c.phone || c.mobile || '';
        const key = String(id || phone || name).toLowerCase().trim();

        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, {
            ...c,
            id: id,
            name: name,
            phone: phone,
            age: c.age || '22',
            gender: c.gender || 'MALE',
            address: c.address || ''
          });
        }
      });
      return Array.from(uniqueMap.values());
    };

    const initialCustList = buildCustomerMap(pool);
    setDbCustomers(initialCustList);

    // Fetch API records asynchronously in background without blocking UI render
    if (!customers || customers.length === 0) {
      Promise.all([
        axios.get('/api/sales/customers/').catch(() => null),
        axios.get('/api/sales/eye-examinations/').catch(() => null)
      ]).then(([resCust, resEx]) => {
        const data = resCust?.data?.results || resCust?.data || [];
        const exData = resEx?.data?.results || resEx?.data || [];
        if (Array.isArray(data) || Array.isArray(exData)) {
          const updatedPool = [...pool, ...(Array.isArray(data) ? data : []), ...(Array.isArray(exData) ? exData : [])];
          setDbCustomers(buildCustomerMap(updatedPool));
        }
      });
    }
  }, [customers]);

  const customerOptions = dbCustomers.length > 0 ? dbCustomers : (Array.isArray(customers) && customers.length > 0 ? customers : [{ id: 'P-1002', name: 'Mohammed', phone: '9961876122' }]);

  // --- PART 1: MASTER SALES HEADER & CUSTOMER DETAILS STATE ---
  const [docType, setDocType] = useState('Invoice');
  const [billNo, setBillNo] = useState(`INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`);
  const [testNo, setTestNo] = useState('');
  
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerInput, setCustomerInput] = useState({
    id: '',
    name: '',
    phone: '',
    age: '',
    gender: 'MALE',
    address: '',
    gstin: ''
  });
  
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().split('T')[0]);
  const [salesman, setSalesman] = useState('ADMIN');
  const [remark, setRemark] = useState('');
  // Diagnosis text lives in rxData.notes (auto-filled from the patient's last eye exam when one
  // is on file — see handleSelectCustomer); icdCode has no equivalent history to pull from since
  // it was never persisted by the Eye Test module, so it's always staff-entered here.
  const [icdCode, setIcdCode] = useState('');

  // --- PART 2: REFRACTION PRESCRIPTION GRID & PRODUCT ENTRY TOOLBAR ---
  const [showRx, setShowRx] = useState(true);
  const [activeRxTab, setActiveRxTab] = useState('prescription');
  const [rxData, setRxData] = useState({
    sphOD: '', cylOD: '', axisOD: '', vaOD: '',
    sphOD_NV: '', cylOD_NV: '', axisOD_NV: '', vaOD_NV: '',
    ipdOD: '', addOD: '',
    sphOS: '', cylOS: '', axisOS: '', vaOS: '',
    sphOS_NV: '', cylOS_NV: '', axisOS_NV: '', vaOS_NV: '',
    ipdOS: '', addOS: '',
    notes: ''
  });

  const [powerChecked, setPowerChecked] = useState(false);
  const [lensIndex, setLensIndex] = useState('1.56');
  const [entryInput, setEntryInput] = useState({
    productId: '',
    barcode: '',
    item: '',
    modelNo: '',
    color: '',
    size: '',
    brand: '',
    category: 'FRAME',
    group: 'GENERIC',
    power: '',
    qty: 1,
    price: '',
    discPercent: 0,
    incTax: 0,
    taxPercent: 18
  });
  // Full product record for the currently-selected Optical DB item, shown as a detail strip
  // (barcode/brand/category/stock/price) under the selector so staff can confirm they picked
  // the right one before it goes into the billing grid.
  const [selectedProductDetail, setSelectedProductDetail] = useState(null);

  // --- PART 3: BILLING ITEMS TABLE & FINANCIAL FOOTER ---
  const [itemsList, setItemsList] = useState([]);
  const [sendWhatsapp, setSendWhatsapp] = useState(true);
  const [sendSms, setSendSms] = useState(true);

  const [couponCode, setCouponCode] = useState('');
  const [couponDisc, setCouponDisc] = useState(0);
  const [overallDisc, setOverallDisc] = useState(0);
  const [advancePaid, setAdvancePaid] = useState('');
  const [outRx, setOutRx] = useState('');
  
  const [multiPay, setMultiPay] = useState({
    cash: '',
    cards: '',
    gpay: '',
    bank: ''
  });

  // --- NEW QUICK ERP LENS & ITEM CREATOR STATE (IMAGE MODEL 2 FORMAT) ---
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickForm, setQuickForm] = useState({
    description: '',
    descriptionL: '',
    category: 'LENS',
    subCat: 'Single Vision',
    group: 'GENERIC',
    brand: 'Essilor',
    modelNo: 'M-101',
    power: '',
    size: '50-18-140',
    color: 'Anti-Blue Cut',
    barcode2: '',
    salesPr: '',
    costPr: '',
    taxPercent: '18.00'
  });

  // Auto-Fill Power from Prescription Grid into Quick Form
  const handleAutoFillPower = () => {
    let pStr = '';
    if (rxData.sphOD || rxData.sphOS) {
      pStr = `OD:${rxData.sphOD || '0'}/${rxData.cylOD || '0'} | OS:${rxData.sphOS || '0'}/${rxData.cylOS || '0'} [ADD:${rxData.addOD || '0'}]`;
    } else {
      pStr = 'OD:0.00 | OS:0.00';
    }
    setQuickForm({
      ...quickForm,
      power: pStr,
      descriptionL: quickForm.descriptionL || `${quickForm.subCat || 'Single Vision'} Lens [Idx:${lensIndex}] ${pStr}`
    });
  };

  // Save Quick Lens/Item & Inject directly to Billing Grid Cart
  const handleSaveQuickItem = () => {
    if (!quickForm.description && !quickForm.descriptionL) {
      alert("Please enter Item Description or Lens Specification.");
      return;
    }

    const price = parseFloat(quickForm.salesPr) || 0;
    const gross = price * 1;
    const itemTitle = quickForm.description || quickForm.descriptionL || 'New Optical Item';

    const newItem = {
      id: `ITEM-${Date.now()}`,
      barcode: quickForm.barcode2 || `BC-${Math.floor(100000 + Math.random() * 900000)}`,
      item: itemTitle,
      modelNo: quickForm.modelNo || 'M-01',
      color: quickForm.color || 'STANDARD',
      size: quickForm.size || '50-18',
      brand: quickForm.brand || 'OPTICAL',
      category: quickForm.category || 'LENS',
      group: quickForm.group || 'GENERIC',
      power: quickForm.power || quickForm.descriptionL || '—',
      qty: 1,
      price,
      disc: 0,
      gross,
      tax: 0,
      taxPercent: parseFloat(quickForm.taxPercent) || 18,
      total: gross
    };

    // 1. Inject directly into billing items list
    setItemsList([...itemsList, newItem]);

    // 2. Save to inventory database local storage
    try {
      const stored = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      localStorage.setItem('optical_inventory_items', JSON.stringify([newItem, ...stored]));
    } catch (e) {}

    // Reset Form
    setQuickForm({
      description: '',
      descriptionL: '',
      category: 'LENS',
      subCat: 'Single Vision',
      group: 'GENERIC',
      brand: 'Essilor',
      modelNo: 'M-101',
      power: '',
      size: '50-18-140',
      color: 'Anti-Blue Cut',
      barcode2: '',
      salesPr: '',
      costPr: '',
      taxPercent: '18.00'
    });

    setQuickAddOpen(false);
    alert(`⚡ Item '${itemTitle}' saved to inventory & added directly to sale cart!`);
  };

  // 1️⃣ PART 1 HANDLER: Test No Auto-Lookup in PostgreSQL Eye Exams DB & LocalStorage
  const handleTestNoChange = async (val) => {
    setTestNo(val);
    if (!val.trim()) return;

    const q = val.trim().toLowerCase();

    // 1. Gather all eye examinations from local storage & API database
    let allExams = [];
    try {
      const localTests = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
      const localExams = JSON.parse(localStorage.getItem('optical_eye_exams') || '[]');
      allExams = [...localTests, ...localExams];
    } catch (e) {}

    try {
      const res = await axios.get('/api/sales/eye-examinations/');
      const data = res.data?.results || res.data || [];
      if (Array.isArray(data)) {
        allExams = [...allExams, ...data];
      }
    } catch (e) {}

    // 2. Find matching examination record
    let matched = allExams.find(e => {
      if (!e) return false;
      const vNum = String(e.visit_number || e.visitNum || e.testNo || e.test_no || e.id || '').toLowerCase().trim();
      const pId = String(e.patient_id || e.patientId || '').toLowerCase().trim();
      const pPhone = String(e.phone || e.mobile || '').toLowerCase().trim();
      const pName = String(e.patient_name || e.name || '').toLowerCase().trim();

      const digitsOnlyV = vNum.replace(/\D/g, '');
      const digitsOnlyQ = q.replace(/\D/g, '');

      return vNum === q || 
             pId === q || 
             pPhone === q || 
             pName.includes(q) || 
             (digitsOnlyQ && digitsOnlyV && digitsOnlyV === digitsOnlyQ);
    });

    // 3. Fallback: If q is a simple number like "1", match 1st exam in database
    if (!matched && /^\d+$/.test(q)) {
      const idx = parseInt(q, 10) - 1;
      if (idx >= 0 && idx < allExams.length) {
        matched = allExams[idx];
      }
    }

    // 4. Apply matched exam details to Customer Details & Prescription Grid
    if (matched) {
      const raw = matched.raw_data || {};
      const subRef = matched.subjectiveRefraction || raw.subjectiveRefraction || matched.subRefraction || {};
      const subOd = subRef.od || matched.od || {};
      const subOs = subRef.os || matched.os || {};

      const custName = matched.patient_name || matched.name || raw.name || customerInput.name || 'Mohammed';
      const custPhone = matched.phone || raw.phone || customerInput.phone || '9961876122';
      const custAge = matched.age || raw.age || customerInput.age || '22';
      const custGender = matched.gender || raw.gender || customerInput.gender || 'MALE';
      const custAddr = matched.address || raw.address || customerInput.address || '';
      const custId = matched.patient_id || matched.patientId || matched.id || 'P-1002';

      setCustomerInput({
        id: custId,
        name: custName,
        phone: custPhone,
        age: custAge,
        gender: String(custGender).toUpperCase(),
        address: custAddr,
        gstin: matched.gstin || customerInput.gstin || ''
      });

      setSelectedCustomerId(custId);

      const sphOD = matched.sub_sph_od || subOd.sph || matched.sphRight || raw.sphRight || '-1.25';
      const cylOD = matched.sub_cyl_od || subOd.cyl || matched.cylRight || raw.cylRight || '-0.50';
      const axisOD = matched.sub_axis_od || subOd.axis || matched.axisRight || raw.axisRight || '90';
      const vaOD = matched.sub_va_od || subOd.va || matched.vaOD || raw.vaOD || '6/6';

      const sphOS = matched.sub_sph_os || subOs.sph || matched.sphLeft || raw.sphLeft || '-1.50';
      const cylOS = matched.sub_cyl_os || subOs.cyl || matched.cylLeft || raw.cylLeft || '-0.75';
      const axisOS = matched.sub_axis_os || subOs.axis || matched.axisLeft || raw.axisLeft || '85';
      const vaOS = matched.sub_va_os || subOs.va || matched.vaOS || raw.vaOS || '6/6';

      const nearAdd = matched.sub_add_od || matched.sub_add_os || subRef.nearAdd || subRef.add || matched.nearAdd || raw.nearAdd || '+1.50';
      const ipd = matched.distance_pd || subRef.pd || matched.distancePD || matched.pd || raw.distancePD || '64';

      setRxData({
        sphOD: sphOD,
        cylOD: cylOD,
        axisOD: axisOD,
        vaOD: vaOD,
        sphOD_NV: matched.sub_nv_sph_od || rxData.sphOD_NV || '',
        cylOD_NV: matched.sub_nv_cyl_od || rxData.cylOD_NV || '',
        axisOD_NV: matched.sub_nv_axis_od || rxData.axisOD_NV || '',
        vaOD_NV: matched.sub_nv_va_od || 'N6',
        ipdOD: ipd,
        addOD: nearAdd,
        sphOS: sphOS,
        cylOS: cylOS,
        axisOS: axisOS,
        vaOS: vaOS,
        sphOS_NV: matched.sub_nv_sph_os || rxData.sphOS_NV || '',
        cylOS_NV: matched.sub_nv_cyl_os || rxData.cylOS_NV || '',
        axisOS_NV: matched.sub_nv_axis_os || rxData.axisOS_NV || '',
        vaOS_NV: matched.sub_nv_va_os || 'N6',
        ipdOS: ipd,
        addOS: nearAdd,
        notes: matched.primary_diagnosis || matched.diagnosis || raw.diagnosis || 'Routine Refraction'
      });
    }
  };

  // 1️⃣ PART 1 HANDLER: Select Customer from Optical DB Dropdown
  const handleSelectCustomer = (cust) => {
    if (!cust) return;
    setSelectedCustomerId(cust.id);
    setCustomerInput({
      id: cust.id || '',
      name: cust.name || '',
      phone: cust.phone || '',
      age: cust.age || '',
      gender: String(cust.gender || 'MALE').toUpperCase(),
      address: cust.address || '',
      gstin: cust.gstin || ''
    });

    const subOd = cust.subjectiveRefraction?.od || cust.od || {};
    const subOs = cust.subjectiveRefraction?.os || cust.os || {};

    const sphOD = cust.sphRight || cust.sub_sph_od || subOd.sph || '-1.25';
    const cylOD = cust.cylRight || cust.sub_cyl_od || subOd.cyl || '-0.50';
    const axisOD = cust.axisRight || cust.sub_axis_od || subOd.axis || '90';
    const vaOD = cust.vaOD || subOd.va || '6/6';

    const sphOS = cust.sphLeft || cust.sub_sph_os || subOs.sph || '-1.50';
    const cylOS = cust.cylLeft || cust.sub_cyl_os || subOs.cyl || '-0.75';
    const axisOS = cust.axisLeft || cust.sub_axis_os || subOs.axis || '85';
    const vaOS = cust.vaOS || subOs.va || '6/6';

    const nearAdd = cust.nearAdd || cust.sub_add_od || cust.subjectiveRefraction?.nearAdd || '+1.50';
    const ipd = cust.distancePD || cust.pd || cust.distance_pd || '64';

    setRxData({
      sphOD: sphOD,
      cylOD: cylOD,
      axisOD: axisOD,
      vaOD: vaOD,
      sphOD_NV: cust.sphRight_NV || '',
      cylOD_NV: cust.cylRight_NV || '',
      axisOD_NV: cust.axisRight_NV || '',
      vaOD_NV: cust.vaOD_NV || 'N6',
      ipdOD: ipd,
      addOD: nearAdd,
      sphOS: sphOS,
      cylOS: cylOS,
      axisOS: axisOS,
      vaOS: vaOS,
      sphOS_NV: cust.sphLeft_NV || '',
      cylOS_NV: cust.cylLeft_NV || '',
      axisOS_NV: cust.axisLeft_NV || '',
      vaOS_NV: cust.vaOS_NV || 'N6',
      ipdOS: ipd,
      addOS: nearAdd,
      notes: cust.primary_diagnosis || cust.diagnosis || cust.notes || 'Routine Refraction'
    });
  };

  // Saves whatever is already typed into the Customer Name/Phone/Age/Gender fields as a new
  // patient — no separate re-entry form. If a patient is already selected (selectedCustomerId
  // set), there's nothing to save. Previously generated a fake local id and mutated the
  // `customers` prop array directly (no POST, no re-render) — a walk-in typed here never
  // actually reached the database and was invisible to Appointments/OpticalServices/
  // PatientHistory, and vanished on refresh. Now resolves-or-creates a real backend Customer,
  // same pattern used by Appointments.jsx.
  const handleSavePatient = async () => {
    if (selectedCustomerId) return;
    if (!customerInput.name || !customerInput.phone) {
      alert('Please enter the patient name and mobile number first.');
      return;
    }
    const existingMatch = customers.find(c => c.phone && c.phone === customerInput.phone);
    if (existingMatch) {
      handleSelectCustomer(existingMatch);
      return;
    }
    try {
      const res = await axios.post('/api/sales/customers/', {
        name: customerInput.name,
        phone: customerInput.phone,
        age: customerInput.age || '',
        gender: customerInput.gender || 'MALE'
      });
      handleSelectCustomer(res.data);
    } catch (e) {
      alert('Could not save the new patient to the database. Please try again.');
    }
  };

  // 2️⃣ PART 2 HANDLER: Product Select from DB
  const handleProductSelect = (selectedProd) => {
    if (!selectedProd) {
      setSelectedProductDetail(null);
      setEntryInput(prev => ({ ...prev, productId: '', barcode: '' }));
      return;
    }
    // model_no/color/size aren't first-class Product fields — they only exist for products
    // that came in through an Excel import with those columns, parked in extra_data. sku
    // doubles as a Model No fallback since the importer itself falls back to it the same way
    // (see import_engine.py: sku = get('sku') or get('model_no')).
    const extra = selectedProd.extra_data || {};
    setEntryInput({
      ...entryInput,
      // productId is the real DB identity used to link the eventual InvoiceItem back to this
      // Product; barcode is purely a display/search value and previously did double duty as
      // BOTH (falling back to the product's own id when no barcode existed) — which broke the
      // moment a product actually HAD a barcode, since then this field held the barcode string
      // instead of the id the backend needs.
      productId: selectedProd.id || '',
      barcode: String(selectedProd.barcode || selectedProd.id || selectedProd.code || ''),
      item: selectedProd.name || '',
      modelNo: extra.model_no || extra.modelNo || selectedProd.sku || '',
      color: extra.color_code || extra.color || '',
      size: extra.size || '',
      brand: selectedProd.brand || 'Generic',
      category: (selectedProd.type || selectedProd.category || 'FRAME').toUpperCase(),
      price: selectedProd.price || selectedProd.sellingPrice || 0,
      discPercent: 0,
      // Pre-fill the Tax % from the picked product. selectedProd.tax is a Tax-master UUID
      // (not a number) so it must NOT be used as a rate — use the numeric taxRate/gst the
      // product loaders derive. Only fall back to 18% when the product has no tax at all.
      taxPercent: resolveProductTaxPercent(selectedProd)
    });
    // Shown as a detail strip under the selector so the user can see exactly what they're
    // about to add (barcode, brand, stock, ...) before committing it to the billing grid.
    setSelectedProductDetail(selectedProd);
  };

  // 2️⃣ PART 2 HANDLER: Add Item to Billing Grid
  const handleAddItem = () => {
    if (!entryInput.item) {
      alert("Please select or enter an item description first.");
      return;
    }

    const qty = parseInt(entryInput.qty) || 1;
    const price = parseFloat(entryInput.price) || 0;
    const disc = parseFloat(entryInput.discPercent) || 0;
    const taxPercent = parseFloat(entryInput.taxPercent) || 0;
    const gross = qty * price;
    const discVal = (gross * disc) / 100;
    const taxableAmount = gross - discVal;
    const taxVal = (taxableAmount * taxPercent) / 100;
    const total = taxableAmount + taxVal;

    // Power String auto-construct if Power checkbox is active
    let formattedPower = '—';
    if (powerChecked) {
      if (entryInput.power) {
        formattedPower = `${entryInput.power} [Idx: ${lensIndex}]`;
      } else if (rxData.sphOD || rxData.sphOS) {
        formattedPower = `OD:${rxData.sphOD || '0'}/${rxData.cylOD || '0'} | OS:${rxData.sphOS || '0'}/${rxData.cylOS || '0'} [Idx: ${lensIndex}]`;
      } else {
        formattedPower = `Power Active [Idx: ${lensIndex}]`;
      }
    }

    const newItem = {
      id: `ITEM-${Date.now()}`,
      productId: entryInput.productId || null,
      barcode: entryInput.barcode || `BC-${Math.floor(1000 + Math.random() * 9000)}`,
      item: entryInput.item,
      modelNo: entryInput.modelNo || 'M-01',
      color: entryInput.color || 'STANDARD',
      size: entryInput.size || '50-18',
      brand: entryInput.brand || 'OPTICAL',
      category: entryInput.category || 'FRAME',
      group: entryInput.group || 'GENERIC',
      power: formattedPower,
      qty,
      price,
      disc: discVal,
      gross,
      discPercent: disc,
      tax: taxVal,
      taxPercent,
      total
    };

    setItemsList([...itemsList, newItem]);
    setEntryInput({
      ...entryInput,
      productId: '', barcode: '', item: '', modelNo: '', color: '', size: '', qty: 1, price: '', power: '',
      discPercent: 0, taxPercent: 18
    });
    setSelectedProductDetail(null);
  };

  // Hardware barcode scanner: looks up the product and adds it directly to the
  // grid. Builds the line item straight from the found product rather than
  // going through handleProductSelect()+handleAddItem() — those read/write
  // entryInput state, and calling both back-to-back in the same handler would
  // read a stale (pre-update) entryInput due to React's async state batching.
  const handleBarcodeScan = (code) => {
    const normalized = code.trim().toLowerCase();
    const found = products.find(p =>
      (p.barcode && String(p.barcode).toLowerCase() === normalized) ||
      (p.code && String(p.code).toLowerCase() === normalized) ||
      (p.sku && String(p.sku).toLowerCase() === normalized)
    );
    if (!found) {
      alert(`No product found for barcode "${code}"`);
      return;
    }
    const price = parseFloat(found.price || found.sellingPrice || 0);
    const scanTaxPercent = resolveProductTaxPercent(found);
    const scanTaxVal = (price * scanTaxPercent) / 100;
    const newItem = {
      id: `ITEM-${Date.now()}`,
      productId: found.id || null,
      barcode: String(found.barcode || found.id || found.code || ''),
      item: found.name || '',
      modelNo: found.modelNo || 'M-01',
      color: found.color || 'STANDARD',
      size: found.size || '50-18',
      brand: found.brand || 'OPTICAL',
      category: (found.type || found.category || 'FRAME').toUpperCase(),
      group: found.group || 'GENERIC',
      power: '—',
      qty: 1,
      price,
      disc: 0,
      discPercent: 0,
      gross: price,
      tax: scanTaxVal,
      taxPercent: scanTaxPercent,
      total: price + scanTaxVal
    };
    setItemsList(prev => [...prev, newItem]);
  };

  useBarcodeScanner(handleBarcodeScan);

  // 3️⃣ PART 3 HANDLER: Remove Item from Grid
  const handleRemoveItem = (id) => {
    setItemsList(itemsList.filter(item => item.id !== id));
  };

  // 3️⃣ PART 3 HANDLER: Edit an already-added row's Qty/Price/Discount/Tax without deleting
  // and re-entering it — recomputes disc/tax/gross/total the same way handleAddItem does.
  const [editingItem, setEditingItem] = useState(null);

  const handleOpenEditItem = (row) => {
    setEditingItem({ ...row });
  };

  const handleSaveEditItem = () => {
    if (!editingItem) return;
    const qty = parseInt(editingItem.qty) || 1;
    const price = parseFloat(editingItem.price) || 0;
    const discPercent = parseFloat(editingItem.discPercent) || 0;
    const taxPercent = parseFloat(editingItem.taxPercent) || 0;
    const gross = qty * price;
    const discVal = (gross * discPercent) / 100;
    const taxableAmount = gross - discVal;
    const taxVal = (taxableAmount * taxPercent) / 100;
    const total = taxableAmount + taxVal;

    setItemsList(prev => prev.map(item => item.id === editingItem.id ? {
      ...item,
      qty, price, discPercent, taxPercent,
      disc: discVal, gross, tax: taxVal, total
    } : item));
    setEditingItem(null);
  };

  // 3️⃣ PART 3 HANDLER: Coupon Code Auto-Calculation
  const handleCouponChange = (code) => {
    setCouponCode(code);
    const upper = code.trim().toUpperCase();
    if (upper === 'OPTICAL10') setCouponDisc(100);
    else if (upper === 'VIP200') setCouponDisc(200);
    else if (upper === 'DISCOUNT50') setCouponDisc(50);
    else setCouponDisc(0);
  };

  // 3️⃣ PART 3 FINANCIAL CALCULATIONS
  const totalQty = itemsList.reduce((sum, item) => sum + (parseInt(item.qty) || 0), 0);
  const grossTotal = itemsList.reduce((sum, item) => sum + (parseFloat(item.gross) || 0), 0);
  const itemDiscounts = itemsList.reduce((sum, item) => sum + (parseFloat(item.disc) || 0), 0);
  const totalTax = itemsList.reduce((sum, item) => sum + (parseFloat(item.tax) || 0), 0);
  const netTotal = Math.max(0, grossTotal - itemDiscounts - couponDisc - overallDisc + totalTax);
  
  const totalPaidAmount = (parseFloat(multiPay.cash) || 0) + 
                          (parseFloat(multiPay.cards) || 0) + 
                          (parseFloat(multiPay.gpay) || 0) + 
                          (parseFloat(multiPay.bank) || 0);

  const balanceDue = Math.max(0, netTotal - (parseFloat(advancePaid) || 0) - totalPaidAmount);

  // 3️⃣ PART 3 HANDLER: Complete & Print Invoice (F10)
  // Handle Document Type Switch (Order vs Invoice vs Quotation)
  const handleDocTypeChange = (type) => {
    setDocType(type);
    const year = new Date().getFullYear();
    const rand = Math.floor(1000 + Math.random() * 9000);

    if (type === 'Order') {
      setBillNo(`ORD-${year}-${rand}`);
    } else if (type === 'Quotation') {
      setBillNo(`QTN-${year}-${rand}`);
    } else {
      setBillNo(`INV-${year}-${rand}`);
    }
  };

  const handleCompleteBilling = async () => {
    if (itemsList.length === 0) {
      alert("Please add at least one item to the billing grid before completing.");
      return;
    }

    // Resolve-or-create the real backend Customer this sale belongs to — same pattern as
    // handleSavePatient/Appointments.jsx, so a walk-in typed directly here still lands in the
    // shared Customer table instead of only existing as a name string on this one invoice.
    let customerId = selectedCustomerId;
    if (!customerId && customerInput.name) {
      const existingMatch = customerInput.phone ? customers.find(c => c.phone && c.phone === customerInput.phone) : null;
      if (existingMatch) {
        customerId = existingMatch.id;
      } else {
        try {
          const res = await axios.post('/api/sales/customers/', {
            name: customerInput.name,
            phone: customerInput.phone || '',
            age: customerInput.age || '',
            gender: customerInput.gender || 'MALE'
          });
          customerId = res.data.id;
        } catch (e) {
          // Continue without a linked customer rather than blocking the sale.
        }
      }
    }

    let backendInvoiceId = null;
    let backendInvoiceNumber = billNo;
    // Orders/Quotations aren't real sales yet (no payment, stock not committed) — only a
    // completed Invoice actually persists to the backend Invoice/InvoiceItem tables and drives
    // stock deduction + the accounting journal entry.
    if (docType === 'Invoice' && customerId) {
      try {
        const status = balanceDue > 0 ? (totalPaidAmount > 0 ? 'PARTIAL' : 'UNPAID') : 'PAID';
        const res = await axios.post('/api/sales/invoices/', {
          invoice_number: billNo,
          customer: customerId,
          invoice_date: new Date().toISOString().split('T')[0],
          status,
          total_amount: grossTotal,
          tax_amount: totalTax,
          discount_amount: itemDiscounts,
          net_amount: netTotal,
          paid_amount: totalPaidAmount,
          payment_method: paymentMode,
          items: itemsList.map(i => ({
            product: i.productId || null,
            description: i.item,
            quantity: i.qty,
            unit_price: i.price,
            tax_rate: i.taxPercent,
            tax_amount: i.tax,
            subtotal: i.total
          }))
        });
        backendInvoiceId = res.data.id;
        backendInvoiceNumber = res.data.invoice_number || billNo;
      } catch (e) {
        // Continue with the local-only record rather than blocking the sale — the receipt
        // still prints and the record still saves to localStorage below.
        console.warn('Invoice did not save to the database:', e);
      }
    }

    const completedOrder = {
      id: backendInvoiceId || billNo,
      invoiceNumber: backendInvoiceNumber,
      customerId,
      date: new Date().toISOString().split('T')[0],
      customerName: customerInput.name || 'Walk-in Customer',
      customerPhone: customerInput.phone || '',
      customerAge: customerInput.age,
      customerGender: customerInput.gender,
      customerAddress: customerInput.address,
      diagnosis: rxData.notes || '',
      icdCode,
      docType,
      items: itemsList,
      totalQty,
      grossTotal,
      itemDiscounts,
      totalTax,
      netTotal,
      advancePaid: parseFloat(advancePaid) || 0,
      balanceDue,
      paymentMode,
      multiPay,
      totalPaidAmount,
      salesman,
      rxData
    };

    try {
      const storedKey = docType === 'Quotation'
        ? 'optical_sales_quotations'
        : docType === 'Order'
          ? 'optical_sales_orders'
          : 'optical_sales_invoices';

      const stored = JSON.parse(localStorage.getItem(storedKey) || '[]');
      localStorage.setItem(storedKey, JSON.stringify([completedOrder, ...stored]));

      // Also record in master sales invoices
      const masterStored = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
      localStorage.setItem('optical_sales_invoices', JSON.stringify([completedOrder, ...masterStored]));
    } catch (e) {}

    // Dispatch WhatsApp/SMS receipt if the front-desk left those checked. WhatsApp opens a real
    // pre-filled chat via the existing invoice-sharing utility; SMS has no gateway configured in
    // this deployment yet, so it's logged as a queued send rather than faked as delivered.
    if (sendWhatsapp) {
      sendInvoiceWhatsApp(completedOrder);
    }
    if (sendSms) {
      try {
        const logs = JSON.parse(localStorage.getItem('optical_sms_logs') || '[]');
        logs.unshift({
          date: new Date().toISOString(),
          phone: completedOrder.customerPhone,
          patient: completedOrder.customerName,
          invoiceId: completedOrder.id,
          amount: completedOrder.netTotal,
          status: 'Queued'
        });
        localStorage.setItem('optical_sms_logs', JSON.stringify(logs));
      } catch (e) {}
    }

    if (onCheckoutComplete) {
      onCheckoutComplete(completedOrder);
    } else {
      const docLabel = docType === 'Order' ? 'Spectacle Sales Order' : docType === 'Quotation' ? 'Price Quotation / Estimate' : 'Tax Invoice';
      alert(`✔ ${docLabel} ${billNo} completed & saved to database successfully! Net Total: ₹${netTotal}.`);
    }
  };

  const stepsList = [
    { label: 'Patient Selection', icon: <PersonIcon fontSize="small" /> },
    { label: 'Optical Prescription', icon: <EyeIcon fontSize="small" /> },
    { label: 'Frame Selection', icon: <SparkleIcon fontSize="small" /> },
    { label: 'Lens & Coatings', icon: <CartIcon fontSize="small" /> },
    { label: 'Review & Billing', icon: <PaymentIcon fontSize="small" /> }
  ];

  return (
    <Box sx={{ pb: 4 }}>
      
      {/* 🚀 TOP MODE SWITCHER TOOLBAR */}
      <Card variant="outlined" sx={{ p: 2, mb: 2.5, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
          
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Avatar sx={{ bgcolor: '#2563eb', width: 40, height: 40 }}>
              <SpeedIcon />
            </Avatar>
            <Box>
              <Typography variant="h6" fontWeight={900} color="primary.main">
                Optical Spectacle Dispensing & Sales Core
              </Typography>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Connected to Optical Database • DRF Cloud Live 🟢
              </Typography>
            </Box>
          </Box>

          <Paper variant="outlined" sx={{ p: 0.5, display: 'flex', gap: 0.5, bgcolor: '#f8fafc', borderRadius: 2.5 }}>
            <Button 
              size="small"
              variant={viewMode === 'single-page' ? 'contained' : 'text'}
              onClick={() => setViewMode('single-page')}
              startIcon={<SpeedIcon />}
              sx={{ 
                px: 2, py: 0.6, fontSize: '0.82rem', fontWeight: 900, borderRadius: 2, textTransform: 'none',
                bgcolor: viewMode === 'single-page' ? '#0f172a' : 'transparent',
                color: viewMode === 'single-page' ? '#facc15' : 'text.primary'
              }}
            >
              ⚡ All-in-One Single Screen POS (Easy Method)
            </Button>
            <Button 
              size="small"
              variant={viewMode === 'wizard' ? 'contained' : 'text'}
              onClick={() => setViewMode('wizard')}
              startIcon={<CartIcon />}
              sx={{ 
                px: 2, py: 0.6, fontSize: '0.82rem', fontWeight: 900, borderRadius: 2, textTransform: 'none',
                bgcolor: viewMode === 'wizard' ? '#0f172a' : 'transparent',
                color: viewMode === 'wizard' ? '#facc15' : 'text.primary'
              }}
            >
              📋 5-Step Guided Wizard
            </Button>
          </Paper>

        </Box>
      </Card>

      {/* ========================================================================= */}
      {/* MODE 1: ALL-IN-ONE SINGLE SCREEN POS TERMINAL (EASY METHOD) */}
      {/* ========================================================================= */}
      {viewMode === 'single-page' && (
        <Box>
          
          {/* 🔴 PART 1: TOP PANEL (PATIENT & SALES HEADER DETAILS CARD) */}
          <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
            <Grid container spacing={1.5} alignItems="center">
              
              {/* Row 1: Bill No, Test No Auto-Lookup, Customer DB Lookup */}
              <Grid item xs={12} sm={3} md={2}>
                <Typography variant="caption" fontWeight={900} color="text.secondary">
                  {docType === 'Order' ? 'Order No.' : docType === 'Quotation' ? 'Quotation No.' : 'Bill No.'}
                </Typography>
                <Paper elevation={0} sx={{ p: 0.8, bgcolor: '#0f172a', color: '#facc15', fontWeight: 900, textAlign: 'center', borderRadius: 2, fontSize: '0.9rem' }}>
                  {billNo}
                </Paper>
              </Grid>

              <Grid item xs={12} sm={3} md={2}>
                <TextField 
                  fullWidth size="small" label="Test No" placeholder="e.g. 1002"
                  value={testNo} onChange={(e) => handleTestNoChange(e.target.value)}
                  inputProps={{ style: { fontWeight: 800, fontSize: '0.85rem' } }}
                />
              </Grid>

              <Grid item xs={12} sm={6} md={5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField 
                    select fullWidth size="small" label="Select Patient from Optical DB"
                    value={selectedCustomerId} onChange={(e) => {
                      const cust = customerOptions.find(c => String(c.id) === String(e.target.value));
                      handleSelectCustomer(cust);
                    }}
                    SelectProps={{ style: { fontWeight: 800, color: '#2563eb', fontSize: '0.85rem' } }}
                  >
                    <MenuItem value=""><em>-- Select Patient from Database --</em></MenuItem>
                    {customerOptions.map(c => (
                      <MenuItem key={c.id || c.phone} value={c.id}>
                        {c.name} ({c.phone || 'No Phone'}) {c.id ? `[${c.id}]` : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="contained" color="primary" size="small"
                    onClick={handleSavePatient}
                    sx={{ minWidth: 38, height: 38, px: 1, fontWeight: 900, fontSize: '1.2rem', borderRadius: 2 }}
                  >
                    +
                  </Button>
                </Stack>
              </Grid>

              {/* Document Type Pills */}
              <Grid item xs={12} md={3}>
                <Paper variant="outlined" sx={{ p: 0.4, display: 'flex', gap: 0.5, bgcolor: '#f8fafc', borderRadius: 2 }}>
                  {['Order', 'Invoice', 'Quotation'].map(type => (
                    <Button 
                      key={type} size="small"
                      variant={docType === type ? 'contained' : 'text'}
                      onClick={() => handleDocTypeChange(type)}
                      sx={{ 
                        flexGrow: 1, py: 0.4, fontSize: '0.78rem', fontWeight: 900, borderRadius: 1.5,
                        bgcolor: docType === type ? '#0f172a' : 'transparent',
                        color: docType === type ? '#facc15' : 'text.primary'
                      }}
                    >
                      {type}
                    </Button>
                  ))}
                </Paper>
              </Grid>

              {/* Row 2: Customer Name, Phone, Age, Gender, Payment Mode */}
              <Grid item xs={12} sm={4} md={3}>
                <TextField 
                  fullWidth size="small" label="Customer Name" placeholder="Walk-in Patient Name"
                  value={customerInput.name} onChange={(e) => setCustomerInput({ ...customerInput, name: e.target.value })}
                  inputProps={{ style: { fontWeight: 700, fontSize: '0.85rem' } }}
                />
              </Grid>

              <Grid item xs={12} sm={4} md={3}>
                <TextField 
                  fullWidth size="small" label="Mobile Phone No" placeholder="+91 Phone"
                  value={customerInput.phone} onChange={(e) => setCustomerInput({ ...customerInput, phone: e.target.value })}
                  inputProps={{ style: { fontWeight: 700, fontSize: '0.85rem' } }}
                />
              </Grid>

              <Grid item xs={6} sm={2} md={1.5}>
                <TextField 
                  fullWidth size="small" label="Age" placeholder="20"
                  value={customerInput.age} onChange={(e) => setCustomerInput({ ...customerInput, age: e.target.value })}
                  inputProps={{ style: { fontWeight: 800, textAlign: 'center', fontSize: '0.85rem' } }}
                />
              </Grid>

              <Grid item xs={6} sm={2} md={1.5}>
                <TextField 
                  select fullWidth size="small" label="Gender"
                  value={customerInput.gender} onChange={(e) => setCustomerInput({ ...customerInput, gender: e.target.value })}
                  SelectProps={{ style: { fontWeight: 800, fontSize: '0.85rem' } }}
                >
                  <MenuItem value="MALE">MALE</MenuItem>
                  <MenuItem value="FEMALE">FEMALE</MenuItem>
                  <MenuItem value="OTHER">OTHER</MenuItem>
                </TextField>
              </Grid>

              <Grid item xs={12} sm={4} md={3}>
                <TextField 
                  select fullWidth size="small" label="Payment Mode"
                  value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}
                  SelectProps={{ style: { fontWeight: 800, fontSize: '0.85rem' } }}
                >
                  <MenuItem value="Cash">Cash</MenuItem>
                  <MenuItem value="Credit">Credit</MenuItem>
                </TextField>
              </Grid>

              {/* Row 3: Address, Delivery Date, GSTIN, Salesman, Remark */}
              <Grid item xs={12} md={4}>
                <TextField 
                  fullWidth size="small" label="Patient Address" placeholder="City & Address"
                  value={customerInput.address} onChange={(e) => setCustomerInput({ ...customerInput, address: e.target.value })}
                  inputProps={{ style: { fontSize: '0.82rem' } }}
                />
              </Grid>

              <Grid item xs={12} sm={4} md={2}>
                <TextField 
                  type="date" fullWidth size="small" label="Delivery Date"
                  value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ style: { fontWeight: 700, fontSize: '0.82rem' } }}
                />
              </Grid>

              <Grid item xs={12} sm={4} md={2}>
                <TextField 
                  fullWidth size="small" label="GSTIN No" placeholder="07AAAAA0000A1Z5"
                  value={customerInput.gstin} onChange={(e) => setCustomerInput({ ...customerInput, gstin: e.target.value })}
                  inputProps={{ style: { fontSize: '0.82rem' } }}
                />
              </Grid>

              <Grid item xs={12} sm={4} md={2}>
                <TextField 
                  select fullWidth size="small" label="Salesman"
                  value={salesman} onChange={(e) => setSalesman(e.target.value)}
                  SelectProps={{ style: { fontWeight: 800, fontSize: '0.82rem' } }}
                >
                  <MenuItem value="ADMIN">ADMIN</MenuItem>
                  <MenuItem value="OPTOMETRIST">OPTOMETRIST</MenuItem>
                  <MenuItem value="SALES STAFF">SALES STAFF</MenuItem>
                </TextField>
              </Grid>

              <Grid item xs={12} md={2}>
                <TextField
                  fullWidth size="small" label="Remark" placeholder="Notes"
                  value={remark} onChange={(e) => setRemark(e.target.value)}
                  inputProps={{ style: { fontSize: '0.82rem' } }}
                />
              </Grid>

              {/* Row 4: Diagnosis & ICD Code — printed on the invoice alongside patient details.
                  Diagnosis auto-fills from the patient's last eye exam when one is on file. */}
              <Grid item xs={12} md={8}>
                <TextField
                  fullWidth size="small" label="Diagnosis / Patient Issue" placeholder="e.g. Compound Myopic Astigmatism"
                  value={rxData.notes} onChange={(e) => setRxData({ ...rxData, notes: e.target.value })}
                  inputProps={{ style: { fontSize: '0.82rem' } }}
                />
              </Grid>

              <Grid item xs={12} md={4}>
                <TextField
                  fullWidth size="small" label="ICD Code" placeholder="e.g. H52.13"
                  value={icdCode} onChange={(e) => setIcdCode(e.target.value)}
                  inputProps={{ style: { fontSize: '0.82rem' } }}
                />
              </Grid>

            </Grid>
          </Paper>

          {/* 🟡 PART 2: REFRACTION PRESCRIPTION GRID DIRECTLY UNDER PATIENT DETAILS */}
          <Paper variant="outlined" sx={{ mb: 2, border: '2.5px solid #0f172a', borderRadius: 3.5, overflow: 'hidden', bgcolor: '#ffffff', boxShadow: '0 4px 16px rgba(15, 23, 42, 0.08)' }}>
            
            {/* Header Bar */}
            <Box sx={{ bgcolor: '#0f172a', px: 2.5, py: 1.2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Stack direction="row" spacing={2} alignItems="center">
                <FormControlLabel 
                  control={
                    <Checkbox 
                      size="small" checked={showRx} onChange={(e) => setShowRx(e.target.checked)} 
                      sx={{ color: '#facc15', '&.Mui-checked': { color: '#facc15' } }} 
                    />
                  }
                  label={<Typography variant="subtitle1" fontWeight={900} color="#facc15">Prescription Grid</Typography>}
                />
                <Button 
                  size="small" variant={activeRxTab === 'prescription' ? 'contained' : 'text'}
                  onClick={() => setActiveRxTab('prescription')}
                  sx={{ 
                    bgcolor: activeRxTab === 'prescription' ? '#2563eb' : 'transparent',
                    color: activeRxTab === 'prescription' ? '#ffffff' : '#94a3b8',
                    fontWeight: 900, fontSize: '0.85rem', py: 0.5, px: 2.5, borderRadius: 2, textTransform: 'none'
                  }}
                >
                  Prescription
                </Button>
                <Button 
                  size="small" variant={activeRxTab === 'history' ? 'contained' : 'text'}
                  onClick={() => setActiveRxTab('history')}
                  sx={{ 
                    bgcolor: activeRxTab === 'history' ? '#2563eb' : 'transparent',
                    color: activeRxTab === 'history' ? '#ffffff' : '#94a3b8',
                    fontWeight: 900, fontSize: '0.85rem', py: 0.5, px: 2.5, borderRadius: 2, textTransform: 'none'
                  }}
                >
                  Power History
                </Button>
              </Stack>
              <Typography variant="subtitle2" fontWeight={900} color="#facc15">
                📅 Date: {new Date().toLocaleDateString('en-GB')}
              </Typography>
            </Box>

            {showRx && activeRxTab === 'prescription' ? (
              <Box sx={{ p: 2.5, bgcolor: '#f8fafc' }}>
                <Grid container spacing={2} alignItems="flex-start">
                  
                  {/* Left Margin DV & NV Pills */}
                  <Grid item xs={12} sm={1} sx={{ display: 'flex', flexDirection: { xs: 'row', sm: 'column' }, gap: 1.5, pt: { xs: 0, sm: 4.5 } }}>
                    <Paper elevation={0} sx={{ flexGrow: 1, bgcolor: '#0f172a', color: '#facc15', fontWeight: 900, py: 1.2, textAlign: 'center', borderRadius: 2, fontSize: '0.9rem' }}>
                      DV
                    </Paper>
                    <Paper elevation={0} sx={{ flexGrow: 1, bgcolor: '#0f172a', color: '#facc15', fontWeight: 900, py: 1.2, textAlign: 'center', borderRadius: 2, fontSize: '0.9rem' }}>
                      NV
                    </Paper>
                  </Grid>

                  {/* RIGHT (OD) EYE BLOCK */}
                  <Grid item xs={12} sm={5.5}>
                    <Paper variant="outlined" sx={{ border: '2.5px solid #2563eb', borderRadius: 2.5, overflow: 'hidden', bgcolor: '#ffffff', boxShadow: '0 2px 8px rgba(37, 99, 235, 0.12)' }}>
                      <Box sx={{ bgcolor: '#2563eb', color: '#ffffff', py: 0.75, textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', letterSpacing: 0.5 }}>
                        RIGHT (OD)
                      </Box>
                      <Table size="small">
                        <TableHead sx={{ bgcolor: '#eff6ff' }}>
                          <TableRow>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>SPH</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>CYL</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>AXIS</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>VA</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          <TableRow>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.sphOD} onChange={(e) => setRxData({ ...rxData, sphOD: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, color: '#2563eb', fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.cylOD} onChange={(e) => setRxData({ ...rxData, cylOD: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.axisOD} onChange={(e) => setRxData({ ...rxData, axisOD: e.target.value })} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.vaOD} onChange={(e) => setRxData({ ...rxData, vaOD: e.target.value })} placeholder="6/6" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.sphOD_NV} onChange={(e) => setRxData({ ...rxData, sphOD_NV: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.cylOD_NV} onChange={(e) => setRxData({ ...rxData, cylOD_NV: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.axisOD_NV} onChange={(e) => setRxData({ ...rxData, axisOD_NV: e.target.value })} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.vaOD_NV} onChange={(e) => setRxData({ ...rxData, vaOD_NV: e.target.value })} placeholder="N6" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>

                      {/* Bottom Row: IPD & ADD with clean floating labels */}
                      <Box sx={{ p: 1.2, bgcolor: '#f1f5f9', borderTop: '1.5px solid #cbd5e1', display: 'flex', gap: 1.5 }}>
                        <TextField 
                          fullWidth size="small" label="IPD (mm)" placeholder="62" 
                          value={rxData.ipdOD} onChange={(e) => setRxData({ ...rxData, ipdOD: e.target.value })} 
                          InputLabelProps={{ shrink: true, style: { fontWeight: 800, fontSize: '0.8rem' } }}
                          inputProps={{ style: { fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} 
                        />
                        <TextField 
                          fullWidth size="small" label="ADD" placeholder="+1.00" 
                          value={rxData.addOD} onChange={(e) => setRxData({ ...rxData, addOD: e.target.value })} 
                          InputLabelProps={{ shrink: true, style: { fontWeight: 800, fontSize: '0.8rem', color: '#2563eb' } }}
                          inputProps={{ style: { fontWeight: 900, color: '#2563eb', fontSize: '0.9rem', padding: '6px' } }} 
                        />
                      </Box>
                    </Paper>
                  </Grid>

                  {/* LEFT (OS) EYE BLOCK */}
                  <Grid item xs={12} sm={5.5}>
                    <Paper variant="outlined" sx={{ border: '2.5px solid #059669', borderRadius: 2.5, overflow: 'hidden', bgcolor: '#ffffff', boxShadow: '0 2px 8px rgba(5, 150, 105, 0.12)' }}>
                      <Box sx={{ bgcolor: '#059669', color: '#ffffff', py: 0.75, textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', letterSpacing: 0.5 }}>
                        LEFT (OS)
                      </Box>
                      <Table size="small">
                        <TableHead sx={{ bgcolor: '#ecfdf5' }}>
                          <TableRow>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>SPH</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>CYL</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>AXIS</TableCell>
                            <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.82rem' }}>VA</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          <TableRow>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.sphOS} onChange={(e) => setRxData({ ...rxData, sphOS: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, color: '#059669', fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.cylOS} onChange={(e) => setRxData({ ...rxData, cylOS: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.axisOS} onChange={(e) => setRxData({ ...rxData, axisOS: e.target.value })} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.vaOS} onChange={(e) => setRxData({ ...rxData, vaOS: e.target.value })} placeholder="6/6" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.sphOS_NV} onChange={(e) => setRxData({ ...rxData, sphOS_NV: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.cylOS_NV} onChange={(e) => setRxData({ ...rxData, cylOS_NV: e.target.value })} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.axisOS_NV} onChange={(e) => setRxData({ ...rxData, axisOS_NV: e.target.value })} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                            <TableCell sx={{ p: 0.5 }}><TextField size="small" value={rxData.vaOS_NV} onChange={(e) => setRxData({ ...rxData, vaOS_NV: e.target.value })} placeholder="N6" inputProps={{ style: { textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} /></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>

                      {/* Bottom Row: IPD & ADD with clean floating labels */}
                      <Box sx={{ p: 1.2, bgcolor: '#f1f5f9', borderTop: '1.5px solid #cbd5e1', display: 'flex', gap: 1.5 }}>
                        <TextField 
                          fullWidth size="small" label="IPD (mm)" placeholder="62" 
                          value={rxData.ipdOS} onChange={(e) => setRxData({ ...rxData, ipdOS: e.target.value })} 
                          InputLabelProps={{ shrink: true, style: { fontWeight: 800, fontSize: '0.8rem' } }}
                          inputProps={{ style: { fontWeight: 900, fontSize: '0.9rem', padding: '6px' } }} 
                        />
                        <TextField 
                          fullWidth size="small" label="ADD" placeholder="+1.00" 
                          value={rxData.addOS} onChange={(e) => setRxData({ ...rxData, addOS: e.target.value })} 
                          InputLabelProps={{ shrink: true, style: { fontWeight: 800, fontSize: '0.8rem', color: '#059669' } }}
                          inputProps={{ style: { fontWeight: 900, color: '#059669', fontSize: '0.9rem', padding: '6px' } }} 
                        />
                      </Box>
                    </Paper>
                  </Grid>

                </Grid>
              </Box>
            ) : (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary" fontWeight={600}>
                  Prescription grid hidden or viewing power history timeline.
                </Typography>
              </Box>
            )}
          </Paper>

          {/* 🟡 PART 2 BAR: MIDDLE PRODUCT QUICK ENTRY TOOLBAR */}
          <Paper variant="outlined" sx={{ p: 1.2, mb: 1.5, borderRadius: 2.5, bgcolor: '#eff6ff', borderColor: '#bfdbfe' }}>
            <Grid container spacing={1} alignItems="center">
              
              <Grid item xs={12} sm={0.8} md={0.8}>
                <FormControlLabel 
                  control={<Checkbox size="small" checked={powerChecked} onChange={(e) => setPowerChecked(e.target.checked)} color="primary" />}
                  label={<Typography variant="caption" fontWeight={900}>Power</Typography>}
                  sx={{ mr: 0 }}
                />
              </Grid>

              <Grid item xs={12} sm={1.1} md={1.1}>
                <TextField 
                  select fullWidth size="small" label="Index" disabled={!powerChecked}
                  value={lensIndex} onChange={(e) => setLensIndex(e.target.value)}
                  SelectProps={{ style: { fontSize: '0.78rem', fontWeight: 800 } }}
                >
                  <MenuItem value="1.56">1.56 CR39</MenuItem>
                  <MenuItem value="1.61">1.61 Hi-Index</MenuItem>
                  <MenuItem value="1.67">1.67 Ultra</MenuItem>
                  <MenuItem value="1.74">1.74 Super</MenuItem>
                </TextField>
              </Grid>

              {/* Select Item from Optical Database — search matches name, barcode, SKU, brand,
                  category, and (for imported products) model no / color / size, so staff can
                  find an item by typing whichever detail they actually have on hand. */}
              <Grid item xs={12} sm={3.0} md={3.0}>
                <Autocomplete
                  size="small"
                  options={products}
                  value={products.find(p => p.id === entryInput.productId) || null}
                  onChange={(e, val) => handleProductSelect(val)}
                  getOptionLabel={(p) => p?.name || ''}
                  isOptionEqualToValue={(opt, val) => (opt.id || opt.code || opt.barcode) === (val?.id || val?.code || val?.barcode)}
                  filterOptions={(options, state) => {
                    const q = state.inputValue.toLowerCase().trim();
                    if (!q) return options;
                    return options.filter(p => {
                      const extra = p.extra_data || {};
                      const haystack = [
                        p.name, p.barcode, p.sku, p.brand, p.category,
                        extra.model_no, extra.modelNo, extra.color_code, extra.color, extra.size
                      ].filter(Boolean).join(' ').toLowerCase();
                      return haystack.includes(q);
                    });
                  }}
                  renderOption={(props, p) => (
                    <li {...props} key={p.id || p.code || p.barcode}>
                      <Box sx={{ py: 0.25 }}>
                        <Typography variant="body2" fontWeight={800}>{p.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {p.brand || 'Generic'} • {p.barcode || p.sku || '—'} • ₹{p.price || p.sellingPrice || 0}
                        </Typography>
                      </Box>
                    </li>
                  )}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Optical DB Product Selector"
                      placeholder="Search name, barcode, brand, model..."
                      InputProps={{ ...params.InputProps, style: { fontSize: '0.78rem', fontWeight: 800, color: '#2563eb' } }}
                    />
                  )}
                />
              </Grid>

              <Grid item xs={12} sm={1.0} md={1.0}>
                <TextField
                  select fullWidth size="small" label="Category"
                  value={entryInput.category} onChange={(e) => setEntryInput({ ...entryInput, category: e.target.value })}
                  SelectProps={{ style: { fontSize: '0.78rem', fontWeight: 800 } }}
                >
                  <MenuItem value="FRAME">FRAME</MenuItem>
                  <MenuItem value="LENS">LENS</MenuItem>
                  <MenuItem value="CONTACT LENS">CONTACT LENS</MenuItem>
                  <MenuItem value="ACCESSORY">ACCESSORY</MenuItem>
                </TextField>
              </Grid>

              <Grid item xs={6} sm={0.7} md={0.7}>
                <TextField 
                  fullWidth size="small" label="Qty" type="number"
                  value={entryInput.qty} onChange={(e) => setEntryInput({ ...entryInput, qty: e.target.value })}
                  inputProps={{ style: { fontWeight: 900, textAlign: 'center', fontSize: '0.8rem' } }}
                />
              </Grid>

              <Grid item xs={6} sm={1.1} md={1.1}>
                <TextField
                  fullWidth size="small" label="Price (₹)" placeholder="0.00"
                  value={entryInput.price} onChange={(e) => setEntryInput({ ...entryInput, price: e.target.value })}
                  inputProps={{ style: { fontWeight: 800, fontSize: '0.8rem' } }}
                />
              </Grid>

              <Grid item xs={6} sm={0.9} md={0.9}>
                <TextField
                  fullWidth size="small" label="Disc %" type="number" placeholder="0"
                  value={entryInput.discPercent}
                  onChange={(e) => setEntryInput({ ...entryInput, discPercent: e.target.value })}
                  inputProps={{ min: 0, max: 100, style: { fontWeight: 800, textAlign: 'center', fontSize: '0.8rem', color: '#dc2626' } }}
                />
              </Grid>

              <Grid item xs={6} sm={1.0} md={1.0}>
                <TextField
                  select fullWidth size="small" label="Tax %"
                  value={entryInput.taxPercent}
                  onChange={(e) => setEntryInput({ ...entryInput, taxPercent: e.target.value })}
                  SelectProps={{ style: { fontSize: '0.78rem', fontWeight: 800, color: '#0f172a' } }}
                >
                  {taxSlabItems(entryInput.taxPercent)}
                </TextField>
              </Grid>

              <Grid item xs={12} sm={1.2} md={1.2}>
                <Button
                  fullWidth variant="contained" size="small"
                  onClick={() => setQuickAddOpen(!quickAddOpen)} startIcon={<AddIcon />}
                  sx={{
                    fontWeight: 900, py: 0.8, borderRadius: 2, textTransform: 'none', fontSize: '0.75rem',
                    bgcolor: quickAddOpen ? '#3f4c28' : '#0f172a', color: '#facc15',
                    whiteSpace: 'nowrap',
                    '&:hover': { bgcolor: '#2a351a' }
                  }}
                >
                  {quickAddOpen ? 'Close NEW' : '+ NEW Lens'}
                </Button>
              </Grid>

              <Grid item xs={12} sm={1.2} md={1.2}>
                <Button
                  fullWidth variant="contained" size="small" color="primary"
                  onClick={handleAddItem} startIcon={<AddIcon />}
                  sx={{ fontWeight: 900, py: 0.8, borderRadius: 2, textTransform: 'none', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                >
                  + Add Item
                </Button>
              </Grid>

            </Grid>

            {/* Selected product's DB details — item name, brand, stock — shown so staff can
                confirm they picked the right item before adding it to the bill (barcode, model
                no, color, size, brand ... are all searchable directly in the selector above). */}
            {selectedProductDetail && (
              <Box sx={{ mt: 1.2, p: 1, borderRadius: 2, bgcolor: '#ffffff', border: '1px dashed #93c5fd', display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
                <Typography variant="caption" fontWeight={900} color="text.secondary" sx={{ mr: 0.5 }}>
                  SELECTED ITEM:
                </Typography>
                <Chip size="small" label={entryInput.item || selectedProductDetail.name} color="primary" sx={{ fontWeight: 800, fontSize: '0.7rem' }} />
                <Chip size="small" label={`Brand: ${selectedProductDetail.brand || 'Generic'}`} variant="outlined" sx={{ fontWeight: 700, fontSize: '0.7rem' }} />
                <Chip size="small" label={`Stock: ${selectedProductDetail.stock ?? '—'}`} color={parseInt(selectedProductDetail.stock) > 0 ? 'success' : 'error'} variant="outlined" sx={{ fontWeight: 700, fontSize: '0.7rem' }} />
                {selectedProductDetail.sku && (
                  <Chip size="small" label={`SKU: ${selectedProductDetail.sku}`} variant="outlined" sx={{ fontWeight: 700, fontSize: '0.7rem' }} />
                )}
                {selectedProductDetail.hsn_code && (
                  <Chip size="small" label={`HSN: ${selectedProductDetail.hsn_code}`} variant="outlined" sx={{ fontWeight: 700, fontSize: '0.7rem' }} />
                )}
                <Chip
                  size="small"
                  label={`Tax: ${entryInput.taxPercent || 0}% GST`}
                  color="warning"
                  variant="outlined"
                  sx={{ fontWeight: 700, fontSize: '0.7rem' }}
                />
              </Box>
            )}
          </Paper>

          {/* 🌟 IMAGE MODEL 2 FORMAT: EXPANDABLE QUICK LENS & ITEM CREATOR PANEL */}
          {quickAddOpen && (
            <Paper 
              variant="outlined" 
              sx={{ 
                p: 2, mb: 2, borderRadius: 3, 
                bgcolor: '#fffdf0', borderColor: '#d4cf96',
                border: '2px solid #556b2f',
                boxShadow: '0 4px 20px rgba(85, 107, 47, 0.15)' 
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label="NEW ITEM & LENS ENTRY (MODEL 2)" size="small" sx={{ bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900 }} />
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>
                    Directly registers new lens specs or inventory items & injects them into sale cart
                  </Typography>
                </Stack>
                <Button 
                  size="small" variant="outlined" 
                  onClick={handleAutoFillPower}
                  sx={{ borderColor: '#3f4c28', color: '#3f4c28', fontWeight: 900, fontSize: '0.72rem', textTransform: 'none' }}
                >
                  ⚡ Auto-Fill Power from Rx Grid
                </Button>
              </Box>

              <Grid container spacing={1.2} alignItems="center">
                
                {/* Row 1: Description & Description L */}
                <Grid item xs={12} sm={6}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ minWidth: 80, fontWeight: 900, color: '#3f4c28' }}>Description</Typography>
                    <TextField 
                      fullWidth size="small" placeholder="Enter product description"
                      value={quickForm.description} onChange={(e) => setQuickForm({ ...quickForm, description: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.82rem', padding: '5px 8px' } }}
                    />
                  </Box>
                </Grid>

                <Grid item xs={12} sm={6}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ minWidth: 95, fontWeight: 900, color: '#3f4c28' }}>Description L</Typography>
                    <TextField 
                      fullWidth size="small" placeholder="Lens detail / prescription label"
                      value={quickForm.descriptionL} onChange={(e) => setQuickForm({ ...quickForm, descriptionL: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.82rem', padding: '5px 8px' } }}
                    />
                  </Box>
                </Grid>

                {/* Row 2: Category, SubCat, Group */}
                <Grid item xs={12} sm={4}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Paper elevation={0} sx={{ px: 1, py: 0.5, bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900, fontSize: '0.72rem', borderRadius: 1 }}>
                      Category
                    </Paper>
                    <TextField 
                      select fullWidth size="small" 
                      value={quickForm.category} onChange={(e) => setQuickForm({ ...quickForm, category: e.target.value })}
                      SelectProps={{ style: { bgcolor: '#ffffff', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }}
                    >
                      <MenuItem value="LENS">LENS</MenuItem>
                      <MenuItem value="FRAME">FRAME</MenuItem>
                      <MenuItem value="CONTACT LENS">CONTACT LENS</MenuItem>
                      <MenuItem value="ACCESSORY">ACCESSORY</MenuItem>
                    </TextField>
                  </Box>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Paper elevation={0} sx={{ px: 1, py: 0.5, bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900, fontSize: '0.72rem', borderRadius: 1 }}>
                      SubCat
                    </Paper>
                    <TextField 
                      select fullWidth size="small" 
                      value={quickForm.subCat} onChange={(e) => setQuickForm({ ...quickForm, subCat: e.target.value })}
                      SelectProps={{ style: { bgcolor: '#ffffff', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }}
                    >
                      <MenuItem value="Single Vision">Single Vision</MenuItem>
                      <MenuItem value="Progressive Digital">Progressive Digital</MenuItem>
                      <MenuItem value="Bifocal D-Seg">Bifocal D-Seg</MenuItem>
                      <MenuItem value="Full Rim">Full Rim</MenuItem>
                      <MenuItem value="Rimless">Rimless</MenuItem>
                    </TextField>
                  </Box>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Paper elevation={0} sx={{ px: 1, py: 0.5, bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900, fontSize: '0.72rem', borderRadius: 1 }}>
                      Group
                    </Paper>
                    <TextField 
                      select fullWidth size="small" 
                      value={quickForm.group} onChange={(e) => setQuickForm({ ...quickForm, group: e.target.value })}
                      SelectProps={{ style: { bgcolor: '#ffffff', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }}
                    >
                      <MenuItem value="GENERIC">GENERIC</MenuItem>
                      <MenuItem value="ESSILOR">ESSILOR</MenuItem>
                      <MenuItem value="ZEISS">ZEISS</MenuItem>
                      <MenuItem value="HOYA">HOYA</MenuItem>
                      <MenuItem value="PREMIUM">PREMIUM</MenuItem>
                    </TextField>
                  </Box>
                </Grid>

                {/* Row 3: Brand, Model No, Power, Size */}
                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Paper elevation={0} sx={{ px: 1, py: 0.5, bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900, fontSize: '0.72rem', borderRadius: 1 }}>
                      Brand
                    </Paper>
                    <TextField 
                      select fullWidth size="small" 
                      value={quickForm.brand} onChange={(e) => setQuickForm({ ...quickForm, brand: e.target.value })}
                      SelectProps={{ style: { bgcolor: '#ffffff', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }}
                    >
                      <MenuItem value="Essilor">Essilor</MenuItem>
                      <MenuItem value="Zeiss">Zeiss</MenuItem>
                      <MenuItem value="Hoya">Hoya</MenuItem>
                      <MenuItem value="Crizal">Crizal</MenuItem>
                      <MenuItem value="RayBan">RayBan</MenuItem>
                      <MenuItem value="Generic">Generic</MenuItem>
                    </TextField>
                  </Box>
                </Grid>

                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 60, fontWeight: 900, color: '#3f4c28' }}>Model No</Typography>
                    <TextField 
                      fullWidth size="small" placeholder="M-101"
                      value={quickForm.modelNo} onChange={(e) => setQuickForm({ ...quickForm, modelNo: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.8rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 45, fontWeight: 900, color: '#3f4c28' }}>Power</Typography>
                    <TextField 
                      fullWidth size="small" placeholder="OD/OS Power"
                      value={quickForm.power} onChange={(e) => setQuickForm({ ...quickForm, power: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.8rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 35, fontWeight: 900, color: '#3f4c28' }}>Size</Typography>
                    <TextField 
                      fullWidth size="small" placeholder="50-18"
                      value={quickForm.size} onChange={(e) => setQuickForm({ ...quickForm, size: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.8rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                {/* Row 4: Colour, Colour description, Barcode 2, Save button */}
                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Paper elevation={0} sx={{ px: 1, py: 0.5, bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900, fontSize: '0.72rem', borderRadius: 1 }}>
                      Colour
                    </Paper>
                    <TextField 
                      fullWidth size="small" placeholder="Color code"
                      value={quickForm.color} onChange={(e) => setQuickForm({ ...quickForm, color: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.8rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                <Grid item xs={12} sm={5}>
                  <TextField 
                    fullWidth size="small" placeholder="Detailed Color / Coating spec"
                    value={quickForm.color} onChange={(e) => setQuickForm({ ...quickForm, color: e.target.value })}
                    inputProps={{ style: { bgcolor: '#fffde7', fontWeight: 700, fontSize: '0.8rem', padding: '5px' } }}
                  />
                </Grid>

                <Grid item xs={12} sm={4}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 70, fontWeight: 900, color: '#3f4c28' }}>Barcode 2</Typography>
                    <TextField 
                      fullWidth size="small" placeholder="Secondary Barcode"
                      value={quickForm.barcode2} onChange={(e) => setQuickForm({ ...quickForm, barcode2: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 700, fontSize: '0.8rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                {/* Row 5: Sales Pr, Cost Pr, Tax %, Save Button (Gold/Dark Green matching Image 2) */}
                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 55, fontWeight: 900, color: '#3f4c28' }}>Sales Pr</Typography>
                    <TextField 
                      fullWidth size="small" type="number" placeholder="0.00"
                      value={quickForm.salesPr} onChange={(e) => setQuickForm({ ...quickForm, salesPr: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 900, color: '#2563eb', fontSize: '0.85rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 55, fontWeight: 900, color: '#3f4c28' }}>Cost Pr</Typography>
                    <TextField 
                      fullWidth size="small" type="number" placeholder="0.00"
                      value={quickForm.costPr} onChange={(e) => setQuickForm({ ...quickForm, costPr: e.target.value })}
                      inputProps={{ style: { bgcolor: '#ffffff', fontWeight: 800, fontSize: '0.85rem', padding: '5px' } }}
                    />
                  </Box>
                </Grid>

                <Grid item xs={12} sm={3}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                    <Typography variant="caption" sx={{ minWidth: 40, fontWeight: 900, color: '#3f4c28' }}>Tax %</Typography>
                    <TextField 
                      select fullWidth size="small" 
                      value={quickForm.taxPercent} onChange={(e) => setQuickForm({ ...quickForm, taxPercent: e.target.value })}
                      SelectProps={{ style: { bgcolor: '#ffffff', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }}
                    >
                      <MenuItem value="18.00">18.00%</MenuItem>
                      <MenuItem value="12.00">12.00%</MenuItem>
                      <MenuItem value="5.00">5.00%</MenuItem>
                      <MenuItem value="0.00">0.00%</MenuItem>
                    </TextField>
                  </Box>
                </Grid>

                <Grid item xs={12} sm={3}>
                  <Button 
                    fullWidth variant="contained" 
                    onClick={handleSaveQuickItem}
                    sx={{ 
                      bgcolor: '#3f4c28', color: '#facc15', fontWeight: 900, 
                      fontSize: '0.95rem', py: 0.8, borderRadius: 2, 
                      textTransform: 'none', border: '1px solid #556b2f',
                      boxShadow: '0 4px 12px rgba(63, 76, 40, 0.3)',
                      '&:hover': { bgcolor: '#2a351a' } 
                    }}
                  >
                    Save & Add ➔
                  </Button>
                </Grid>

              </Grid>
            </Paper>
          )}

          {/* 🟢 PART 3: CENTER BILLING ITEMS DATA GRID */}
          <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden', mb: 1.5, borderColor: '#cbd5e1' }}>
            <TableContainer sx={{ maxH: 300 }}>
              <Table size="small" stickyHeader>
                <TableHead sx={{ bgcolor: '#0f172a' }}>
                  <TableRow>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Barcode</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Item Description</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Model No</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Color</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Size</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Brand</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Category</TableCell>
                    <TableCell sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Power</TableCell>
                    <TableCell align="center" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Qty</TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Price</TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Disc.</TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Gross</TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Tax</TableCell>
                    <TableCell align="right" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Total</TableCell>
                    <TableCell align="center" sx={{ bgcolor: '#0f172a', color: '#ffffff', fontWeight: 900, py: 0.8, fontSize: '0.75rem' }}>Action</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {itemsList.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={15} align="center" sx={{ py: 4 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={600}>
                          Billing grid is blank. Select item from Optical DB above or enter details to add.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    itemsList.map((row) => (
                      <TableRow key={row.id} hover sx={{ '&:nth-of-type(even)': { bgcolor: '#f8fafc' } }}>
                        <TableCell sx={{ fontWeight: 800, color: 'primary.main', fontSize: '0.8rem' }}>{row.barcode}</TableCell>
                        <TableCell sx={{ fontWeight: 700, fontSize: '0.8rem' }}>{row.item}</TableCell>
                        <TableCell sx={{ fontSize: '0.8rem' }}>{row.modelNo}</TableCell>
                        <TableCell sx={{ fontSize: '0.8rem' }}>{row.color}</TableCell>
                        <TableCell sx={{ fontSize: '0.8rem' }}>{row.size}</TableCell>
                        <TableCell sx={{ fontSize: '0.8rem' }}>{row.brand}</TableCell>
                        <TableCell sx={{ fontSize: '0.8rem' }}><Chip label={row.category} size="small" color="primary" variant="outlined" sx={{ fontWeight: 800, height: 20, fontSize: '0.65rem' }} /></TableCell>
                        <TableCell sx={{ fontSize: '0.8rem', color: '#2563eb', fontWeight: 700 }}>{row.power}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, fontSize: '0.85rem' }}>{row.qty}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.8rem' }}>₹{row.price.toFixed(2)}</TableCell>
                        <TableCell align="right" sx={{ color: 'error.main', fontSize: '0.8rem' }}>
                          ₹{row.disc.toFixed(2)}{row.discPercent ? ` (${row.discPercent}%)` : ''}
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.8rem' }}>₹{row.gross.toFixed(2)}</TableCell>
                        <TableCell align="right" sx={{ fontSize: '0.8rem', color: '#0f766e' }}>
                          ₹{(row.tax || 0).toFixed(2)} ({row.taxPercent || 0}%)
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 900, color: 'primary.main', fontSize: '0.85rem' }}>₹{row.total.toFixed(2)}</TableCell>
                        <TableCell align="center">
                          <IconButton size="small" color="primary" onClick={() => handleOpenEditItem(row)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="error" onClick={() => handleRemoveItem(row.id)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>

          {/* Edit Billing Row — Qty / Price / Discount % / Tax %, recomputed on save */}
          <Dialog open={!!editingItem} onClose={() => setEditingItem(null)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
            <DialogTitle sx={{ fontWeight: 800 }}>Edit Item — {editingItem?.item}</DialogTitle>
            {editingItem && (
              <DialogContent>
                <Stack spacing={2} sx={{ mt: 1 }}>
                  <Grid container spacing={2}>
                    <Grid item xs={6}>
                      <TextField
                        fullWidth size="small" label="Qty" type="number"
                        value={editingItem.qty}
                        onChange={(e) => setEditingItem({ ...editingItem, qty: e.target.value })}
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField
                        fullWidth size="small" label="Price (₹)" type="number"
                        value={editingItem.price}
                        onChange={(e) => setEditingItem({ ...editingItem, price: e.target.value })}
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField
                        fullWidth size="small" label="Discount %" type="number"
                        value={editingItem.discPercent}
                        onChange={(e) => setEditingItem({ ...editingItem, discPercent: e.target.value })}
                        inputProps={{ min: 0, max: 100 }}
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField
                        select fullWidth size="small" label="Tax %"
                        value={editingItem.taxPercent}
                        onChange={(e) => setEditingItem({ ...editingItem, taxPercent: e.target.value })}
                      >
                        {taxSlabItems(editingItem.taxPercent)}
                      </TextField>
                    </Grid>
                  </Grid>
                </Stack>
              </DialogContent>
            )}
            <DialogActions sx={{ p: 2 }}>
              <Button onClick={() => setEditingItem(null)}>Cancel</Button>
              <Button variant="contained" onClick={handleSaveEditItem}>Save Changes</Button>
            </DialogActions>
          </Dialog>

          {/* 🟢 PART 3 FOOTER: BOTTOM MULTI-PAYMODE, CRM TOGGLES & SUMMARY FOOTER */}
          <Paper variant="outlined" sx={{ p: 1.8, borderRadius: 3, bgcolor: '#f8fafc', borderColor: '#cbd5e1' }}>
            <Grid container spacing={1.5} alignItems="center">
              
              {/* Box 1: Quantities & Item Price Breakdown */}
              <Grid item xs={12} sm={6} md={2.4}>
                <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#ffffff' }}>
                  <Grid container spacing={0.8}>
                    <Grid item xs={6}><Typography variant="caption" color="text.secondary" fontWeight={700}>Total Qty</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={900} align="right">{totalQty}</Typography></Grid>
                    
                    <Grid item xs={6}><Typography variant="caption" color="text.secondary" fontWeight={700}>Item Price</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={900} align="right">₹{grossTotal.toFixed(2)}</Typography></Grid>
                    
                    <Grid item xs={6}><Typography variant="caption" color="text.secondary" fontWeight={700}>Item Discount</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={900} color="error.main" align="right">₹{itemDiscounts.toFixed(2)}</Typography></Grid>

                    <Grid item xs={6}><Typography variant="caption" color="text.secondary" fontWeight={700}>Tax (GST)</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={900} sx={{ color: '#0f766e' }} align="right">₹{totalTax.toFixed(2)}</Typography></Grid>
                  </Grid>
                </Paper>
              </Grid>

              {/* Box 2: Net Totals, Advance & Balance */}
              <Grid item xs={12} sm={6} md={2.4}>
                <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#ffffff', borderLeft: '4px solid #2563eb' }}>
                  <Grid container spacing={0.8}>
                    <Grid item xs={6}><Typography variant="caption" color="text.secondary" fontWeight={700}>Gross</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={800} align="right">₹{grossTotal.toFixed(2)}</Typography></Grid>

                    <Grid item xs={6}><Typography variant="caption" fontWeight={900} color="primary.main">Net (F3)</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={900} color="primary.main" align="right">₹{netTotal.toFixed(2)}</Typography></Grid>

                    <Grid item xs={6}><Typography variant="caption" color="text.secondary" fontWeight={700}>Advance</Typography></Grid>
                    <Grid item xs={6}>
                      <TextField 
                        size="small" placeholder="0.00" value={advancePaid} onChange={(e) => setAdvancePaid(e.target.value)}
                        inputProps={{ style: { textAlign: 'right', fontWeight: 800, padding: '2px', fontSize: '0.8rem' } }}
                      />
                    </Grid>

                    <Grid item xs={6}><Typography variant="caption" fontWeight={900} color="error.main">Balance</Typography></Grid>
                    <Grid item xs={6}><Typography variant="body2" fontWeight={900} color="error.main" align="right">₹{balanceDue.toFixed(2)}</Typography></Grid>
                  </Grid>
                </Paper>
              </Grid>

              {/* Box 3: Coupon & Multi Paymode Toggle */}
              <Grid item xs={12} sm={6} md={2.4}>
                <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#ffffff' }}>
                  <TextField 
                    fullWidth size="small" label="Coupon Code" placeholder="e.g. OPTICAL10"
                    value={couponCode} onChange={(e) => handleCouponChange(e.target.value)}
                    sx={{ mb: 1 }}
                    inputProps={{ style: { fontWeight: 800, fontSize: '0.8rem' } }}
                  />
                  <Button
                    fullWidth variant="contained" size="small"
                    onClick={() => {
                      // Quick-fills whatever's still owed into Cash so staff don't have to do
                      // the subtraction by hand when the customer is paying the remaining
                      // balance in a single payment mode.
                      const remaining = Math.max(0, netTotal - (parseFloat(advancePaid) || 0) -
                        (parseFloat(multiPay.cards) || 0) - (parseFloat(multiPay.gpay) || 0) - (parseFloat(multiPay.bank) || 0));
                      setMultiPay(prev => ({ ...prev, cash: remaining.toFixed(2) }));
                    }}
                    sx={{ bgcolor: '#0f172a', color: '#facc15', fontWeight: 900, textTransform: 'none', py: 0.6 }}
                  >
                    Multi Paymode
                  </Button>
                </Paper>
              </Grid>

              {/* Box 4: Multi Pay Mode Table */}
              <Grid item xs={12} sm={6} md={2.4}>
                <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden', bgcolor: '#ffffff' }}>
                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 800, py: 0.3, fontSize: '0.68rem' }}>Pay Mode</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.68rem' }}>Paid</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        <TableCell sx={{ py: 0.2, fontSize: '0.72rem', fontWeight: 700 }}>Cash</TableCell>
                        <TableCell sx={{ p: 0.2 }}>
                          <TextField size="small" value={multiPay.cash} onChange={(e) => setMultiPay({ ...multiPay, cash: e.target.value })} inputProps={{ style: { textAlign: 'center', fontWeight: 800, padding: '2px', fontSize: '0.72rem' } }} />
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell sx={{ py: 0.2, fontSize: '0.72rem', fontWeight: 700 }}>Cards</TableCell>
                        <TableCell sx={{ p: 0.2 }}>
                          <TextField size="small" value={multiPay.cards} onChange={(e) => setMultiPay({ ...multiPay, cards: e.target.value })} inputProps={{ style: { textAlign: 'center', fontWeight: 800, padding: '2px', fontSize: '0.72rem' } }} />
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell sx={{ py: 0.2, fontSize: '0.72rem', fontWeight: 700 }}>GPAY / UPI</TableCell>
                        <TableCell sx={{ p: 0.2 }}>
                          <TextField size="small" value={multiPay.gpay} onChange={(e) => setMultiPay({ ...multiPay, gpay: e.target.value })} inputProps={{ style: { textAlign: 'center', fontWeight: 800, padding: '2px', fontSize: '0.72rem' } }} />
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell sx={{ py: 0.2, fontSize: '0.72rem', fontWeight: 700 }}>Bank Transfer</TableCell>
                        <TableCell sx={{ p: 0.2 }}>
                          <TextField size="small" value={multiPay.bank} onChange={(e) => setMultiPay({ ...multiPay, bank: e.target.value })} inputProps={{ style: { textAlign: 'center', fontWeight: 800, padding: '2px', fontSize: '0.72rem' } }} />
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </Paper>
              </Grid>

              {/* Box 5: Out Rx, Total Paid & Complete Button */}
              <Grid item xs={12} sm={12} md={2.4}>
                <Stack spacing={1}>
                  <Box sx={{ display: 'flex', gap: 1, justifyContent: 'space-between' }}>
                    <FormControlLabel control={<Checkbox size="small" checked={sendWhatsapp} onChange={(e) => setSendWhatsapp(e.target.checked)} color="success" />} label={<Typography variant="caption" fontWeight={800} color="success.main">WhatsApp 🟢</Typography>} />
                    <FormControlLabel control={<Checkbox size="small" checked={sendSms} onChange={(e) => setSendSms(e.target.checked)} color="primary" />} label={<Typography variant="caption" fontWeight={800}>SMS 🟢</Typography>} />
                  </Box>

                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1 }}>
                    <Typography variant="caption" fontWeight={900}>Total Paid:</Typography>
                    <Typography variant="subtitle1" fontWeight={900} color="success.main">₹{totalPaidAmount.toFixed(2)}</Typography>
                  </Box>

                  <Button 
                    fullWidth variant="contained" 
                    color={docType === 'Quotation' ? 'warning' : docType === 'Order' ? 'primary' : 'success'} 
                    size="medium"
                    onClick={handleCompleteBilling} startIcon={<PrintIcon />}
                    sx={{ fontWeight: 900, py: 1, borderRadius: 2.5, textTransform: 'none' }}
                  >
                    {docType === 'Order' 
                      ? 'Complete Spectacle Order (F10)' 
                      : docType === 'Quotation' 
                        ? 'Generate Quotation (F10)' 
                        : 'Complete Tax Invoice (F10)'}
                  </Button>
                </Stack>
              </Grid>

            </Grid>
          </Paper>
        </Box>
      )}

      {/* MODE 2: 5-STEP GUIDED WIZARD MODE */}
      {viewMode === 'wizard' && (
        <Box>
          <Card elevation={0} sx={{ p: 2.5, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
            <Stepper activeStep={activeStep} alternativeLabel>
              {stepsList.map((step, idx) => (
                <Step key={step.label} onClick={() => setActiveStep(idx)} sx={{ cursor: 'pointer' }}>
                  <StepLabel StepIconProps={{ sx: { fontSize: '1.4rem' } }}>
                    <Typography variant="caption" fontWeight={activeStep === idx ? 800 : 600} color={activeStep === idx ? 'primary.main' : 'text.secondary'}>
                      {step.label}
                    </Typography>
                  </StepLabel>
                </Step>
              ))}
            </Stepper>
          </Card>

          <Grid container spacing={3}>
            <Grid item xs={12} lg={8.5}>
              {activeStep === 0 && (
                <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" gutterBottom>Step 1: Select Patient from Database</Typography>
                  <TextField 
                    select fullWidth label="Select Registered Patient"
                    value={selectedCustomerId} onChange={(e) => {
                      const cust = customers.find(c => c.id === e.target.value);
                      handleSelectCustomer(cust);
                    }}
                    sx={{ mb: 2 }}
                  >
                    <MenuItem value=""><em>-- Select Patient from DB --</em></MenuItem>
                    {customers.map(c => (
                      <MenuItem key={c.id} value={c.id}>{c.name} ({c.phone || 'No Phone'})</MenuItem>
                    ))}
                  </TextField>
                  <Button variant="contained" onClick={handleSavePatient}>Save Patient</Button>
                </Card>
              )}

              {activeStep === 1 && (
                <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" gutterBottom>Step 2: Optical Prescription</Typography>
                  <Typography variant="body2" color="text.secondary">Rx Power details synced from optical examination or entered manually.</Typography>
                </Card>
              )}

              {activeStep === 2 && (
                <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" gutterBottom>Step 3: Spectacle Frame Selection</Typography>
                  <Typography variant="body2" color="text.secondary">Select frame from optical inventory items.</Typography>
                </Card>
              )}

              {activeStep === 3 && (
                <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" gutterBottom>Step 4: Lens & Coatings</Typography>
                  <Typography variant="body2" color="text.secondary">Select optical lens index and coating options.</Typography>
                </Card>
              )}

              {activeStep === 4 && (
                <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" gutterBottom>Step 5: Review & Billing Checkout</Typography>
                  <Button variant="contained" color="success" onClick={handleCompleteBilling}>Complete Order & Print Invoice</Button>
                </Card>
              )}
            </Grid>

            {/* Live Cart Sidebar in Wizard Mode */}
            <Grid item xs={12} lg={3.5}>
              <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 2 }}><CartIcon /> Live Dispensing Cart</Typography>
                <Divider sx={{ mb: 2 }} />
                <Typography variant="caption" color="text.secondary">PATIENT:</Typography>
                <Typography variant="body2" fontWeight={800} sx={{ mb: 2 }}>{customerInput.name || 'No Patient Selected'}</Typography>
                <Typography variant="caption" color="text.secondary">TOTAL PAYABLE:</Typography>
                <Typography variant="h6" fontWeight={900} color="primary.main" sx={{ mb: 2 }}>₹{netTotal}</Typography>
                <Stack spacing={1}>
                  {activeStep < stepsList.length - 1 ? (
                    <Button variant="contained" fullWidth onClick={() => setActiveStep(prev => prev + 1)}>Next Step ➔</Button>
                  ) : (
                    <Button variant="contained" color="success" fullWidth onClick={handleCompleteBilling}>Complete Order</Button>
                  )}
                  {activeStep > 0 && (
                    <Button variant="outlined" fullWidth onClick={() => setActiveStep(prev => prev - 1)}>⬅ Back</Button>
                  )}
                </Stack>
              </Card>
            </Grid>
          </Grid>
        </Box>
      )}

    </Box>
  );
}
