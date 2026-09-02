// Shared barcode-to-product matching. A product resolves from a scanned code if
// the code equals its primary `barcode` OR any code in its printed per-label
// EAN-13 series (`extra_barcodes`, minted by printBarcodeLabels). Keeping this in
// one place means the POS, New Sale, and Purchase Entry scanners stay in sync.
export function barcodeMatchesProduct(product, code) {
  if (!product || code == null) return false;
  const c = String(code).trim().toLowerCase();
  if (!c) return false;
  if (product.barcode && String(product.barcode).toLowerCase() === c) return true;
  const extra = product.extra_barcodes || product.extraBarcodes;
  return Array.isArray(extra) && extra.some((x) => String(x).toLowerCase() === c);
}
