import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  FormGroup, FormHelperText, Grid, IconButton, InputAdornment, MenuItem, Switch, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, Badge as BadgeIcon, Delete as DeleteIcon, Edit as EditIcon, Percent as PercentIcon,
  Public as CountryIcon, Star as StarIcon,
} from '@mui/icons-material';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import { EmptyState, GREEN, SectionCard, errText, greenButtonSx } from './businessUi';
import { notify } from '../../../utils/notify';
import { apiErrorMessage } from '../../../utils/apiError';
import { getBusinessPrefsState, saveBusinessPrefs, taxTermsForCountry } from '../../../utils/businessPrefs';
import { notifyTaxSlabsChanged } from '../../../context/SettingsContext';

const URL = '/api/company/tax-config/';
const TAX_TYPES = { GST: 'GST (CGST + SGST)', IGST: 'IGST', VAT: 'VAT', CESS: 'Cess', SALES_TAX: 'Sales tax', OTHER: 'Other' };
const CATEGORIES = { STANDARD: 'Standard rated', ZERO_RATED: 'Zero rated', EXEMPT: 'Exempt', NIL_RATED: 'Nil rated', NON_TAXABLE: 'Non-taxable' };
const ZERO = new Set(['ZERO_RATED', 'EXEMPT', 'NIL_RATED', 'NON_TAXABLE']);
// The tax type a new rate starts with for the business's tax regime.
const DEFAULT_TYPE = { GST: 'GST', VAT: 'VAT', 'Sales Tax': 'SALES_TAX', Tax: 'OTHER' };
const BLANK = {
  name: '', rate: '', tax_type: 'GST', treatment: 'EXCLUSIVE', category: 'STANDARD', applies_to_sales: true,
  applies_to_purchases: true, is_active: true, is_default: false, description: '',
};

