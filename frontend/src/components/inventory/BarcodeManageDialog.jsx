import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography } from '@mui/material';
import BarcodeSection from './BarcodeSection';

// Wraps BarcodeSection in mode="manage" for an existing, already-persisted product —
// the single entry point for generate/regenerate/copy/print/clear + history on that product.
export default function BarcodeManageDialog({ open, onClose, product, onProductUpdated }) {
  if (!product) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>
        Manage Barcode
        <Typography variant="body2" color="text.secondary" fontWeight={500}>
          {product.name} {product.code ? `(${product.code})` : ''}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <BarcodeSection
          mode="manage"
          productId={product.id}
          value={product.barcode}
          productName={product.name}
          productCode={product.code}
          productPrice={product.sellingPrice}
          productStock={product.stock}
          onSaved={(newBarcode) => onProductUpdated && onProductUpdated(product.id, newBarcode)}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
