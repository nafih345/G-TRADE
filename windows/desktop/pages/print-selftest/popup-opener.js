// Same pattern as frontend/src/billing/printBill.js: open a blank same-origin window, write the
// bill into it, and let the bill's own script call window.print().
window.openBillPopup = () => {
  const w = window.open('', '_blank', 'width=420,height=740');
  if (!w) return false;
  w.document.open();
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Bill POPUP-001</title>'
    + '<style>@page { size: A5; margin: 8mm; } body{font-family:Arial,sans-serif}</style></head>'
    + '<body><h1>Bill POPUP-001</h1><p>Written into an about:blank pop-up.</p>'
    + '<script>window.onload=function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);};<\/script>'
    + '</body></html>');
  w.document.close();
  return true;
};
