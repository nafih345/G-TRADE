import React, { useState, useEffect, useMemo } from 'react';
import { 
  Box, Grid, Card, Typography, Button, 
  Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, Stack, IconButton, Avatar,
  InputAdornment, Divider, Tooltip, Paper, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TablePagination,
  Checkbox, Drawer, Alert, Menu, ListItemIcon, ListItemText,
  Breadcrumbs, Link, CircularProgress, Snackbar
} from '@mui/material';
import {
  Add as AddIcon,
  Category as CategoryIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Search as SearchIcon,
  Refresh as RefreshIcon,
  FileDownload as ExportIcon,
  FileUpload as ImportIcon,
  Visibility as ViewIcon,
  ContentCopy as DuplicateIcon,
  FilterList as FilterIcon,
  CheckCircle as ActiveIcon,
  Cancel as InactiveIcon,
  Warning as WarningIcon,
  MoreVert as MoreVertIcon,
  Inventory2 as ProductIcon,
  NavigateNext as NavigateNextIcon
} from '@mui/icons-material';
import axios from 'axios';

const OPTICAL_CATEGORY_MASTER_DEFAULTS = {
  'frames': {
    code: 'FRA',
    name: 'Spectacle Frames',
    description: 'Spectacle frames (Full Rim, Supra / Semi-Rimless, Rimless, Titanium & Acetate)',
    gst_percentage: '18%',
    hsn_code: '90031100'
  },
  'frame': {
    code: 'FRA',
    name: 'Spectacle Frames',
    description: 'Spectacle frames (Full Rim, Supra / Semi-Rimless, Rimless, Titanium & Acetate)',
    gst_percentage: '18%',
    hsn_code: '90031100'
  },
  'sunglasses': {
    code: 'SUN',
    name: 'Sunglasses',
    description: 'Sunglasses & UV Protection Eyewear (Polarized, Aviator, Wayfarer, Sports)',
    gst_percentage: '18%',
    hsn_code: '90041000'
  },
  'sunglass': {
    code: 'SUN',
    name: 'Sunglasses',
    description: 'Sunglasses & UV Protection Eyewear (Polarized, Aviator, Wayfarer, Sports)',
    gst_percentage: '18%',
    hsn_code: '90041000'
  },
  'prescription lenses': {
    code: 'LNS',
    name: 'Prescription Lenses',
    description: 'Ophthalmic Prescription Lenses (Single Vision, Bifocal, Progressive Digital, Blue Cut)',
    gst_percentage: '12%',
    hsn_code: '90014010'
  },
  'lenses': {
    code: 'LNS',
    name: 'Prescription Lenses',
    description: 'Ophthalmic Prescription Lenses (Single Vision, Bifocal, Progressive Digital, Blue Cut)',
    gst_percentage: '12%',
    hsn_code: '90014010'
  },
  'contact lenses': {
    code: 'CLN',
    name: 'Contact Lenses',
    description: 'Contact Lenses & Lens Care (Daily Disposable, Monthly, Toric, Color Cosmetic)',
    gst_percentage: '12%',
    hsn_code: '90013000'
  },
  'reading glasses': {
    code: 'RDG',
    name: 'Reading Glasses',
    description: 'Ready Readers (+1.00 to +3.50), Folding Readers & Anti-Blue Light Reading Glasses',
    gst_percentage: '18%',
    hsn_code: '90049090'
  },
  'accessories': {
    code: 'ACC',
    name: 'Accessories',
    description: 'Spectacle Chains & Cords, Microfiber Cloths, Nose Pads, Screws & Optical Tools',
    gst_percentage: '18%',
    hsn_code: '90039000'
  },
  'lens solutions': {
    code: 'SOL',
    name: 'Lens Solutions',
    description: 'Multi-Purpose Contact Lens Solutions, Saline Rinsing Liquids & Disinfecting Cleaners',
    gst_percentage: '18%',
    hsn_code: '33079090'
  },
  'cleaning kits': {
    code: 'CLK',
    name: 'Cleaning Kits',
    description: 'Lens Cleaning Sprays, Anti-Fog Microfiber Wipes & Lens Care Maintenance Fluid',
    gst_percentage: '18%',
    hsn_code: '34022090'
  },
  'cases': {
    code: 'CAS',
    name: 'Cases & Pouches',
    description: 'Hard Shell Eyeglass Cases, Soft Leather Pouches & Contact Lens Storage Boxes',
    gst_percentage: '18%',
    hsn_code: '42029200'
  },
  'eye drops': {
    code: 'EYD',
    name: 'Eye Drops',
    description: 'Lubricating Artificial Tears, Anti-Allergy Eye Drops & Contact Lens Relief Drops',
    gst_percentage: '12%',
    hsn_code: '30049099'
  }
};

