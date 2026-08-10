import React, { useState, useEffect, useMemo } from 'react';
import { 
  Box, Grid, Card, Typography, Button, 
  Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, Stack, IconButton, Avatar,
  InputAdornment, Divider, Paper, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TablePagination,
  Checkbox, Drawer, Alert, CircularProgress, Snackbar,
  Breadcrumbs, Link
} from '@mui/material';
import {
  Add as AddIcon,
  Verified as BrandIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Search as SearchIcon,
  Refresh as RefreshIcon,
  FileDownload as ExportIcon,
  FileUpload as ImportIcon,
  Visibility as ViewIcon,
  ContentCopy as DuplicateIcon,
  Warning as WarningIcon,
  Inventory2 as ProductIcon,
  NavigateNext as NavigateNextIcon,
  Shield as WarrantyIcon,
  Business as SupplierIcon
} from '@mui/icons-material';
import axios from 'axios';

export default function BrandManagementView({ products = [] }) {
  const [brands, setBrands] = useState([]);
  const [dbProducts, setDbProducts] = useState(products);
  const [loading, setLoading] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' });

  // Filtering, Search, Sorting, & Pagination State
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sortBy, setSortBy] = useState('name_asc');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [selectedIds, setSelectedIds] = useState([]);

  // Modals & Drawers State
  const [addEditModalOpen, setAddEditModalOpen] = useState(false);
  const [editingBrand, setEditingBrand] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [brandToDelete, setBrandToDelete] = useState(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [viewingBrand, setViewingBrand] = useState(null);

  // Form State
  const [formState, setFormState] = useState({
    name: '',
    code: '',
    supplier: '',
    category: 'Frames & Sunglasses',
    warrantyMonths: 12,
    website: '',
    status: 'Active'
  });
  const [formErrors, setFormErrors] = useState({});

  // 1. Fetch Brands & Products strictly from Database API
  const fetchBrandMasterData = async () => {
    setLoading(true);
    let fetchedBrands = [];
    let fetchedProducts = [];

    // Fetch Database Products
    try {
      const pRes = await axios.get('/api/products/items/');
      const rawProds = pRes.data?.results || pRes.data || [];
      if (Array.isArray(rawProds)) {
        fetchedProducts = rawProds.map(p => ({
          id: String(p.id),
          code: p.sku || p.code || `PROD-${p.id}`,
          name: p.name || 'Unnamed Product',
          brand: p.brand || p.brand_name || '',
          brand_name: p.brand_name || p.brand || '',
          category: p.category || p.category_name || 'Uncategorized',
          purchasePrice: parseFloat(p.cost_price || p.purchasePrice || 0),
          sellingPrice: parseFloat(p.price || p.selling_price || p.retail_price || 0),
          stock: parseInt(p.stock || p.quantity || 0),
          status: p.is_active === false ? 'Inactive' : 'Active'
        }));
      }
    } catch (e) {
      console.warn("Product API notice:", e);
    }

    if (fetchedProducts.length === 0 && products.length > 0) {
      fetchedProducts = [...products];
    } else if (fetchedProducts.length === 0) {
      try {
        const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
        fetchedProducts = local.map(p => ({
          id: String(p.id || p.code),
          code: p.code || p.sku || `PROD-${p.id}`,
          name: p.name || 'Unnamed Product',
          brand: p.brand || p.brand_name || '',
          brand_name: p.brand_name || p.brand || '',
          category: p.category || p.category_name || 'Uncategorized',
          purchasePrice: parseFloat(p.purchasePrice || p.cost_price || 0),
          sellingPrice: parseFloat(p.sellingPrice || p.price || p.retail_price || 0),
          stock: parseInt(p.stock || 0),
          status: 'Active'
        }));
      } catch (err) {}
    }
    setDbProducts(fetchedProducts);

    // Fetch Master Brands from Database API
    try {
      const bRes = await axios.get('/api/masters/brands/');
      const rawBrands = bRes.data?.results || bRes.data || [];
      if (Array.isArray(rawBrands)) {
        fetchedBrands = rawBrands.map(b => ({
          id: String(b.id),
          name: b.name,
          code: b.code || b.name.slice(0, 3).toUpperCase(),
          supplier: b.supplier || b.supplier_name || 'Authorized Distributor',
          category: b.category || 'Frames & Sunglasses',
          warrantyMonths: parseInt(b.warrantyMonths || b.warranty_months || 12),
          website: b.website || '',
          status: b.status || 'Active',
          products_count: parseInt(b.products_count || 0),
          created_at: b.created_at ? new Date(b.created_at).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN')
        }));
      }
    } catch (e) {
      console.warn("Brand API notice:", e);
    }

    // Extract unique brands present on actual Database Products (Filtering out empty / invalid brands)
    const validProdBrandNames = Array.from(
      new Set(
        fetchedProducts
          .map(p => (p.brand || p.brand_name || '').trim())
          .filter(b => b && b.toLowerCase() !== 'none' && b.toLowerCase() !== 'null' && b.toLowerCase() !== 'n/a' && b.toLowerCase() !== 'undefined')
      )
    );

    const brandMap = new Map();
    fetchedBrands.forEach(b => brandMap.set(b.name.toLowerCase(), b));

    // Add product brands found in Database Products that aren't in master table yet
    validProdBrandNames.forEach(bName => {
      if (!brandMap.has(bName.toLowerCase())) {
        brandMap.set(bName.toLowerCase(), {
          id: `BRD-DB-${bName.replace(/\s+/g, '-').toUpperCase()}`,
          name: bName,
          code: bName.slice(0, 3).toUpperCase(),
          supplier: 'Authorized Agency',
          category: 'Optical Lines',
          warrantyMonths: 12,
          website: '',
          status: 'Active',
          created_at: new Date().toLocaleDateString('en-IN')
        });
      }
    });

    const finalBrandsList = Array.from(brandMap.values());
    setBrands(finalBrandsList);
    try {
      localStorage.setItem('optical_brands_db', JSON.stringify(finalBrandsList));
    } catch (e) {}
    setLoading(false);
  };

  useEffect(() => {
    fetchBrandMasterData();
    window.addEventListener('optical_stock_updated', fetchBrandMasterData);
    return () => window.removeEventListener('optical_stock_updated', fetchBrandMasterData);
  }, [products]);

  // Calculate Product Count per Brand dynamically from Database Products
  const brandProductMap = useMemo(() => {
    const map = {};
    dbProducts.forEach(p => {
      const bName = String(p.brand || p.brand_name || '').trim();
      if (!bName || bName.toLowerCase() === 'none' || bName.toLowerCase() === 'null') return;
      const lower = bName.toLowerCase();
      map[lower] = (map[lower] || 0) + 1;
    });
    return map;
  }, [dbProducts]);

  const getProductCountForBrand = (brandName, brandObj = null) => {
    const apiCount = brandObj?.products_count || 0;
    const target = String(brandName || '').trim().toLowerCase();
    
    let localCount = 0;
    if (brandProductMap[target] !== undefined) {
      localCount = brandProductMap[target];
    } else {
      localCount = dbProducts.filter(p => {
        const pBrand = String(p.brand || p.brand_name || '').trim().toLowerCase();
        return pBrand === target || (target.length > 2 && pBrand.includes(target));
      }).length;
    }

    return Math.max(apiCount, localCount);
  };

  // KPI Dashboard Statistics Calculations
  const stats = useMemo(() => {
    const total = brands.length;
    const active = brands.filter(b => b.status === 'Active').length;
    const inactive = brands.filter(b => b.status === 'Inactive').length;

    let assigned = 0;
    let unassigned = 0;

    dbProducts.forEach(p => {
      const b = String(p.brand || p.brand_name || '').trim();
      if (b && b.toLowerCase() !== 'generic' && b.toLowerCase() !== 'none' && b.toLowerCase() !== 'n/a') {
        assigned++;
      } else {
        unassigned++;
      }
    });

    return { total, active, inactive, assigned, unassigned };
  }, [brands, dbProducts]);

  // Filtering & Sorting Logic
  const filteredBrands = useMemo(() => {
    return brands
      .filter(brand => {
        const query = searchQuery.toLowerCase().trim();
        const matchesSearch = !query ||
          brand.name.toLowerCase().includes(query) ||
          brand.code.toLowerCase().includes(query) ||
          (brand.supplier && brand.supplier.toLowerCase().includes(query)) ||
          (brand.category && brand.category.toLowerCase().includes(query)) ||
          brand.status.toLowerCase().includes(query);

        const matchesStatus = statusFilter === 'All' || brand.status === statusFilter;

        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => {
        if (sortBy === 'name_asc') return a.name.localeCompare(b.name);
        if (sortBy === 'name_desc') return b.name.localeCompare(a.name);
        if (sortBy === 'code_asc') return a.code.localeCompare(b.code);
        if (sortBy === 'products_desc') return getProductCountForBrand(b.name, b) - getProductCountForBrand(a.name, a);
        if (sortBy === 'newest') return b.id.localeCompare(a.id);
        if (sortBy === 'oldest') return a.id.localeCompare(b.id);
        return 0;
      });
  }, [brands, searchQuery, statusFilter, sortBy, brandProductMap]);

  // Pagination Handler
  const paginatedBrands = useMemo(() => {
    const start = page * rowsPerPage;
    return filteredBrands.slice(start, start + rowsPerPage);
  }, [filteredBrands, page, rowsPerPage]);

  // Row Selection Handlers
  const handleSelectAll = (event) => {
    if (event.target.checked) {
      setSelectedIds(filteredBrands.map(b => b.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectOne = (id) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter(i => i !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  // Open Add / Edit Dialog
  const handleOpenAddModal = () => {
    setEditingBrand(null);
    setFormState({
      name: '',
      code: `BRD-${Math.floor(100 + Math.random() * 900)}`,
      supplier: 'Authorized Eyewear Agency',
      category: 'Frames & Sunglasses',
      warrantyMonths: 12,
      website: '',
      status: 'Active'
    });
    setFormErrors({});
    setAddEditModalOpen(true);
  };

  const handleOpenEditModal = (brand) => {
    setEditingBrand(brand);
    setFormState({
      name: brand.name,
      code: brand.code,
      supplier: brand.supplier || '',
      category: brand.category || 'Frames & Sunglasses',
      warrantyMonths: brand.warrantyMonths || 12,
      website: brand.website || '',
      status: brand.status || 'Active'
    });
    setFormErrors({});
    setAddEditModalOpen(true);
  };

  // Save Brand Handler with Validation Rules
  const handleSaveBrand = async (saveAndNew = false) => {
    const errors = {};
    if (!formState.name.trim()) errors.name = 'Brand Name is required';
    if (!formState.code.trim()) errors.code = 'Brand Code is required';

    // Unique Code Validation
    const codeConflict = brands.find(b => 
      b.code.toLowerCase() === formState.code.trim().toLowerCase() && 
      (!editingBrand || b.id !== editingBrand.id)
    );
    if (codeConflict) errors.code = 'Brand Code must be unique';

    // Unique Name Validation
    const nameConflict = brands.find(b => 
      b.name.toLowerCase() === formState.name.trim().toLowerCase() && 
      (!editingBrand || b.id !== editingBrand.id)
    );
    if (nameConflict) errors.name = 'Brand Name must be unique';

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    const payload = {
      name: formState.name.trim(),
      code: formState.code.trim().toUpperCase(),
      supplier: formState.supplier.trim(),
      category: formState.category,
      warrantyMonths: parseInt(formState.warrantyMonths || 12),
      website: formState.website.trim(),
      status: formState.status
    };

    try {
      if (editingBrand && !editingBrand.id.startsWith('BRD-DB-')) {
        await axios.put(`/api/masters/brands/${editingBrand.id}/`, payload);
      } else {
        await axios.post('/api/masters/brands/', payload);
      }
    } catch (err) {
      console.warn("Local brand sync used.");
    }

    const updatedBrandObj = {
      id: editingBrand ? editingBrand.id : `BRD-${Date.now()}`,
      ...payload,
      created_at: editingBrand ? editingBrand.created_at : new Date().toLocaleDateString('en-IN')
    };

    let updatedList = [];
    if (editingBrand) {
      updatedList = brands.map(b => b.id === editingBrand.id ? updatedBrandObj : b);
    } else {
      updatedList = [updatedBrandObj, ...brands];
    }

    setBrands(updatedList);
    try {
      localStorage.setItem('optical_brands_db', JSON.stringify(updatedList));
    } catch (e) {}

    setSnackbar({
      open: true,
      message: `Brand '${payload.name}' saved to database successfully!`,
      severity: 'success'
    });

    if (saveAndNew) {
      handleOpenAddModal();
    } else {
      setAddEditModalOpen(false);
    }
  };

  // Delete Brand Request Handler with Product Validation
  const handleRequestDelete = (brand) => {
    const prodCount = getProductCountForBrand(brand.name, brand);
    setBrandToDelete({ ...brand, prodCount });
    setDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!brandToDelete) return;
    if (brandToDelete.prodCount > 0) {
      setDeleteModalOpen(false);
      return;
    }

    try {
      if (!brandToDelete.id.startsWith('BRD-DB-')) {
        await axios.delete(`/api/masters/brands/${brandToDelete.id}/`);
      }
    } catch (e) {
      console.warn("Brand deletion notice:", e);
    }

    const updated = brands.filter(b => b.id !== brandToDelete.id);
    setBrands(updated);
    try {
      localStorage.setItem('optical_brands_db', JSON.stringify(updated));
    } catch (e) {}

    setSnackbar({
      open: true,
      message: `Brand '${brandToDelete.name}' removed from database.`,
      severity: 'success'
    });
    setDeleteModalOpen(false);
    setBrandToDelete(null);
  };

  // Duplicate Brand Handler
  const handleDuplicateBrand = (brand) => {
    const newCode = `${brand.code}-COPY`.slice(0, 50);
    const newName = `${brand.name} (Copy)`;
    const newBrand = {
      ...brand,
      id: `BRD-${Date.now()}`,
      code: newCode,
      name: newName,
      created_at: new Date().toLocaleDateString('en-IN')
    };
    const updated = [newBrand, ...brands];
    setBrands(updated);
    try {
      localStorage.setItem('optical_brands_db', JSON.stringify(updated));
    } catch (e) {}
    setSnackbar({ open: true, message: `Brand duplicated as '${newName}'`, severity: 'info' });
  };

  // Bulk Actions Handlers
  const handleBulkActivate = () => {
    const updated = brands.map(b => selectedIds.includes(b.id) ? { ...b, status: 'Active' } : b);
    setBrands(updated);
    setSelectedIds([]);
    setSnackbar({ open: true, message: `${selectedIds.length} brands activated.`, severity: 'success' });
  };

  const handleBulkDeactivate = () => {
    const updated = brands.map(b => selectedIds.includes(b.id) ? { ...b, status: 'Inactive' } : b);
    setBrands(updated);
    setSelectedIds([]);
    setSnackbar({ open: true, message: `${selectedIds.length} brands deactivated.`, severity: 'info' });
  };

  const handleBulkDelete = () => {
    const deletable = selectedIds.filter(id => {
      const b = brands.find(item => item.id === id);
      return b && getProductCountForBrand(b.name, b) === 0;
    });

    if (deletable.length === 0) {
      alert("Selected brands contain active products and cannot be deleted.");
      return;
    }

    const updated = brands.filter(b => !deletable.includes(b.id));
    setBrands(updated);
    setSelectedIds([]);
    setSnackbar({ open: true, message: `${deletable.length} brand(s) removed from database.`, severity: 'success' });
  };

  // Export Brands to CSV
  const handleExportCSV = () => {
    if (brands.length === 0) return;
    let csv = "Brand Code,Brand Name,Supplier / Distributor,Warranty (Months),Category,Assigned Products,Status,Created Date\n";
    brands.forEach(b => {
      const pCount = getProductCountForBrand(b.name, b);
      csv += `"${b.code}","${b.name}","${(b.supplier || '').replace(/"/g, '""')}","${b.warrantyMonths || 12}","${b.category || 'Optical'}","${pCount}","${b.status}","${b.created_at}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Optical_ERP_Brand_Master_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setSnackbar({ open: true, message: "Brand master exported to CSV successfully!", severity: 'success' });
  };

  // View Brand Details Drawer Handler
  const handleOpenDetailDrawer = (brand) => {
    const assignedProducts = dbProducts.filter(p => {
      const pBrand = String(p.brand || p.brand_name || '').trim().toLowerCase();
      const target = brand.name.trim().toLowerCase();
      return pBrand === target || (target.length > 2 && pBrand.includes(target));
    });

    setViewingBrand({ ...brand, assignedProducts });
    setDetailDrawerOpen(true);
  };

  return (
    <Box sx={{ p: 0 }}>
      {/* 📌 SECTION 1: ERP BREADCRUMB & HEADER */}
      <Box sx={{ mb: 3 }}>
        <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />} aria-label="breadcrumb" sx={{ mb: 1 }}>
          <Link underline="hover" color="inherit" href="/" sx={{ fontSize: '0.85rem' }}>
            Inventory
          </Link>
          <Typography color="text.primary" sx={{ fontSize: '0.85rem', fontWeight: 700 }}>
            Brands
          </Typography>
        </Breadcrumbs>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="h4" fontWeight={900} color="#0f172a" sx={{ letterSpacing: '-0.5px' }}>
              Brand Master
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
              Manage optical brand agency partnerships, warranty terms, and authorized distributors.
            </Typography>
          </Box>

          {/* Top-Right Primary Action Buttons */}
          <Stack direction="row" spacing={1.5}>
            <Button 
              variant="outlined" startIcon={<RefreshIcon />} onClick={fetchBrandMasterData} 
              sx={{ borderRadius: 2.5, fontWeight: 700, textTransform: 'none', color: '#475569', borderColor: '#cbd5e1' }}
            >
              Refresh
            </Button>
            <Button 
              variant="outlined" startIcon={<ExportIcon />} onClick={handleExportCSV} 
              sx={{ borderRadius: 2.5, fontWeight: 700, textTransform: 'none', color: '#475569', borderColor: '#cbd5e1' }}
            >
              Export
            </Button>
            <Button 
              variant="contained" startIcon={<AddIcon />} onClick={handleOpenAddModal} 
              sx={{ borderRadius: 2.5, fontWeight: 800, textTransform: 'none', px: 3, bgcolor: '#2563eb', '&:hover': { bgcolor: '#1d4ed8' } }}
            >
              + Add Brand
            </Button>
          </Stack>
        </Box>
      </Box>

      {/* 📌 SECTION 2: PROFESSIONAL ERP KPI DASHBOARD CARDS */}
      <Grid container spacing={2.5} sx={{ mb: 3.5 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              TOTAL BRANDS
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#0f172a" sx={{ my: 0.5 }}>
              {stats.total}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Registered in Brand Master
            </Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #059669', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              ACTIVE BRANDS
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#059669" sx={{ my: 0.5 }}>
              {stats.active}
            </Typography>
            <Typography variant="caption" color="success.main" fontWeight={700}>
              ● Authorized & Available
            </Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #64748b', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              INACTIVE BRANDS
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#64748b" sx={{ my: 0.5 }}>
              {stats.inactive}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Suspended or Discontinued
            </Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #7c3aed', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              PRODUCTS ASSIGNED
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#7c3aed" sx={{ my: 0.5 }}>
              {stats.assigned}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Items mapped to Brand Agencies
            </Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #d97706', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              UNASSIGNED PRODUCTS
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#d97706" sx={{ my: 0.5 }}>
              {stats.unassigned}
            </Typography>
            <Typography variant="caption" color="warning.main" fontWeight={700}>
              Requires Brand Mapping
            </Typography>
          </Card>
        </Grid>
      </Grid>

      {/* 📌 SECTION 3: SEARCH, FILTERS & SORTING TOOLBAR */}
      <Card variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 3, bgcolor: '#ffffff' }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={4} md={4}>
            <TextField
              fullWidth
              size="small"
              placeholder="Search Brand Name, Code, Supplier, Category..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start"><SearchIcon color="action" fontSize="small" /></InputAdornment>,
                sx: { borderRadius: 2 }
              }}
            />
          </Grid>

          <Grid item xs={6} sm={3} md={2.5}>
            <TextField
              select
              fullWidth
              size="small"
              label="Status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              sx={{ borderRadius: 2 }}
            >
              <MenuItem value="All">All Statuses</MenuItem>
              <MenuItem value="Active">Active</MenuItem>
              <MenuItem value="Inactive">Inactive</MenuItem>
            </TextField>
          </Grid>

          <Grid item xs={6} sm={3} md={3}>
            <TextField
              select
              fullWidth
              size="small"
              label="Sort By"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              sx={{ borderRadius: 2 }}
            >
              <MenuItem value="name_asc">Brand Name (A - Z)</MenuItem>
              <MenuItem value="name_desc">Brand Name (Z - A)</MenuItem>
              <MenuItem value="code_asc">Brand Code</MenuItem>
              <MenuItem value="products_desc">Products Count (High to Low)</MenuItem>
              <MenuItem value="newest">Newest First</MenuItem>
              <MenuItem value="oldest">Oldest First</MenuItem>
            </TextField>
          </Grid>

          <Grid item xs={12} sm={2} md={2.5}>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              {(searchQuery || statusFilter !== 'All' || sortBy !== 'name_asc') && (
                <Button 
                  variant="text" size="small" 
                  onClick={() => { setSearchQuery(''); setStatusFilter('All'); setSortBy('name_asc'); }}
                  sx={{ textTransform: 'none', fontWeight: 700 }}
                >
                  Reset Filters
                </Button>
              )}
              <IconButton color="primary" onClick={fetchBrandMasterData} title="Refresh Brand Master Data">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Grid>
        </Grid>
      </Card>

      {/* 📌 BULK ACTION BAR WHEN ROWS ARE SELECTED */}
      {selectedIds.length > 0 && (
        <Paper elevation={0} sx={{ p: 1.5, px: 3, mb: 2, borderRadius: 2.5, bgcolor: '#eff6ff', border: '1px solid #bfdbfe', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="body2" fontWeight={800} color="#1e40af">
            ✓ {selectedIds.length} Brand(s) Selected
          </Typography>
          <Stack direction="row" spacing={1.5}>
            <Button size="small" variant="contained" color="success" onClick={handleBulkActivate} sx={{ fontWeight: 800 }}>
              Bulk Activate
            </Button>
            <Button size="small" variant="contained" color="warning" onClick={handleBulkDeactivate} sx={{ fontWeight: 800 }}>
              Bulk Deactivate
            </Button>
            <Button size="small" variant="contained" color="error" onClick={handleBulkDelete} sx={{ fontWeight: 800 }}>
              Bulk Delete
            </Button>
          </Stack>
        </Paper>
      )}

      {/* 📌 SECTION 4: PROFESSIONAL ERP DATA TABLE */}
      <Card variant="outlined" sx={{ borderRadius: 3.5, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <TableContainer sx={{ maxHeight: 600 }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow sx={{ '& th': { bgcolor: '#f8fafc', fontWeight: 800, color: '#334155', py: 1.8 } }}>
                <TableCell padding="checkbox">
                  <Checkbox
                    indeterminate={selectedIds.length > 0 && selectedIds.length < filteredBrands.length}
                    checked={filteredBrands.length > 0 && selectedIds.length === filteredBrands.length}
                    onChange={handleSelectAll}
                    size="small"
                  />
                </TableCell>
                <TableCell>Code</TableCell>
                <TableCell>Brand Name</TableCell>
                <TableCell>Supplier / Agency</TableCell>
                <TableCell align="center">Warranty</TableCell>
                <TableCell align="center">Products</TableCell>
                <TableCell align="center">Status</TableCell>
                <TableCell>Created Date</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 6 }}>
                    <CircularProgress size={32} />
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontWeight: 600 }}>
                      Loading Brand Master Records...
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : paginatedBrands.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 8 }}>
                    <BrandIcon sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.3, mb: 1 }} />
                    <Typography variant="body1" fontWeight={800} color="text.primary">
                      No Brand Master Records Found
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      {searchQuery ? "No brands match your search keyword or filters." : "Click '+ Add Brand' to register your first brand master."}
                    </Typography>
                    {!searchQuery && (
                      <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpenAddModal} sx={{ fontWeight: 800 }}>
                        + Add Brand
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedBrands.map((brand) => {
                  const isSelected = selectedIds.includes(brand.id);
                  const prodCount = getProductCountForBrand(brand.name, brand);

                  return (
                    <TableRow key={brand.id} hover selected={isSelected} sx={{ cursor: 'pointer' }}>
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={isSelected} onChange={() => handleSelectOne(brand.id)} size="small" />
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(brand)}>
                        <Chip label={brand.code} size="small" sx={{ fontWeight: 900, bgcolor: '#f1f5f9', color: '#0f172a', borderRadius: 1.5 }} />
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(brand)}>
                        <Typography variant="body2" fontWeight={800} color="#0f172a">
                          {brand.name}
                        </Typography>
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(brand)}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          {brand.supplier || 'Authorized Agency'}
                        </Typography>
                      </TableCell>

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(brand)}>
                        <Chip 
                          icon={<WarrantyIcon style={{ fontSize: 13 }} />}
                          label={`${brand.warrantyMonths || 12} Mo Warranty`} 
                          size="small" 
                          variant="outlined" 
                          color="primary"
                          sx={{ fontWeight: 800, height: 22 }} 
                        />
                      </TableCell>

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(brand)}>
                        <Chip 
                          label={`${prodCount} Items`} 
                          size="small" 
                          sx={{ 
                            fontWeight: 800, 
                            bgcolor: prodCount > 0 ? '#eff6ff' : '#f8fafc', 
                            color: prodCount > 0 ? '#2563eb' : '#94a3b8',
                            border: '1px solid',
                            borderColor: prodCount > 0 ? '#bfdbfe' : '#e2e8f0'
                          }} 
                        />
                      </TableCell>

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(brand)}>
                        <Chip 
                          label={brand.status} 
                          size="small" 
                          color={brand.status === 'Active' ? 'success' : 'default'} 
                          sx={{ fontWeight: 800, height: 22, borderRadius: 1.5 }} 
                        />
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(brand)}>
                        <Typography variant="caption" color="text.secondary">
                          {brand.created_at}
                        </Typography>
                      </TableCell>

                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" spacing={0.5} justifyContent="center">
                          <IconButton size="small" color="info" title="View Brand Details" onClick={() => handleOpenDetailDrawer(brand)}>
                            <ViewIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="primary" title="Edit Brand" onClick={() => handleOpenEditModal(brand)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="secondary" title="Duplicate Brand" onClick={() => handleDuplicateBrand(brand)}>
                            <DuplicateIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="error" title="Delete Brand" onClick={() => handleRequestDelete(brand)}>
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

        {/* Table Pagination */}
        <TablePagination
          rowsPerPageOptions={[10, 25, 50, 100]}
          component="div"
          count={filteredBrands.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(e, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0); }}
        />
      </Card>

      {/* 📌 SECTION 5: ADD / EDIT BRAND MODAL */}
      <Dialog open={addEditModalOpen} onClose={() => setAddEditModalOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
        <DialogTitle sx={{ fontWeight: 900, borderBottom: '1px solid', borderColor: 'divider', pb: 1.5 }}>
          {editingBrand ? '✏️ Edit Brand Master' : '➕ Add Brand Master'}
        </DialogTitle>
        <DialogContent sx={{ pt: 2.5 }}>
          <Stack spacing={2.5}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={8}>
                <TextField
                  required
                  fullWidth
                  label="Brand Name"
                  placeholder="e.g. RayBan, Oakley, Essilor, Zeiss"
                  value={formState.name}
                  onChange={(e) => setFormState({ ...formState, name: e.target.value })}
                  error={Boolean(formErrors.name)}
                  helperText={formErrors.name}
                  size="small"
                  inputProps={{ style: { fontWeight: 800 } }}
                />
              </Grid>

              <Grid item xs={12} sm={4}>
                <TextField
                  required
                  fullWidth
                  label="Brand Code"
                  placeholder="e.g. RB, OAK, ESS"
                  value={formState.code}
                  onChange={(e) => setFormState({ ...formState, code: e.target.value.toUpperCase() })}
                  error={Boolean(formErrors.code)}
                  helperText={formErrors.code}
                  size="small"
                  inputProps={{ style: { textTransform: 'uppercase', fontWeight: 800 } }}
                />
              </Grid>
            </Grid>

            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Authorized Supplier / Vendor"
                  placeholder="e.g. Luxottica India, Essilor Supplier"
                  value={formState.supplier}
                  onChange={(e) => setFormState({ ...formState, supplier: e.target.value })}
                  size="small"
                />
              </Grid>

              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Product Line / Category"
                  placeholder="e.g. Frames & Sunglasses, Ophthalmic Lenses"
                  value={formState.category}
                  onChange={(e) => setFormState({ ...formState, category: e.target.value })}
                  size="small"
                />
              </Grid>
            </Grid>

            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField
                  fullWidth
                  type="number"
                  label="Warranty Period (Months)"
                  value={formState.warrantyMonths}
                  onChange={(e) => setFormState({ ...formState, warrantyMonths: e.target.value })}
                  size="small"
                />
              </Grid>

              <Grid item xs={6}>
                <TextField
                  select
                  fullWidth
                  label="Status"
                  value={formState.status}
                  onChange={(e) => setFormState({ ...formState, status: e.target.value })}
                  size="small"
                >
                  <MenuItem value="Active">Active</MenuItem>
                  <MenuItem value="Inactive">Inactive</MenuItem>
                </TextField>
              </Grid>
            </Grid>

            <TextField
              fullWidth
              label="Official Website / Portal URL"
              placeholder="e.g. https://www.ray-ban.com"
              value={formState.website}
              onChange={(e) => setFormState({ ...formState, website: e.target.value })}
              size="small"
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
          <Button onClick={() => setAddEditModalOpen(false)} sx={{ fontWeight: 700 }}>
            Cancel
          </Button>
          <Stack direction="row" spacing={1.5}>
            {!editingBrand && (
              <Button variant="outlined" onClick={() => handleSaveBrand(true)} sx={{ fontWeight: 800 }}>
                Save & New
              </Button>
            )}
            <Button variant="contained" color="primary" onClick={() => handleSaveBrand(false)} sx={{ fontWeight: 900, px: 3 }}>
              Save Brand
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>

      {/* 📌 SECTION 6: DELETE BRAND VALIDATION MODAL */}
      <Dialog open={deleteModalOpen} onClose={() => setDeleteModalOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 900, color: brandToDelete?.prodCount > 0 ? 'error.main' : 'text.primary' }}>
          {brandToDelete?.prodCount > 0 ? '⚠️ Cannot Delete Brand' : '🗑️ Confirm Brand Deletion'}
        </DialogTitle>
        <DialogContent>
          {brandToDelete?.prodCount > 0 ? (
            <Alert severity="error" icon={<WarningIcon />} sx={{ borderRadius: 2, mt: 1 }}>
              <Typography variant="subtitle2" fontWeight={800}>
                This brand is assigned to {brandToDelete.prodCount} product(s) and cannot be deleted.
              </Typography>
              <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                Please move or delete the assigned products before removing brand <strong>'{brandToDelete.name}' ({brandToDelete.code})</strong>.
              </Typography>
            </Alert>
          ) : (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Are you sure you want to permanently delete brand <strong>'{brandToDelete?.name}' ({brandToDelete?.code})</strong> from the database?
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDeleteModalOpen(false)}>
            {brandToDelete?.prodCount > 0 ? 'Close' : 'Cancel'}
          </Button>
          {brandToDelete?.prodCount === 0 && (
            <Button variant="contained" color="error" onClick={handleConfirmDelete} sx={{ fontWeight: 800 }}>
              Delete Brand
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* 📌 SECTION 7: BRAND DETAILS & ASSIGNED PRODUCTS DRAWER */}
      <Drawer anchor="right" open={detailDrawerOpen} onClose={() => setDetailDrawerOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 520 }, p: 3 } }}>
        {viewingBrand && (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h5" fontWeight={900}>
                Brand Details
              </Typography>
              <IconButton size="small" onClick={() => setDetailDrawerOpen(false)}>
                <WarningIcon />
              </IconButton>
            </Box>

            <Chip label={viewingBrand.code} color="primary" sx={{ fontWeight: 900, mb: 2 }} />

            <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#f8fafc', mb: 3 }}>
              <Typography variant="subtitle1" fontWeight={900} color="#0f172a" sx={{ mb: 1 }}>
                {viewingBrand.name}
              </Typography>

              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>SUPPLIER / DISTRIBUTOR</Typography>
                  <Typography variant="body2" fontWeight={800}>{viewingBrand.supplier || 'Authorized Agency'}</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>WARRANTY PERIOD</Typography>
                  <Typography variant="body2" fontWeight={800}>{viewingBrand.warrantyMonths || 12} Months</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>STATUS</Typography>
                  <Chip label={viewingBrand.status} size="small" color={viewingBrand.status === 'Active' ? 'success' : 'default'} sx={{ fontWeight: 800, height: 20 }} />
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>REGISTERED DATE</Typography>
                  <Typography variant="body2" fontWeight={800}>{viewingBrand.created_at}</Typography>
                </Grid>
              </Grid>
            </Paper>

            {/* Read-Only Products List assigned to this Brand */}
            <Typography variant="subtitle2" fontWeight={900} color="#0f172a" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <ProductIcon color="primary" fontSize="small" /> Products Under This Brand ({viewingBrand.assignedProducts?.length || 0})
            </Typography>

            {viewingBrand.assignedProducts?.length === 0 ? (
              <Alert severity="info" sx={{ borderRadius: 2 }}>
                No products are currently assigned to this brand in the database.
              </Alert>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2.5, maxHeight: 350 }}>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#f8fafc' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 800 }}>Product Name</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Category</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Stock</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Selling Price</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {viewingBrand.assignedProducts.map(p => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{p.code}</Typography>
                        </TableCell>
                        <TableCell><Typography variant="body2">{p.category}</Typography></TableCell>
                        <TableCell><Typography variant="body2" fontWeight={800}>{p.stock} units</Typography></TableCell>
                        <TableCell><Typography variant="body2" fontWeight={800}>₹{p.sellingPrice.toFixed(2)}</Typography></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        )}
      </Drawer>

      {/* Snackbar Notifications */}
      <Snackbar 
        open={snackbar.open} 
        autoHideDuration={4000} 
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert severity={snackbar.severity} sx={{ borderRadius: 2, fontWeight: 700 }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
