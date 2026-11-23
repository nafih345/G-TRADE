# G OPTICALS for Windows: Print Preview Fix

**Date:** 18 Nov 2026 · **Installer:** `windows\out\installer\G-OPTICALS-Setup-1.0.0.exe` · **SHA-256** `7E55919659C1E358A42B61D28A64EC252F0A21B5D58F2F5BC81AE5F48814E018` · 206,277,433 bytes · **BUILD_ID** `1.0.0-20261118T072055Z-9f20de5a` · **Unsigned** · **Not installed on any PC**

## 1. The cause

Clicking **Print** in the desktop app opened the Windows print dialog, which said "This app doesn't support print preview".

- The desktop app is Electron. Electron does **not** include Chrome's print-preview screen. `window.print()` and `webContents.print()` go straight to the operating system's print dialog.
- Windows 11's print dialog can only show a preview when the app supplies preview pages, and Electron supplies none. So it shows that message for every Electron app.
- The desktop shell (`windows/desktop`) had no print handling of its own. Every print button reached that dialog: bills, receipts, labels, prescriptions, eye-test reports and accounting reports, whether in the main window or a print pop-up.

A second, related defect: Electron 44 no longer reports the default printer, and the existing `listPrinters` bridge returned `isDefault: undefined` for every printer.

## 2. The fix

`window.print()` now opens the app's own **print preview** in every app window and every print pop-up. Existing print buttons need no change.

| Part | What it does |
|---|---|
| `desktop/preload.js` | Replaces `window.print` before any page script runs. Print pop-ups get the same preload. If the shell ever refuses, the page falls back to the native print path. |
| `desktop/lib/printPreview.js` | Reads the document's own `@page` size and margins. Renders the pages with `printToPDF`, Chromium's print engine. Opens one preview per window, so a double-click on Print does not open two. |
| `desktop/pages/print-preview.*` | The preview window. It shows the real pages and has settings for printer, paper, orientation, margins and copies. It also offers **Save as PDF** and an optional **Windows print dialog…** link. Keys: Ctrl+P, Ctrl+S, Esc. |
| `desktop/lib/printing.js` | Pure rules, all unit-tested: paper and margin parsing, the render and print options, printer classification, choice of the starting printer, warnings, and the PDF file name. |
| `desktop/lib/printerInventory.js` | Windows' own printer list (default printer, port, driver, offline status), read with one fixed PowerShell query and cached. |
| Frontend `utils/desktopPrint.js` | The Eye Test Report prints from an `<iframe>`, which the shell cannot preview. In the desktop app it now prints through a pop-up copy. Browsers are unchanged. |

**What is printed is what was previewed.** The printer is asked for exactly the paper size of the previewed PDF:
- Standard sheets are requested by name; landscape sheets are rotated.
- Receipts and labels are requested at their exact size in microns.

Margins come from the document's CSS in both the preview and the print. This is a measured Chromium behaviour, explained in §3.

**Paper formats**
- *As designed* uses the size set in the Bill Designer: A4, A5, A4 landscape, a fixed-size receipt or labels.
- **80 mm thermal receipts** that declare `size: 80mm auto` (the legacy thermal template and the eye-test receipt) are measured and laid out as one page as long as the receipt. That value is invalid CSS, which Chromium ignores; until now it fell back to Letter paper.
- A4, A5 or Letter can be chosen to fit a document onto that sheet.

**Printers**
- Paper printers are listed first, with the Windows default marked. Virtual printers (PDF writers, XPS, OneNote, Fax, AnyDesk) are listed separately as "no paper".
- The preview remembers the last printer used for each kind of document (sheet, receipt, label), so bills, receipts and labels can each go to their own printer.

**No paper printer:** the preview starts on **Save as PDF** and explains how to add a printer in Windows Settings. A **↻** button refreshes the printer list.

## 3. Facts verified on this PC (Electron 44.9.3, Chromium 152, Windows 11)

- The preload runs in `about:blank` print pop-ups and survives `document.write`. The pop-up's IPC origin is its opener's origin.
- A valid CSS `@page` size wins over the requested paper only when `preferCSSPageSize` is set. A smaller page is centred on a larger sheet; a larger page is reduced to fit.
- CSS `@page` **margins win over the margins option** in both `printToPDF` and `webContents.print`, even with `marginType: 'none'`. That is why the preview and the print agree, and why margin overrides are injected as CSS.
- `getPrintersAsync()` returns no default or status information.
- Chromium's PDF viewer works in a sandboxed window (`plugins: true`, toolbar hidden). **No new dependency** was added.
- The local server's Content Security Policy (`script-src 'unsafe-inline'`) is inherited by print pop-ups and is required for the bills' auto-print script.