const productMatchesCategory = (product, catName) => {
  const pCat = String(product.category || product.category_name || '').trim().toLowerCase();
  const target = String(catName || '').trim().toLowerCase();
  if (!pCat || !target) return false;
  if (pCat === target) return true;
  if (target.includes('frame') && (pCat.includes('frame') || pCat.includes('spectacle'))) return true;
  if (target.includes('lens') && (pCat.includes('lens') || pCat.includes('lenses') || pCat.includes('ophthalmic'))) return true;
  if (target.includes('sunglass') && pCat.includes('sunglass')) return true;
  if (target.includes('contact') && pCat.includes('contact')) return true;
  if (target.includes('reading') && (pCat.includes('reading') || pCat.includes('reader'))) return true;
  if (target.includes('accessori') && pCat.includes('accessori')) return true;
  if (target.includes('solution') && pCat.includes('solution')) return true;
  if (target.includes('clean') && (pCat.includes('clean') || pCat.includes('kit'))) return true;
  if (target.includes('case') && pCat.includes('case')) return true;
  if (target.includes('drop') && pCat.includes('drop')) return true;
  return false;
};

const getValidCategoryDefaults = (categoryName) => {
  const nameLower = String(categoryName || '').trim().toLowerCase();
  if (OPTICAL_CATEGORY_MASTER_DEFAULTS[nameLower]) {
    return OPTICAL_CATEGORY_MASTER_DEFAULTS[nameLower];
  }
  for (const [key, val] of Object.entries(OPTICAL_CATEGORY_MASTER_DEFAULTS)) {
    if (nameLower.includes(key) || key.includes(nameLower)) {
      return val;
    }
  }
  return {
    code: categoryName.slice(0, 3).toUpperCase(),
    name: categoryName,
    description: `Optical ${categoryName} category master management record`,
    gst_percentage: '18%',
    hsn_code: '90031100'
  };
};

