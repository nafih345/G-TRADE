import React, { useRef, useMemo, useState, useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import axios from 'axios';
import { Box, TextField, InputAdornment, Typography, CircularProgress } from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import { useDebounce } from '../../../hooks/useDebounce';

const CORE_COLUMNS = [
  { key: 'sku', label: 'SKU / Code', width: 160 },
  { key: 'barcode', label: 'Barcode', width: 140 },
  { key: 'name', label: 'Product Name', width: 280 },
  { key: 'category', label: 'Category', width: 150 },
  { key: 'brand', label: 'Brand', width: 140 },
  { key: 'supplier', label: 'Supplier', width: 170 },
  { key: 'cost_price', label: 'Cost Price', width: 110, align: 'right' },
  { key: 'selling_price', label: 'Selling Price', width: 120, align: 'right' },
  { key: 'stock', label: 'Stock', width: 90, align: 'right' },
];

const ROW_HEIGHT = 40;
const PAGE_SIZE = 150;

/**
 * Enterprise-scale product grid: server-side paginated + searched, rendered through
 * @tanstack/react-virtual so only the rows actually on screen exist in the DOM,
 * regardless of how many hundreds of thousands of rows the query matches.
 */
export default function VirtualizedProductGrid({ endpoint, extraParams = {}, emptyHint }) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const parentRef = useRef(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['product-grid', endpoint, debouncedSearch, extraParams],
    queryFn: async ({ pageParam = 1 }) => {
      const res = await axios.get(endpoint, {
        params: { page: pageParam, page_size: PAGE_SIZE, search: debouncedSearch, ...extraParams }
      });
      return res.data;
    },
    getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),
    keepPreviousData: true,
  });

  const rows = useMemo(() => (data?.pages || []).flatMap(p => p.results || []), [data]);
  const totalCount = data?.pages?.[0]?.count ?? 0;

  const columns = useMemo(() => {
    const headers = data?.pages?.[0]?.column_headers || [];
    const coreLabels = new Set(CORE_COLUMNS.map(c => c.label.toLowerCase()));
    const customColumns = headers
      .filter(h => h && !coreLabels.has(h.toLowerCase()))
      .map(h => ({ key: h, label: h, width: 150 }));
    return [...CORE_COLUMNS, ...customColumns];
  }, [data]);

  const rowVirtualizer = useVirtualizer({
    count: hasNextPage ? rows.length + 1 : rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastIndex = virtualItems.length ? virtualItems[virtualItems.length - 1].index : -1;

  useEffect(() => {
    if (lastIndex >= rows.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <Box>
      <TextField
        fullWidth
        size="small"
        placeholder="Search by name, SKU, barcode, brand, category, or supplier..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        sx={{ mb: 1.5 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
        {totalCount.toLocaleString()} product{totalCount === 1 ? '' : 's'}{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}
      </Typography>

      <Box sx={{ overflowX: 'auto', border: '1px solid #cbd5e1', borderRadius: 2 }}>
        <Box sx={{ minWidth: columns.reduce((s, c) => s + c.width, 0) }}>
          <Box sx={{ display: 'flex', bgcolor: '#0f172a', color: '#fff', fontWeight: 800, fontSize: '0.72rem', position: 'sticky', top: 0, zIndex: 1 }}>
            {columns.map(col => (
              <Box key={col.key} sx={{ width: col.width, flexShrink: 0, p: 1, textAlign: col.align || 'left' }}>{col.label}</Box>
            ))}
          </Box>

          <Box ref={parentRef} sx={{ height: 520, overflow: 'auto' }}>
            {isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={28} /></Box>
            ) : rows.length === 0 ? (
              <Box sx={{ py: 6, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">{emptyHint || 'No products found.'}</Typography>
              </Box>
            ) : (
              <Box sx={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                {virtualItems.map(vRow => {
                  const row = rows[vRow.index];
                  return (
                    <Box
                      key={vRow.key}
                      sx={{
                        position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT,
                        transform: `translateY(${vRow.start}px)`, display: 'flex', alignItems: 'center',
                        borderBottom: '1px solid #f1f5f9', bgcolor: vRow.index % 2 ? '#fafafa' : '#fff'
                      }}
                    >
                      {row ? columns.map(col => (
                        <Box key={col.key} sx={{ width: col.width, flexShrink: 0, px: 1, fontSize: '0.8rem', textAlign: col.align || 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {typeof row[col.key] === 'number' ? row[col.key].toLocaleString() : (row[col.key] ?? '—')}
                        </Box>
                      )) : (
                        <Box sx={{ px: 2 }}><CircularProgress size={16} /></Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
