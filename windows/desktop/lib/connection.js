'use strict';
// Server connection: config storage, pairing (fetch + pin the CA), pinned health checks.
// Plain Node (tls/https/fs) so it is unit-testable without Electron.

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const https = require('node:https');
const { PRODUCT_NAME } = require('./brand');
const crypto = require('node:crypto');
const sec = require('./security');

// 'G-TRADE' below is the internal data folder name (kept for upgrades), not product branding.
const MACHINE_CONFIG = path.join(process.env.ProgramData || 'C:\\ProgramData', 'G-TRADE', 'client', 'client.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A stored connection is usable only if every field is present and the CA PEM matches its pin. */
function validateConnection(c) {
  if (!c || typeof c !== 'object') return null;
  try {
    const { origin } = sec.normalizeServerUrl(c.serverUrl);
    const fp = sec.normalizeFingerprint(c.caFingerprint);
    if (!fp || !c.caPem || sec.fingerprintOfPem(c.caPem) !== fp) return null;
    return { serverUrl: origin, caFingerprint: fp, caPem: c.caPem, mode: c.mode || 'workstation', source: c.source };
  } catch {
    return null;
  }
}

/** User choice (userData/connection.json) wins over the machine default written by the installer. */
function loadConnection(userFile, machineFile = MACHINE_CONFIG) {
  const user = validateConnection({ ...readJson(userFile), source: 'user' });
  if (user) return user;
  return validateConnection({ ...readJson(machineFile), source: 'machine' });
}

function saveUserConnection(userFile, conn) {
  const v = validateConnection(conn);
  if (!v) throw new Error('Connection details are incomplete or the certificate does not match.');
  writeJsonAtomic(userFile, { serverUrl: v.serverUrl, caFingerprint: v.caFingerprint, caPem: v.caPem, mode: v.mode,
    savedAt: new Date().toISOString() });
  return v;
}

function derToPem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * First contact with a LAN server: read the certificate chain WITHOUT trusting it, and return the
 * root CA so the user can confirm it with the pairing code from the server's connection sheet.
 */
function probeServerCa(serverUrl, timeoutMs = 6000) {
  const { host, port } = sec.normalizeServerUrl(serverUrl);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: /^[0-9.:]+$/.test(host) ? undefined : host,
      rejectUnauthorized: false, timeout: timeoutMs }, () => {
      let cert = sock.getPeerCertificate(true);
      const seen = new Set();
      while (cert && cert.issuerCertificate && cert.issuerCertificate !== cert && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        cert = cert.issuerCertificate;
      }
      sock.end();
      if (!cert || !cert.raw) return reject(new Error('The server did not present a certificate.'));
      const caPem = derToPem(cert.raw);
      const x = new crypto.X509Certificate(caPem);
      if (!x.ca) return reject(new Error(`The server did not send its ${PRODUCT_NAME} certificate authority.`));
      const fp = sec.fingerprintOfPem(caPem);
      resolve({ caPem, caFingerprint: fp, pairingCode: sec.pairingCode(fp), subject: x.subject });
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`No answer from ${host}:${port}.`)); });
    sock.on('error', (e) => reject(new Error(`Cannot reach ${host}:${port} (${e.code || e.message}).`)));
  });
}

/** GET a JSON endpoint over TLS that trusts ONLY the pinned CA. */
function pinnedGetJson(serverUrl, caPem, pathName, timeoutMs = 8000) {
  const { host, port } = sec.normalizeServerUrl(serverUrl);
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: pathName, method: 'GET', ca: caPem, timeout: timeoutMs,
      servername: /^[0-9.:]+$/.test(host) ? undefined : host, headers: { Accept: 'application/json', 'User-Agent': 'G-TRADE-Desktop' },
      agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }); } catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** One status verdict for the UI: online | degraded | offline (+ server version, incompatibility). */
async function checkServer(conn, appVersion) {
  try {
    const { status, json } = await pinnedGetJson(conn.serverUrl, conn.caPem, '/api/health/');
    if (status !== 200 || !json) return { state: 'offline', detail: `HTTP ${status}` };
    if (json.edition !== 'local') return { state: 'degraded', detail: `${NOT_LOCAL_SERVER}.` };
    const tooOld = json.min_client_version && sec.compareVersions(appVersion, json.min_client_version) < 0;
    const state = json.status === 'ok' && !json.maintenance ? 'online' : 'degraded';
    let detail = json.maintenance ? `Maintenance: ${json.maintenance}` : (state === 'online' ? '' : `Database ${json.database}; migrations ${json.migrations}`);
    if (tooOld) detail = `This desktop app (${appVersion}) is older than the server requires (${json.min_client_version}). Update it.`;
    return { state: tooOld ? 'degraded' : state, detail, serverVersion: json.server_version || '', mode: json.mode || '',
      clientTooOld: Boolean(tooOld), license: json.license || null };
  } catch (err) {
    const tlsErr = /certificate|self[- ]signed|altname|CERT/i.test(err.message);
    return { state: 'offline', detail: tlsErr ? `Security check failed: ${err.message}` : err.message, tlsError: tlsErr };
  }
}

// Prefix main.js matches to tell 'wrong kind of server' from a transient outage.
const NOT_LOCAL_SERVER = `Not a ${PRODUCT_NAME} local server`;

module.exports = { MACHINE_CONFIG, NOT_LOCAL_SERVER, loadConnection, saveUserConnection, validateConnection, probeServerCa,
  pinnedGetJson, checkServer, derToPem, writeJsonAtomic, readJson };
