import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDebounce } from '../hooks/useDebounce';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs,
  Grid, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Paper, Chip, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField,
  MenuItem, Stack, IconButton, Autocomplete, Alert, Checkbox
} from '@mui/material';
import {
  Add as AddIcon,
  QrCode as BarcodeIcon,
  Search as SearchIcon,
  SwapHoriz as TransferIcon,
  Tune as AdjustIcon,
  Delete as DeleteIcon,
  AutoAwesome as SparkleIcon
} from '@mui/icons-material';
import axios from 'axios';
import CategoryManagementView from '../components/inventory/CategoryManagementView';
import BrandManagementView from '../components/inventory/BrandManagementView';
import LensManagementView from '../components/inventory/LensManagementView';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import BarcodePrintDialog from '../components/inventory/BarcodePrintDialog';
import BarcodeManageDialog from '../components/inventory/BarcodeManageDialog';
import BarcodeSection from '../components/inventory/BarcodeSection';

const initialProducts = [];

const opticalCategories = [
  'Frames', 'Prescription Lenses', 'Sunglasses', 'Contact Lenses',
  'Reading Glasses', 'Accessories', 'Lens Solutions', 'Cleaning Kits',
  'Cases', 'Eye Drops'
];

const opticalBrands = [
  'RayBan', 'Oakley', 'Essilor', 'Zeiss', 'Hoya', 'Crizal',
  'Kodak', 'Bausch + Lomb', 'Johnson & Johnson'
];

