'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../lib/printing');
const { createPrinterInventory } = require('../lib/printerInventory');
const { createPrintPrefs } = require('../lib/printPreview');

const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

test('CSS lengths convert to millimetres', () => {
  assert.equal(P.cssLengthToMm('8mm'), 8);
  assert.equal(P.cssLengthToMm('1cm'), 10);
  assert.ok(near(P.cssLengthToMm('1in'), 25.4));
  assert.ok(near(P.cssLengthToMm('72pt'), 25.4));
  assert.ok(near(P.cssLengthToMm('96px'), 25.4));
  assert.equal(P.cssLengthToMm('0'), 0);
  assert.equal(P.cssLengthToMm('12'), null); // unitless non-zero is not a length
  assert.equal(P.cssLengthToMm('auto'), null);
});

test('@page sizes: named, landscape, exact, square, receipt roll', () => {
  assert.deepEqual(P.parsePageSize('A4'), { widthMm: 210, heightMm: 297, roll: false, named: 'A4', orientation: 'portrait' });
  assert.deepEqual(P.parsePageSize('a4 landscape'), { widthMm: 297, heightMm: 210, roll: false, named: 'A4', orientation: 'landscape' });
  assert.deepEqual(P.parsePageSize('A5 portrait'), { widthMm: 148, heightMm: 210, roll: false, named: 'A5', orientation: 'portrait' });
  const label = P.parsePageSize('38mm 25mm');
  assert.equal(label.widthMm, 38);
  assert.equal(label.heightMm, 25);
  assert.equal(P.parsePageSize('80mm').heightMm, 80); // one length = a square page (CSS)
  // The frontend's thermal templates use this invalid value; the shell measures the length.
  assert.deepEqual(P.parsePageSize('80mm auto'), { widthMm: 80, heightMm: null, roll: true, named: null, orientation: null });
  assert.equal(P.parsePageSize('210mm 297mm landscape').widthMm, 297);
  assert.equal(P.parsePageSize('auto'), null);
  assert.equal(P.parsePageSize(''), null);
  assert.equal(P.parsePageSize('banana'), null);
  assert.equal(P.parsePageSize('landscape').orientation, 'landscape');
});

test('margin shorthand and raw @page text', () => {
  assert.deepEqual(P.parseMarginShorthand('4mm'), { top: 4, right: 4, bottom: 4, left: 4 });
  assert.deepEqual(P.parseMarginShorthand('3mm 5mm'), { top: 3, right: 5, bottom: 3, left: 5 });
  assert.deepEqual(P.parseMarginShorthand('1mm 2mm 3mm 4mm'), { top: 1, right: 2, bottom: 3, left: 4 });
  assert.equal(P.parseMarginShorthand('wide'), null);
  assert.equal(P.findRawPageSize('body{} @page { size: 80mm auto; margin: 4mm; } @page :first { size: A4 }'), '80mm auto');
  assert.equal(P.findRawPageSize('@page{size:38mm 25mm;margin:0}'), '38mm 25mm');
  assert.equal(P.findRawPageSize('p { size: 3 }'), null);
});

test('documents are classified from their own @page rules', () => {
  // Bill Designer A4 / A5 bills, accounting reports
  assert.equal(P.describeDocument({ cssSize: 'A4', margin: '12mm 12mm 12mm 12mm' }).kind, 'sheet');
  const a5 = P.describeDocument({ title: 'Prescription', cssSize: 'A5', margin: '8mm 8mm 8mm 8mm' });
  assert.equal(a5.kind, 'sheet');
  assert.equal(a5.cssSize, true);
  assert.deepEqual(a5.marginsMm, { top: 8, right: 8, bottom: 8, left: 8 });
  // Legacy thermal bill / eye-test receipt: "80mm auto" is dropped by CSSOM but found in the raw text
  const roll = P.describeDocument({ cssSize: null, rawSize: '80mm auto', margin: '4mm 4mm 4mm 4mm' });
  assert.equal(roll.kind, 'receipt');
  assert.equal(roll.roll, true);
  assert.equal(roll.size.widthMm, 80);
  // Visual (schema 2) thermal bill with an exact size
  assert.equal(P.describeDocument({ cssSize: '80mm 142mm', hint: 'receipt' }).kind, 'receipt');
  assert.equal(P.describeDocument({ cssSize: '80mm 142mm' }).kind, 'receipt');
  // Labels: hinted, or small fixed pages
  assert.equal(P.describeDocument({ cssSize: '50mm 25mm', hint: 'label' }).kind, 'label');
  assert.equal(P.describeDocument({ cssSize: '104mm 150mm', hint: 'label' }).kind, 'label'); // 4-inch shipping label
  assert.equal(P.describeDocument({ cssSize: '38mm 25mm' }).kind, 'label');
  assert.equal(P.describeDocument({ cssSize: 'A4 portrait', hint: 'label' }).kind, 'sheet'); // A4 sheet of labels
  assert.equal(P.describeDocument({ cssSize: '80mm 55mm', hint: 'receipt' }).kind, 'receipt'); // short receipt, not a label
  assert.equal(P.describeDocument({ cssSize: 'A4', hint: 'receipt' }).kind, 'sheet');
  // An app screen with no @page size (Reports, Ledger, P&L, voucher forms)
  const screen = P.describeDocument({ title: 'G OPTICALS' });
  assert.equal(screen.kind, 'screen');
  assert.equal(screen.cssSize, false);
  // A zero-width-space title (label print windows) reads as no title
  assert.equal(P.describeDocument({ title: '​' }).title, '');
});

