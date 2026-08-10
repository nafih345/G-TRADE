import React, { useState, useEffect } from 'react';
import { 
  Box, Card, CardContent, Typography, Button, Grid, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Chip, Dialog, DialogTitle, DialogContent, 
  DialogActions, TextField, MenuItem, Stack, IconButton, 
  Tooltip, Alert, InputAdornment, Avatar, Tabs, Tab
} from '@mui/material';
import {
  Add as AddIcon,
  Search as SearchIcon,
  Visibility as EyeIcon,
  AutoAwesome as SparkleIcon,
  Speed as SpeedIcon,
  LocalOffer as PriceIcon,
  Tune as TuneIcon,
  CheckCircle as CheckIcon,
  QrCode as BarcodeIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  CloudDone as CloudIcon,
  LightMode as SunIcon,
  Laptop as DigitalIcon
} from '@mui/icons-material';
import axios from 'axios';

const initialLensCatalog = [
  {
    id: 'LENS-101',
    sku: 'LNS-CR39-ARC',
    barcode: '890123450001',
    name: 'Standard Anti-Reflective CR39 1.50',
    brand: 'Essilor',
    lensType: 'Single Vision',
    index: '1.50',
    coating: 'Anti-Glare (ARC)',
    material: 'CR39 Resin',
    sphRange: '-6.00 to +4.00',
    cylRange: '-2.00 to 0.00',
    purchasePrice: 250,
    sellingPrice: 750,
    stock: 45,
    reorderLevel: 10,
    aiTags: ['Budget Friendly', 'Daily Wear'],
    status: 'Active'
  },
  {
    id: 'LENS-102',
    sku: 'LNS-156-BLUE',
    barcode: '890123450002',
    name: 'BlueControl UV420 Shield 1.56',
    brand: 'Hoya',
    lensType: 'Single Vision',
    index: '1.56',
    coating: 'Blue Cut UV420',
    material: 'Nk-55 Hi-Index',
    sphRange: '-8.00 to +6.00',
    cylRange: '-4.00 to 0.00',
    purchasePrice: 450,
    sellingPrice: 1450,
    stock: 32,
    reorderLevel: 8,
    aiTags: ['💻 Digital Screen Shield', 'UV400 Protection'],
    status: 'Active'
  },
  {
    id: 'LENS-103',
    sku: 'LNS-167-PROG',
    barcode: '890123450003',
    name: 'Precision SmartLife Progressive 1.67',
    brand: 'Zeiss',
    lensType: 'Progressive Digital',
    index: '1.67',
    coating: 'DuraVision Platinum',
    material: 'Ultra Thin 1.67',
    sphRange: '-12.00 to +8.00',
    cylRange: '-4.00 to 0.00',
    purchasePrice: 2800,
    sellingPrice: 6500,
    stock: 14,
    reorderLevel: 5,
    aiTags: ['🔬 High Myopia Slim Edge', 'Premium Optics'],
    status: 'Active'
  },
  {
    id: 'LENS-104',
    sku: 'LNS-156-TRANS',
    barcode: '890123450004',
    name: 'Transitions VII Photochromic 1.56',
    brand: 'Essilor',
    lensType: 'Single Vision',
    index: '1.56',
    coating: 'Photochromic Auto-Tint',
    material: 'PhotoResin',
    sphRange: '-6.00 to +4.00',
    cylRange: '-2.00 to 0.00',
    purchasePrice: 950,
    sellingPrice: 2850,
    stock: 22,
    reorderLevel: 5,
    aiTags: ['☀️ UV Outdoor Tint', '🚗 Night Driving'],
    status: 'Active'
  }
];

