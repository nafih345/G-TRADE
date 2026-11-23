// Printing that behaves the same in a browser and in the Windows desktop app.
//
// In the desktop app, window.print() opens the app's own print preview: the desktop shell
// (windows/desktop/preload.js) replaces it in the main window and in every print pop-up, so the
// existing print buttons need no change. That preview renders whole windows, so a document shown
// inside an <iframe> is printed from a same-origin pop-up copy instead. Browsers keep their own
// print dialog and preview, exactly as before.
import { desktopBridge } from './edition.js';

/** True inside the desktop app (its print preview is available). */
export const hasAppPrintPreview = (bridge = desktopBridge()) => typeof bridge?.printPreview === 'function';

/**
 * Print the document shown in a same-origin <iframe>.
 *  - Browser: the frame prints itself (unchanged behaviour).
 *  - Desktop app: the same HTML is written into a print pop-up whose window.print() opens the
 *    app's preview; the pop-up closes again when the preview does.
 * `html` (optional) is the frame's source document, used as-is when given.
 * Resolves true once printing was started, false if there was nothing to print / no pop-up.
 */
export function printFrame(frame, {
  html = '', features = 'width=900,height=950', bridge = desktopBridge(),
  openWindow = (...args) => window.open(...args), delayMs = 250,
} = {}) {
  const frameWindow = frame?.contentWindow;
  if (!hasAppPrintPreview(bridge)) {
    if (!frameWindow) return Promise.resolve(false);
    frameWindow.focus();
    frameWindow.print();
    return Promise.resolve(true);
  }
  const source = html || frame?.contentDocument?.documentElement?.outerHTML || '';
  if (!source) return Promise.resolve(false);
  const popup = openWindow('', '_blank', features);
  if (!popup) return Promise.resolve(false);
  popup.document.open();
  popup.document.write(/^\s*<!doctype/i.test(source) ? source : `<!DOCTYPE html>${source}`);
  popup.document.close();
  return new Promise((resolve) => {
    // Same short pause the other print pop-ups use, so images and fonts are laid out first.
    setTimeout(() => {
      let preview;
      try { preview = popup.print(); } catch { resolve(false); return; }
      resolve(true);
      Promise.resolve(preview).finally(() => { try { popup.close(); } catch { /* already closed */ } });
    }, delayMs);
  });
}