test('render plans: the document decides unless the user overrides', () => {
  const a5 = P.describeDocument({ cssSize: 'A5', margin: '8mm' });
  let plan = P.buildRenderPlan({ paper: 'document', margins: 'document' }, a5);
  assert.equal(plan.pdfOptions.preferCSSPageSize, true);
  assert.equal(plan.css, '');
  assert.equal(plan.pdfOptions.printBackground, true);
  plan = P.buildRenderPlan({ paper: 'A4', margins: 'none' }, a5);
  assert.equal(plan.pdfOptions.preferCSSPageSize, false);
  assert.equal(plan.pdfOptions.pageSize, 'A4');
  assert.equal(plan.pdfOptions.landscape, false); // CSS orientation wins for a sized document
  assert.match(plan.css, /@page \{ margin: 0mm !important; \}/);

  const screen = P.describeDocument({});
  plan = P.buildRenderPlan({ paper: 'A4', orientation: 'landscape' }, screen);
  assert.equal(plan.pdfOptions.landscape, true);
  assert.equal(P.orientationApplies(screen, P.sanitizeSettings({ paper: 'A4' })), true);
  assert.equal(P.orientationApplies(a5, P.sanitizeSettings({ paper: 'document' })), false);

  const roll = P.describeDocument({ rawSize: '80mm auto', margin: '4mm' });
  plan = P.buildRenderPlan({ paper: 'document' }, roll, 120);
  assert.equal(plan.needsRollLength, true);
  assert.ok(near(plan.pdfOptions.pageSize.width * 25.4, 80));
  assert.ok(near(plan.pdfOptions.pageSize.height * 25.4, 120));
  assert.equal(P.rollLengthMm(100, { top: 4, bottom: 4 }), 111);
  assert.equal(P.rollLengthMm(0, { top: 0, bottom: 0 }), 20);
  assert.equal(P.rollLengthMm(99999, { top: 4, bottom: 4 }), P.ROLL_MAX_MM);
});

test('settings from the preview page are sanitised', () => {
  assert.deepEqual(P.sanitizeSettings({ destination: 'EPSON TM-T82', paper: 'A5', orientation: 'landscape', margins: 'narrow', copies: 3 }),
    { destination: 'EPSON TM-T82', paper: 'A5', orientation: 'landscape', margins: 'narrow', copies: 3 });
  const bad = P.sanitizeSettings({ destination: 'x\u0000y', paper: 'A0', orientation: 'up', margins: '99mm', copies: 1e6, extra: 'dropped' });
  assert.deepEqual(bad, { destination: P.PDF_DESTINATION, paper: 'document', orientation: 'portrait', margins: 'document', copies: P.MAX_COPIES });
  assert.equal(P.sanitizeSettings({ copies: 0 }).copies, 1);
  assert.equal(P.sanitizeSettings({ copies: 2.5 }).copies, 1);
  assert.equal(P.sanitizeSettings(null).destination, P.PDF_DESTINATION);
  assert.equal(P.sanitizeSettings({ destination: 'p'.repeat(300) }).destination, P.PDF_DESTINATION);
});

