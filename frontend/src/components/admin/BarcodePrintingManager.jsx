import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Box, Card, Typography, Button, TextField, InputAdornment, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Paper, Chip, Checkbox, TablePagination, CircularProgress, FormControlLabel
} from '@mui/material';
import {
  Search as SearchIcon,
  QrCode as BarcodeIcon,
  AutoAwesome as GenerateIcon
} from '@mui/icons-material';
import { useDebounce } from '../../hooks/useDebounce';
import BarcodePrintDialog from '../inventory/BarcodePrintDialog';

// A catalog-wide console for finding products missing a barcode and bulk
// generating/printing labels, independent of the Products page's row actions.
export default function BarcodePrintingManager() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [missingOnly, setMissingOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [selected, setSelected] = useState(new Map()); // id -> product row
  const [printOpen, setPrintOpen] = useState(false);
  const [bulkGenerating, setBulkGenerating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['barcode-admin-products', debouncedSearch, missingOnly, page, rowsPerPage],
    queryFn: async () => {
      const res = await axios.get('/api/products/items/', {
        params: {
          search: debouncedSearch || undefined,
          has_barcode: missingOnly ? 'false' : undefined,
          page: page + 1,
          page_size: rowsPerPage
        }
      });
      return res.data;
    },
    keepPreviousData: true
  });

  const rows = data?.results || [];
  const totalCount = data?.count ?? 0;
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggleOne = (row) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id); else next.set(row.id, row);
      return next;
    });
  };

  const toggleAllOnPage = (checked) => {
    setSelected((prev) => {
      const next = new Map(prev);
      rows.forEach((r) => { checked ? next.set(r.id, r) : next.delete(r.id); });
      return next;
    });
  };

  const selectedProducts = useMemo(() => Array.from(selected.values()).map((p) => ({
    id: p.id, name: p.name, code: p.sku, barcode: p.barcode,
    sellingPrice: p.price ?? p.selling_price ?? 0, stock: p.stock
  })), [selected]);

  const selectedMissingIds = useMemo(
    () => Array.from(selected.values()).filter((p) => !p.barcode).map((p) => p.id),
    [selected]
  );

  const handleBulkGenerate = async () => {
    if (selectedMissingIds.length === 0) {
      alert('None of the selected products are missing a barcode.');
      return;
    }
    setBulkGenerating(true);
    try {
      const res = await axios.post('/api/products/items/generate_missing_barcodes/', {
        product_ids: selectedMissingIds
      });
      alert(`Generated barcodes for ${res.data.generated} product(s).`);
      setSelected(new Map());
      queryClient.invalidateQueries({ queryKey: ['barcode-admin-products'] });
    } catch (e) {
      alert('Could not generate barcodes. Please try again.');
    } finally {
      setBulkGenerating(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" fontWeight={800} sx={{ mb: 0.5 }}>Barcode Printing</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        Find products across the full catalog, generate missing barcodes, and print labels in bulk.
      </Typography>

      <Card variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
          <TextField
            fullWidth size="small" placeholder="Search by name, SKU, barcode, brand, or category..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" color="action" /></InputAdornment> }}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={missingOnly}
                onChange={(e) => { setMissingOnly(e.target.checked); setPage(0); }}
              />
            }
            label="Missing barcodes only"
            sx={{ whiteSpace: 'nowrap' }}
          />
        </Stack>
      </Card>

      {selected.size > 0 && (
        <Card variant="outlined" sx={{ p: 1.5, px: 2.5, mb: 2, borderRadius: 2.5, bgcolor: '#eff6ff', border: '1px solid #bfdbfe', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" fontWeight={800} color="#1e40af">
            {selected.size} product(s) selected
          </Typography>
          <Stack direction="row" spacing={1.5}>
            <Button
              size="small" variant="outlined" startIcon={<GenerateIcon />}
              onClick={handleBulkGenerate} disabled={bulkGenerating}
            >
              {bulkGenerating ? 'Generating...' : `Generate Missing (${selectedMissingIds.length})`}
            </Button>
            <Button
              size="small" variant="contained" startIcon={<BarcodeIcon />}
              onClick={() => setPrintOpen(true)}
              sx={{ backgroundColor: '#7c3aed', '&:hover': { backgroundColor: '#6d28d9' } }}
            >
              Print Labels
            </Button>
          </Stack>
        </Card>
      )}

      <Card sx={{ borderRadius: 3.5, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <TableContainer>
          <Table size="small">
            <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    indeterminate={selected.size > 0 && !allOnPageSelected}
                    checked={allOnPageSelected}
                    onChange={(e) => toggleAllOnPage(e.target.checked)}
                  />
                </TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Code / SKU</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Category</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Barcode</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Stock</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6 }}><CircularProgress size={28} /></TableCell></TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6 }}>
                    <Typography variant="body2" color="text.secondary">
                      {missingOnly ? 'No products are missing a barcode.' : 'No products found.'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id} hover selected={selected.has(row.id)}>
                    <TableCell padding="checkbox">
                      <Checkbox checked={selected.has(row.id)} onChange={() => toggleOne(row)} />
                    </TableCell>
                    <TableCell><Typography variant="body2" fontWeight={600} color="primary.main">{row.sku}</Typography></TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.category}</TableCell>
                    <TableCell>
                      {row.barcode ? (
                        <Chip label={row.barcode} size="small" sx={{ fontWeight: 700, bgcolor: '#eff6ff', color: '#2563eb' }} />
                      ) : (
                        <Chip label="Missing" size="small" color="warning" variant="outlined" sx={{ fontWeight: 700 }} />
                      )}
                    </TableCell>
                    <TableCell align="right">{row.stock ?? 0}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          rowsPerPageOptions={[10, 25, 50, 100]}
          component="div"
          count={totalCount}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(e, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0); }}
        />
      </Card>

      <BarcodePrintDialog open={printOpen} onClose={() => setPrintOpen(false)} products={selectedProducts} />
    </Box>
  );
}