## 4. Tests and results

| Test | Result |
|---|---|
| Desktop unit tests (`windows/desktop`: `npm test`), 18 new | **40 / 40** |
| Frontend: new `desktopPrint` tests + billing, labels, eye-test, brand, branding, UI-scale, purchase-label suites | **all pass** (3 new) |
| Print self-test, **packaged** `G-TRADE.exe --print-selftest` (`tests/test_print_preview_e2e.py`, with `GTRADE_DESKTOP_EXE`) | **pass**. It covers 7 document kinds plus a bill printed from a pop-up. Each opens the real preview, renders, takes a paper / orientation / margin change through the preview's own controls, saves a PDF, and resolves `window.print()` when the preview closes. The double-click guard is included. |
| **Real Windows spooler**, packaged build → *Microsoft Print to PDF* (`GTRADE_PRINT_SPOOLER=1`) | **pass**. All 4 jobs were sent through the preview's Print button and accepted by Windows. Spooled output: A4 invoice → 210×297, A5 prescription → 148×210, both exactly as previewed. The 80 mm receipt and the 3 labels → A4, because Microsoft Print to PDF has no custom paper sizes; the preview warns about exactly this. |
| `verify_package.py` on the 7-Zip-extracted installer | **32 / 32**, including two new print-preview checks |
| `payload_guard` on `win-unpacked` | OK |
| `test_desktop_install_e2e` (real installed stack + Electron smoke; now also prints the live app page through the preview) | **7 / 7**. On the live, logged-in app page, `window.print()` opened the preview, rendered A4 pages (the app's own print CSS fixes A4 portrait, 1 cm), listed the 4 printers with the default marked, and saved the PDF. |

Two defects were found by these runs and fixed before the final build:
- A double-click on Print could open two previews. It now opens one, and both calls resolve.
- My first smoke-test version also "printed" the shell's own offline page. That page keeps the native `print()`, so the native dialog hung the hidden window. The smoke test now prints only the server's page, and a test guards this.

Evidence (result JSON, a screenshot of every preview, the previewed PDFs and the spooled PDFs): `windows\out\evidence\print-preview-20261118\`.

## 5. Not verified: physical printers

**No physical printer is installed on this PC.** Only virtual printers are installed: Microsoft Print to PDF, WPS Print to PDF, OneNote and AnyDesk. **Printing on paper was not tested on any laser, inkjet, thermal receipt or label printer.** In particular:

- Whether a given thermal receipt driver (Epson TM, XPrinter, …) accepts the exact roll size the app sends (for example 80 × 86 mm) and cuts once.
- Whether a label driver (TSC, Zebra, …) accepts 38 × 25 mm pages without rotating them.
- Paper trays, duplex and driver-specific options. These are available through **Windows print dialog…**.

**To test on a shop PC with the printer connected,** run:

```
"C:\Program Files\G-TRADE\G-TRADE.exe" --print-selftest=%TEMP%\print-test.json --print-selftest-printer="<printer name>"
```

This is documented in the Administrator Guide, §4b. It prints the A4 invoice, A5 prescription, 80 mm receipt and 3 labels on that printer, and reports the result for each.

## 6. Unchanged

- **Cloud / browser printing:** the frontend changes only take effect when the desktop bridge is present. In a browser, `window.print()` and the iframe print behave exactly as before.
- **Document formatting:** templates, CSS and the Bill Designer are untouched. The only change is a `gtrade-print-kind` meta hint on label windows and visual thermal bills, which browsers ignore.
- **The existing `gtradeDesktop.print()` silent-print bridge** is kept.

## 7. Notes for the owner

- **This PC was updated during this work.** At 12:46–12:49 the previous RC `C5AA1470…` (BUILD `…T061340Z-6f5e3229`) was installed over the existing installation. The update log reports complete, health ok. **That build does not contain the print preview.** It is archived in `windows\out\archive\pre-print-preview-20261118\` with a `SUPERSEDED.txt` note.
- This installer also carries the uncommitted Excel-import work already in the working tree (`backend/apps/products/import_engine.py`). The previous RC carried it too.
- **Default printer:** the spooler tests made Windows switch the default printer to Microsoft Print to PDF, because "Let Windows manage my default printer" is on. It was restored to **OneNote (Desktop)**, the default before testing. The print queue is empty. The same Windows setting will move the default to whichever printer the shop last used; the preview's per-document memory keeps the right printer selected regardless.
- Release files: `windows\out\installer\RELEASE_MANIFEST.json`, `PACKAGE_VERIFICATION.json`, `G-OPTICALS-Setup-1.0.0.exe.sha256.txt`.
- Nothing was committed to git.