test('print options ask the printer for exactly the previewed paper', () => {
  // Measured on Electron 44 / Windows: a CSS A4 page comes back as 209.9 x 297 mm.
  assert.deepEqual(P.buildPrintOptions({ destination: 'HP LaserJet', copies: 2 }, { widthMm: 209.9, heightMm: 297 }),
    { silent: true, printBackground: true, margins: { marginType: 'default' }, copies: 2, deviceName: 'HP LaserJet', pageSize: 'A4' });
  const land = P.buildPrintOptions({ destination: 'HP' }, { widthMm: 297, heightMm: 209.9 });
  assert.equal(land.pageSize, 'A4');
  assert.equal(land.landscape, true);
  assert.equal(P.buildPrintOptions({ destination: 'HP' }, { widthMm: 148.2, heightMm: 209.9 }).pageSize, 'A5');
  // Receipt roll and labels: exact microns, never rotated (label stock feeds as designed)
  const receipt = P.buildPrintOptions({ destination: 'EPSON TM-T82' }, { widthMm: 80.1, heightMm: 86.1 });
  assert.deepEqual(receipt.pageSize, { width: 80100, height: 86100 });
  assert.equal(receipt.landscape, undefined);
  const label = P.buildPrintOptions({ destination: 'TSC TE244' }, { widthMm: 38.1, heightMm: 25.1 });
  assert.deepEqual(label.pageSize, { width: 38100, height: 25100 });
  assert.equal(label.landscape, undefined);
  // Windows dialog variant
  assert.equal(P.buildPrintOptions({ destination: 'HP' }, { widthMm: 210, heightMm: 297 }, { silent: false }).silent, false);
  assert.equal(P.buildPrintOptions({ destination: P.PDF_DESTINATION }, { widthMm: 210, heightMm: 297 }).deviceName, undefined);
});

test('paper descriptions', () => {
  assert.equal(P.describePaper(209.9, 297), 'A4 portrait · 210 × 297 mm');
  assert.equal(P.describePaper(297, 209.9), 'A4 landscape · 297 × 210 mm');
  assert.equal(P.describePaper(80.1, 86.1, 'receipt'), 'Receipt · 80 × 86 mm');
  assert.equal(P.describePaper(38.1, 25.1, 'label'), 'Label · 38 × 25 mm');
  assert.equal(P.describePaper(100.5, 50.5), '100.5 × 50.5 mm');
});

test('PDF info reads page count and first page size from Chromium output', () => {
  const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  const a5 = P.pdfInfo(fx('print-a5.pdf'));
  assert.deepEqual([a5.pages, a5.widthMm, a5.heightMm], [1, 148.2, 209.9]);
  const labels = P.pdfInfo(fx('print-labels-3.pdf'));
  assert.deepEqual([labels.pages, labels.widthMm, labels.heightMm], [3, 38.1, 25.1]);
  assert.deepEqual(P.pdfInfo(Buffer.from('not a pdf')), { pages: 0, widthMm: 0, heightMm: 0 });
});

// What Windows' Win32_Printer reported on the build PC (no paper printer installed).
const INVENTORY_JSON = JSON.stringify([
  { Name: 'OneNote (Desktop)', Default: false, PortName: 'nul:', DriverName: 'Send to Microsoft OneNote 16 Driver', WorkOffline: false, PrinterStatus: 3 },
  { Name: 'WPS Print to PDF', Default: false, PortName: 'Kingsoft Virtual Printer Port', DriverName: 'Kingsoft Virtual Printer Driver', WorkOffline: false, PrinterStatus: 3 },
  { Name: 'Microsoft Print to PDF', Default: true, PortName: 'PORTPROMPT:', DriverName: 'Microsoft Print To PDF', WorkOffline: false, PrinterStatus: 3, PrinterPaperNames: ['Letter', 'A4', 'A5'] },
  { Name: 'AnyDesk Printer', Default: false, PortName: 'AD_Port', DriverName: 'AnyDesk v4 Printer Driver', WorkOffline: false, PrinterStatus: 3 },
]);
const ELECTRON_LIST = ['OneNote (Desktop)', 'WPS Print to PDF', 'Microsoft Print to PDF', 'AnyDesk Printer'].map((name) => ({ name, displayName: name, description: '', options: {} }));

test('printers: virtual ones are never mistaken for paper printers', () => {
  const inv = P.parsePrinterInventory(INVENTORY_JSON);
  assert.equal(inv.length, 4);
  assert.equal(inv.find((p) => p.name === 'Microsoft Print to PDF').isDefault, true);
  const merged = P.mergePrinters(ELECTRON_LIST, inv);
  assert.equal(merged.hasPhysical, false);
  assert.equal(merged.inventoryAvailable, true);
  assert.deepEqual(merged.printers.map((p) => p.type).sort(), ['onenote', 'pdf', 'pdf', 'remote']);
  // No paper printer -> the preview starts on Save as PDF
  assert.equal(P.chooseDestination(merged.printers, 'sheet', ''), P.PDF_DESTINATION);
  // ...unless the user deliberately chose a virtual printer last time
  assert.equal(P.chooseDestination(merged.printers, 'sheet', 'Microsoft Print to PDF'), 'Microsoft Print to PDF');
  // Inventory unavailable: names alone still classify these
  const fallback = P.mergePrinters(ELECTRON_LIST, null);
  assert.equal(fallback.hasPhysical, false);
  assert.equal(fallback.inventoryAvailable, false);
});