function TaxDialog({ open, initial, onClose, onSaved, taxLabel }) {
  const [form, setForm] = useState(BLANK);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(initial ? { ...BLANK, ...initial } : { ...BLANK, tax_type: DEFAULT_TYPE[taxLabel] || 'OTHER' });
    setErrors({});
  }, [open, initial, taxLabel]);

  const set = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v };
    if (k === 'category' && ZERO.has(v)) next.rate = '0';
    return next;
  });

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = `Enter a ${taxLabel} name.`;
    const r = Number(form.rate);
    if (form.rate === '' || !Number.isFinite(r)) e.rate = 'Enter the rate as a percentage, e.g. 18 or 0.';
    else if (r < 0 || r > 100) e.rate = 'The rate must be between 0 and 100.';
    else if (ZERO.has(form.category) && r !== 0) e.rate = 'This category must have a 0% rate.';
    else if (form.category === 'STANDARD' && r === 0) e.category = 'A 0% rate needs the Zero rated, Exempt, Nil rated or Non-taxable category.';
    if (!form.applies_to_sales && !form.applies_to_purchases) e.applies_to_sales = 'Apply the rate to sales, purchases or both.';
    if (form.is_default && !form.is_active) e.is_default = 'An inactive rate cannot be the default.';
    return e;
  };

  const save = async () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = { ...form, rate: String(form.rate) };
      const res = initial?.id ? await axios.put(`${URL}${initial.id}/`, body) : await axios.post(URL, body);
      notify(`${taxLabel} rate ${res.data.name} ${initial?.id ? 'updated' : 'created'}.`, 'success');
      onSaved();
    } catch (err) {
      const data = err?.response?.data;
      if (data?.errors) setErrors(data.errors);
      notify(data?.detail || apiErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 800 }}>{initial?.id ? `Edit ${taxLabel} Rate` : `Add ${taxLabel} Rate`}</DialogTitle>
      <DialogContent dividers>
        {initial?.id && initial.product_count > 0 && (
          <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
            Used by {initial.product_count} product(s). Completed bills keep the rate they were billed at.
          </Alert>
        )}
        <Grid container spacing={2}>
          <Grid item xs={12} sm={7}>
            <TextField fullWidth autoFocus required label={`${taxLabel} Name`} value={form.name} onChange={(e) => set('name', e.target.value)}
              error={!!errors.name} helperText={errText(errors.name) || `e.g. ${taxLabel} ${taxLabel === 'GST' ? 18 : 5}%`}
              inputProps={{ maxLength: 50 }} />
          </Grid>
          <Grid item xs={12} sm={5}>
            <TextField fullWidth required type="number" label="Percentage" value={form.rate} onChange={(e) => set('rate', e.target.value)}
              disabled={ZERO.has(form.category)} inputProps={{ min: 0, max: 100, step: 0.01 }}
              InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
              error={!!errors.rate} helperText={errText(errors.rate) || '0 – 100, up to 2 decimals.'} />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField select fullWidth label="Tax Type" value={form.tax_type} onChange={(e) => set('tax_type', e.target.value)}
              error={!!errors.tax_type} helperText={errText(errors.tax_type)}>
              {Object.entries(TAX_TYPES).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField select fullWidth label="Category" value={form.category} onChange={(e) => set('category', e.target.value)}
              error={!!errors.category} helperText={errText(errors.category) || 'Zero-rated and exempt supplies are kept apart.'}>
              {Object.entries(CATEGORIES).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField select fullWidth label="Inclusive / Exclusive" value={form.treatment} onChange={(e) => set('treatment', e.target.value)}
              helperText={form.treatment === 'INCLUSIVE' ? `Prices already include this ${taxLabel}.` : `${taxLabel} is added on top of the price.`}>
              <MenuItem value="EXCLUSIVE">Exclusive</MenuItem>
              <MenuItem value="INCLUSIVE">Inclusive</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <FormGroup>
              <Typography variant="caption" color="text.secondary">Applicable transactions</Typography>
              <FormControlLabel control={<Checkbox checked={form.applies_to_sales} onChange={(e) => set('applies_to_sales', e.target.checked)} />} label="Sales" />
              <FormControlLabel control={<Checkbox checked={form.applies_to_purchases} onChange={(e) => set('applies_to_purchases', e.target.checked)} />} label="Purchases" />
              {errors.applies_to_sales && <FormHelperText error>{errText(errors.applies_to_sales)}</FormHelperText>}
            </FormGroup>
          </Grid>
          <Grid item xs={12}>
            <TextField fullWidth label="Description" value={form.description} onChange={(e) => set('description', e.target.value)}
              inputProps={{ maxLength: 200 }} />
          </Grid>
          <Grid item xs={12} sm={6}>
            <FormControlLabel control={<Switch checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />} label="Active" />
          </Grid>
          <Grid item xs={12} sm={6}>
            <FormControlLabel control={<Switch checked={form.is_default} onChange={(e) => set('is_default', e.target.checked)} />} label={`Default ${taxLabel} rate`} />
            {errors.is_default && <FormHelperText error>{errText(errors.is_default)}</FormHelperText>}
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving} sx={greenButtonSx}>{saving ? 'Saving…' : `Save ${taxLabel} Rate`}</Button>
      </DialogActions>
    </Dialog>
  );
}

const normReg = (v) => String(v || '').replace(/\s/g, '').toUpperCase();

/**
 * Settings → Business & Localization → Tax Configuration.
 *   prefs          the saved Business & Localization preferences (country, tax_enabled)
 *   onPrefsSaved   called with the server payload after the switch / registration number saves
 *   onNavigate     switch to another Business & Localization section
 */
