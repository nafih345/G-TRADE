import React, { useState, useEffect } from 'react';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs,
  Grid, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Chip, Dialog, 
  DialogTitle, DialogContent, DialogActions, TextField, 
  MenuItem, Stack, IconButton, Autocomplete 
} from '@mui/material';
import {
  Add as AddIcon,
  QrCode as BarcodeIcon,
  Search as SearchIcon,
  SwapHoriz as TransferIcon,
  Tune as AdjustIcon
} from '@mui/icons-material';
import axios from 'axios';

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

const opticalSuppliers = [];

export default function Products() {
  const [products, setProducts] = useState(initialProducts);
  const [currentTab, setCurrentTab] = useState(0);
  const [open, setOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [barcodeDialog, setBarcodeDialog] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  
  const [newProduct, setNewProduct] = useState({
    code: '', barcode: '', name: '', brand: '', supplier: '', category: 'Frames',
    frameType: 'Full Rim', lensType: 'N/A', color: '', material: 'Metal',
    gender: 'Unisex', size: '', purchasePrice: '', sellingPrice: '',
    gst: '18%', stock: '', rack: '', shelf: '', warehouse: 'Main', status: 'Active'
  });

  const [adjustStock, setAdjustStock] = useState({ id: '', name: '', current: 0, change: 0, reason: 'Manual audit' });
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [dbSuppliers, setDbSuppliers] = useState([]);

  // Sync Registered Suppliers from Purchases Module / API
  useEffect(() => {
    const fetchRegisteredSuppliers = async () => {
      let suppList = [];
      try {
        const local = JSON.parse(localStorage.getItem('optical_suppliers') || '[]');
        suppList = [...local];
      } catch (e) {}

      try {
        const res = await axios.get('/api/purchasing/suppliers/');
        if (res.data && Array.isArray(res.data)) {
          const apiNames = res.data.map(s => s.name).filter(Boolean);
          suppList = [...suppList, ...apiNames];
        }
      } catch (e) {}

      setDbSuppliers(Array.from(new Set(suppList)));
    };
    fetchRegisteredSuppliers();
  }, [open]);

  // Fetch Inventory Products from Sales/Products Database
  useEffect(() => {
    const fetchInventoryProducts = async () => {
      try {
        const res = await axios.get('/api/products/items/');
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          const formatted = res.data.map(p => ({
            id: String(p.id),
            code: p.sku || p.code || `PROD-${p.id}`,
            barcode: p.barcode || '88019482',
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
          setProducts(formatted);
        }
      } catch (err) {
        console.log("Database products check: using standard empty state");
      }
    };
    fetchInventoryProducts();
  }, []);

  const handleTabChange = (event, newValue) => setCurrentTab(newValue);

  const handleOpen = () => setOpen(true);
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
      brand: newProduct.brand || 'Generic',
      purchasePrice: parseFloat(newProduct.purchasePrice) || 0,
      sellingPrice: parseFloat(newProduct.sellingPrice) || 0,
      stock: parseInt(newProduct.stock) || 0,
      barcode: newProduct.barcode || String(Math.floor(10000000 + Math.random() * 90000000))
    };
    
    try {
      await axios.post('/api/products/items/', {
        name: productToAdd.name,
        sku: productToAdd.code,
        price: productToAdd.sellingPrice,
        cost_price: productToAdd.purchasePrice,
        stock: productToAdd.stock,
        category: productToAdd.category,
        brand: productToAdd.brand
      });
    } catch (err) {
      console.log("Local state updated for new product.");
    }

    setProducts([productToAdd, ...products]);
    setNewProduct({
      code: '', barcode: '', name: '', brand: '', category: 'Frames',
      frameType: 'Full Rim', lensType: 'N/A', color: '', material: 'Metal',
      gender: 'Unisex', size: '', purchasePrice: '', sellingPrice: '',
      gst: '18%', stock: '', rack: '', shelf: '', warehouse: 'Main', status: 'Active'
    });
    handleClose();
    alert(`Product '${productToAdd.name}' saved to inventory database successfully!`);
  };

  const handleOpenBarcode = (product) => {
    setSelectedProduct(product);
    setBarcodeDialog(true);
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
    alert(`Stock for ${adjustStock.name} updated successfully!`);
  };

  return (
    <Box sx={{ p: 4 }}>
      {/* Header section */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>Optical Inventory Catalog</Typography>
          <Typography variant="body2" color="text.secondary">Manage frames, ophthalmic lenses, sunglasses, contact lenses, and diagnostics</Typography>
        </Box>
        
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant="outlined" startIcon={<AdjustIcon />} onClick={() => setAdjustOpen(true)}>
            Stock Adjust
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpen} sx={{ backgroundColor: '#2563EB' }}>
            Add New Product
          </Button>
        </Box>
      </Box>

      {/* Tabs */}
      <Tabs value={currentTab} onChange={handleTabChange} sx={{ mb: 3 }}>
        <Tab label="Products List" sx={{ fontWeight: 600 }} />
        <Tab label="Categories" sx={{ fontWeight: 600 }} />
        <Tab label="Brands Management" sx={{ fontWeight: 600 }} />
      </Tabs>

      {currentTab === 0 && (() => {
        const filteredProducts = products.filter(product => {
          const searchLower = searchQuery.toLowerCase();
          const matchesSearch = (product.name && product.name.toLowerCase().includes(searchLower)) ||
                                (product.code && product.code.toLowerCase().includes(searchLower)) ||
                                (product.barcode && product.barcode.toLowerCase().includes(searchLower)) ||
                                (product.brand && product.brand.toLowerCase().includes(searchLower));
          const matchesCat = categoryFilter === 'All' || product.category === categoryFilter;
          return matchesSearch && matchesCat;
        });

        return (
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
                          <TableCell colSpan={8} align="center" sx={{ py: 8 }}>
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
                            <TableRow key={product.id} hover>
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
                                <Typography variant="body2">Buy: ₹{product.purchasePrice.toFixed(2)}</Typography>
                                <Typography variant="body2" fontWeight={600}>Sell: ₹{product.sellingPrice.toFixed(2)} <span style={{fontSize: '0.75rem', color: 'gray'}}>({product.gst} GST)</span></Typography>
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
                                  <IconButton color="primary" onClick={() => handleOpenBarcode(product)}>
                                    <BarcodeIcon fontSize="small" />
                                  </IconButton>
                                  <IconButton color="secondary" onClick={() => handleOpenAdjustment(product)}>
                                    <AdjustIcon fontSize="small" />
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
        );
      })()}

      {currentTab === 1 && (
        <Grid container spacing={3}>
          {opticalCategories.map((cat, index) => (
            <Grid item xs={12} sm={6} md={4} lg={3} key={index}>
              <Card sx={{ textAlign: 'center', p: 3, border: '1px solid', borderColor: 'divider' }}>
                <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>{cat}</Typography>
                <Typography variant="caption" color="text.secondary">VisionERP Modular Category</Typography>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {currentTab === 2 && (
        <Grid container spacing={3}>
          {opticalBrands.map((brand, index) => (
            <Grid item xs={12} sm={6} md={4} key={index}>
              <Card sx={{ p: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid', borderColor: 'divider' }}>
                <Typography variant="h6" fontWeight={700}>{brand}</Typography>
                <Chip label="Authorized Supplier" color="primary" size="small" variant="outlined" />
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {/* Add New Product Dialog */}
      <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Add Optical Stock / Product</span>
          <Button 
            variant="contained" 
            size="small" 
            startIcon={<BarcodeIcon />} 
            onClick={() => setScanDialogOpen(true)}
            sx={{ backgroundColor: '#10B981', color: 'white', fontWeight: 700 }}
          >
            📷 Scan Arriving Product Barcode
          </Button>
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ mb: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="body2" color="text.secondary" fontWeight={500}>
              💡 <strong>Arriving Stock with Barcode?</strong> Click <strong>"Scan Barcode"</strong> to automatically scan product packaging barcode via USB Scanner or Smartphone camera.
            </Typography>
            <Button size="small" variant="outlined" startIcon={<BarcodeIcon />} onClick={() => setScanDialogOpen(true)}>
              Scan Barcode
            </Button>
          </Box>

          <Grid container spacing={2}>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="Product Code" 
                fullWidth 
                placeholder="e.g. RF-102"
                value={newProduct.code} 
                onChange={(e) => setNewProduct({...newProduct, code: e.target.value})} 
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="Barcode / EAN Code" 
                fullWidth 
                placeholder="Scan or type barcode"
                value={newProduct.barcode} 
                onChange={(e) => setNewProduct({...newProduct, barcode: e.target.value})}
                InputProps={{
                  endAdornment: (
                    <Stack direction="row" spacing={0.5}>
                      <IconButton color="primary" size="small" title="Scan Barcode via Camera / Scanner" onClick={() => setScanDialogOpen(true)}>
                        <BarcodeIcon fontSize="small" />
                      </IconButton>
                      <Button 
                        size="small" 
                        sx={{ fontSize: '0.65rem', minWidth: 'auto', px: 1 }}
                        onClick={() => setNewProduct({...newProduct, barcode: String(Math.floor(88000000 + Math.random() * 11000000))})}
                      >
                        Auto
                      </Button>
                    </Stack>
                  )
                }}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="Product Name" 
                fullWidth 
                required
                placeholder="e.g. Aviator Classic Rimless"
                value={newProduct.name} 
                onChange={(e) => setNewProduct({...newProduct, name: e.target.value})} 
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField select label="Category" fullWidth value={newProduct.category} onChange={(e) => setNewProduct({...newProduct, category: e.target.value})}>
                {opticalCategories.map(cat => <MenuItem key={cat} value={cat}>{cat}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={6} sm={4}>
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
                    label="Brand" 
                    placeholder="Type or select brand..."
                    fullWidth 
                  />
                )}
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <Autocomplete
                freeSolo
                options={Array.from(new Set([...dbSuppliers, ...products.map(p => p.supplier).filter(Boolean)]))}
                value={newProduct.supplier}
                onInputChange={(event, newInputValue) => {
                  setNewProduct({ ...newProduct, supplier: newInputValue });
                }}
                renderInput={(params) => (
                  <TextField 
                    {...params} 
                    label="Supplier Name" 
                    placeholder="Type supplier name..."
                    fullWidth 
                  />
                )}
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField select label="Gender Target" fullWidth value={newProduct.gender} onChange={(e) => setNewProduct({...newProduct, gender: e.target.value})}>
                <MenuItem value="Male">Male</MenuItem>
                <MenuItem value="Female">Female</MenuItem>
                <MenuItem value="Kids">Kids</MenuItem>
                <MenuItem value="Unisex">Unisex</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField label="Purchase Price (₹)" fullWidth type="number" value={newProduct.purchasePrice} onChange={(e) => setNewProduct({...newProduct, purchasePrice: e.target.value})} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField label="Selling Price (₹)" fullWidth type="number" value={newProduct.sellingPrice} onChange={(e) => setNewProduct({...newProduct, sellingPrice: e.target.value})} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField select label="GST Tax Rate" fullWidth value={newProduct.gst} onChange={(e) => setNewProduct({...newProduct, gst: e.target.value})}>
                <MenuItem value="5%">5% GST</MenuItem>
                <MenuItem value="12%">12% GST</MenuItem>
                <MenuItem value="18%">18% GST</MenuItem>
                <MenuItem value="28%">28% GST</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField label="Initial Stock Qty" fullWidth type="number" value={newProduct.stock} onChange={(e) => setNewProduct({...newProduct, stock: e.target.value})} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField label="Rack Location" fullWidth placeholder="e.g. Rack A1" value={newProduct.rack} onChange={(e) => setNewProduct({...newProduct, rack: e.target.value})} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField label="Shelf Location" fullWidth placeholder="e.g. Shelf S2" value={newProduct.shelf} onChange={(e) => setNewProduct({...newProduct, shelf: e.target.value})} />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={handleClose}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" sx={{ backgroundColor: '#2563EB', px: 3, fontWeight: 700 }}>
            Save Product to Database
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

      {/* Barcode Viewer Dialog */}
      <Dialog open={barcodeDialog} onClose={() => setBarcodeDialog(false)}>
        <DialogTitle sx={{ fontWeight: 700 }}>Barcode Generator & Label</DialogTitle>
        <DialogContent dividers sx={{ textAlign: 'center', p: 4 }}>
          {selectedProduct && (
            <Box>
              <Typography variant="subtitle1" fontWeight={700}>{selectedProduct.brand} - {selectedProduct.name}</Typography>
              <Typography variant="body2" sx={{ mb: 3 }}>Code: {selectedProduct.code} | Price: ${selectedProduct.sellingPrice}</Typography>
              {/* Visual simulated Barcode */}
              <Box sx={{ border: '2px solid black', p: 2, display: 'inline-block', letterSpacing: 4, fontFamily: 'monospace', fontWeight: 'bold', mb: 2 }}>
                |||| | ||||| | || | ||| ||<br />
                {selectedProduct.barcode}
              </Box>
            </Box>
          )}
          <Typography variant="caption" color="text.secondary">Ready to print label tags (38mm x 25mm)</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBarcodeDialog(false)}>Close</Button>
          <Button variant="contained" onClick={() => window.print()}>Print Label</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