test('printers: physical ones, offline, single-object JSON, garbage', () => {
  const one = P.parsePrinterInventory(JSON.stringify({ Name: 'EPSON TM-T82 Receipt', Default: true, PortName: 'USB001', DriverName: 'EPSON TM-T82 Receipt', WorkOffline: true, PrinterStatus: 3 }));
  assert.equal(one.length, 1);
  assert.equal(one[0].offline, true);
  assert.equal(one[0].status, 'Offline');
  assert.equal(P.parsePrinterInventory('not json'), null);
  assert.deepEqual(P.parsePrinterInventory(''), null);
  assert.equal(P.classifyPrinter({ name: 'HP LaserJet M1005', driverName: 'HP LaserJet M1005', portName: 'USB001' }).virtual, false);
  assert.equal(P.classifyPrinter({ name: 'Brother (redirected 2)', portName: 'TS001' }).virtual, false); // RDP printer prints paper
  assert.equal(P.classifyPrinter({ name: 'Fax', portName: 'SHRFAX:' }).type, 'fax');
  assert.equal(P.classifyPrinter({ name: 'Microsoft XPS Document Writer', portName: 'PORTPROMPT:' }).type, 'xps');
  assert.equal(P.classifyPrinter({ name: 'Some Printer', portName: 'FILE:' }).virtual, true);
});

test('destination: last used per document kind, then default, then a printer that suits the paper', () => {
  const printers = P.mergePrinters(
    [{ name: 'HP LaserJet' }, { name: 'EPSON TM-T82' }, { name: 'TSC TE244' }, { name: 'Microsoft Print to PDF' }],
    [{ name: 'HP LaserJet', isDefault: true, portName: 'USB001', driverName: 'HP', offline: false, status: 'Ready', paperNames: [] },
      { name: 'Microsoft Print to PDF', isDefault: false, portName: 'PORTPROMPT:', driverName: 'Microsoft Print To PDF', offline: false, status: 'Ready', paperNames: [] }],
  ).printers;
  assert.equal(printers[0].name, 'HP LaserJet'); // physical, default first
  assert.equal(printers.at(-1).name, 'Microsoft Print to PDF'); // virtual last
  assert.equal(P.chooseDestination(printers, 'sheet', ''), 'HP LaserJet');
  assert.equal(P.chooseDestination(printers, 'screen', ''), 'HP LaserJet');
  assert.equal(P.chooseDestination(printers, 'receipt', ''), 'EPSON TM-T82');
  assert.equal(P.chooseDestination(printers, 'label', ''), 'TSC TE244');
  assert.equal(P.chooseDestination(printers, 'receipt', 'HP LaserJet'), 'HP LaserJet'); // the user's choice wins
  assert.equal(P.chooseDestination(printers, 'receipt', 'Removed Printer'), 'EPSON TM-T82');
  assert.equal(P.chooseDestination(printers, 'receipt', P.PDF_DESTINATION), P.PDF_DESTINATION);
});

test('warnings and failure messages', () => {
  const pdf = { displayName: 'Microsoft Print to PDF', virtual: true, offline: false };
  assert.match(P.destinationWarnings(pdf, { widthMm: 80, heightMm: 86 }, 'receipt')[0], /standard sheet sizes only/);
  assert.deepEqual(P.destinationWarnings(pdf, { widthMm: 210, heightMm: 297 }, 'sheet'), []);
  assert.match(P.destinationWarnings({ displayName: 'HP', virtual: false, offline: true }, { widthMm: 210, heightMm: 297 }, 'sheet')[0], /offline/);
  assert.equal(P.printFailureMessage('Print job canceled'), 'Printing was cancelled.');
  assert.match(P.printFailureMessage('Invalid deviceName provided'), /no longer available/);
  assert.match(P.printFailureMessage('Print job failed'), /could not print/);
  assert.match(P.printFailureMessage(''), /did not accept/);
});

