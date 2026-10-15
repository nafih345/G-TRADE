// Loads label templates + print settings + the field catalog once per mount, runs the
// one-time import of browser-stored legacy designs, and resolves which template a
// workflow (inventory / purchase / barcode_printing) should print with.
import { useCallback, useEffect, useState } from 'react';
import { fetchLabelBundle, importLegacyIfNeeded, apiError } from './labelApi.js';

export const WORKFLOWS = [
  { id: 'inventory', label: 'Inventory → Products', key: 'inventory_template' },
  { id: 'purchase', label: 'Purchase → Purchase Entry', key: 'purchase_template' },
  { id: 'barcode_printing', label: 'Barcode Printing', key: 'barcode_printing_template' },
];

export function templateForWorkflow(bundle, workflow) {
  const templates = bundle?.templates || [];
  const key = WORKFLOWS.find((w) => w.id === workflow)?.key;
  const assigned = key && bundle?.settings?.[key];
  return templates.find((t) => t.id === assigned) || templates.find((t) => t.is_default) || templates[0] || null;
}

export default function useLabelBundle(active = true) {
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let b = await fetchLabelBundle();
      if (!b.offline && b.settings && !b.settings.legacy_migrated) {
        const imported = await importLegacyIfNeeded(b.settings);
        if (imported?.imported) b = await fetchLabelBundle();
      }
      setBundle(b);
      if (b.offline) setError(`Showing saved copies of your templates — ${b.error}`);
      return b;
    } catch (err) {
      setError(apiError(err, 'Could not load label templates.'));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  return { bundle, setBundle, loading, error, reload };
}
