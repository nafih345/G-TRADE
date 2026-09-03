import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { ACTIVE_BRANCH_KEY } from '../utils/apiClient';
import { useAuth } from './AuthContext';

const BranchContext = createContext(null);

export const useBranch = () => useContext(BranchContext) || {
  multiBranchEnabled: false, activeBranch: null, branches: [], isAdmin: false,
  setActiveBranch: () => {}, refresh: () => {},
};

/**
 * Centralized active-branch state (spec section 14). One `/api/company/branch-context/`
 * call hydrates: the multi-branch flag, the branches this user may access, and the
 * currently-active branch. `setActiveBranch` persists the id to localStorage *before*
 * updating React state so the axios interceptor picks it up on the very next request.
 */
export const BranchProvider = ({ children }) => {
  const { user } = useAuth();
  const [multiBranchEnabled, setMultiBranchEnabled] = useState(false);
  const [branches, setBranches] = useState([]);
  const [activeBranch, setActiveBranchState] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/company/branch-context/');
      setMultiBranchEnabled(!!data.multi_branch_enabled);
      setIsAdmin(!!data.is_admin);
      setBranches(data.branches || []);

      const stored = localStorage.getItem(ACTIVE_BRANCH_KEY);
      const allowed = (data.branches || []).map(b => b.id);
      let active = (data.branches || []).find(b => b.id === stored)
        || data.active_branch
        || data.default_branch
        || (data.branches || [])[0]
        || null;
      if (data.multi_branch_enabled && stored && !allowed.includes(stored) && active) {
        // Stored branch is no longer accessible — fall back and rewrite storage.
        localStorage.setItem(ACTIVE_BRANCH_KEY, active.id);
      } else if (active && !stored) {
        localStorage.setItem(ACTIVE_BRANCH_KEY, active.id);
      }
      setActiveBranchState(active);
    } catch {
      setMultiBranchEnabled(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, user]);

  const setActiveBranch = useCallback((branchId) => {
    localStorage.setItem(ACTIVE_BRANCH_KEY, branchId);
    setActiveBranchState(prev => branches.find(b => b.id === branchId) || prev);
    window.dispatchEvent(new CustomEvent('active_branch_changed', { detail: { branchId } }));
  }, [branches]);

  return (
    <BranchContext.Provider value={{
      multiBranchEnabled, branches, activeBranch, isAdmin, loaded,
      setActiveBranch, refresh,
    }}>
      {children}
    </BranchContext.Provider>
  );
};