export default function Products() {
  const [products, setProducts] = useState(initialProducts);
  const [currentTab, setCurrentTab] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const path = (location.pathname || '').toLowerCase();
    if (path.includes('categories')) {
      setCurrentTab(1);
    } else if (path.includes('brands')) {
      setCurrentTab(2);
    } else if (path.includes('lenses') || path.includes('lens')) {
      setCurrentTab(3);
    } else {
      setCurrentTab(0);
    }
  }, [location.pathname]);

  const handleTabChange = (event, newValue) => {
    setCurrentTab(newValue);
    if (newValue === 1) navigate('/inventory/categories');
    else if (newValue === 2) navigate('/inventory/brands');
    else if (newValue === 3) navigate('/inventory/lenses');
    else navigate('/inventory/products');
  };
  const [open, setOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [barcodePrintOpen, setBarcodePrintOpen] = useState(false);
  const [barcodePrintTargets, setBarcodePrintTargets] = useState([]);
  const [selectedProductIds, setSelectedProductIds] = useState(new Set());
  const [manageBarcodeOpen, setManageBarcodeOpen] = useState(false);
  const [manageBarcodeProduct, setManageBarcodeProduct] = useState(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  
  const [newProduct, setNewProduct] = useState({
    code: '', barcode: '', name: '', brand: '', supplier: '', category: 'Frames',
    frameType: '', lensType: '', color: '', material: '',
    gender: '', size: '', purchasePrice: '', sellingPrice: '',
    gst: '18%', stock: '', rack: '', shelf: '', warehouse: 'Main', status: 'Active'
  });

  const [adjustStock, setAdjustStock] = useState({ id: '', name: '', current: 0, change: 0, reason: 'Manual audit' });
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [dbSuppliers, setDbSuppliers] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState({
    open: false, title: '', message: '', type: 'danger', confirmText: 'Confirm', onConfirm: null
  });

  // Sync Registered Suppliers from Purchases Module / API
  useEffect(() => {
    const fetchRegisteredSuppliers = async () => {
      let suppList = [];
      try {
        const local = JSON.parse(localStorage.getItem('optical_suppliers') || '[]');
        const localDB = JSON.parse(localStorage.getItem('optical_suppliers_db') || '[]');
        const localNames = localDB.map(s => s.name || s.company_name || s.company).filter(Boolean);
        suppList = [...local, ...localNames];
      } catch (e) {}

      try {
        let res;
        try {
          res = await axios.get('/api/purchase/suppliers/');
        } catch (e1) {
          res = await axios.get('/api/purchasing/suppliers/');
        }
        const raw = res.data?.results || res.data || [];
        if (Array.isArray(raw)) {
          const apiNames = raw.map(s => s.name || s.company_name || s.company).filter(Boolean);
          suppList = [...suppList, ...apiNames];
        }
      } catch (e) {}

      setDbSuppliers(Array.from(new Set(suppList)).filter(Boolean));
    };
    fetchRegisteredSuppliers();
    window.addEventListener('optical_suppliers_updated', fetchRegisteredSuppliers);
    return () => window.removeEventListener('optical_suppliers_updated', fetchRegisteredSuppliers);
  }, [open]);

  // Fetch Inventory Products from Sales/Products Database & Local Storage
  useEffect(() => {
    const fetchInventoryProducts = async () => {
      let itemsList = [];
      try {
        const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
        itemsList = [...local];
      } catch (e) {}

      try {
        const res = await axios.get('/api/products/items/');
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          const formatted = res.data.map(p => ({
            id: String(p.id),
            code: p.sku || p.code || `PROD-${p.id}`,
            barcode: p.barcode || '',
            name: p.name || 'Unnamed Item',
            brand: p.brand || 'Generic',
            supplier: p.supplier || '',
            category: p.category || 'Frames',
            frameType: p.frameType || 'Full Rim',
            lensType: p.lensType || 'N/A',
            color: p.color || '',
            material: p.material || 'Metal',
            gender: p.gender || 'Unisex',
            size: p.size || '',
            purchasePrice: parseFloat(p.cost_price || p.purchasePrice || 0),
            sellingPrice: parseFloat(p.price || p.sellingPrice || 0),
            gst: p.gst || '18%',
            stock: parseInt(p.stock || p.quantity || 0),
            rack: p.rack || 'A1',
            shelf: p.shelf || 'S1',
            warehouse: p.warehouse || 'Main',
            status: p.is_active === false ? 'Inactive' : 'Active'
          }));
          itemsList = [...itemsList, ...formatted];
        }
      } catch (err) {}

      // Deduplicate by SKU or Name
      const unique = Array.from(new Map(itemsList.map(item => [item.code || item.barcode || item.name, item])).values());
      setProducts(unique);
    };

    fetchInventoryProducts();

    window.addEventListener('optical_stock_updated', fetchInventoryProducts);
    return () => window.removeEventListener('optical_stock_updated', fetchInventoryProducts);
  }, []);

  const handleOpen = () => {
    setNewProduct({
      code: '', barcode: '', name: '', brand: '', supplier: '', category: 'Frames',
      frameType: '', lensType: '', color: '', material: '',
      gender: '', size: '', purchasePrice: '', sellingPrice: '',
      gst: '18%', stock: '', rack: '', shelf: '', warehouse: 'Main', status: 'Active'
    });
    setOpen(true);
  };
  const handleClose = () => setOpen(false);

  const handleSave = async () => {
    if (!newProduct.name) {
      alert("Please enter a Product Name.");
      return;
    }
    const productToAdd = {
      id: String(Date.now()),
      ...newProduct,
      code: newProduct.code || `PRD-${Math.floor(100 + Math.random() * 900)}`,
      brand: newProduct.brand || '',
      purchasePrice: parseFloat(newProduct.purchasePrice) || 0,
      sellingPrice: parseFloat(newProduct.sellingPrice) || 0,
      stock: parseInt(newProduct.stock) || 0,
      barcode: newProduct.barcode || ''
    };

    try {
      await axios.post('/api/products/items/', {
        name: productToAdd.name,
        sku: productToAdd.code,
        barcode: productToAdd.barcode,
        price: productToAdd.sellingPrice,
        cost_price: productToAdd.purchasePrice,
        stock: productToAdd.stock,
        category: productToAdd.category,
        category_name: productToAdd.category,
        brand: productToAdd.brand,
        brand_name: productToAdd.brand
      });
    } catch (err) {
      console.log("Local state updated for new product.");
    }

    setProducts([productToAdd, ...products]);
    setNewProduct({
      code: '', barcode: '', name: '', brand: '', supplier: '', category: 'Frames',
      frameType: '', lensType: '', color: '', material: '',
      gender: '', size: '', purchasePrice: '', sellingPrice: '',
      gst: '18%', stock: '', rack: '', shelf: '', warehouse: 'Main', status: 'Active'
    });
    handleClose();
    alert(`Product '${productToAdd.name}' saved to inventory database successfully!`);
  };

  const handleOpenBarcode = (product) => {
    setManageBarcodeProduct(product);
    setManageBarcodeOpen(true);
  };

  const handleBulkPrintBarcodes = () => {
    const targets = filteredProducts.filter(p => selectedProductIds.has(p.id));
    setBarcodePrintTargets(targets);
    setBarcodePrintOpen(true);
  };

  const handleBulkGenerateBarcodes = async () => {
    const targetIds = filteredProducts.filter(p => selectedProductIds.has(p.id) && !p.barcode).map(p => p.id);
    if (targetIds.length === 0) {
      alert('All selected products already have a barcode.');
      return;
    }
    setBulkGenerating(true);
    try {
      const res = await axios.post('/api/products/items/generate_missing_barcodes/', { product_ids: targetIds });
      const byId = new Map((res.data.products || []).map(p => [String(p.id), p.barcode]));
      setProducts(prev => prev.map(p => byId.has(p.id) ? { ...p, barcode: byId.get(p.id) } : p));
      alert(`Generated barcodes for ${res.data.generated} product(s).`);
    } catch (e) {
      alert('Could not generate barcodes. Please try again.');
    } finally {
      setBulkGenerating(false);
    }
  };

  const handleProductBarcodeUpdated = (productId, newBarcode) => {
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, barcode: newBarcode } : p));
    try {
      const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      const localUpdated = local.map(p => p.id === productId ? { ...p, barcode: newBarcode } : p);
      localStorage.setItem('optical_inventory_items', JSON.stringify(localUpdated));
    } catch (e) {}
  };

  const toggleSelectProduct = (id) => {
    setSelectedProductIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = (checked) => {
    setSelectedProductIds(checked ? new Set(filteredProducts.map(p => p.id)) : new Set());
  };

  const handleOpenAdjustment = (product) => {
    setAdjustStock({ id: product.id, name: product.name, current: product.stock, change: 0, reason: 'Manual audit' });
    setAdjustOpen(true);
  };

  const handleSaveAdjustment = () => {
    setProducts(products.map(p => {
      if (p.id === adjustStock.id) {
        return { ...p, stock: Math.max(0, p.stock + parseInt(adjustStock.change || 0)) };
      }
      return p;
    }));
    setAdjustOpen(false);
  };

  const handleDeleteProduct = (product) => {
    setConfirmDialog({
      open: true,
      title: "Delete Inventory Product",
      message: `Are you sure you want to permanently delete product '${product.name}' (${product.code}) from database?`,
      type: 'danger',
      confirmText: "Delete Product",
      onConfirm: async () => {
        try {
          if (product.id) {
            await axios.delete(`/api/products/items/${product.id}/`);
          }
        } catch (e) {
          console.warn("API product delete notice:", e);
        }

        const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
        const cleaned = local.filter(p => String(p.id) !== String(product.id) && String(p.code) !== String(product.code));
        localStorage.setItem('optical_inventory_items', JSON.stringify(cleaned));
        setProducts(prev => prev.filter(p => String(p.id) !== String(product.id) && String(p.code) !== String(product.code)));
        window.dispatchEvent(new Event('optical_stock_updated'));
      }
    });
  };

  const handleOpenFastLens = () => {
    setNewProduct({
      code: '',
      barcode: '',
      name: '',
      brand: '',
      supplier: '',
      category: 'Prescription Lenses',
      frameType: '',
      lensType: '',
      color: '',
      material: '',
      gender: '',
      size: '',
      purchasePrice: '',
      sellingPrice: '',
      gst: '18%',
      stock: '',
      rack: '',
      shelf: '',
      warehouse: 'Main',
      status: 'Active'
    });
    setOpen(true);
  };

  const handleClearEntireDatabase = () => {
    setConfirmDialog({
      open: true,
      title: "Clear Entire Project Database",
      message: "⚠️ ARE YOU SURE? This will permanently wipe ALL products, sales invoices, eye tests, purchase orders, suppliers, accounts, chart of accounts, and stock records across the entire project!",
      type: 'danger',
      confirmText: "Wipe Entire Database",
      onConfirm: async () => {
        try {
          await axios.delete('/api/products/items/clear-all/');
        } catch (e) {
          try {
            await axios.post('/api/products/items/clear-all/');
          } catch (err) {
            console.warn("Clear database API notice:", err);
          }
        }
        try {
          localStorage.removeItem('optical_inventory_items');
          localStorage.removeItem('optical_sales_invoices');
          localStorage.removeItem('optical_purchase_orders');
          localStorage.removeItem('optical_suppliers');
          localStorage.removeItem('optical_suppliers_db');
          localStorage.removeItem('optical_eye_tests');
          localStorage.removeItem('optical_customers');
        } catch (e) {}
        setProducts([]);
        window.dispatchEvent(new Event('optical_stock_updated'));
        window.dispatchEvent(new Event('optical_suppliers_updated'));
        alert("Entire project database cleared successfully!");
      }
    });
  };

  const debouncedSearchQuery = useDebounce(searchQuery, 150);

  const filteredProducts = useMemo(() => {
    const searchLower = (debouncedSearchQuery || '').toLowerCase().trim();
    return products.filter(product => {
      const matchesSearch = !searchLower ||
                            (product.name && product.name.toLowerCase().includes(searchLower)) ||
                            (product.code && product.code.toLowerCase().includes(searchLower)) ||
                            (product.barcode && product.barcode.toLowerCase().includes(searchLower)) ||
                            (product.brand && product.brand.toLowerCase().includes(searchLower));
      if (!matchesSearch) return false;
      if (categoryFilter === 'All') return true;

      const pCat = String(product.category || product.category_name || '').trim().toLowerCase();
      const filterCat = String(categoryFilter).trim().toLowerCase();

      if (pCat === filterCat) return true;

      // Category alias matching
      if (filterCat === 'frames' && (pCat.includes('frame') || pCat.includes('spectacle'))) return true;
      if (filterCat === 'prescription lenses' && (pCat.includes('lens') || pCat.includes('lenses') || pCat.includes('ophthalmic'))) return true;
      if (filterCat === 'sunglasses' && pCat.includes('sunglass')) return true;
      if (filterCat === 'contact lenses' && pCat.includes('contact')) return true;
      if (filterCat === 'reading glasses' && (pCat.includes('reading') || pCat.includes('reader'))) return true;
      if (filterCat === 'accessories' && pCat.includes('accessori')) return true;
      if (filterCat === 'lens solutions' && pCat.includes('solution')) return true;
      if (filterCat === 'cleaning kits' && (pCat.includes('clean') || pCat.includes('kit'))) return true;
      if (filterCat === 'cases' && pCat.includes('case')) return true;
      if (filterCat === 'eye drops' && pCat.includes('drop')) return true;

      // Name fallback matching if product category was not explicitly assigned
      const pName = String(product.name || '').toLowerCase();
      if (filterCat === 'sunglasses' && pName.includes('sunglass')) return true;
      if (filterCat === 'prescription lenses' && (pName.includes('lens') || pName.includes('crizal') || pName.includes('essilor') || pName.includes('hoya') || pName.includes('zeiss') || pName.includes('kodak') || pName.includes('progressive') || pName.includes('bifocal') || pName.includes('single vision'))) return true;
      if (filterCat === 'contact lenses' && pName.includes('contact')) return true;
      if (filterCat === 'cases' && pName.includes('case')) return true;
      if (filterCat === 'eye drops' && pName.includes('drop')) return true;
      if (filterCat === 'cleaning kits' && (pName.includes('clean') || pName.includes('kit'))) return true;
      if (filterCat === 'lens solutions' && pName.includes('solution')) return true;
      if (filterCat === 'reading glasses' && (pName.includes('reading') || pName.includes('reader'))) return true;

      return false;
    });
  }, [products, debouncedSearchQuery, categoryFilter]);

  return (
    <Box sx={{ p: 4 }}>
      {/* Header section */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>Optical Inventory Catalog</Typography>
          <Typography variant="body2" color="text.secondary">Manage frames, ophthalmic lenses, sunglasses, contact lenses, and diagnostics</Typography>
        </Box>
        
        <Box sx={{ display: 'flex', gap: 1 }}>
          {selectedProductIds.size > 0 && (
            <>
              <Button
                variant="outlined"
                startIcon={<SparkleIcon />}
                onClick={handleBulkGenerateBarcodes}
                disabled={bulkGenerating}
                sx={{ fontWeight: 800 }}
              >
                {bulkGenerating ? 'Generating...' : 'Generate Missing Barcodes'}
              </Button>
              <Button
                variant="contained"
                startIcon={<BarcodeIcon />}
                onClick={handleBulkPrintBarcodes}
                sx={{ backgroundColor: '#7c3aed', '&:hover': { backgroundColor: '#6d28d9' }, fontWeight: 800 }}
              >
                Bulk Print Barcodes ({selectedProductIds.size})
              </Button>
            </>
          )}
          <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={handleClearEntireDatabase} sx={{ fontWeight: 800 }}>
            Clear Database
          </Button>
          <Button variant="outlined" startIcon={<AdjustIcon />} onClick={() => setAdjustOpen(true)}>
            Stock Adjust
          </Button>
          <Button 
            variant="contained" startIcon={<AddIcon />}
            onClick={handleOpenFastLens} 
            sx={{ backgroundColor: '#059669', '&:hover': { backgroundColor: '#047857' }, fontWeight: 800 }}
          >
            🔬 + Fast Lens Creator
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpen} sx={{ backgroundColor: '#2563EB', fontWeight: 800 }}>
            Add New Product
          </Button>
        </Box>
      </Box>

      {/* Tabs */}
      <Tabs value={currentTab} onChange={handleTabChange} sx={{ mb: 3 }}>
        <Tab label="Products List" sx={{ fontWeight: 600 }} />
        <Tab label="Categories" sx={{ fontWeight: 600 }} />
        <Tab label="Brands Management" sx={{ fontWeight: 600 }} />
        <Tab label="🔬 Lens Options & Catalog Matrix" sx={{ fontWeight: 800, color: '#2563eb' }} />
      </Tabs>

      {currentTab === 0 && (
          <Stack spacing={2}>
            {/* Search & Category Filter */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <TextField 
                  fullWidth 
                  size="small" 
                  placeholder="Search Product Name, SKU Code, Barcode, or Brand..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  InputProps={{
                    startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                  }}
                />
                <TextField 
                  select 
                  size="small" 
                  label="Category" 
                  value={categoryFilter} 
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  sx={{ minWidth: 180 }}
                >
                  <MenuItem value="All">All Categories</MenuItem>
                  {opticalCategories.map(cat => (
                    <MenuItem key={cat} value={cat}>{cat}</MenuItem>
                  ))}
                </TextField>
                {(searchQuery || categoryFilter !== 'All') && (
                  <Button variant="text" size="small" onClick={() => { setSearchQuery(''); setCategoryFilter('All'); }}>
                    Reset
                  </Button>
                )}
              </Stack>
            </Card>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <CardContent sx={{ p: 0 }}>
                <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
                  <Table size="small">
                    <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                      <TableRow>
                        <TableCell padding="checkbox">
                          <Checkbox
                            size="small"
                            indeterminate={selectedProductIds.size > 0 && selectedProductIds.size < filteredProducts.length}
                            checked={filteredProducts.length > 0 && selectedProductIds.size === filteredProducts.length}
                            onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                          />
                        </TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Code / Barcode</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Name & Brand</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Category</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Specs (Type/Size/Gender)</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Prices</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Stock Location</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                        <TableCell sx={{ fontWeight: 700 }} align="center">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filteredProducts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} align="center" sx={{ py: 8 }}>
                            <Typography variant="body2" color="text.secondary" fontWeight={500}>
                              {searchQuery ? "No matching inventory items found." : "No inventory products currently found in the database."}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                              {searchQuery ? "Try refining your search keyword or resetting category filters." : "Click '+ Add New Product' to register frames, lenses, sunglasses, or contact lenses."}
                            </Typography>
                            {!searchQuery && (
                              <Button 
                                size="small" 
                                variant="contained" 
                                startIcon={<AddIcon />} 
                                onClick={handleOpen} 
                                sx={{ backgroundColor: '#2563EB', mt: 2 }}
                              >
                                + Add First Product
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredProducts.map((product) => {
                          const isLowStock = product.stock <= 10;
                          return (
                            <TableRow key={product.id} hover selected={selectedProductIds.has(product.id)}>
                              <TableCell padding="checkbox">
                                <Checkbox
                                  size="small"
                                  checked={selectedProductIds.has(product.id)}
                                  onChange={() => toggleSelectProduct(product.id)}
                                />
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" fontWeight={600} color="primary.main">{product.code}</Typography>
                                <Typography variant="caption" color="text.secondary">{product.barcode}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" fontWeight={600}>{product.name}</Typography>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                  Brand: {product.brand || 'Generic'}
                                </Typography>
                                {product.supplier && (
                                  <Typography variant="caption" color="primary.main" fontWeight={500} sx={{ display: 'block' }}>
                                    Supplier: {product.supplier}
                                  </Typography>
                                )}
                              </TableCell>
                              <TableCell>{product.category}</TableCell>
                              <TableCell>
                                <Typography variant="body2">{product.frameType === 'N/A' ? product.lensType : product.frameType}</Typography>
                                <Typography variant="caption" color="text.secondary" display="block">{product.size} | {product.gender}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">Buy: ₹{(parseFloat(product.purchasePrice) || 0).toFixed(2)}</Typography>
                                <Typography variant="body2" fontWeight={600}>Sell: ₹{(parseFloat(product.sellingPrice) || 0).toFixed(2)} <span style={{fontSize: '0.75rem', color: 'gray'}}>({product.gst || '18%'} GST)</span></Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" fontWeight={700} color={isLowStock ? 'error.main' : 'success.main'}>
                                  {product.stock} units
                                </Typography>
                                <Typography variant="caption" color="text.secondary">Rack {product.rack} / {product.warehouse}</Typography>
                              </TableCell>
                              <TableCell>
                                <Chip label={product.status} size="small" color="success" sx={{ borderRadius: 1 }} />
                              </TableCell>
                              <TableCell align="center">
                                <Stack direction="row" spacing={0.5} justifyContent="center">
                                  <IconButton
                                    color={product.barcode ? 'primary' : 'warning'}
                                    onClick={() => handleOpenBarcode(product)}
                                    title={product.barcode ? 'Manage Barcode' : 'Generate Barcode'}
                                  >
                                    <BarcodeIcon fontSize="small" />
                                  </IconButton>
                                  <IconButton color="secondary" onClick={() => handleOpenAdjustment(product)}>
                                    <AdjustIcon fontSize="small" />
                                  </IconButton>
                                  <IconButton color="error" title="Delete Product" onClick={() => handleDeleteProduct(product)}>
                                    <DeleteIcon fontSize="small" />
                                  </IconButton>
                                </Stack>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </CardContent>
            </Card>
          </Stack>
        )}

      {currentTab === 1 && (
        <CategoryManagementView products={products} />
      )}

      {currentTab === 2 && (
        <BrandManagementView products={products} />
      )}

      {currentTab === 3 && (
        <LensManagementView onProductAdded={() => window.dispatchEvent(new Event('optical_stock_updated'))} />
      )}

      {/* Add New Product / Lens Dialog */}
      <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center', bgcolor: newProduct.category === 'Prescription Lenses' ? '#0f172a' : '#ffffff', color: newProduct.category === 'Prescription Lenses' ? '#facc15' : 'inherit', transition: 'all 0.3s ease' }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography variant="h6" fontWeight={900}>
              {newProduct.category === 'Prescription Lenses' ? '🔬 Add Ophthalmic Lens Product' : '📦 Add Optical Stock / Product'}
            </Typography>
            <Paper variant="outlined" sx={{ p: 0.3, display: 'flex', gap: 0.5, bgcolor: '#f1f5f9', borderRadius: 2 }}>
              <Button 
                size="small" 
                variant={newProduct.category !== 'Prescription Lenses' ? 'contained' : 'text'}
                onClick={() => setNewProduct({ ...newProduct, category: 'Frames' })}
                sx={{ py: 0.2, px: 1, fontSize: '0.72rem', fontWeight: 800 }}
              >
                Frame / General
              </Button>
              <Button 
                size="small" 
                variant={newProduct.category === 'Prescription Lenses' ? 'contained' : 'text'}
                onClick={() => setNewProduct({ ...newProduct, category: 'Prescription Lenses', name: newProduct.name || 'BlueControl UV420 Lens 1.56' })}
                sx={{ py: 0.2, px: 1, fontSize: '0.72rem', fontWeight: 800, bgcolor: newProduct.category === 'Prescription Lenses' ? '#2563eb' : 'transparent', color: newProduct.category === 'Prescription Lenses' ? '#ffffff' : 'inherit' }}
              >
                🔬 Lens Mode
              </Button>
            </Paper>
          </Stack>

          <Button 
            variant="contained" 
            size="small" 
            startIcon={<BarcodeIcon />} 
            onClick={() => setScanDialogOpen(true)}
            sx={{ backgroundColor: '#10B981', color: 'white', fontWeight: 700 }}
          >
            📷 Scan Barcode
          </Button>
        </DialogTitle>

        <DialogContent dividers>
          
          {/* ⚡ FAST LENS PRESET QUICK FILLER BAR WHEN IN LENS MODE */}
          {newProduct.category === 'Prescription Lenses' && (
            <Alert severity="info" icon={<SparkleIcon />} sx={{ mb: 2, borderRadius: 2.5, bgcolor: '#eff6ff', borderColor: '#bfdbfe' }}>
              <Typography variant="subtitle2" fontWeight={900} color="#1e3a8a">
                ⚡ Fast Lens Quick-Fill Presets (Click to auto-populate lens details):
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.8 }}>
                <Chip 
                  label="⚡ Essilor Crizal 1.67" size="small" clickable color="primary" 
                  onClick={() => setNewProduct({ ...newProduct, category: 'Prescription Lenses', name: 'Essilor Crizal Sapphire HR 1.67', brand: 'Essilor', lensType: 'Single Vision', frameType: '1.67', color: 'Anti-Glare (ARC)', purchasePrice: '1800', sellingPrice: '4200' })}
                  sx={{ fontWeight: 800 }} 
                />
                <Chip 
                  label="⚡ Hoya BlueControl 1.56" size="small" clickable color="success" 
                  onClick={() => setNewProduct({ ...newProduct, category: 'Prescription Lenses', name: 'Hoya BlueControl UV420 1.56', brand: 'Hoya', lensType: 'Single Vision', frameType: '1.56', color: 'Blue Cut UV420', purchasePrice: '450', sellingPrice: '1450' })}
                  sx={{ fontWeight: 800 }} 
                />
                <Chip 
                  label="⚡ Zeiss Progressive 1.60" size="small" clickable 
                  onClick={() => setNewProduct({ ...newProduct, category: 'Prescription Lenses', name: 'Zeiss SmartLife Progressive 1.60', brand: 'Zeiss', lensType: 'Progressive Digital', frameType: '1.60', color: 'Anti-Glare (ARC)', purchasePrice: '2400', sellingPrice: '6800' })}
                  sx={{ bgcolor: '#ca8a04', color: '#fff', fontWeight: 800 }} 
                />
                <Chip 
                  label="⚡ Kodak Photochromic 1.56" size="small" clickable 
                  onClick={() => setNewProduct({ ...newProduct, category: 'Prescription Lenses', name: 'Kodak CityLens Photochromic 1.56', brand: 'Kodak', lensType: 'Single Vision', frameType: '1.56', color: 'Photochromic Auto-Tint', purchasePrice: '850', sellingPrice: '2400' })}
                  sx={{ bgcolor: '#9333ea', color: '#fff', fontWeight: 800 }} 
                />
              </Stack>
            </Alert>
          )}

          <Grid container spacing={2}>

            {/* ROW 1: Category | Code/SKU */}
            <Grid item xs={12} sm={6}>
              <TextField
                select
                label="Product Category"
                fullWidth
                value={newProduct.category}
                onChange={(e) => setNewProduct({...newProduct, category: e.target.value})}
              >
                {opticalCategories.map(cat => <MenuItem key={cat} value={cat}>{cat}</MenuItem>)}
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                label="Product Code / SKU"
                fullWidth
                placeholder="e.g. RF-102 or LNS-156"
                value={newProduct.code}
                onChange={(e) => setNewProduct({...newProduct, code: e.target.value})}
              />
            </Grid>

            <Grid item xs={12}>
              <BarcodeSection
                mode="create"
                value={newProduct.barcode}
                onChange={(val) => setNewProduct({ ...newProduct, barcode: val })}
                productName={newProduct.name}
                productCode={newProduct.code}
                productPrice={parseFloat(newProduct.sellingPrice) || 0}
              />
            </Grid>

            {/* ROW 2: Product Name (8) | Brand (4) */}
            <Grid item xs={12} sm={8}>
              <TextField 
                label={newProduct.category === 'Prescription Lenses' ? "Lens Product Name & Specification *" : "Product Name *"} 
                fullWidth 
                required
                placeholder={newProduct.category === 'Prescription Lenses' ? "e.g. Essilor Crizal Sapphire HR 1.67 Blue Cut" : "e.g. Aviator Classic Rimless"}
                value={newProduct.name} 
                onChange={(e) => setNewProduct({...newProduct, name: e.target.value})} 
                inputProps={{ style: { fontWeight: 800 } }}
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <Autocomplete
                freeSolo
                options={opticalBrands}
                value={newProduct.brand}
                onInputChange={(event, newInputValue) => {
                  setNewProduct({ ...newProduct, brand: newInputValue });
                }}
                renderInput={(params) => (
                  <TextField 
                    {...params} 
                    label="Brand / Manufacturer" 
                    placeholder="e.g. Essilor, Zeiss, RayBan..."
                    fullWidth 
                  />
                )}
              />
            </Grid>

            {/* ROW 3: Lens Specs if Prescription Lenses (Refractive Index | Design Type | Coating) */}
            {newProduct.category === 'Prescription Lenses' && (
              <>
                <Grid item xs={12} sm={4}>
                  <TextField 
                    select label="Refractive Index" fullWidth 
                    value={newProduct.frameType || '1.56'} 
                    onChange={(e) => setNewProduct({...newProduct, frameType: e.target.value})}
                  >
                    <MenuItem value="1.50">1.50 Standard CR39</MenuItem>
                    <MenuItem value="1.56">1.56 Mid Index Blue Cut</MenuItem>
                    <MenuItem value="1.60">1.60 Hi-Index</MenuItem>
                    <MenuItem value="1.67">1.67 Ultra Thin</MenuItem>
                    <MenuItem value="1.74">1.74 Super High Index</MenuItem>
                  </TextField>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <TextField 
                    select label="Lens Design Type" fullWidth 
                    value={newProduct.lensType || 'Single Vision'} 
                    onChange={(e) => setNewProduct({...newProduct, lensType: e.target.value})}
                  >
                    <MenuItem value="Single Vision">Single Vision</MenuItem>
                    <MenuItem value="Progressive Digital">Progressive Digital</MenuItem>
                    <MenuItem value="Bifocal D-Seg">Bifocal D-Seg</MenuItem>
                    <MenuItem value="Office / Workspace">Office / Workspace</MenuItem>
                  </TextField>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <TextField 
                    select label="Coating Technology" fullWidth 
                    value={newProduct.color || 'Blue Cut UV420'} 
                    onChange={(e) => setNewProduct({...newProduct, color: e.target.value})}
                  >
                    <MenuItem value="Anti-Glare (ARC)">Anti-Glare (ARC)</MenuItem>
                    <MenuItem value="Blue Cut UV420">Blue Cut UV420</MenuItem>
                    <MenuItem value="Photochromic Auto-Tint">Photochromic Auto-Tint</MenuItem>
                    <MenuItem value="Polarized Sun Shield">Polarized Sun Shield</MenuItem>
                    <MenuItem value="Hard Coated Scratch Resistant">Hard Coated Scratch Resistant</MenuItem>
                  </TextField>
                </Grid>
              </>
            )}

            {/* ROW 4: Supplier Name | Purchase Price | Selling Price */}
            <Grid item xs={12} sm={4}>
              <Autocomplete
                freeSolo
                options={dbSuppliers}
                value={newProduct.supplier || ''}
                onInputChange={(event, newInputValue) => {
                  setNewProduct({ ...newProduct, supplier: newInputValue || '' });
                }}
                onChange={(event, newValue) => {
                  setNewProduct({ ...newProduct, supplier: newValue || '' });
                }}
                renderInput={(params) => (
                  <TextField 
                    {...params} 
                    label="Supplier Name" 
                    placeholder="Search or select supplier..."
                    fullWidth 
                  />
                )}
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField 
                label="Purchase Cost Price (₹)" 
                fullWidth 
                type="number" 
                value={newProduct.purchasePrice} 
                onChange={(e) => setNewProduct({...newProduct, purchasePrice: e.target.value})} 
                inputProps={{ style: { fontWeight: 800 } }} 
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField 
                label="Selling MRP Price (₹)" 
                fullWidth 
                type="number" 
                value={newProduct.sellingPrice} 
                onChange={(e) => setNewProduct({...newProduct, sellingPrice: e.target.value})} 
                inputProps={{ style: { fontWeight: 900, color: '#059669' } }} 
              />
            </Grid>

            {/* ROW 5: GST Rate | Initial Stock Qty | Rack Location */}
            <Grid item xs={12} sm={4}>
              <TextField 
                select 
                label="GST Tax Rate" 
                fullWidth 
                value={newProduct.gst} 
                onChange={(e) => setNewProduct({...newProduct, gst: e.target.value})}
              >
                <MenuItem value="5%">5% GST</MenuItem>
                <MenuItem value="12%">12% GST</MenuItem>
                <MenuItem value="18%">18% GST</MenuItem>
                <MenuItem value="28%">28% GST</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField 
                label="Initial Stock Qty" 
                fullWidth 
                type="number" 
                value={newProduct.stock} 
                onChange={(e) => setNewProduct({...newProduct, stock: e.target.value})} 
                inputProps={{ style: { fontWeight: 800 } }} 
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField 
                label="Rack Location" 
                fullWidth 
                placeholder="e.g. Rack A1 / Lens Drawer 2" 
                value={newProduct.rack} 
                onChange={(e) => setNewProduct({...newProduct, rack: e.target.value})} 
              />
            </Grid>

          </Grid>
        </DialogContent>

        <DialogActions sx={{ p: 2, justifyContent: 'space-between', bgcolor: '#f8fafc' }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" sx={{ backgroundColor: '#2563EB', px: 3.5, py: 1, fontWeight: 900, borderRadius: 2 }}>
            Save {newProduct.category === 'Prescription Lenses' ? 'Lens Option' : 'Product'} to Database
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- BARCODE SCANNER MODAL FOR ARRIVING PRODUCTS --- */}
      <Dialog 
        open={scanDialogOpen} 
        onClose={() => setScanDialogOpen(false)} 
        maxWidth="xs" 
        fullWidth
        PaperProps={{ sx: { borderRadius: 4 } }}
      >
        <DialogTitle sx={{ fontWeight: 800, textAlign: 'center' }}>📷 Scan Arriving Stock Barcode</DialogTitle>
        <DialogContent dividers sx={{ textAlign: 'center', py: 4 }}>
          <Box sx={{ 
            p: 3, 
            border: '2px dashed #2563eb', 
            borderRadius: 3, 
            bgcolor: '#eff6ff', 
            mb: 3,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }}>
            <Typography variant="h1" sx={{ my: 1 }}>📱</Typography>
            <Typography variant="subtitle2" fontWeight={700} color="primary">Point USB Scanner or Camera at Barcode</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              Hardware USB barcode scanners automatically input codes here upon trigger
            </Typography>
          </Box>

          <TextField 
            autoFocus 
            fullWidth 
            label="Scanned Barcode / EAN Number" 
            placeholder="Barcode will appear here..."
            value={newProduct.barcode}
            onChange={(e) => {
              const val = e.target.value;
              setNewProduct({ ...newProduct, barcode: val });
              // Check if barcode already exists in database
              const existing = products.find(p => p.barcode === val || p.code === val);
              if (existing) {
                setNewProduct({
                  ...newProduct,
                  barcode: val,
                  code: existing.code,
                  name: existing.name,
                  brand: existing.brand,
                  category: existing.category,
                  purchasePrice: String(existing.purchasePrice),
                  sellingPrice: String(existing.sellingPrice),
                  stock: String(existing.stock)
                });
              }
            }}
            InputProps={{
              startAdornment: <BarcodeIcon color="action" sx={{ mr: 1 }} />
            }}
          />

          <Stack spacing={1} sx={{ mt: 3 }}>
            <Button 
              variant="contained" 
              color="success"
              onClick={() => {
                const sampleBarcode = String(Math.floor(88000000 + Math.random() * 11000000));
                setNewProduct({ ...newProduct, barcode: sampleBarcode });
                setScanDialogOpen(false);
                alert(`Barcode '${sampleBarcode}' scanned successfully!`);
              }}
              sx={{ fontWeight: 700 }}
            >
              Simulate Barcode Scan Success
            </Button>
            <Button variant="text" size="small" onClick={() => setScanDialogOpen(false)}>
              Done / Close Scanner
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Barcode Label Print Dialog */}
      <BarcodePrintDialog
        open={barcodePrintOpen}
        onClose={() => setBarcodePrintOpen(false)}
        products={barcodePrintTargets}
      />

      {/* Barcode Management Dialog — generate/regenerate/copy/print/clear for an existing product */}
      <BarcodeManageDialog
        open={manageBarcodeOpen}
        onClose={() => setManageBarcodeOpen(false)}
        product={manageBarcodeProduct}
        onProductUpdated={handleProductBarcodeUpdated}
      />

      {/* Styled MUI Confirm Dialog replacing native browser confirm */}
      <ConfirmActionDialog 
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        type={confirmDialog.type}
        confirmText={confirmDialog.confirmText}
        onClose={() => setConfirmDialog({ ...confirmDialog, open: false })}
        onConfirm={confirmDialog.onConfirm}
      />
    </Box>
  );
}
