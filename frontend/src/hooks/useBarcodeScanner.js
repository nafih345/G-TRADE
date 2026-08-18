import { useEffect, useRef } from 'react';

// Detects hardware USB/Bluetooth barcode-scanner input: scanners emit keystrokes
// much faster than a human types, then send Enter. Buffers keydown events and
// fires onScan(code) when Enter arrives after a fast enough burst of keys.
export default function useBarcodeScanner(onScan, { minLength = 3, maxGapMs = 120, exemptRefs = [] } = {}) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let buffer = '';
    let lastTime = Date.now();

    const handleKeyDown = (e) => {
      const tag = e.target.tagName;
      const isExempt = exemptRefs.some((ref) => ref.current && e.target === ref.current);
      const isInput = (tag === 'INPUT' || tag === 'TEXTAREA') && !isExempt;

      const now = Date.now();
      if (now - lastTime > maxGapMs) {
        buffer = '';
      }
      lastTime = now;

      if (e.key === 'Enter') {
        if (buffer.length >= minLength && !isInput) {
          e.preventDefault();
          onScanRef.current(buffer.trim());
          buffer = '';
        }
      } else if (e.key.length === 1 && !isInput) {
        buffer += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minLength, maxGapMs]);
}