export default function CategoryManagementView({ products = [] }) {
  const [categories, setCategories] = useState([]);
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
  const [editingCategory, setEditingCategory] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [moveToCategoryId, setMoveToCategoryId] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [viewingCategory, setViewingCategory] = useState(null);
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Form State
  const [formState, setFormState] = useState({
    name: '',
    code: '',
    description: '',
    gst_percentage: '18%',
    hsn_code: '90031100',
    status: 'Active',
    display_order: 1
  });
  const [formErrors, setFormErrors] = useState({});

  // Action Menu Anchor
  const [menuAnchorEl, setMenuAnchorEl] = useState(null);
  const [menuTargetCat, setMenuTargetCat] = useState(null);

  // 1. Fetch Categories & Products from Backend API / Database
  const fetchCategoryMasterData = async () => {
    setLoading(true);
    let fetchedCategories = [];
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
          brand: p.brand || p.brand_name || 'Generic',
          category: p.category || p.category_name || '',
          category_name: p.category_name || p.category || '',
          cost_price: parseFloat(p.cost_price || p.purchasePrice || 0),
          selling_price: parseFloat(p.price || p.selling_price || p.retail_price || 0),
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
          brand: p.brand || p.brand_name || 'Generic',
          category: p.category || p.category_name || '',
          category_name: p.category_name || p.category || '',
          cost_price: parseFloat(p.purchasePrice || p.cost_price || 0),
          selling_price: parseFloat(p.sellingPrice || p.price || p.retail_price || 0),
          stock: parseInt(p.stock || 0),
          status: 'Active'
        }));
      } catch (err) {}
    }
    setDbProducts(fetchedProducts);

    // Fetch Master Categories
    try {
      const cRes = await axios.get('/api/masters/categories/');
      const rawCats = cRes.data?.results || cRes.data || [];
      if (Array.isArray(rawCats)) {
        fetchedCategories = rawCats.map(c => {
          const defaults = getValidCategoryDefaults(c.name);
          return {
            id: String(c.id),
            name: c.name,
            code: c.code || defaults.code,
            description: (c.description && c.description !== 'Database Registered Category') ? c.description : defaults.description,
            gst_percentage: (c.gst_percentage && c.gst_percentage !== '18%') ? c.gst_percentage : defaults.gst_percentage,
            hsn_code: (c.hsn_code && c.hsn_code !== '90031100') ? c.hsn_code : defaults.hsn_code,
            status: c.status || 'Active',
            display_order: parseInt(c.display_order || 1),
            created_at: c.created_at ? new Date(c.created_at).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN'),
            updated_at: c.updated_at ? new Date(c.updated_at).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN')
          };
        });
      }
    } catch (e) {
      console.warn("Category API notice:", e);
    }

    // Merge with any distinct category names present on actual Database Products
    const prodCatNames = Array.from(new Set(fetchedProducts.map(p => (p.category || p.category_name || '').trim()).filter(Boolean)));
    const catMap = new Map();
    fetchedCategories.forEach(c => catMap.set(c.name.toLowerCase(), c));

    prodCatNames.forEach(cName => {
      if (!catMap.has(cName.toLowerCase())) {
        const defaults = getValidCategoryDefaults(cName);
        catMap.set(cName.toLowerCase(), {
          id: `CAT-DB-${cName.replace(/\s+/g, '-').toUpperCase()}`,
          name: defaults.name || cName,
          code: defaults.code,
          description: defaults.description,
          gst_percentage: defaults.gst_percentage,
          hsn_code: defaults.hsn_code,
          status: 'Active',
          display_order: catMap.size + 1,
          created_at: new Date().toLocaleDateString('en-IN'),
          updated_at: new Date().toLocaleDateString('en-IN')
        });
      }
    });

    const finalCategoriesList = Array.from(catMap.values());
    setCategories(finalCategoriesList);
    try {
      localStorage.setItem('optical_categories_db', JSON.stringify(finalCategoriesList));
    } catch (e) {}
    setLoading(false);
  };

  useEffect(() => {
    fetchCategoryMasterData();
    window.addEventListener('optical_stock_updated', fetchCategoryMasterData);
    return () => window.removeEventListener('optical_stock_updated', fetchCategoryMasterData);
  }, [products]);

  // Calculate Product Count per Category dynamically from Database Products
  const categoryProductMap = useMemo(() => {
    const map = {};
    dbProducts.forEach(p => {
      const catName = String(p.category || p.category_name || '').trim();
      if (!catName) return;
      const lower = catName.toLowerCase();
      map[lower] = (map[lower] || 0) + 1;
    });
    return map;
  }, [dbProducts]);

  const getProductCountForCat = (catName, catObj = null) => {
    const apiCount = catObj?.products_count || 0;
    const target = String(catName || '').trim().toLowerCase();

    let localCount = 0;
    if (categoryProductMap[target] !== undefined) {
      localCount = categoryProductMap[target];
    } else {
      localCount = dbProducts.filter(p => productMatchesCategory(p, catName)).length;
    }

    return Math.max(apiCount, localCount);
  };

  // KPI Dashboard Statistics Calculations
  const stats = useMemo(() => {
    const total = categories.length;
    const active = categories.filter(c => c.status === 'Active').length;
    const inactive = categories.filter(c => c.status === 'Inactive').length;

    let assigned = 0;
    let unassigned = 0;

    dbProducts.forEach(p => {
      const c = String(p.category || p.category_name || '').trim();
      if (c && c.toLowerCase() !== 'uncategorized' && c.toLowerCase() !== 'n/a') {
        assigned++;
      } else {
        unassigned++;
      }
    });

    return { total, active, inactive, assigned, unassigned };
  }, [categories, dbProducts]);

  // Filtering & Sorting Logic
  const filteredCategories = useMemo(() => {
    return categories
      .filter(cat => {
        const query = searchQuery.toLowerCase().trim();
        const matchesSearch = !query ||
          cat.name.toLowerCase().includes(query) ||
          cat.code.toLowerCase().includes(query) ||
          (cat.description && cat.description.toLowerCase().includes(query)) ||
          cat.gst_percentage.toLowerCase().includes(query) ||
          cat.hsn_code.toLowerCase().includes(query) ||
          cat.status.toLowerCase().includes(query);

        const matchesStatus = statusFilter === 'All' || cat.status === statusFilter;

        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => {
        if (sortBy === 'name_asc') return a.name.localeCompare(b.name);
        if (sortBy === 'name_desc') return b.name.localeCompare(a.name);
        if (sortBy === 'code_asc') return a.code.localeCompare(b.code);
        if (sortBy === 'products_desc') return getProductCountForCat(b.name) - getProductCountForCat(a.name);
        if (sortBy === 'newest') return b.id.localeCompare(a.id);
        if (sortBy === 'oldest') return a.id.localeCompare(b.id);
        return 0;
      });
  }, [categories, searchQuery, statusFilter, sortBy, categoryProductMap]);

  // Pagination Handler
  const paginatedCategories = useMemo(() => {
    const start = page * rowsPerPage;
    return filteredCategories.slice(start, start + rowsPerPage);
  }, [filteredCategories, page, rowsPerPage]);

  // Row Selection Handlers
  const handleSelectAll = (event) => {
    if (event.target.checked) {
      setSelectedIds(filteredCategories.map(c => c.id));
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
    setEditingCategory(null);
    setFormState({
      name: '',
      code: `CAT-${Math.floor(100 + Math.random() * 900)}`,
      description: '',
      gst_percentage: '18%',
      hsn_code: '90031100',
      status: 'Active',
      display_order: categories.length + 1
    });
    setFormErrors({});
    setAddEditModalOpen(true);
  };

  const handleOpenEditModal = (cat) => {
    setEditingCategory(cat);
    setFormState({
      name: cat.name,
      code: cat.code,
      description: cat.description || '',
      gst_percentage: cat.gst_percentage || '18%',
      hsn_code: cat.hsn_code || '90031100',
      status: cat.status || 'Active',
      display_order: cat.display_order || 1
    });
    setFormErrors({});
    setAddEditModalOpen(true);
  };

  // Save Category Handler with Validation Rules
  const handleSaveCategory = async (saveAndNew = false) => {
    const errors = {};
    if (!formState.name.trim()) errors.name = 'Category Name is required';
    if (!formState.code.trim()) errors.code = 'Category Code is required';
    if (!formState.hsn_code.trim()) errors.hsn_code = 'HSN Code is required';

    // Unique Code Validation
    const codeConflict = categories.find(c => 
      c.code.toLowerCase() === formState.code.trim().toLowerCase() && 
      (!editingCategory || c.id !== editingCategory.id)
    );
    if (codeConflict) errors.code = 'Category Code must be unique';

    // Unique Name Validation
    const nameConflict = categories.find(c => 
      c.name.toLowerCase() === formState.name.trim().toLowerCase() && 
      (!editingCategory || c.id !== editingCategory.id)
    );
    if (nameConflict) errors.name = 'Category Name must be unique';

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    const payload = {
      name: formState.name.trim(),
      code: formState.code.trim().toUpperCase(),
      description: formState.description.trim(),
      gst_percentage: formState.gst_percentage,
      hsn_code: formState.hsn_code.trim(),
      status: formState.status,
      display_order: parseInt(formState.display_order || 1)
    };

    try {
      if (editingCategory && !editingCategory.id.startsWith('CAT-DB-')) {
        await axios.put(`/api/masters/categories/${editingCategory.id}/`, payload);
      } else {
        await axios.post('/api/masters/categories/', payload);
      }
    } catch (err) {
      console.warn("Local category sync used.");
    }

    const updatedCatObj = {
      id: editingCategory ? editingCategory.id : `CAT-${Date.now()}`,
      ...payload,
      created_at: editingCategory ? editingCategory.created_at : new Date().toLocaleDateString('en-IN'),
      updated_at: new Date().toLocaleDateString('en-IN')
    };

    let updatedList = [];
    if (editingCategory) {
      updatedList = categories.map(c => c.id === editingCategory.id ? updatedCatObj : c);
    } else {
      updatedList = [updatedCatObj, ...categories];
    }

    setCategories(updatedList);
    try {
      localStorage.setItem('optical_categories_db', JSON.stringify(updatedList));
    } catch (e) {}

    setSnackbar({
      open: true,
      message: `Category '${payload.name}' saved to database successfully!`,
      severity: 'success'
    });

    if (saveAndNew) {
      handleOpenAddModal();
    } else {
      setAddEditModalOpen(false);
    }
  };

  // Delete Category Request Handler with Product Validation
  const handleRequestDelete = (cat) => {
    const prodCount = getProductCountForCat(cat.name);
    setCategoryToDelete({ ...cat, prodCount });
    setMoveToCategoryId('');
    setDeleteModalOpen(true);
  };

  // Reassigns every product in categoryToDelete to the chosen target category, then deletes it.
  const handleReassignAndDelete = async () => {
    if (!categoryToDelete || !moveToCategoryId) return;
    const targetCat = categories.find(c => c.id === moveToCategoryId);
    if (!targetCat) return;

    const assigned = dbProducts.filter(p => productMatchesCategory(p, categoryToDelete.name));
    setReassigning(true);

    for (const p of assigned) {
      try {
        await axios.patch(`/api/products/items/${p.id}/`, {
          category_name: targetCat.name,
          category: targetCat.name
        });
      } catch (e) {
        console.warn(`Category reassignment API sync failed for product ${p.id}, updated locally only:`, e);
      }
    }

    try {
      const assignedIds = new Set(assigned.map(p => String(p.id)));
      const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      const localUpdated = local.map(p => assignedIds.has(String(p.id)) ? { ...p, category: targetCat.name } : p);
      localStorage.setItem('optical_inventory_items', JSON.stringify(localUpdated));
    } catch (e) {}

    try {
      if (!categoryToDelete.id.startsWith('CAT-DB-')) {
        await axios.delete(`/api/masters/categories/${categoryToDelete.id}/`);
      }
    } catch (e) {}

    const updatedCategories = categories.filter(c => c.id !== categoryToDelete.id);
    setCategories(updatedCategories);
    try {
      localStorage.setItem('optical_categories_db', JSON.stringify(updatedCategories));
    } catch (e) {}

    setDbProducts(prev => prev.map(p =>
      assigned.some(a => a.id === p.id) ? { ...p, category: targetCat.name, category_name: targetCat.name } : p
    ));
    window.dispatchEvent(new Event('optical_stock_updated'));

    setSnackbar({
      open: true,
      message: `Moved ${assigned.length} product(s) to '${targetCat.name}' and deleted category '${categoryToDelete.name}'.`,
      severity: 'success'
    });

    setReassigning(false);
    setDeleteModalOpen(false);
    setCategoryToDelete(null);
    setMoveToCategoryId('');
  };

  const handleConfirmDelete = async () => {
    if (!categoryToDelete) return;
    if (categoryToDelete.prodCount > 0) {
      setDeleteModalOpen(false);
      return;
    }

    try {
      if (!categoryToDelete.id.startsWith('CAT-DB-')) {
        await axios.delete(`/api/masters/categories/${categoryToDelete.id}/`);
      }
    } catch (e) {}

    const updated = categories.filter(c => c.id !== categoryToDelete.id);
    setCategories(updated);
    try {
      localStorage.setItem('optical_categories_db', JSON.stringify(updated));
    } catch (e) {}

    setSnackbar({
      open: true,
      message: `Category '${categoryToDelete.name}' removed from database.`,
      severity: 'success'
    });
    setDeleteModalOpen(false);
    setCategoryToDelete(null);
  };

  // Duplicate Category Handler
  const handleDuplicateCategory = (cat) => {
    const newCode = `${cat.code}-COPY`.slice(0, 50);
    const newName = `${cat.name} (Copy)`;
    const newCat = {
      ...cat,
      id: `CAT-${Date.now()}`,
      code: newCode,
      name: newName,
      created_at: new Date().toLocaleDateString('en-IN'),
      updated_at: new Date().toLocaleDateString('en-IN')
    };
    const updated = [newCat, ...categories];
    setCategories(updated);
    try {
      localStorage.setItem('optical_categories_db', JSON.stringify(updated));
    } catch (e) {}
    setSnackbar({ open: true, message: `Category duplicated as '${newName}'`, severity: 'info' });
  };

  // Toggle Category Status (Active / Inactive)
  const handleToggleStatus = (cat) => {
    const nextStatus = cat.status === 'Active' ? 'Inactive' : 'Active';
    const updated = categories.map(c => c.id === cat.id ? { ...c, status: nextStatus } : c);
    setCategories(updated);
    try {
      localStorage.setItem('optical_categories_db', JSON.stringify(updated));
    } catch (e) {}
    setSnackbar({ open: true, message: `Category '${cat.name}' set to ${nextStatus}`, severity: 'info' });
  };

  // Bulk Actions Handlers
  const handleBulkActivate = () => {
    const updated = categories.map(c => selectedIds.includes(c.id) ? { ...c, status: 'Active' } : c);
    setCategories(updated);
    setSelectedIds([]);
    setSnackbar({ open: true, message: `${selectedIds.length} categories activated.`, severity: 'success' });
  };

  const handleBulkDeactivate = () => {
    const updated = categories.map(c => selectedIds.includes(c.id) ? { ...c, status: 'Inactive' } : c);
    setCategories(updated);
    setSelectedIds([]);
    setSnackbar({ open: true, message: `${selectedIds.length} categories deactivated.`, severity: 'info' });
  };

  const handleBulkDelete = () => {
    // Only delete categories with 0 assigned products
    const deletable = selectedIds.filter(id => {
      const cat = categories.find(c => c.id === id);
      return cat && getProductCountForCat(cat.name) === 0;
    });

    if (deletable.length === 0) {
      alert("Selected categories contain active products and cannot be deleted.");
      return;
    }

    const updated = categories.filter(c => !deletable.includes(c.id));
    setCategories(updated);
    setSelectedIds([]);
    setSnackbar({ open: true, message: `${deletable.length} category(ies) removed from database.`, severity: 'success' });
  };

  // Export Categories to CSV File
  const handleExportCSV = () => {
    if (categories.length === 0) return;
    let csv = "Category Code,Category Name,Description,GST %,HSN Code,Assigned Products,Status,Created Date\n";
    categories.forEach(c => {
      const pCount = getProductCountForCat(c.name);
      csv += `"${c.code}","${c.name}","${(c.description || '').replace(/"/g, '""')}","${c.gst_percentage}","${c.hsn_code}","${pCount}","${c.status}","${c.created_at}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Optical_ERP_Category_Master_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setSnackbar({ open: true, message: "Category master exported to CSV successfully!", severity: 'success' });
  };

  // View Category Details Drawer Handler
  const handleOpenDetailDrawer = (cat) => {
    const assignedProducts = dbProducts.filter(p => productMatchesCategory(p, cat.name));
    setViewingCategory({ ...cat, assignedProducts });
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
            Categories
          </Typography>
        </Breadcrumbs>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="h4" fontWeight={900} color="#0f172a" sx={{ letterSpacing: '-0.5px' }}>
              Category Master
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
              Manage product categories used throughout the Optical ERP.
            </Typography>
          </Box>

          {/* Top-Right Primary Action Buttons */}
          <Stack direction="row" spacing={1.5}>
            <Button 
              variant="outlined" startIcon={<RefreshIcon />} onClick={fetchCategoryMasterData} 
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
              variant="outlined" startIcon={<ImportIcon />} onClick={() => setImportModalOpen(true)} 
              sx={{ borderRadius: 2.5, fontWeight: 700, textTransform: 'none', color: '#475569', borderColor: '#cbd5e1' }}
            >
              Import
            </Button>
            <Button 
              variant="contained" startIcon={<AddIcon />} onClick={handleOpenAddModal} 
              sx={{ borderRadius: 2.5, fontWeight: 800, textTransform: 'none', px: 3, bgcolor: '#2563eb', '&:hover': { bgcolor: '#1d4ed8' } }}
            >
              + Add Category
            </Button>
          </Stack>
        </Box>
      </Box>

      {/* 📌 SECTION 2: PROFESSIONAL ERP KPI DASHBOARD CARDS */}
      <Grid container spacing={2.5} sx={{ mb: 3.5 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              TOTAL CATEGORIES
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#0f172a" sx={{ my: 0.5 }}>
              {stats.total}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Registered in Category Master
            </Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #059669', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              ACTIVE CATEGORIES
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#059669" sx={{ my: 0.5 }}>
              {stats.active}
            </Typography>
            <Typography variant="caption" color="success.main" fontWeight={700}>
              ● Ready for Product Association
            </Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={2.4}>
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #64748b', bgcolor: '#ffffff' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} display="block" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              INACTIVE CATEGORIES
            </Typography>
            <Typography variant="h4" fontWeight={900} color="#64748b" sx={{ my: 0.5 }}>
              {stats.inactive}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Archived or Suspended
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
              Items mapped to Categories
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
              Requires Classification
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
              placeholder="Search Category Name, Code, HSN, Description..."
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
              <MenuItem value="name_asc">Category Name (A - Z)</MenuItem>
              <MenuItem value="name_desc">Category Name (Z - A)</MenuItem>
              <MenuItem value="code_asc">Category Code</MenuItem>
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
              <IconButton color="primary" onClick={fetchCategoryMasterData} title="Refresh Category Master Data">
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
            ✓ {selectedIds.length} Category(ies) Selected
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
                    indeterminate={selectedIds.length > 0 && selectedIds.length < filteredCategories.length}
                    checked={filteredCategories.length > 0 && selectedIds.length === filteredCategories.length}
                    onChange={handleSelectAll}
                    size="small"
                  />
                </TableCell>
                <TableCell>Code</TableCell>
                <TableCell>Category Name</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="center">GST %</TableCell>
                <TableCell align="center">HSN Code</TableCell>
                <TableCell align="center">Products</TableCell>
                <TableCell align="center">Status</TableCell>
                <TableCell>Created Date</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={10} align="center" sx={{ py: 6 }}>
                    <CircularProgress size={32} />
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontWeight: 600 }}>
                      Loading Category Master Records...
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : paginatedCategories.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} align="center" sx={{ py: 8 }}>
                    <CategoryIcon sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.3, mb: 1 }} />
                    <Typography variant="body1" fontWeight={800} color="text.primary">
                      No Category Master Records Found
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      {searchQuery ? "No categories match your search keyword or filters." : "Click '+ Add Category' to register your first product category."}
                    </Typography>
                    {!searchQuery && (
                      <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpenAddModal} sx={{ fontWeight: 800 }}>
                        + Add Category
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedCategories.map((cat) => {
                  const isSelected = selectedIds.includes(cat.id);
                  const prodCount = getProductCountForCat(cat.name, cat);

                  return (
                    <TableRow key={cat.id} hover selected={isSelected} sx={{ cursor: 'pointer' }}>
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={isSelected} onChange={() => handleSelectOne(cat.id)} size="small" />
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(cat)}>
                        <Chip label={cat.code} size="small" sx={{ fontWeight: 900, bgcolor: '#f1f5f9', color: '#0f172a', borderRadius: 1.5 }} />
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(cat)}>
                        <Typography variant="body2" fontWeight={800} color="#0f172a">
                          {cat.name}
                        </Typography>
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(cat)} sx={{ maxWidth: 220 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {cat.description || '—'}
                        </Typography>
                      </TableCell>

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(cat)}>
                        <Chip label={cat.gst_percentage} size="small" color="primary" variant="outlined" sx={{ fontWeight: 800, height: 22 }} />
                      </TableCell>

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(cat)}>
                        <Typography variant="caption" fontWeight={700} color="#475569">
                          {cat.hsn_code}
                        </Typography>
                      </TableCell>

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(cat)}>
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

                      <TableCell align="center" onClick={() => handleOpenDetailDrawer(cat)}>
                        <Chip 
                          label={cat.status} 
                          size="small" 
                          color={cat.status === 'Active' ? 'success' : 'default'} 
                          sx={{ fontWeight: 800, height: 22, borderRadius: 1.5 }} 
                        />
                      </TableCell>

                      <TableCell onClick={() => handleOpenDetailDrawer(cat)}>
                        <Typography variant="caption" color="text.secondary">
                          {cat.created_at}
                        </Typography>
                      </TableCell>

                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" spacing={0.5} justifyContent="center">
                          <IconButton size="small" color="info" title="View Category Details" onClick={() => handleOpenDetailDrawer(cat)}>
                            <ViewIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="primary" title="Edit Category" onClick={() => handleOpenEditModal(cat)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="secondary" title="Duplicate Category" onClick={() => handleDuplicateCategory(cat)}>
                            <DuplicateIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="error" title="Delete Category" onClick={() => handleRequestDelete(cat)}>
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
          count={filteredCategories.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(e, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0); }}
        />
      </Card>

      {/* 📌 SECTION 5: ADD / EDIT CATEGORY MODAL */}
      <Dialog open={addEditModalOpen} onClose={() => setAddEditModalOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
        <DialogTitle sx={{ fontWeight: 900, borderBottom: '1px solid', borderColor: 'divider', pb: 1.5 }}>
          {editingCategory ? '✏️ Edit Category Master' : '➕ Add Category Master'}
        </DialogTitle>
        <DialogContent sx={{ pt: 2.5 }}>
          <Stack spacing={2.5}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={8}>
                <TextField
                  required
                  fullWidth
                  label="Category Name"
                  placeholder="e.g. Spectacle Frames, Prescription Lenses"
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
                  label="Category Code"
                  placeholder="e.g. FRA, LNS, SUN"
                  value={formState.code}
                  onChange={(e) => setFormState({ ...formState, code: e.target.value.toUpperCase() })}
                  error={Boolean(formErrors.code)}
                  helperText={formErrors.code}
                  size="small"
                  inputProps={{ style: { textTransform: 'uppercase', fontWeight: 800 } }}
                />
              </Grid>
            </Grid>

            <TextField
              fullWidth
              multiline
              rows={3}
              label="Description"
              placeholder="Enter category specifications, classification details or usage rules..."
              value={formState.description}
              onChange={(e) => setFormState({ ...formState, description: e.target.value })}
              size="small"
            />

            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField
                  select
                  required
                  fullWidth
                  label="GST Percentage *"
                  value={formState.gst_percentage}
                  onChange={(e) => setFormState({ ...formState, gst_percentage: e.target.value })}
                  size="small"
                >
                  <MenuItem value="0%">0% (Exempt)</MenuItem>
                  <MenuItem value="5%">5% GST</MenuItem>
                  <MenuItem value="12%">12% GST</MenuItem>
                  <MenuItem value="18%">18% GST</MenuItem>
                  <MenuItem value="28%">28% GST</MenuItem>
                </TextField>
              </Grid>

              <Grid item xs={6}>
                <TextField
                  required
                  fullWidth
                  label="HSN Code *"
                  placeholder="e.g. 90031100"
                  value={formState.hsn_code}
                  onChange={(e) => setFormState({ ...formState, hsn_code: e.target.value })}
                  error={Boolean(formErrors.hsn_code)}
                  helperText={formErrors.hsn_code}
                  size="small"
                />
              </Grid>
            </Grid>

            <Grid container spacing={2}>
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

              <Grid item xs={6}>
                <TextField
                  fullWidth
                  type="number"
                  label="Display Order"
                  value={formState.display_order}
                  onChange={(e) => setFormState({ ...formState, display_order: e.target.value })}
                  size="small"
                />
              </Grid>
            </Grid>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
          <Button onClick={() => setAddEditModalOpen(false)} sx={{ fontWeight: 700 }}>
            Cancel
          </Button>
          <Stack direction="row" spacing={1.5}>
            {!editingCategory && (
              <Button variant="outlined" onClick={() => handleSaveCategory(true)} sx={{ fontWeight: 800 }}>
                Save & New
              </Button>
            )}
            <Button variant="contained" color="primary" onClick={() => handleSaveCategory(false)} sx={{ fontWeight: 900, px: 3 }}>
              Save Category
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>

      {/* 📌 SECTION 6: DELETE CATEGORY VALIDATION MODAL */}
      <Dialog open={deleteModalOpen} onClose={() => setDeleteModalOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 900, color: categoryToDelete?.prodCount > 0 ? 'error.main' : 'text.primary' }}>
          {categoryToDelete?.prodCount > 0 ? '⚠️ Category In Use' : '🗑️ Confirm Category Deletion'}
        </DialogTitle>
        <DialogContent>
          {categoryToDelete?.prodCount > 0 ? (
            <>
              <Alert severity="error" icon={<WarningIcon />} sx={{ borderRadius: 2, mt: 1 }}>
                <Typography variant="subtitle2" fontWeight={800}>
                  This category contains {categoryToDelete.prodCount} product(s) and cannot be deleted directly.
                </Typography>
                <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                  Choose another category below to move the assigned products into before removing <strong>'{categoryToDelete.name}' ({categoryToDelete.code})</strong>.
                </Typography>
              </Alert>

              <TextField
                select
                fullWidth
                required
                label="Move Products To"
                value={moveToCategoryId}
                onChange={(e) => setMoveToCategoryId(e.target.value)}
                size="small"
                sx={{ mt: 2.5 }}
              >
                {categories.filter(c => c.id !== categoryToDelete.id).map(c => (
                  <MenuItem key={c.id} value={c.id}>{c.name} ({c.code})</MenuItem>
                ))}
              </TextField>
            </>
          ) : (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Are you sure you want to permanently delete category <strong>'{categoryToDelete?.name}' ({categoryToDelete?.code})</strong> from the database?
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDeleteModalOpen(false)}>Cancel</Button>
          {categoryToDelete?.prodCount === 0 ? (
            <Button variant="contained" color="error" onClick={handleConfirmDelete} sx={{ fontWeight: 800 }}>
              Delete Category
            </Button>
          ) : (
            <Button
              variant="contained"
              color="error"
              onClick={handleReassignAndDelete}
              disabled={!moveToCategoryId || reassigning}
              sx={{ fontWeight: 800 }}
            >
              {reassigning ? 'Moving Products...' : 'Move & Delete'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* 📌 SECTION 7: CATEGORY DETAILS & ASSIGNED PRODUCTS DRAWER */}
      <Drawer anchor="right" open={detailDrawerOpen} onClose={() => setDetailDrawerOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 520 }, p: 3 } }}>
        {viewingCategory && (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h5" fontWeight={900}>
                Category Details
              </Typography>
              <IconButton size="small" onClick={() => setDetailDrawerOpen(false)}>
                <InactiveIcon />
              </IconButton>
            </Box>

            <Chip label={viewingCategory.code} color="primary" sx={{ fontWeight: 900, mb: 2 }} />

            <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#f8fafc', mb: 3 }}>
              <Typography variant="subtitle1" fontWeight={900} color="#0f172a" sx={{ mb: 1 }}>
                {viewingCategory.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {viewingCategory.description || 'No detailed description provided.'}
              </Typography>

              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>GST PERCENTAGE</Typography>
                  <Typography variant="body2" fontWeight={800}>{viewingCategory.gst_percentage}</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>HSN CODE</Typography>
                  <Typography variant="body2" fontWeight={800}>{viewingCategory.hsn_code}</Typography>
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>STATUS</Typography>
                  <Chip label={viewingCategory.status} size="small" color={viewingCategory.status === 'Active' ? 'success' : 'default'} sx={{ fontWeight: 800, height: 20 }} />
                </Grid>
                <Grid item xs={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>DISPLAY ORDER</Typography>
                  <Typography variant="body2" fontWeight={800}>{viewingCategory.display_order}</Typography>
                </Grid>
              </Grid>
            </Paper>

            {/* Read-Only Products List assigned to this Category */}
            <Typography variant="subtitle2" fontWeight={900} color="#0f172a" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <ProductIcon color="primary" fontSize="small" /> Products Using This Category ({viewingCategory.assignedProducts?.length || 0})
            </Typography>

            {viewingCategory.assignedProducts?.length === 0 ? (
              <Alert severity="info" sx={{ borderRadius: 2 }}>
                No products are currently assigned to this category in the database.
              </Alert>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2.5, maxHeight: 350 }}>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#f8fafc' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 800 }}>Product Name</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Brand</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Stock</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Selling Price</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {viewingCategory.assignedProducts.map(p => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{p.code}</Typography>
                        </TableCell>
                        <TableCell><Typography variant="body2">{p.brand}</Typography></TableCell>
                        <TableCell><Typography variant="body2" fontWeight={800}>{p.stock} units</Typography></TableCell>
                        <TableCell><Typography variant="body2" fontWeight={800}>₹{p.selling_price.toFixed(2)}</Typography></TableCell>
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