test('Save as PDF file names are safe Windows names', () => {
  const day = new Date(2026, 10, 18);
  assert.equal(P.pdfFileName('Tax Invoice INV-0042', day), 'Tax Invoice INV-0042.pdf');
  assert.equal(P.pdfFileName('a/b\\c:d*e?f"g<h>i|j', day), 'a b c d e f g h i j.pdf');
  assert.equal(P.pdfFileName('​', day), 'Document 2026-11-18.pdf');
  assert.equal(P.pdfFileName('CON', day), 'Document 2026-11-18.pdf');
  assert.equal(P.pdfFileName('Report...', day), 'Report.pdf');
  assert.ok(P.pdfFileName('x'.repeat(500), day).length <= 124);
});

test('printer inventory: cached, refreshable, never fatal, Windows only', async () => {
  let calls = 0;
  let clock = 0;
  const inv = createPrinterInventory({ run: async () => { calls += 1; return INVENTORY_JSON; }, now: () => clock, platform: 'win32' });
  assert.equal((await inv.get()).length, 4);
  await inv.get();
  assert.equal(calls, 1); // cached
  await inv.get({ refresh: true });
  assert.equal(calls, 2);
  clock += 31000;
  await inv.get();
  assert.equal(calls, 3); // expired
  const failing = createPrinterInventory({ run: async () => { throw new Error('powershell blocked'); }, platform: 'win32' });
  assert.equal(await failing.get(), null);
  const other = createPrinterInventory({ run: async () => { throw new Error('not called'); }, platform: 'linux' });
  assert.equal(await other.get(), null);
});

test('remembered destinations are stored per document kind', () => {
  const store = {};
  const prefs = createPrintPrefs({ file: 'x.json', readJson: () => ({ lastDestination: { receipt: 'EPSON TM-T82', bad: 3 } }),
    writeJsonAtomic: (f, d) => { store[f] = d; } });
  assert.equal(prefs.lastDestination('receipt'), 'EPSON TM-T82');
  assert.equal(prefs.lastDestination('bad'), '');
  prefs.remember('sheet', 'HP LaserJet');
  assert.deepEqual(store['x.json'], { version: 1, lastDestination: { receipt: 'EPSON TM-T82', bad: 3, sheet: 'HP LaserJet' } });
  const test2 = createPrintPrefs({ file: 'y.json', readJson: () => null, writeJsonAtomic: () => { throw new Error('must not write'); }, persist: false });
  test2.remember('sheet', 'HP');
  assert.equal(test2.lastDestination('sheet'), 'HP');
});

test('wiring: every app window and print pop-up gets the preview instead of the Windows dialog', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const preload = read('preload.js');
  assert.match(preload, /contextBridge\.executeInMainWorld\(/);
  assert.match(preload, /Object\.defineProperty\(window, 'print'/);
  assert.match(preload, /invoke\('print:preview'\)/);
  assert.match(preload, /nativePrint\.call\(window\)/); // falls back rather than failing to print
  const main = read('main.js');
  // pop-ups (bills, labels, reports) get the same preload as the main window
  assert.match(main, /overrideBrowserWindowOptions: \{ autoHideMenuBar: true, webPreferences: \{ \.\.\.securePopupPrefs, preload: PRELOAD \} \}/);
  assert.match(main, /handle\('print:preview', \['server'\]/);
  assert.match(main, /printPreview\.registerIpc\(\(channel, fn\) => handle\(channel, \['local'\], fn\)\)/);
  assert.match(main, /frame\.origin/); // about:blank pop-ups are recognised by their inherited origin
  // The smoke run prints only the server's page: the shell's offline page keeps the native print()
  // (a native dialog in a hidden smoke window would hang the run).
  assert.match(main, /if \(current && sec\.sameOrigin\(result\.url, current\.serverUrl\)\) \{\s*try \{\s*result\.print = await exercisePreview/);
  const pre = read('preload-preview.js');
  assert.deepEqual([...pre.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]).sort(),
    ['preview:close', 'preview:init', 'preview:print', 'preview:printers', 'preview:render', 'preview:reveal', 'preview:savePdf', 'preview:systemDialog']);
  const html = read('pages/print-preview.html');
  assert.match(html, /script-src 'self';/);
  assert.match(html, /frame-src blob:/);
  assert.ok(!/<script>/.test(html), 'no inline script in the preview page');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('preload-preview.js'));
  assert.ok(pkg.build.files.includes('pages/**/*'));
});

test('the in-page probe and measure scripts are self-contained expressions', () => {
  assert.doesNotThrow(() => new Function(`return ${P.PROBE_SCRIPT};`));
  assert.doesNotThrow(() => new Function(`return ${P.measureScript(74)};`));
  assert.match(P.measureScript('1e9'), /'400mm'/); // clamped
});