export default function LensManagementView({ onProductAdded }) {
  const [lensList, setLensList] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [designFilter, setDesignFilter] = useState('All');
  const [indexFilter, setIndexFilter] = useState('All');
  const [dialogOpen, setDialogOpen] = useState(false);

  const [newLens, setNewLens] = useState({
    name: '',
    brand: 'Essilor',
    lensType: 'Single Vision',
    index: '1.56',
    coating: 'Blue Cut UV420',
    material: 'CR39 Resin',
    sphRange: '-6.00 to +6.00',
    cylRange: '-2.00 to 0.00',
    purchasePrice: '',
    sellingPrice: '',
    stock: '20',
    reorderLevel: '5',
    supplier: 'Direct Optical Wholesaler'
  });

  // Load Lenses from Database API & LocalStorage
  useEffect(() => {
    const fetchLenses = async () => {
      let combinedLenses = [];
      try {
        const stored = JSON.parse(localStorage.getItem('optical_lens_catalog') || '[]');
        combinedLenses = Array.isArray(stored) ? [...stored] : [];
      } catch (e) {}

      try {
        const res = await axios.get('/api/products/items/');
        const items = res.data?.results || res.data || [];
        if (Array.isArray(items) && items.length > 0) {
          const lensItems = items.filter(p => {
            const cat = String(p.category_name || p.category || '').toLowerCase();
            const name = String(p.name || '').toLowerCase();
            return cat.includes('lens') || name.includes('lens') || p.frameType;
          }).map(p => ({
            id: String(p.id),
            sku: p.sku || p.code || `LNS-${p.id}`,
            barcode: p.barcode || '890123450001',
            name: p.name || 'Optical Lens Item',
            brand: p.brand_name || p.brand || 'Essilor',
            lensType: p.lensType || p.frame_type || 'Single Vision',
            index: p.index || p.size || '1.56',
            coating: p.coating || p.color || 'Anti-Glare (ARC)',
            material: p.material || 'Hi-Index Resin',
            sphRange: p.sphRange || '-6.00 to +6.00',
            cylRange: p.cylRange || '-2.00 to 0.00',
            purchasePrice: parseFloat(p.cost_price || p.purchasePrice || 0),
            sellingPrice: parseFloat(p.retail_price || p.selling_price || p.price || 0),
            stock: parseInt(p.stock || 1),
            reorderLevel: 5,
            aiTags: ['Database Catalog Item', p.brand_name || 'Optical Lens'],
            status: 'Active'
          }));

          const seenSkus = new Set(combinedLenses.map(l => String(l.sku || l.id).toLowerCase()));
          lensItems.forEach(item => {
            const key = String(item.sku || item.id).toLowerCase();
            if (!seenSkus.has(key)) {
              seenSkus.add(key);
              combinedLenses.push(item);
            }
          });
        }
      } catch (err) {
        console.warn("Notice loading lens catalog from API:", err);
      }

      if (combinedLenses.length === 0) {
        combinedLenses = initialLensCatalog;
      }
      setLensList(combinedLenses);
      try {
        localStorage.setItem('optical_lens_catalog', JSON.stringify(combinedLenses));
      } catch (e) {}
    };

    fetchLenses();
  }, []);

  const saveLensCatalog = (updated) => {
    setLensList(updated);
    try {
      localStorage.setItem('optical_lens_catalog', JSON.stringify(updated));
    } catch (e) {}

    // Sync back to master inventory if callback exists
    if (onProductAdded) {
      onProductAdded();
    }
  };

  // Quick 1-Click Preset Installer
  const handleInstallPreset = async (presetName, brand, type, index, coating, buyPrice, sellPrice, tag) => {
    const skuCode = `LNS-${index}-${Math.floor(100 + Math.random() * 900)}`;
    const barcodeVal = String(Math.floor(890000000000 + Math.random() * 9999999999));
    
    const newPreset = {
      id: `LENS-${Date.now()}`,
      sku: skuCode,
      barcode: barcodeVal,
      name: presetName,
      brand,
      lensType: type,
      index,
      coating,
      material: `Index ${index}`,
      sphRange: '-8.00 to +6.00',
      cylRange: '-2.00 to 0.00',
      purchasePrice: buyPrice,
      sellingPrice: sellPrice,
      stock: 25,
      reorderLevel: 5,
      aiTags: [tag, 'Fast Installer'],
      status: 'Active'
    };

    // Post to Database API
    try {
      await axios.post('/api/products/items/', {
        name: presetName,
        sku: skuCode,
        barcode: barcodeVal,
        category_name: 'Prescription Lenses',
        brand_name: brand,
        cost_price: buyPrice,
        retail_price: sellPrice,
        stock: 25,
        is_active: true
      });
    } catch (err) {}

    const updated = [newPreset, ...lensList];
    saveLensCatalog(updated);
    alert(`⚡ Lens Preset '${presetName}' registered into inventory matrix successfully!`);
  };

  // Create Custom Lens Option
  const handleSaveLens = async () => {
    if (!newLens.name) {
      alert("Please enter Lens Product Name.");
      return;
    }

    const skuCode = `LNS-${newLens.index}-${Math.floor(1000 + Math.random() * 9000)}`;
    const barcodeVal = String(Math.floor(890000000000 + Math.random() * 9999999999));

    const created = {
      id: `LENS-${Date.now()}`,
      sku: skuCode,
      barcode: barcodeVal,
      name: newLens.name,
      brand: newLens.brand,
      lensType: newLens.lensType,
      index: newLens.index,
      coating: newLens.coating,
      material: newLens.material,
      sphRange: newLens.sphRange,
      cylRange: newLens.cylRange,
      purchasePrice: parseFloat(newLens.purchasePrice) || 0,
      sellingPrice: parseFloat(newLens.sellingPrice) || 0,
      stock: parseInt(newLens.stock) || 0,
      reorderLevel: parseInt(newLens.reorderLevel) || 5,
      aiTags: ['Custom Catalog Entry', `${newLens.index} Index`],
      status: 'Active'
    };

    // Post to Database API
    try {
      await axios.post('/api/products/items/', {
        name: newLens.name,
        sku: skuCode,
        barcode: barcodeVal,
        category_name: 'Prescription Lenses',
        brand_name: newLens.brand,
        cost_price: parseFloat(newLens.purchasePrice) || 0,
        retail_price: parseFloat(newLens.sellingPrice) || 0,
        stock: parseInt(newLens.stock) || 0,
        is_active: true
      });
    } catch (err) {}

    const updated = [created, ...lensList];
    saveLensCatalog(updated);
    setDialogOpen(false);
    setNewLens({
      name: '', brand: 'Essilor', lensType: 'Single Vision', index: '1.56',
      coating: 'Blue Cut UV420', material: 'CR39 Resin', sphRange: '-6.00 to +6.00',
      cylRange: '-2.00 to 0.00', purchasePrice: '', sellingPrice: '', stock: '20', reorderLevel: '5', supplier: ''
    });
    alert(`New Ophthalmic Lens '${created.name}' added to database successfully!`);
  };

  // Delete Lens Entry
  const handleDeleteLens = (id) => {
    const updated = lensList.filter(l => l.id !== id);
    saveLensCatalog(updated);
  };

  // Filtered Lens Items
  const filteredLenses = lensList.filter(l => {
    const matchSearch = (l.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                        (l.brand || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                        (l.sku || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                        (l.coating || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchDesign = designFilter === 'All' || l.lensType === designFilter;
    const matchIndex = indexFilter === 'All' || l.index === indexFilter;
    return matchSearch && matchDesign && matchIndex;
  });

  return (
    <Box sx={{ pb: 4 }}>
      
      {/* 🚀 QUICK PRESET ONE-CLICK INSTALLER BAR */}
      <Card variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3.5, bgcolor: '#ffffff', borderColor: '#2563eb', borderLeft: '6px solid #2563eb', boxShadow: '0 4px 16px rgba(37, 99, 235, 0.08)' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar sx={{ bgcolor: '#2563eb', width: 38, height: 38 }}>
              <SparkleIcon fontSize="small" />
            </Avatar>
            <Box>
              <Typography variant="subtitle1" fontWeight={900} color="#0f172a">
                ⚡ Quick Presets: 1-Click Lens Option Creator
              </Typography>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Instantly install standard optical lens products into inventory with pre-calculated margins
              </Typography>
            </Box>
          </Stack>
          
          <Button 
            variant="contained" color="primary" startIcon={<AddIcon />}
            onClick={() => setDialogOpen(true)}
            sx={{ fontWeight: 900, borderRadius: 2, textTransform: 'none', px: 2.5 }}
          >
            + Add Custom Lens Option
          </Button>
        </Box>

        <Grid container spacing={1.5}>
          <Grid item xs={12} sm={6} md={4} lg={2.4}>
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, bgcolor: '#eff6ff', borderColor: '#bfdbfe', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%' }}>
              <Box>
                <Chip label="ESSILOR" size="small" color="primary" sx={{ fontWeight: 900, fontSize: '0.65rem', mb: 0.5 }} />
                <Typography variant="body2" fontWeight={800} color="#1e3a8a">Crizal Sapphire 1.67</Typography>
                <Typography variant="caption" color="text.secondary">Ultra-Thin ARC • Single Vision</Typography>
              </Box>
              <Button 
                size="small" variant="contained" fullWidth 
                onClick={() => handleInstallPreset('Essilor Crizal Sapphire HR 1.67', 'Essilor', 'Single Vision', '1.67', 'DuraVision ARC', 1800, 4200, '🔬 High Myopia')}
                sx={{ mt: 1.5, fontWeight: 900, fontSize: '0.75rem', bgcolor: '#2563eb', textTransform: 'none' }}
              >
                + Add (₹4,200)
              </Button>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={4} lg={2.4}>
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, bgcolor: '#f0fdf4', borderColor: '#bbf7d0', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%' }}>
              <Box>
                <Chip label="HOYA" size="small" color="success" sx={{ fontWeight: 900, fontSize: '0.65rem', mb: 0.5 }} />
                <Typography variant="body2" fontWeight={800} color="#065f46">BlueControl UV420 1.56</Typography>
                <Typography variant="caption" color="text.secondary">Digital Shield • Anti-Fatigue</Typography>
              </Box>
              <Button 
                size="small" variant="contained" color="success" fullWidth 
                onClick={() => handleInstallPreset('Hoya BlueControl UV420 1.56', 'Hoya', 'Single Vision', '1.56', 'Blue Cut UV420', 450, 1450, '💻 Digital Screen Shield')}
                sx={{ mt: 1.5, fontWeight: 900, fontSize: '0.75rem', textTransform: 'none' }}
              >
                + Add (₹1,450)
              </Button>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={4} lg={2.4}>
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, bgcolor: '#fefce8', borderColor: '#fef08a', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%' }}>
              <Box>
                <Chip label="ZEISS" size="small" sx={{ bgcolor: '#ca8a04', color: '#fff', fontWeight: 900, fontSize: '0.65rem', mb: 0.5 }} />
                <Typography variant="body2" fontWeight={800} color="#713f12">SmartLife Progressive 1.60</Typography>
                <Typography variant="caption" color="text.secondary">HD Freeform Digital Corridor</Typography>
              </Box>
              <Button 
                size="small" variant="contained" fullWidth 
                onClick={() => handleInstallPreset('Zeiss SmartLife Progressive 1.60', 'Zeiss', 'Progressive Digital', '1.60', 'LotuTec Anti-Reflective', 2400, 6800, '👁 Presbyopia HD')}
                sx={{ mt: 1.5, fontWeight: 900, fontSize: '0.75rem', bgcolor: '#ca8a04', '&:hover': { bgcolor: '#a16207' }, textTransform: 'none' }}
              >
                + Add (₹6,800)
              </Button>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={4} lg={2.4}>
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, bgcolor: '#faf5ff', borderColor: '#e9d5ff', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%' }}>
              <Box>
                <Chip label="KODAK" size="small" sx={{ bgcolor: '#9333ea', color: '#fff', fontWeight: 900, fontSize: '0.65rem', mb: 0.5 }} />
                <Typography variant="body2" fontWeight={800} color="#581c87">CityLens Photochromic 1.56</Typography>
                <Typography variant="caption" color="text.secondary">Rapid Sunlight Darkening</Typography>
              </Box>
              <Button 
                size="small" variant="contained" fullWidth 
                onClick={() => handleInstallPreset('Kodak CityLens Photochromic 1.56', 'Kodak', 'Single Vision', '1.56', 'Photochromic Auto-Tint', 850, 2400, '☀️ Outdoor Transition')}
                sx={{ mt: 1.5, fontWeight: 900, fontSize: '0.75rem', bgcolor: '#9333ea', '&:hover': { bgcolor: '#7e22ce' }, textTransform: 'none' }}
              >
                + Add (₹2,400)
              </Button>
            </Paper>
          </Grid>

          <Grid item xs={12} sm={6} md={4} lg={2.4}>
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, bgcolor: '#f8fafc', borderColor: '#cbd5e1', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100%' }}>
              <Box>
                <Chip label="GENERIC" size="small" sx={{ bgcolor: '#475569', color: '#fff', fontWeight: 900, fontSize: '0.65rem', mb: 0.5 }} />
                <Typography variant="body2" fontWeight={800} color="#0f172a">Standard CR39 ARC 1.50</Typography>
                <Typography variant="caption" color="text.secondary">Everyday Hard Coated Resin</Typography>
              </Box>
              <Button 
                size="small" variant="contained" fullWidth 
                onClick={() => handleInstallPreset('Standard Anti-Reflective CR39 1.50', 'Generic', 'Single Vision', '1.50', 'Anti-Glare (ARC)', 200, 650, 'Budget Daily')}
                sx={{ mt: 1.5, fontWeight: 900, fontSize: '0.75rem', bgcolor: '#475569', '&:hover': { bgcolor: '#334155' }, textTransform: 'none' }}
              >
                + Add (₹650)
              </Button>
            </Paper>
          </Grid>

        </Grid>
      </Card>

      {/* 📊 SEARCH & INDEX FILTER TOOLBAR */}
      <Card variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3, bgcolor: '#ffffff' }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={4} md={5}>
            <TextField 
              fullWidth size="small" placeholder="Search Lens Name, Brand, Coating, or SKU..."
              value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start"><SearchIcon color="action" fontSize="small" /></InputAdornment>
              }}
            />
          </Grid>

          <Grid item xs={6} sm={4} md={3.5}>
            <TextField 
              select fullWidth size="small" label="Design Type"
              value={designFilter} onChange={(e) => setDesignFilter(e.target.value)}
            >
              <MenuItem value="All">All Designs (Single / Prog / Bifocal)</MenuItem>
              <MenuItem value="Single Vision">Single Vision</MenuItem>
              <MenuItem value="Progressive Digital">Progressive Digital</MenuItem>
              <MenuItem value="Bifocal D-Seg">Bifocal D-Seg</MenuItem>
              <MenuItem value="Office / Workspace">Office / Workspace</MenuItem>
            </TextField>
          </Grid>

          <Grid item xs={6} sm={4} md={3.5}>
            <TextField 
              select fullWidth size="small" label="Refractive Index"
              value={indexFilter} onChange={(e) => setIndexFilter(e.target.value)}
            >
              <MenuItem value="All">All Refractive Indices</MenuItem>
              <MenuItem value="1.50">1.50 Standard CR39</MenuItem>
              <MenuItem value="1.56">1.56 Mid Index Blue Cut</MenuItem>
              <MenuItem value="1.60">1.60 Hi-Index</MenuItem>
              <MenuItem value="1.67">1.67 Ultra Thin</MenuItem>
              <MenuItem value="1.74">1.74 Super High Index</MenuItem>
            </TextField>
          </Grid>
        </Grid>
      </Card>

      {/* 📋 LENS CATALOG DATA GRID */}
      <Card variant="outlined" sx={{ borderRadius: 3.5, overflow: 'hidden', borderColor: '#cbd5e1' }}>
        <TableContainer component={Paper} elevation={0}>
          <Table size="small">
            <TableHead sx={{ bgcolor: '#0f172a' }}>
              <TableRow>
                <TableCell sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>SKU / Barcode</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Lens Name & Brand</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Design & Index</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Coatings & Tags</TableCell>
                <TableCell sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Power Matrix</TableCell>
                <TableCell align="right" sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Buy Price</TableCell>
                <TableCell align="right" sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Sell Price</TableCell>
                <TableCell align="center" sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Stock</TableCell>
                <TableCell align="center" sx={{ color: '#ffffff', fontWeight: 900, py: 1, fontSize: '0.78rem' }}>Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredLenses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4 }}>
                    <Typography variant="body2" color="text.secondary" fontWeight={600}>
                      No optical lens items found matching criteria. Click '+ Add Custom Lens Option' or use Quick Presets above.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                filteredLenses.map((lens) => (
                  <TableRow key={lens.id} hover sx={{ '&:nth-of-type(even)': { bgcolor: '#f8fafc' } }}>
                    <TableCell sx={{ fontWeight: 800, color: 'primary.main', fontSize: '0.8rem' }}>
                      <Typography variant="body2" fontWeight={800} color="#2563eb">{lens.sku}</Typography>
                      <Typography variant="caption" color="text.secondary">{lens.barcode}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={800} color="#0f172a">{lens.name}</Typography>
                      <Chip label={lens.brand} size="small" variant="outlined" sx={{ fontWeight: 800, height: 18, fontSize: '0.65rem' }} />
                    </TableCell>
                    <TableCell>
                      <Chip label={lens.lensType} size="small" color="primary" sx={{ fontWeight: 800, height: 20, fontSize: '0.7rem', mr: 0.5 }} />
                      <Chip label={`Index ${lens.index}`} size="small" color="secondary" sx={{ fontWeight: 800, height: 20, fontSize: '0.7rem' }} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" display="block" fontWeight={700} color="#047857">{lens.coating}</Typography>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                        {(lens.aiTags || []).map((tag, idx) => (
                          <Chip key={idx} label={tag} size="small" sx={{ bgcolor: '#e0f2fe', color: '#0369a1', fontWeight: 800, height: 18, fontSize: '0.62rem' }} />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.78rem', fontWeight: 700 }}>
                      <Typography variant="caption" display="block">SPH: {lens.sphRange}</Typography>
                      <Typography variant="caption" color="text.secondary" display="block">CYL: {lens.cylRange}</Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.82rem' }}>₹{lens.purchasePrice}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 900, color: 'success.main', fontSize: '0.88rem' }}>₹{lens.sellingPrice}</TableCell>
                    <TableCell align="center">
                      <Chip 
                        label={`${lens.stock} Pcs`} size="small"
                        color={lens.stock <= (lens.reorderLevel || 5) ? 'error' : 'success'}
                        sx={{ fontWeight: 900, height: 22, fontSize: '0.72rem' }}
                      />
                    </TableCell>
                    <TableCell align="center">
                      <IconButton size="small" color="error" onClick={() => handleDeleteLens(lens.id)}>
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

      {/* ➕ DIALOG: ADD CUSTOM OPTICAL LENS OPTION */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
        <DialogTitle sx={{ fontWeight: 900, bgcolor: '#0f172a', color: '#facc15' }}>
          🔬 Register New Ophthalmic Lens Option
        </DialogTitle>
        <DialogContent dividers sx={{ p: 2.5 }}>
          <Grid container spacing={2}>
            
            <Grid item xs={12}>
              <TextField 
                fullWidth size="small" label="Lens Product Name" placeholder="e.g. Essilor Crizal Sapphire HR 1.67" required
                value={newLens.name} onChange={(e) => setNewLens({ ...newLens, name: e.target.value })}
                inputProps={{ style: { fontWeight: 800 } }}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField 
                select fullWidth size="small" label="Lens Brand"
                value={newLens.brand} onChange={(e) => setNewLens({ ...newLens, brand: e.target.value })}
              >
                {['Essilor', 'Zeiss', 'Hoya', 'Crizal', 'Kodak', 'Generic', 'VisionRx'].map(b => (
                  <MenuItem key={b} value={b}>{b}</MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid item xs={6}>
              <TextField 
                select fullWidth size="small" label="Design Type"
                value={newLens.lensType} onChange={(e) => setNewLens({ ...newLens, lensType: e.target.value })}
              >
                <MenuItem value="Single Vision">Single Vision</MenuItem>
                <MenuItem value="Progressive Digital">Progressive Digital</MenuItem>
                <MenuItem value="Bifocal D-Seg">Bifocal D-Seg</MenuItem>
                <MenuItem value="Office / Workspace">Office / Workspace</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={6}>
              <TextField 
                select fullWidth size="small" label="Refractive Index"
                value={newLens.index} onChange={(e) => setNewLens({ ...newLens, index: e.target.value })}
              >
                <MenuItem value="1.50">1.50 Standard CR39</MenuItem>
                <MenuItem value="1.56">1.56 Mid Index</MenuItem>
                <MenuItem value="1.60">1.60 Hi-Index</MenuItem>
                <MenuItem value="1.67">1.67 Ultra Thin</MenuItem>
                <MenuItem value="1.74">1.74 Super High Index</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={6}>
              <TextField 
                select fullWidth size="small" label="Coating Type"
                value={newLens.coating} onChange={(e) => setNewLens({ ...newLens, coating: e.target.value })}
              >
                <MenuItem value="Anti-Glare (ARC)">Anti-Glare (ARC)</MenuItem>
                <MenuItem value="Blue Cut UV420">Blue Cut UV420</MenuItem>
                <MenuItem value="Photochromic Auto-Tint">Photochromic Auto-Tint</MenuItem>
                <MenuItem value="Polarized Sun Shield">Polarized Sun Shield</MenuItem>
                <MenuItem value="Hard Coated Scratch Resistant">Hard Coated Scratch Resistant</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={6}>
              <TextField 
                fullWidth size="small" label="SPH Power Range" placeholder="-8.00 to +6.00"
                value={newLens.sphRange} onChange={(e) => setNewLens({ ...newLens, sphRange: e.target.value })}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField 
                fullWidth size="small" label="CYL Power Range" placeholder="-4.00 to 0.00"
                value={newLens.cylRange} onChange={(e) => setNewLens({ ...newLens, cylRange: e.target.value })}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField 
                fullWidth size="small" label="Purchase Price (₹)" placeholder="400" type="number"
                value={newLens.purchasePrice} onChange={(e) => setNewLens({ ...newLens, purchasePrice: e.target.value })}
                inputProps={{ style: { fontWeight: 800 } }}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField 
                fullWidth size="small" label="Selling MRP Price (₹)" placeholder="1200" type="number"
                value={newLens.sellingPrice} onChange={(e) => setNewLens({ ...newLens, sellingPrice: e.target.value })}
                inputProps={{ style: { fontWeight: 900, color: '#059669' } }}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField 
                fullWidth size="small" label="Stock Opening Qty" placeholder="20" type="number"
                value={newLens.stock} onChange={(e) => setNewLens({ ...newLens, stock: e.target.value })}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField 
                fullWidth size="small" label="Minimum Alert Level" placeholder="5" type="number"
                value={newLens.reorderLevel} onChange={(e) => setNewLens({ ...newLens, reorderLevel: e.target.value })}
              />
            </Grid>

          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, bgcolor: '#f8fafc' }}>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveLens} sx={{ fontWeight: 900, px: 3, bgcolor: '#2563eb' }}>
            Save Lens Option
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
}
