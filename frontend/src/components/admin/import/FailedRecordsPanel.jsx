import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import {
  Card, Typography, Box, Table, TableHead, TableBody, TableRow, TableCell,
  TableContainer, Paper, Button, Pagination
} from '@mui/material';
import { Download as DownloadIcon, CheckCircle as SuccessIcon } from '@mui/icons-material';

const PAGE_SIZE = 100;

export default function FailedRecordsPanel({ batchId, batchNumber }) {
  const [page, setPage] = useState(1);

  const { data } = useQuery({
    queryKey: ['import-errors', batchId, page],
    queryFn: async () => (await axios.get(`/api/import/${batchId}/errors/`, { params: { page, page_size: PAGE_SIZE } })).data,
    enabled: !!batchId,
    keepPreviousData: true,
  });

  if (!batchId) {
    return (
      <Card variant="outlined" sx={{ p: 4, borderRadius: 3, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          Select an import batch from "Import History" to view its failed records.
        </Typography>
      </Card>
    );
  }

  const rows = data?.results || [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <Card variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h6" fontWeight={800}>Failed Records{batchNumber ? ` — ${batchNumber}` : ''}</Typography>
          <Typography variant="caption" color="text.secondary">{totalCount.toLocaleString()} row(s) failed validation</Typography>
        </Box>
        <Button startIcon={<DownloadIcon />} onClick={() => window.open(`/api/import/${batchId}/export-failed/`, '_blank')} disabled={!totalCount}>
          Export Failed Records
        </Button>
      </Box>

      {rows.length === 0 ? (
        <Box sx={{ py: 5, textAlign: 'center' }}>
          <SuccessIcon sx={{ fontSize: 40, color: 'success.main', mb: 1 }} />
          <Typography variant="body2" color="text.secondary">No failed records for this batch.</Typography>
        </Box>
      ) : (
        <>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell>Row #</TableCell>
                  <TableCell>Product Code</TableCell>
                  <TableCell>Product Name</TableCell>
                  <TableCell>Error Reason</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.id} hover>
                    <TableCell>#{r.row_number}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{r.product_code || '—'}</TableCell>
                    <TableCell>{r.product_name || '—'}</TableCell>
                    <TableCell sx={{ color: 'error.main', fontWeight: 700 }}>{r.error_message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Pagination count={totalPages} page={page} onChange={(e, v) => setPage(v)} />
            </Box>
          )}
        </>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        To fix these rows: export them, correct the highlighted issues in Excel, then upload the corrected file as a new import.
      </Typography>
    </Card>
  );
}
