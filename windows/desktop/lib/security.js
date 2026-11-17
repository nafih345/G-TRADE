'use strict';
// Pure security policy for the desktop shell. No Electron imports: unit-tested with `node --test`.

const crypto = require('node:crypto');
const { PRODUCT_NAME } = require('./brand');

/** "https://shop-srv:8443/" -> { origin: 'https://shop-srv:8443', host, port } ; throws on anything else. */
function normalizeServerUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter the server address.');
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That is not a valid server address.');
  }
  if (url.protocol !== 'https:') throw new Error(`${PRODUCT_NAME} servers are only reached over HTTPS.`);
  if (url.username || url.password) throw new Error('The address must not contain a user name or password.');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the server name and port.');
  if (!url.port) url.port = '8443';
  return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) };
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Main-window navigation: only the server origin. Print popups open about:blank (allowed separately). */
function isAllowedNavigation(targetUrl, serverOrigin) {
  return sameOrigin(targetUrl, serverOrigin);
}

/** Links leaving the app (WhatsApp share, a brand website) go to the system browser, https/mailto only. */
function isSafeExternalUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    return u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function fingerprintOfPem(pem) {
  return new crypto.X509Certificate(pem).fingerprint256.toUpperCase();
}

function normalizeFingerprint(fp) {
  const hex = String(fp || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 64) return '';
  return hex.match(/.{2}/g).join(':');
}

/** 8-character pairing code shown on the server's connection sheet: first 4 bytes of the CA fingerprint. */
function pairingCode(fingerprint) {
  const hex = normalizeFingerprint(fingerprint).replace(/:/g, '');
  return hex ? `${hex.slice(0, 4)}-${hex.slice(4, 8)}` : '';
}

function pairingCodeMatches(entered, fingerprint) {
  const a = String(entered || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const b = pairingCode(fingerprint).replace('-', '');
  return a.length === 8 && b.length === 8 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Decide whether a server certificate is acceptable for the pinned installation CA.
 * leafPem: certificate presented for `hostname`; caPem: the pinned CA (from client.json).
 * Returns { ok, reason }. Checks: CA fingerprint pin, leaf issued+signed by that CA, validity, hostname/IP.
 */
function verifyPinnedLeaf({ hostname, leafPem, caPem, pinnedFingerprint, now = new Date() }) {
  try {
    const ca = new crypto.X509Certificate(caPem);
    if (normalizeFingerprint(ca.fingerprint256) !== normalizeFingerprint(pinnedFingerprint)) {
      return { ok: false, reason: 'pinned CA does not match the stored fingerprint' };
    }
    const leaf = new crypto.X509Certificate(leafPem);
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return { ok: false, reason: 'certificate not issued by the pinned CA' };
    if (now < new Date(leaf.validFrom) || now > new Date(leaf.validTo)) return { ok: false, reason: 'certificate expired or not yet valid' };
    const isIp = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
    const match = isIp ? leaf.checkIP(hostname) : leaf.checkHost(hostname);
    if (!match) return { ok: false, reason: `certificate is not valid for ${hostname}` };
    return { ok: true, reason: 'pinned' };
  } catch (err) {
    return { ok: false, reason: `invalid certificate: ${err.message}` };
  }
}

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Only these print options pass from a page to webContents.print(). */
function sanitizePrintOptions(opts = {}) {
  const out = { silent: Boolean(opts.silent), printBackground: true };
  if (typeof opts.deviceName === 'string' && opts.deviceName.length <= 256) out.deviceName = opts.deviceName;
  const copies = Number(opts.copies);
  if (Number.isInteger(copies) && copies >= 1 && copies <= 20) out.copies = copies;
  if (opts.landscape === true) out.landscape = true;
  return out;
}

/** Web permission requests from pages: everything denied except clipboard write (copy buttons). */
function isPermissionAllowed(permission) {
  return permission === 'clipboard-sanitized-write';
}

/**
 * The single path to "open this link in the user's browser". Only https/mailto pass. In an
 * automated smoke run (`smoke: true`) nothing ever reaches the OS browser: requests are only
 * recorded in `opener.suppressed`, so tests that probe blocked navigation cannot open browser tabs.
 */
function createExternalOpener({ open, smoke }) {
  const suppressed = [];
  const opener = (url) => {
    if (!isSafeExternalUrl(url)) return false;
    if (smoke) {
      suppressed.push(String(url));
      return false;
    }
    open(url);
    return true;
  };
  opener.suppressed = suppressed;
  return opener;
}

module.exports = {
  normalizeServerUrl, sameOrigin, isAllowedNavigation, isSafeExternalUrl, fingerprintOfPem, normalizeFingerprint,
  pairingCode, pairingCodeMatches, verifyPinnedLeaf, compareVersions, sanitizePrintOptions, isPermissionAllowed,
  createExternalOpener,
};
