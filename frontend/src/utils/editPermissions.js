// Direct Edit switches + admin-approved edit requests in the browser.
//
// The rules live on the server (backend/apps/authentication/edit_permissions.py). The profile
// carries user.edit_permissions = { eye_test, sales, wholesale, inventory, purchase, accounts }
// (true = Direct Edit ON). With a switch OFF, a saved record of that module opens for editing
// only after an admin approves an edit request for that exact record, and the approval is used
// up by the first successful save.
//
//   ensureEditAccess({ module, recordId, recordRef })  → Promise<boolean>
//     Call before opening a saved record for editing. true = go ahead (Direct Edit ON, or an
//     approval is waiting). false = keep the record read-only; the "Edit Permission Required"
//     dialog (<EditPermissionHost />) has been shown so the user can send a request.
//
//   installEditApprovalInterceptor()
//     Safety net: any save the server refuses with code `edit_approval_required` opens the same
//     dialog for that record, so a screen without an explicit check still leads to a request.
import axios from 'axios';
import { notify } from './notify';

export const EDIT_MODULES = [
  { key: 'eye_test', label: 'Eye Test' },
  { key: 'sales', label: 'Retail Sales' },
  { key: 'wholesale', label: 'Wholesale Distribution' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'purchase', label: 'Purchase Entry' },
  { key: 'accounts', label: 'Financial Accounts & Ledgers' },
];
export const EDIT_MODULE_LABELS = Object.fromEntries(EDIT_MODULES.map(m => [m.key, m.label]));

const readProfile = () => {
  try { return JSON.parse(localStorage.getItem('user_profile') || 'null'); } catch { return null; }
};

// The cached switch. Profiles cached before the switches existed have no map: treat as ON (the
// server still enforces the real value).
export const hasDirectEdit = (module, user = readProfile()) => {
  const perms = user?.edit_permissions;
  return !perms || perms[module] !== false;
};

// ---- dialog bus (rendered by components/EditPermissionHost.jsx) ------------------------------
const listeners = new Set();
let current = null;
const emit = () => listeners.forEach(fn => fn(current));

export const subscribeEditDialog = (fn) => {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
};

export const closeEditDialog = () => {
  current = null;
  emit();
};

// { module, recordId, recordRef, request, mode, message }
export const openEditDialog = (info) => {
  current = { ...info, openedAt: Date.now() };
  emit();
};

const isRealId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export async function ensureEditAccess({ module, recordId, recordRef = '' }) {
  if (hasDirectEdit(module)) return true;
  // A record that only exists on this device (offline copy) has nothing to approve on the server.
  if (!isRealId(String(recordId || ''))) return true;
  let data;
  try {
    ({ data } = await axios.get('/api/auth/edit-requests/access/', {
      params: { module, record_id: recordId }, __silentError: true,
    }));
  } catch (e) {
    notify('Could not check your edit permission — the record stays read-only. Try again.', 'warning');
    return false;
  }
  if (data?.allowed) {
    if (data.mode === 'approved') {
      notify(`Edit approved by ${data.request?.reviewed_by_name || 'admin'} — this record unlocks for one save.`, 'success');
    }
    return true;
  }
  openEditDialog({ module, recordId: String(recordId), recordRef, request: data?.request || null, mode: data?.mode });
  return false;
}

export async function sendEditRequest({ module, recordId, recordRef, reason }) {
  const { data } = await axios.post('/api/auth/edit-requests/', {
    module, record_id: recordId, record_ref: recordRef || '', reason,
  });
  return data;
}

export const fetchPendingEditCount = async () => {
  try {
    const { data } = await axios.get('/api/auth/edit-requests/pending-count/', { __silentError: true });
    return data?.reviewer ? (data.count || 0) : 0;
  } catch { return 0; }
};

let installed = false;
export function installEditApprovalInterceptor() {
  if (installed) return;
  installed = true;
  axios.interceptors.response.use(undefined, (error) => {
    const data = error?.response?.data;
    if (error?.response?.status === 403 && data?.code === 'edit_approval_required' && data.record_id) {
      openEditDialog({
        module: data.module, recordId: data.record_id, recordRef: data.record_ref || '',
        mode: (data.request_status || '').toLowerCase() || 'none', message: data.detail, request: null,
      });
    }
    return Promise.reject(error);
  });
}
