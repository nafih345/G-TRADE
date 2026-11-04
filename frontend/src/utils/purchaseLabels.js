// Purchase Entry → Barcode Printing: pure helpers for the print-job unit ranges.
// The server (backend/apps/purchasing/label_printing.py) owns the counters; these only shape
// what the screen sends and translate "the last good label" into a count and back.

const toInt = (v) => Math.max(0, Math.floor(Number(v) || 0));

// items: label-status rows. counts: { [itemId]: labels to print now }.
// PRINT continues each line from its next unit; returns lines in the entry's order.
export function buildPrintLines(items, counts) {
  const lines = [];
  for (const it of items) {
    const want = Math.min(toInt(counts[it.id]), it.pending || 0);
    if (!want || !it.next_unit) continue;
    lines.push({ item: it.id, from_unit: it.next_unit, to_unit: it.next_unit + want - 1 });
  }
  return lines;
}

// ranges: { [itemId]: { from, to } } — any units 1..printed of each line.
export function buildReprintLines(items, ranges) {
  const lines = [];
  for (const it of items) {
    const r = ranges[it.id];
    if (!r) continue;
    const from = Math.max(1, toInt(r.from));
    const to = Math.min(toInt(r.to), it.printed || 0);
    if (to >= from) lines.push({ item: it.id, from_unit: from, to_unit: to });
  }
  return lines;
}

export const lineSize = (l) => l.to_unit - l.from_unit + 1;
export const jobSize = (lines) => lines.reduce((s, l) => s + lineSize(l), 0);

// "The last label that came out right was unit `unit` of line `index`" → labels printed from
// the start of the job (the printer works through the lines in order).
export function countThrough(lines, index, unit) {
  let count = 0;
  for (let i = 0; i < index && i < lines.length; i += 1) count += lineSize(lines[i]);
  const l = lines[index];
  if (!l) return count;
  return count + Math.min(lineSize(l), Math.max(0, toInt(unit) - l.from_unit + 1));
}

// The inverse: which line / unit the count-th label was (count ≥ 1), or null.
export function positionOf(lines, count) {
  let left = toInt(count);
  if (!left) return null;
  for (let i = 0; i < lines.length; i += 1) {
    const n = lineSize(lines[i]);
    if (left <= n) return { index: i, unit: lines[i].from_unit + left - 1 };
    left -= n;
  }
  const last = lines.length - 1;
  return last >= 0 ? { index: last, unit: lines[last].to_unit } : null;
}

// Rows for printLabelJob: one row per line, qty = units in the range.
export function printRows(lines, items, labelData) {
  const byId = new Map(items.map((it) => [it.id, it]));
  return lines.map((l) => {
    const it = byId.get(l.item);
    const product = { id: it.product, name: it.product_name, barcode: it.barcode, mrp: it.mrp, sellingPrice: it.selling_price };
    return {
      product,
      qty: lineSize(l),
      data: labelData?.[it.product],
      job: { batch_no: it.batch_number || '', expiry_date: it.expiry_date || '' },
    };
  });
}
