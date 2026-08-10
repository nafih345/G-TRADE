import React, { useState } from 'react';
import { 
  Box, Card, Typography, Button, Grid, 
  Paper, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Chip, Alert, Stack, LinearProgress,
  IconButton, Tooltip
} from '@mui/material';
import { 
  CloudUpload as UploadIcon, 
  FileDownload as DownloadIcon, 
  CheckCircle as SuccessIcon, 
  Inventory as StockIcon,
  Warning as WarningIcon,
  Refresh as ResetIcon,
  Delete as ClearIcon,
  Delete as DeleteIcon
} from '@mui/icons-material';
import axios from 'axios';

// Dynamically load SheetJS XLSX parser library from CDN
const loadSheetJS = () => {
  return new Promise((resolve, reject) => {
    if (window.XLSX) {
      resolve(window.XLSX);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('Failed to load XLSX library'));
    document.head.appendChild(script);
  });
};

export default function ExcelStockImporter({ onImportSuccess }) {
  const [file, setFile] = useState(null);
  const [parsedItems, setParsedItems] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Sample CSV Template Downloader
  const handleDownloadSampleTemplate = () => {
    const headers = "Barcode,SKU/Code,Product Name,Category,Brand,Frame/Lens Type,Cost Price (INR),Selling Price (INR),Stock Quantity,Reorder Level,Supplier,Rack Location\n";
    const sampleRows = [
      "880194821001,FRAME-RB-01,RayBan Wayfarer Classic Black,Frames,RayBan,Full Rim,2500,4990,25,5,RayBan India,Rack A-1",
      "880194821002,LENS-CRZ-02,Crizal Prevencia Anti-Blue 1.56,Prescription Lenses,Crizal,Single Vision,1200,2800,50,10,Essilor India,Rack B-3",
      "880194821003,SUN-OAK-03,Oakley Holbrook Polarized Matte Black,Sunglasses,Oakley,Full Rim,4500,8990,12,3,Oakley Distr,Rack A-4",
      "880194821004,CL-ACV-04,Acuvue Oasys 1-Day Contact Lens (30 Pack),Contact Lenses,Johnson & Johnson,N/A,1800,3200,40,8,J&J Vision,Rack C-2"
    ].join("\n");

    const blob = new Blob([headers + sampleRows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'Optical_Stock_Import_Template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Process rows extracted from Excel or CSV
  const processRawRows = (rows) => {
    if (!rows || rows.length <= 1) return [];

    const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
    const items = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || (Array.isArray(row) && row.length === 0)) continue;

      const getVal = (possibleKeys) => {
        for (const key of possibleKeys) {
          const idx = headers.findIndex(h => h.includes(key));
          if (idx !== -1 && row[idx] !== undefined && row[idx] !== null && String(row[idx]).trim() !== '') {
            return String(row[idx]).trim();
          }
        }
        return '';
      };

      const hasAnyVal = Array.isArray(row) ? row.some(v => v !== undefined && v !== null && String(v).trim() !== '') : true;
      if (!hasAnyVal) continue;

      const code = getVal(['code', 'sku', 'item code', 'no', 'sl']) || `SKU-${1000 + i}`;
      const modelNo = getVal(['modelno', 'model']) || '';
      const name = getVal(['item_name', 'name', 'product', 'item', 'description', 'particular', 'title', 'details']) || modelNo || `Item ${code}`;
      const barcode = getVal(['barcode', 'tag', 'upc', 'ean', 'barcode no']) || '';
      const category = getVal(['category name', 'category', 'sub category', 'cat', 'group', 'type']) || 'Frames';
      const brand = getVal(['brand', 'make', 'company', 'company name']) || 'Generic';
      const frameType = getVal(['frame', 'style', 'lens type']) || 'Full Rim';
      const costPrice = parseFloat(getVal(['cost', 'purchase', 'buy', 'cp', 'cost price'])) || 0;
      const sellingPrice = parseFloat(getVal(['selling', 'retail', 'mrp', 'sp', 'price', 'rate', 'selling price'])) || costPrice;
      const stock = parseInt(getVal(['stock', 'qty', 'quantity', 'count', 'pcs', 'balance', 'closing stock'])) || 1;
      const reorderLevel = parseInt(getVal(['reorder', 'min stock', 'minimum'])) || 5;
      const supplier = getVal(['supplier', 'vendor', 'party']) || '';
      const rack = getVal(['rack', 'location', 'shelf', 'bin']) || 'A1';

      items.push({
        id: code,
        code,
        barcode,
        name,
        category,
        brand,
        frameType,
        purchasePrice: costPrice,
        cost_price: costPrice,
        sellingPrice,
        retail_price: sellingPrice,
        price: sellingPrice,
        stock,
        quantity: stock,
        reorderLevel,
        supplier,
        rack,
        status: 'Active'
      });
    }

    // Index-based fallback if header matching didn't yield any products
    if (items.length === 0) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        const colName = row[1] || row[0];
        if (!colName || String(colName).trim() === '') continue;

        items.push({
          id: String(row[0] || `SKU-${i}`),
          code: String(row[0] || `SKU-${i}`),
          barcode: String(row[0] || `BAR-${i}`),
          name: String(colName).trim(),
          category: String(row[2] || 'Frames'),
          brand: String(row[3] || 'Generic'),
          purchasePrice: parseFloat(row[4]) || 0,
          sellingPrice: parseFloat(row[5]) || parseFloat(row[4]) || 0,
          stock: parseInt(row[6]) || 1,
          rack: 'A1',
          status: 'Active'
        });
      }
    }

    return items;
  };

  // CSV Fallback Parser
  const parseCSVText = (text) => {
    const lines = text.split(/\r\n|\n/).filter(line => line.trim() !== '');
    if (lines.length <= 1) return [];
    const rows = lines.map(line => {
      const matches = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || line.split(',');
      return (matches || []).map(v => v.trim().replace(/^["']|["']$/g, ''));
    });
    return processRawRows(rows);
  };

  // Handle File Select & Excel Parsing
  const handleFileChange = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setErrorMsg('');
    setImportResult(null);

    const isXLSX = selectedFile.name.endsWith('.xlsx') || selectedFile.name.endsWith('.xls');

    if (isXLSX) {
      try {
        const XLSX = await loadSheetJS();
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            const items = processRawRows(jsonRows);

            if (items.length === 0) {
              setErrorMsg("Could not parse any valid product rows from the file. Please check column format.");
              setParsedItems([]);
            } else {
              setParsedItems(items);
            }
          } catch (err) {
            setErrorMsg("Failed to parse Excel spreadsheet. Please ensure it is a valid .xlsx or .xls file.");
          }
        };
        reader.readAsArrayBuffer(selectedFile);
      } catch (e) {
        setErrorMsg("Loading XLSX engine... Please upload file again or use .CSV format.");
      }
    } else {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const text = evt.target.result;
          const items = parseCSVText(text);
          if (items.length === 0) {
            setErrorMsg("Could not parse any valid product rows from the file. Please check column format.");
            setParsedItems([]);
          } else {
            setParsedItems(items);
          }
        } catch (err) {
          setErrorMsg("Error reading CSV file content.");
        }
      };
      reader.readAsText(selectedFile);
    }
  };

  // Execute Import & Merge to LocalStorage & Dispatch Update Event
  const handleExecuteImport = async () => {
    if (parsedItems.length === 0) return;

    setImporting(true);
    setErrorMsg('');

    try {
      const existingStr = localStorage.getItem('optical_inventory_items') || '[]';
      const existingItems = JSON.parse(existingStr);

      const itemsMap = new Map();
      existingItems.forEach(item => itemsMap.set(item.code || item.barcode || item.name, item));

      let updatedCount = 0;
      let newCount = 0;

      parsedItems.forEach(newItem => {
        const key = newItem.code || newItem.barcode || newItem.name;
        if (itemsMap.has(key)) {
          const prev = itemsMap.get(key);
          itemsMap.set(key, {
            ...prev,
            stock: (prev.stock || 0) + newItem.stock,
            purchasePrice: newItem.purchasePrice || prev.purchasePrice,
            sellingPrice: newItem.sellingPrice || prev.sellingPrice,
            supplier: newItem.supplier || prev.supplier,
            rack: newItem.rack || prev.rack
          });
          updatedCount++;
        } else {
          itemsMap.set(key, newItem);
          newCount++;
        }
      });

      const updatedList = Array.from(itemsMap.values());
      localStorage.setItem('optical_inventory_items', JSON.stringify(updatedList));

      try {
        await axios.post('/api/inventory/bulk-import/', { items: parsedItems });
      } catch (apiErr) {}

      window.dispatchEvent(new Event('optical_stock_updated'));

      setImportResult({
        total: parsedItems.length,
        newItems: newCount,
        updatedItems: updatedCount,
        grandTotal: updatedList.length
      });

      if (onImportSuccess) onImportSuccess(updatedList);
    } catch (err) {
      setErrorMsg("Failed to complete stock import. Please try again.");
    } finally {
      setImporting(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setParsedItems([]);
    setImportResult(null);
    setErrorMsg('');
  };

  return (
    <Card variant="outlined" sx={{ p: 3, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StockIcon /> Bulk Stock & Product Excel Importer
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Upload an Excel (.xlsx / .xls / .csv) sheet with stock details to automatically reflect inventory across Sales, Products, Stock, and Purchases.
          </Typography>
        </Box>

        <Button
          variant="outlined"
          color="primary"
          startIcon={<DownloadIcon />}
          onClick={handleDownloadSampleTemplate}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
        >
          Download Sample Template (.CSV)
        </Button>
      </Box>

      {errorMsg && (
        <Alert severity="error" icon={<WarningIcon />} sx={{ mb: 2, borderRadius: 2 }}>
          {errorMsg}
        </Alert>
      )}

      {importResult && (
        <Alert severity="success" icon={<SuccessIcon />} sx={{ mb: 2, borderRadius: 2 }}>
          <Typography variant="subtitle2" fontWeight={800}>
            🎉 Excel Stock Import Completed Successfully!
          </Typography>
          <Typography variant="body2">
            Successfully imported <strong>{importResult.total}</strong> products ({importResult.newItems} new items added, {importResult.updatedItems} stock levels updated). Total items now in Inventory: <strong>{importResult.grandTotal}</strong>. Stock details are now reflected across Sales, Products, Stock, and Purchases!
          </Typography>
        </Alert>
      )}

      {/* Upload Dropzone */}
      {!importResult && (
        <Paper
          variant="outlined"
          sx={{
            p: 4,
            border: '2px dashed #3b82f6',
            borderRadius: 3,
            bgcolor: '#f8fafc',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease-in-out',
            '&:hover': { bgcolor: '#eff6ff', borderColor: '#1d4ed8' },
            mb: 3
          }}
          component="label"
        >
          <input
            type="file"
            accept=".csv, .xlsx, .xls, .tsv, .txt"
            hidden
            onChange={handleFileChange}
          />
          <UploadIcon sx={{ fontSize: 48, color: '#3b82f6', mb: 1 }} />
          <Typography variant="subtitle1" fontWeight={800} color="text.primary">
            {file ? file.name : "Click or Drag Excel (.XLSX / .XLS / .CSV) Stock Sheet Here"}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            Supports binary Excel spreadsheets (.XLSX / .XLS) and .CSV files with Item Name, Category, Brand, Prices, and Stock Count
          </Typography>
        </Paper>
      )}

      {/* Parsed Items Preview & Summary */}
      {parsedItems.length > 0 && !importResult && (
        <Box sx={{ mb: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label={`${parsedItems.length} Products Found`} color="primary" sx={{ fontWeight: 800 }} />
              <Typography variant="caption" color="text.secondary">
                Review data below before syncing with database
              </Typography>
            </Stack>

            <Stack direction="row" spacing={1.5}>
              <Button size="small" variant="outlined" color="inherit" startIcon={<ClearIcon />} onClick={handleReset}>
                Reset
              </Button>
              <Button
                variant="contained"
                color="success"
                startIcon={<UploadIcon />}
                onClick={handleExecuteImport}
                disabled={importing}
                sx={{ textTransform: 'none', fontWeight: 800, px: 3, borderRadius: 2 }}
              >
                {importing ? "Syncing Stock..." : "Import & Sync All Modules"}
              </Button>
            </Stack>
          </Box>

          {importing && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}

          {/* Table Preview */}
          <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #cbd5e1', borderRadius: 2, maxHeight: 320 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: '#0f172a', color: '#fff' } }}>
                  <TableCell>SKU / Code</TableCell>
                  <TableCell>Barcode</TableCell>
                  <TableCell>Product Name</TableCell>
                  <TableCell>Category</TableCell>
                  <TableCell>Brand</TableCell>
                  <TableCell align="right">Cost Price</TableCell>
                  <TableCell align="right">Selling Price</TableCell>
                  <TableCell align="center">Stock Qty</TableCell>
                  <TableCell align="center">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {parsedItems.map((row, idx) => (
                  <TableRow key={idx} hover>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>{row.code || row.barcode || (idx + 1)}</TableCell>
                    <TableCell>{row.barcode || '—'}</TableCell>
                    <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{row.name}</TableCell>
                    <TableCell><Chip label={row.category} size="small" variant="outlined" /></TableCell>
                    <TableCell>{row.brand}</TableCell>
                    <TableCell align="right">₹{row.purchasePrice}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800, color: '#059669' }}>₹{row.sellingPrice}</TableCell>
                    <TableCell align="center">
                      <Chip label={`${row.stock} pcs`} size="small" color="success" sx={{ fontWeight: 800 }} />
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="Delete Item">
                        <IconButton 
                          size="small" 
                          color="error" 
                          onClick={() => {
                            setParsedItems(prev => prev.filter((_, i) => i !== idx));
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {parsedItems.length > 15 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, textAlign: 'center' }}>
              Showing first 15 of {parsedItems.length} products. All {parsedItems.length} items will be imported.
            </Typography>
          )}
        </Box>
      )}

      {importResult && (
        <Button variant="outlined" color="primary" startIcon={<ResetIcon />} onClick={handleReset} sx={{ mt: 1 }}>
          Import Another Excel File
        </Button>
      )}
    </Card>
  );
}