export default function TaxConfigTab({ prefs, onPrefsSaved, onNavigate }) {
  const [taxes, setTaxes] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // null closed | {} new | tax
  const [deleting, setDeleting] = useState(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [regNo, setRegNo] = useState(() => getBusinessPrefsState().tax_registration_number || '');
  const [savedRegNo, setSavedRegNo] = useState(regNo);
  const [regError, setRegError] = useState('');
  const [regSaving, setRegSaving] = useState(false);

  const country = prefs?.country || 'IN';
  const { label: taxLabel, regLabel } = taxTermsForCountry(country);
  const enabled = prefs?.tax_enabled !== false;

  const load = useCallback(() => {
    axios.get(URL).then((r) => { setTaxes(r.data); setLoadError(''); })
      .catch((e) => setLoadError(`Could not load ${taxLabel} rates. ${apiErrorMessage(e)}`));
  }, [taxLabel]);
  useEffect(() => { load(); }, [load]);
  // The registration number lives on the store; take the freshest copy from the server.
  useEffect(() => {
    axios.get('/api/company/localization/').then((r) => {
      const v = r.data?.tax_registration_number || '';
      setRegNo(v);
      setSavedRegNo(v);
    }).catch(() => {});
  }, []);

  const afterChange = () => { load(); notifyTaxSlabsChanged(); };

  const setEnabled = async (on) => {
    setSwitching(true);
    try {
      const data = await saveBusinessPrefs({ tax_enabled: on });
      onPrefsSaved?.(data);
      notifyTaxSlabsChanged();
      notify(on
        ? `${taxLabel} enabled — rates can be added and edited.`
        : `${taxLabel} disabled — no ${taxLabel} is charged on new bills.`, 'success');
    } catch (e) {
      notify(`Could not change the ${taxLabel} setting. ${e?.response?.data?.detail || apiErrorMessage(e)}`, 'error');
    } finally {
      setSwitching(false);
    }
  };

  const saveRegNo = async () => {
    setRegSaving(true);
    setRegError('');
    try {
      const data = await saveBusinessPrefs({ tax_registration_number: normReg(regNo) });
      const v = data?.tax_registration_number || '';
      setRegNo(v);
      setSavedRegNo(v);
      onPrefsSaved?.(data);
      notify(`${regLabel} saved.`, 'success');
    } catch (e) {
      setRegError(errText(e?.response?.data?.errors?.tax_registration_number) || '');
      notify(`${regLabel} was not saved. ${e?.response?.data?.detail || apiErrorMessage(e)}`, 'error');
    } finally {
      setRegSaving(false);
    }
  };

  const toggleActive = async (tax) => {
    try {
      await axios.put(`${URL}${tax.id}/`, { is_active: !tax.is_active, ...(tax.is_active ? { is_default: false } : {}) });
      notify(`${tax.name} ${tax.is_active ? 'disabled' : 'enabled'}.`, 'success');
      afterChange();
    } catch (e) {
      notify(e?.response?.data?.detail || apiErrorMessage(e), 'error');
    }
  };

  const doDelete = async () => {
    const tax = deleting;
    setDeleting(null);
    try {
      await axios.delete(`${URL}${tax.id}/`);
      notify(`${tax.name} deleted.`, 'success');
      afterChange();
    } catch (e) {
      notify(e?.response?.data?.detail || apiErrorMessage(e), 'error');
    }
  };

  const addButton = (
    <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({})} sx={{ ...greenButtonSx, whiteSpace: 'nowrap' }}>
      Add {taxLabel} Rate
    </Button>
  );

  return (
    <>
      <SectionCard id="tax-master" icon={<PercentIcon />} title="Tax Configuration"
        subtitle="What tax your business charges. The name follows the country set in General; each change here saves immediately.">
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 2 }}>
          <Chip icon={<CountryIcon />} variant="outlined" label={`Country: ${country}`} />
          <Chip variant="outlined" label={`Tax label: ${taxLabel}`} sx={{ fontWeight: 700 }} />
          <Chip variant="outlined" label={`Registration: ${regLabel}`} />
          {onNavigate && <Button size="small" onClick={() => onNavigate('general')}>Change country</Button>}
        </Box>
        <Box sx={{
          p: 2, border: '1px solid', borderColor: enabled ? GREEN : 'divider', borderRadius: 2,
          bgcolor: enabled ? 'rgba(22,163,74,0.04)' : 'action.hover',
        }}>
          <FormControlLabel
            control={(
              <Switch checked={enabled} disabled={switching}
                onChange={(e) => (e.target.checked ? setEnabled(true) : setConfirmOff(true))}
                inputProps={{ 'aria-label': `Enable ${taxLabel}`, 'data-testid': 'tax-master-switch' }} />
            )}
            label={<Typography fontWeight={800}>Enable {taxLabel}</Typography>}
          />
          <Typography variant="body2" color="text.secondary" sx={{ ml: 6 }}>
            {enabled
              ? `${taxLabel} is charged on sales and purchases using the rates below, and shown on products, billing screens and invoice prints.`
              : `${taxLabel} is off: no ${taxLabel} is charged on new bills, and ${taxLabel} fields, columns and print lines are hidden. Bills already saved keep the tax they were billed with.`}
          </Typography>
        </Box>
      </SectionCard>

      {enabled && (
        <SectionCard id="tax-registration" icon={<BadgeIcon />} title={regLabel}
          subtitle={`Your ${taxLabel} registration number — printed on invoices.`}>
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField size="small" label={regLabel} value={regNo} sx={{ minWidth: 280 }}
              onChange={(e) => { setRegNo(e.target.value.toUpperCase()); setRegError(''); }}
              placeholder={country === 'IN' ? '32ABCDE1234F1Z5' : ''}
              inputProps={{ maxLength: 20, 'data-testid': 'tax-reg-number' }}
              error={!!regError}
              helperText={regError || (country === 'IN' ? '15-character GSTIN.' : 'Up to 15 letters, digits or hyphens.')} />
            <Button variant="contained" onClick={saveRegNo} disabled={normReg(regNo) === savedRegNo || regSaving} sx={greenButtonSx}>
              {regSaving ? 'Saving…' : `Save ${regLabel}`}
            </Button>
          </Box>
        </SectionCard>
      )}

      {enabled && (
        <SectionCard id="tax-config" icon={<PercentIcon />} title={`${taxLabel} Details & Slabs`}
          subtitle={`${taxLabel} rates used on products, sales and purchases. Each change saves immediately.`}
          action={taxes?.length ? addButton : null}>
          {loadError && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{loadError}</Alert>}
          {!loadError && taxes === null && <Typography variant="body2" color="text.secondary">Loading {taxLabel} rates…</Typography>}
          {taxes && taxes.length === 0 && (
            <EmptyState icon={<PercentIcon />} title={`No ${taxLabel} rates configured`}
              description={`Add the ${taxLabel} rates your business charges — including 0% zero-rated or exempt supplies.`} action={addButton} />
          )}
          {taxes && taxes.length > 0 && (
            <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
              <Table size="small" sx={{ minWidth: 820 }}>
                <TableHead>
                  <TableRow sx={{ '& th': { fontWeight: 700, bgcolor: 'action.hover' } }}>
                    <TableCell>Name</TableCell>
                    <TableCell align="right">Rate</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell>Treatment</TableCell>
                    <TableCell>Applies to</TableCell>
                    <TableCell align="right">Products</TableCell>
                    <TableCell>Active</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {taxes.map((t) => (
                    <TableRow key={t.id} hover sx={{ opacity: t.is_active ? 1 : 0.6 }}>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                          <Typography variant="body2" fontWeight={700}>{t.name}</Typography>
                          {t.is_default && <Tooltip title={`Default ${taxLabel} rate`}><StarIcon sx={{ fontSize: 16, color: GREEN }} /></Tooltip>}
                        </Box>
                        {t.description && <Typography variant="caption" color="text.secondary">{t.description}</Typography>}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>{Number(t.rate)}%</TableCell>
                      <TableCell>{TAX_TYPES[t.tax_type] || t.tax_type}</TableCell>
                      <TableCell><Chip size="small" label={CATEGORIES[t.category] || t.category} variant="outlined" /></TableCell>
                      <TableCell>{t.treatment === 'INCLUSIVE' ? 'Inclusive' : 'Exclusive'}</TableCell>
                      <TableCell>{[t.applies_to_sales && 'Sales', t.applies_to_purchases && 'Purchases'].filter(Boolean).join(', ')}</TableCell>
                      <TableCell align="right">{t.product_count ?? '—'}</TableCell>
                      <TableCell>
                        <Switch size="small" checked={t.is_active} onChange={() => toggleActive(t)} inputProps={{ 'aria-label': `${t.is_active ? 'Disable' : 'Enable'} ${t.name}` }} />
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Tooltip title="Edit"><IconButton size="small" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}><EditIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title={t.product_count ? 'In use by products — deactivate instead' : 'Delete'}>
                          <span>
                            <IconButton size="small" color="error" disabled={!!t.product_count} onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <TaxDialog open={editing !== null} initial={editing?.id ? editing : null} onClose={() => setEditing(null)}
            taxLabel={taxLabel} onSaved={() => { setEditing(null); afterChange(); }} />
          <ConfirmActionDialog open={!!deleting} type="danger" title={`Delete ${taxLabel} rate?`}
            message={deleting ? `Delete ${deleting.name} (${Number(deleting.rate)}%)? Completed bills keep their billed rate.` : ''}
            confirmText="Delete" cancelText="Cancel" onConfirm={doDelete} onClose={() => setDeleting(null)} />
        </SectionCard>
      )}

      <ConfirmActionDialog open={confirmOff} type="warning" title={`Disable ${taxLabel}?`}
        message={`New bills will charge no ${taxLabel}, and ${taxLabel} fields are hidden on products, sales, purchases and prints. Your rates are kept and come back when you switch ${taxLabel} on again.`}
        confirmText={`Disable ${taxLabel}`} cancelText="Cancel"
        onConfirm={() => { setConfirmOff(false); setEnabled(false); }} onClose={() => setConfirmOff(false)} />
    </>
  );
}
