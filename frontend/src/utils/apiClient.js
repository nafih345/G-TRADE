// Global axios request interceptor for Multi-Branch context.
//
// Every API call in this app uses the shared `axios` default instance (see main.jsx),
// so attaching the branch/identity headers here — in one place — covers all ~30 call
// sites without touching them. The backend's BranchContextMiddleware reads these to
// resolve the active branch and enforce per-user branch access.
import axios from 'axios';

export const ACTIVE_BRANCH_KEY = 'active_branch_id';

function readProfile() {
  try {
    return JSON.parse(localStorage.getItem('user_profile') || '{}');
  } catch {
    return {};
  }
}

let installed = false;

export function installBranchInterceptor() {
  if (installed) return;
  installed = true;

  axios.interceptors.request.use((config) => {
    try {
      const branchId = localStorage.getItem(ACTIVE_BRANCH_KEY);
      if (branchId) config.headers['X-Branch-Id'] = branchId;

      const profile = readProfile();
      if (profile.username) config.headers['X-User-Name'] = profile.username;
      if (profile.role) config.headers['X-User-Role'] = profile.role;
    } catch {
      /* headers are best-effort — never block a request over them */
    }
    return config;
  });
}
