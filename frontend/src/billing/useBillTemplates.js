import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchTemplates, fetchAssignments, fetchBillingSettings,
  createTemplate, updateTemplate, deleteTemplate, duplicateTemplate,
  setDefaultTemplate, activateTemplate, deactivateTemplate,
  bulkUpdateAssignments, updateBillingSettings,
} from './billingApi';
import { PRESET_TEMPLATES, DEFAULT_ASSIGNMENTS } from './templatePresets';
import { invalidateBillingContext } from './billingContext';

const KEYS = {
  templates: ['billing', 'templates'],
  assignments: ['billing', 'assignments'],
  settings: ['billing', 'settings'],
};

export function useBillTemplates() {
  const qc = useQueryClient();

  const templatesQ = useQuery({
    queryKey: KEYS.templates,
    queryFn: fetchTemplates,
    placeholderData: PRESET_TEMPLATES,
    staleTime: 30_000,
  });

  const assignmentsQ = useQuery({
    queryKey: KEYS.assignments,
    queryFn: fetchAssignments,
    staleTime: 30_000,
  });

  const settingsQ = useQuery({
    queryKey: KEYS.settings,
    queryFn: fetchBillingSettings,
    staleTime: 30_000,
  });

  const refetchAll = () => {
    invalidateBillingContext();
    qc.invalidateQueries({ queryKey: ['billing'] });
  };
  const opts = { onSuccess: refetchAll };

  const createM = useMutation({ mutationFn: createTemplate, ...opts });
  const updateM = useMutation({ mutationFn: ({ id, payload }) => updateTemplate(id, payload), ...opts });
  const deleteM = useMutation({ mutationFn: deleteTemplate, ...opts });
  const duplicateM = useMutation({ mutationFn: duplicateTemplate, ...opts });
  const setDefaultM = useMutation({ mutationFn: setDefaultTemplate, ...opts });
  const activateM = useMutation({ mutationFn: activateTemplate, ...opts });
  const deactivateM = useMutation({ mutationFn: deactivateTemplate, ...opts });
  const saveAssignmentsM = useMutation({ mutationFn: bulkUpdateAssignments, ...opts });
  const saveSettingsM = useMutation({ mutationFn: updateBillingSettings, ...opts });

  return {
    templates: templatesQ.data || PRESET_TEMPLATES,
    assignments: assignmentsQ.data || [],
    settings: settingsQ.data || {},
    isLoading: templatesQ.isLoading,
    isBackendLive: !templatesQ.isError,
    refetchAll,

    createTemplate: createM,
    updateTemplate: updateM,
    deleteTemplate: deleteM,
    duplicateTemplate: duplicateM,
    setDefaultTemplate: setDefaultM,
    activateTemplate: activateM,
    deactivateTemplate: deactivateM,
    saveAssignments: saveAssignmentsM,
    saveSettings: saveSettingsM,
  };
}

export { DEFAULT_ASSIGNMENTS };
