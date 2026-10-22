// API calls for Settings → System Security & Backup and the session/re-auth plumbing.
import axios from 'axios';

const data = (r) => r.data;

export const securityApi = {
  getSettings: () => axios.get('/api/security/settings/').then(data),
  saveSettings: (body) => axios.patch('/api/security/settings/', body).then(data),
  policy: () => axios.get('/api/security/policy/').then(data),
  heartbeat: () => axios.post('/api/security/session/heartbeat/'),
  reauth: (password, code) => axios.post('/api/security/reauth/', { password, code }).then(data),
  twoFactorSetup: () => axios.post('/api/security/two-factor/setup/').then(data),
  twoFactorConfirm: (code) => axios.post('/api/security/two-factor/confirm/', { code }).then(data),
  twoFactorDisable: (password, code) => axios.post('/api/security/two-factor/disable/', { password, code }).then(data),
  auditLog: (params) => axios.get('/api/security/audit-log/', { params }).then(data),
};

export const backupApi = {
  health: () => axios.get('/api/backups/health/').then(data),
  history: (params) => axios.get('/api/backups/history/', { params }).then(data),
  create: () => axios.post('/api/backups/create/').then(data),
  get: (id) => axios.get(`/api/backups/${id}/`).then(data),
  remove: (id) => axios.delete(`/api/backups/${id}/`).then(data),
  upload: (file, onProgress) => {
    const form = new FormData();
    form.append('file', file);
    return axios.post('/api/backups/upload/', form, {
      onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded * 100) / e.total) : null),
    }).then(data);
  },
  restore: (body) => axios.post('/api/backups/restore/', body).then(data),
  restoreStatus: (id) => axios.get(`/api/backups/restore/${id}/`).then(data),
  schedule: () => axios.get('/api/backups/schedule/').then(data),
  saveSchedule: (body) => axios.put('/api/backups/schedule/', body).then(data),

  /** Mint a short-lived signed link and let the browser stream the file natively. */
  async download(id) {
    const { url, filename } = await axios.post(`/api/backups/${id}/download-link/`).then(data);
    const base = (axios.defaults.baseURL || '').replace(/\/$/, '');
    const a = document.createElement('a');
    a.href = `${base}${url}`;
    a.download = filename || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return filename;
  },
};

/** Field errors from a 400 {errors: {...}} body. */
export const fieldErrors = (err) => (err?.response?.status === 400 && err.response.data?.errors) || {};

/** Poll `fn` every `ms` until `done(result)`; returns a cancel function. */
export function poll(fn, done, { ms = 1500, onUpdate, onError } = {}) {
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await fn();
      if (stopped) return;
      onUpdate?.(result);
      if (done(result)) return;
    } catch (e) {
      if (stopped) return;
      onError?.(e);
    }
    timer = setTimeout(tick, ms);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}
