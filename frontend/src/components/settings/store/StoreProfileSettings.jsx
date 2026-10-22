import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Avatar, Box, Button, Checkbox, Collapse,
  FormControlLabel, Grid, IconButton, InputAdornment, MenuItem, Paper, Skeleton, Stack, Switch,
  TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  Storefront as StoreIcon, Phone as PhoneIcon, WhatsApp as WhatsAppIcon, Email as EmailIcon,
  Language as WebIcon, MedicalServices as ClinicIcon, CloudUpload as UploadIcon,
  DeleteOutline as DeleteIcon, ExpandMore as ExpandIcon, Add as AddIcon, Close as CloseIcon,
  Undo as UndoIcon, Save as SaveIcon, Image as ImageIcon,
} from '@mui/icons-material';
import { useBranch } from '../../../context/BranchContext';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import { invalidateBillingContext } from '../../../billing/billingContext';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { setNavigationGuard, confirmLeave } from '../../../utils/navigationGuard';
import {
  ADDRESS_KINDS, COUNTRIES, INDIAN_STATES, STORE_TYPES, WEEKDAYS, fetchStoreProfile, formatPhone,
  isIndia, profileToForm, saveStoreProfile, stateForGstin, validateProfile,
} from '../../../utils/storeProfile';
import BrandPreviewCard from './BrandPreviewCard';
import ProfileCompletenessCard from './ProfileCompletenessCard';
import InvoicePreviewDialog from './InvoicePreviewDialog';
import {
  GREEN, GREEN_SOFT, LOGO_HINT, SectionCard, greenButtonSx, prepareLogo,
} from './storeUi';

const LEAVE_MESSAGE = 'You have unsaved changes to the Store & Clinic Profile. Leave without saving?';

// Immutable set for dotted paths ("clinic_settings.exam_start", "extra_addresses.billing.city").
function setIn(obj, path, value) {
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { ...obj, [head]: value };
  return { ...obj, [head]: setIn(obj[head] || {}, rest.join('.'), value) };
}
const getIn = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

const sameForm = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const StoreProfileSettings = forwardRef(function StoreProfileSettings({ onStateChange, onOpenTab }, ref) {
  const navigate = useNavigate();
  const { multiBranchEnabled } = useBranch();
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(() => profileToForm({}));
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [logoMsg, setLogoMsg] = useState({ error: '', warning: '' });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [addressesOpen, setAddressesOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef(null);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await fetchStoreProfile({ completeness: true });
      setSaved(data);
      setForm(profileToForm(data));
      setErrors({});
    } catch (e) {
      setLoadError(`Couldn't load the store profile. ${apiErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const savedForm = useMemo(() => (saved ? profileToForm(saved) : null), [saved]);
  const dirty = !!savedForm && !sameForm(form, savedForm);

  // ---- unsaved-changes protection ---------------------------------------------------------
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = LEAVE_MESSAGE; return LEAVE_MESSAGE; };
    window.addEventListener('beforeunload', onBeforeUnload);
    const release = setNavigationGuard(LEAVE_MESSAGE);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); release(); };
  }, [dirty]);

  const set = (path, value) => {
    setForm((f) => setIn(f, path, value));
    setStatus(null);
    if (errors[path]) setErrors((e) => { const n = { ...e }; delete n[path]; return n; });
  };

  const focusField = (path) => {
    if (path.startsWith('extra_addresses')) setAddressesOpen(true);
    setTimeout(() => {
      const el = document.getElementById(`sp-${path}`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); }
    }, 60);
  };

  const save = useCallback(async () => {
    if (savingRef.current || !saved) return false;
    const errs = validateProfile(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setStatus({ type: 'error', msg: 'Please fix the highlighted fields before saving.' });
      focusField(Object.keys(errs)[0]);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setStatus(null);
    try {
      const data = await saveStoreProfile({ ...form, gstin: form.gstin.replace(/\s/g, '').toUpperCase() });
      setSaved(data);
      setForm(profileToForm(data));
      invalidateBillingContext();
      setStatus({ type: 'success', msg: 'Store profile saved. Invoices, receipts and labels now use these details.' });
      notify('Store profile saved.', 'success');
      return true;
    } catch (e) {
      const body = e?.response?.data;
      if (body?.errors) {
        setErrors(body.errors);
        focusField(Object.keys(body.errors)[0]);
      }
      setStatus({ type: 'error', msg: body?.detail || apiErrorMessage(e, 'The store profile could not be saved.') });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, saved]);

  const discard = useCallback(() => {
    if (savedForm) setForm(savedForm);
    setErrors({});
    setLogoMsg({ error: '', warning: '' });
    setStatus({ type: 'info', msg: 'Changes discarded — the last saved values are restored.' });
  }, [savedForm]);

  useImperativeHandle(ref, () => ({ save, discard, isDirty: () => dirty }), [save, discard, dirty]);
  useEffect(() => { onStateChange?.({ dirty, saving, canSave: !!saved && !loading }); }, [dirty, saving, saved, loading, onStateChange]);

  // Ctrl+S saves while this tab is open.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // ---- logo -------------------------------------------------------------------------------
  const onLogoFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { dataUrl, warning } = await prepareLogo(file);
      set('logo_data_url', dataUrl);
      setLogoMsg({ error: '', warning });
    } catch (err) {
      setLogoMsg({ error: err.message || 'Could not use this image.', warning: '' });
    }
  };

  // ---- completeness navigation ----------------------------------------------------------------
  const openSection = (s) => {
    const missing = s.missing || [];
    const fieldFor = {
      'Store / clinic name': 'name', 'Store type': 'store_type', 'Display name': 'display_name',
      'Phone number': 'phone', 'Email address': 'email', 'Street address': 'address',
      'City, state & PIN code': !form.city ? 'city' : !form.state ? 'state' : 'pin_code',
      'Clinic / branch code': 'branch_code', 'Contact person': 'contact_person',
      'Opening hours': 'opening_time', 'Working days': 'working_days', 'Clinical registration number': 'clinical_reg_no',
      GSTIN: 'gstin', Tagline: 'tagline', 'Store logo': 'logo-upload',
    };
    const onPage = missing.map((m) => fieldFor[m]).find(Boolean);
    if (onPage) { focusField(onPage); return; }
    if (missing.includes('Currency')) onOpenTab?.('billing');
    else onOpenTab?.('bill-designer');
  };

  // ---- field helpers --------------------------------------------------------------------------
  const field = (path, label, props = {}) => {
    const { helper, ...rest } = props;
    return (
      <TextField
        id={`sp-${path}`}
        label={label}
        fullWidth
        size="small"
        value={getIn(form, path) ?? ''}
        onChange={(e) => set(path, e.target.value)}
        error={!!errors[path]}
        helperText={errors[path] || helper || ' '}
        disabled={loading}
        {...rest}
      />
    );
  };

  const adorn = (icon) => ({ startAdornment: <InputAdornment position="start" sx={{ color: 'text.secondary' }}>{icon}</InputAdornment> });

  const stateField = (path, country, label = 'State') => {
    const value = getIn(form, path) || '';
    if (!isIndia(country)) return field(path, label);
    const names = INDIAN_STATES.map(([, n]) => n);
    return field(path, label, {
      select: true,
      children: [
        <MenuItem key="" value=""><em>Select state</em></MenuItem>,
        ...(value && !names.includes(value) ? [<MenuItem key={value} value={value}>{value}</MenuItem>] : []),
        ...names.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>),
      ],
    });
  };

  const countryField = (path, label = 'Country', allowBlank = false) => {
    const value = getIn(form, path) || '';
    return field(path, label, {
      select: true,
      SelectProps: { displayEmpty: allowBlank },
      InputLabelProps: allowBlank ? { shrink: true } : undefined,
      children: [
        ...(allowBlank ? [<MenuItem key="" value=""><em>Same as store</em></MenuItem>] : []),
        ...(value && !COUNTRIES.includes(value) ? [<MenuItem key={value} value={value}>{value}</MenuItem>] : []),
        ...COUNTRIES.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>),
      ],
    });
  };

  const gstinState = stateForGstin(form.gstin.replace(/\s/g, '').toUpperCase());
  let gstinHelper = gstinState ? `State code ${form.gstin.slice(0, 2)} · ${gstinState}` : '';
  if (gstinState && form.state && isIndia(form.country) && form.state !== gstinState) {
    gstinHelper = `GSTIN is registered in ${gstinState}, but the address state is ${form.state}.`;
  }
  const clinicType = form.store_type === 'EYE_CLINIC' || form.store_type === 'OPTICAL_AND_CLINIC';

  if (loading && !saved) {
    return (
      <Grid container spacing={3}>
        <Grid item xs={12} md={7} lg={8}><Stack spacing={3}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={260} />)}</Stack></Grid>
        <Grid item xs={12} md={5} lg={4}><Stack spacing={3}><Skeleton variant="rounded" height={360} /><Skeleton variant="rounded" height={260} /></Stack></Grid>
      </Grid>
    );
  }

  if (loadError && !saved) {
    return (
      <Alert severity="error" sx={{ borderRadius: 3 }} action={<Button color="inherit" onClick={load}>Retry</Button>}>
        {loadError} Saving is disabled until the current profile loads, so nothing is overwritten.
      </Alert>
    );
  }

  return (
    <>
      {status && (
        <Alert severity={status.type} onClose={() => setStatus(null)} sx={{ mb: 2, borderRadius: 3, fontWeight: 600 }} role={status.type === 'error' ? 'alert' : 'status'}>
          {status.msg}
        </Alert>
      )}

      <Collapse in={dirty} unmountOnExit>
        <Paper
          elevation={0}
          role="status"
          sx={{
            mb: 2, px: 2, py: 1.25, borderRadius: 3, border: '1px solid', borderColor: 'warning.light',
            bgcolor: 'rgba(245, 158, 11, 0.08)', display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap',
          }}
        >
          <Typography variant="body2" fontWeight={700} sx={{ flex: 1, minWidth: 200 }}>You have unsaved changes.</Typography>
          <Button size="small" startIcon={<UndoIcon />} onClick={() => setConfirmReset(true)} disabled={saving} sx={{ fontWeight: 700 }}>
            Reset to Saved Values
          </Button>
          <Button size="small" variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={saving} sx={greenButtonSx}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </Paper>
      </Collapse>

      <Grid container spacing={3} alignItems="flex-start">
        {/* ---------------- LEFT: forms ---------------- */}
        <Grid item xs={12} md={7} lg={8} sx={{ minWidth: 0 }}>
          <Stack spacing={3}>
            {/* STORE IDENTITY */}
            <SectionCard id="sp-identity" icon={<StoreIcon />} title="Store Identity" subtitle="Basic information about your optical store / clinic">
              <Box sx={{ display: 'flex', gap: 2.5, alignItems: 'center', flexWrap: 'wrap', mb: 3 }}>
                <Avatar
                  src={form.logo_data_url || undefined}
                  alt="Store logo preview"
                  sx={{
                    width: 104, height: 104, bgcolor: 'background.default', color: 'text.disabled',
                    border: '2px dashed', borderColor: form.logo_data_url ? GREEN : 'divider',
                    '& img': { objectFit: 'contain', p: 1 },
                  }}
                >
                  <ImageIcon sx={{ fontSize: 36 }} />
                </Avatar>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="subtitle2" fontWeight={800}>Store Logo</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>{LOGO_HINT}</Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button
                      id="sp-logo-upload"
                      size="small"
                      variant="outlined"
                      startIcon={<UploadIcon />}
                      onClick={() => fileRef.current?.click()}
                      sx={{ fontWeight: 700, color: GREEN, borderColor: GREEN, '&:hover': { borderColor: GREEN, bgcolor: GREEN_SOFT } }}
                    >
                      {form.logo_data_url ? 'Replace Logo' : 'Upload Logo'}
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      startIcon={<DeleteIcon />}
                      disabled={!form.logo_data_url}
                      onClick={() => { set('logo_data_url', ''); setLogoMsg({ error: '', warning: '' }); }}
                      sx={{ fontWeight: 700 }}
                    >
                      Remove Logo
                    </Button>
                  </Stack>
                  <input
                    ref={fileRef}
                    hidden
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
                    onChange={onLogoFile}
                    aria-label="Upload store logo"
                  />
                  {(logoMsg.error || errors.logo_data_url) && (
                    <Typography variant="caption" color="error" role="alert" sx={{ display: 'block', mt: 1 }}>{logoMsg.error || errors.logo_data_url}</Typography>
                  )}
                  {logoMsg.warning && <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1 }}>{logoMsg.warning}</Typography>}
                </Box>
              </Box>

              <Grid container columnSpacing={2} rowSpacing={1.25}>
                <Grid item xs={12} sm={6}>{field('name', 'Store / Clinic Name', { required: true, inputProps: { maxLength: 150 } })}</Grid>
                <Grid item xs={12} sm={6}>{field('display_name', 'Display Name', { helper: 'Printed on invoices — defaults to the store name', inputProps: { maxLength: 150 } })}</Grid>
                <Grid item xs={12} sm={6}>
                  {field('store_type', 'Store Type', {
                    select: true,
                    SelectProps: { displayEmpty: true },
                    InputLabelProps: { shrink: true },
                    children: [<MenuItem key="" value=""><em>Select store type</em></MenuItem>,
                      ...STORE_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)],
                  })}
                </Grid>
                <Grid item xs={12} sm={6}>
                  {field('gstin', 'GSTIN Registration Number', {
                    helper: gstinHelper,
                    FormHelperTextProps: { sx: gstinHelper.startsWith('GSTIN is') && !errors.gstin ? { color: 'warning.main' } : undefined },
                    inputProps: { maxLength: 15, style: { textTransform: 'uppercase' }, spellCheck: false },
                    placeholder: 'e.g. 32ABCDE1234F1Z5',
                  })}
                </Grid>
                <Grid item xs={12}>{field('business_reg_no', 'Business Registration Number', { inputProps: { maxLength: 60 }, helper: 'Shop & establishment / trade licence / CIN — optional' })}</Grid>
                <Grid item xs={12}>{field('tagline', 'Tagline', { inputProps: { maxLength: 120 }, helper: 'Optional line under the store name on documents' })}</Grid>
              </Grid>
            </SectionCard>

            {/* CONTACT INFORMATION */}
            <SectionCard id="sp-contact" icon={<PhoneIcon />} title="Contact Information" subtitle="Your store's contact details and address">
              <Grid container columnSpacing={2} rowSpacing={1.25}>
                <Grid item xs={12} sm={6}>
                  {field('phone', 'Phone Number', {
                    required: true, type: 'tel', InputProps: adorn(<PhoneIcon fontSize="small" />),
                    onBlur: () => set('phone', formatPhone(form.phone, form.country)),
                    inputProps: { inputMode: 'tel', maxLength: 20 },
                  })}
                </Grid>
                <Grid item xs={12} sm={6}>
                  {field('whatsapp', 'WhatsApp Number', {
                    type: 'tel', InputProps: {
                      ...adorn(<WhatsAppIcon fontSize="small" />),
                      endAdornment: form.phone && !form.whatsapp ? (
                        <InputAdornment position="end">
                          <Button size="small" onClick={() => set('whatsapp', form.phone)} sx={{ fontSize: 11, minWidth: 0, color: GREEN }}>Same as phone</Button>
                        </InputAdornment>
                      ) : null,
                    },
                    onBlur: () => set('whatsapp', formatPhone(form.whatsapp, form.country)),
                    inputProps: { inputMode: 'tel', maxLength: 20 },
                  })}
                </Grid>
                <Grid item xs={12} sm={6}>{field('email', 'Email Address', { type: 'email', InputProps: adorn(<EmailIcon fontSize="small" />), inputProps: { inputMode: 'email' } })}</Grid>
                <Grid item xs={12} sm={6}>{field('website', 'Website', { InputProps: adorn(<WebIcon fontSize="small" />), placeholder: 'www.yourstore.com', inputProps: { inputMode: 'url' } })}</Grid>

                <Grid item xs={12}><Typography variant="overline" color="text.secondary" fontWeight={800}>Store Address</Typography></Grid>
                <Grid item xs={12}>{field('address', 'Street Address', { multiline: true, minRows: 2, inputProps: { maxLength: 500 } })}</Grid>
                <Grid item xs={12} sm={6} lg={3}>{field('city', 'City / District')}</Grid>
                <Grid item xs={12} sm={6} lg={3}>{stateField('state', form.country)}</Grid>
                <Grid item xs={12} sm={6} lg={3}>{field('pin_code', isIndia(form.country) ? 'PIN Code' : 'Postal Code', { inputProps: { inputMode: isIndia(form.country) ? 'numeric' : 'text', maxLength: 10 } })}</Grid>
                <Grid item xs={12} sm={6} lg={3}>{countryField('country')}</Grid>
              </Grid>

              <Accordion
                expanded={addressesOpen}
                onChange={(_, v) => setAddressesOpen(v)}
                disableGutters
                elevation={0}
                sx={{ mt: 1, border: '1px solid', borderColor: 'divider', borderRadius: '12px !important', '&:before': { display: 'none' } }}
              >
                <AccordionSummary expandIcon={<ExpandIcon />} aria-controls="sp-extra-addresses" id="sp-extra-addresses-header">
                  <Box>
                    <Typography variant="subtitle2" fontWeight={800}>Registered, billing &amp; shipping addresses</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {ADDRESS_KINDS.filter(([k]) => !form.extra_addresses[k].same_as_store).length
                        ? `${ADDRESS_KINDS.filter(([k]) => !form.extra_addresses[k].same_as_store).length} separate address(es) configured`
                        : 'All the same as the store address'}
                    </Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails id="sp-extra-addresses">
                  <Stack spacing={2}>
                    {ADDRESS_KINDS.map(([kind, label]) => {
                      const a = form.extra_addresses[kind];
                      const base = `extra_addresses.${kind}`;
                      return (
                        <Box key={kind}>
                          <FormControlLabel
                            control={(
                              <Checkbox
                                checked={a.same_as_store}
                                onChange={(e) => set(`${base}.same_as_store`, e.target.checked)}
                                sx={{ '&.Mui-checked': { color: GREEN } }}
                              />
                            )}
                            label={<Typography variant="body2" fontWeight={700}>{`${label} — same as store address`}</Typography>}
                          />
                          <Collapse in={!a.same_as_store} unmountOnExit>
                            <Grid container columnSpacing={2} rowSpacing={1.25} sx={{ pt: 1, pl: { sm: 4 } }}>
                              <Grid item xs={12}>{field(`${base}.street`, 'Street Address', { multiline: true, minRows: 2 })}</Grid>
                              <Grid item xs={12} sm={6} lg={3}>{field(`${base}.city`, 'City / District')}</Grid>
                              <Grid item xs={12} sm={6} lg={3}>{stateField(`${base}.state`, a.country || form.country)}</Grid>
                              <Grid item xs={12} sm={6} lg={3}>{field(`${base}.pin_code`, 'PIN / Postal Code', { inputProps: { maxLength: 10 } })}</Grid>
                              <Grid item xs={12} sm={6} lg={3}>{countryField(`${base}.country`, 'Country', true)}</Grid>
                            </Grid>
                            {kind === 'billing' && (
                              <Typography variant="caption" color="text.secondary" sx={{ pl: { sm: 4 } }}>
                                When set, invoices and receipts print this address instead of the store address.
                              </Typography>
                            )}
                          </Collapse>
                        </Box>
                      );
                    })}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            </SectionCard>

            {/* CLINIC DETAILS */}
            <SectionCard id="sp-clinic" icon={<ClinicIcon />} title="Clinic Details" subtitle="Information about your eye clinic services">
              {multiBranchEnabled && (
                <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }} action={(
                  <Button color="inherit" size="small" onClick={() => { if (confirmLeave()) navigate('/admin/branches'); }}>Branches</Button>
                )}
                >
                  The branch code here belongs to the default branch. Other branches keep their own unique codes, contacts and addresses in Branch Management.
                </Alert>
              )}
              <Grid container columnSpacing={2} rowSpacing={1.25}>
                <Grid item xs={12} sm={6}>
                  {field('branch_code', 'Clinic / Branch Code', {
                    inputProps: { maxLength: 20, style: { textTransform: 'uppercase' } },
                    helper: 'Unique code, e.g. HO or KOCHI-01',
                  })}
                </Grid>
                <Grid item xs={12} sm={6}>{field('contact_person', 'Contact Person', { inputProps: { maxLength: 120 } })}</Grid>
                <Grid item xs={12} sm={6}>
                  {field('clinical_reg_no', 'Clinical Registration Number', {
                    inputProps: { maxLength: 60 },
                    helper: clinicType || form.provides_eye_exams ? 'Recommended for clinics' : 'Optional for stores without clinical services',
                  })}
                </Grid>
                <Grid item xs={6} sm={3}>{field('opening_time', 'Opens at', { type: 'time', InputLabelProps: { shrink: true } })}</Grid>
                <Grid item xs={6} sm={3}>{field('closing_time', 'Closes at', { type: 'time', InputLabelProps: { shrink: true } })}</Grid>

                <Grid item xs={12}>
                  <Typography id="sp-working-days-label" variant="body2" fontWeight={700} sx={{ mb: 0.75 }}>Working Days</Typography>
                  <ToggleButtonGroup
                    id="sp-working_days"
                    value={form.working_days}
                    onChange={(_, v) => set('working_days', WEEKDAYS.map(([d]) => d).filter((d) => v.includes(d)))}
                    aria-labelledby="sp-working-days-label"
                    size="small"
                    sx={{ flexWrap: 'wrap', gap: 0.75, '& .MuiToggleButtonGroup-grouped': { border: '1px solid', borderColor: 'divider', borderRadius: '8px !important', m: 0 } }}
                  >
                    {WEEKDAYS.map(([d, label]) => (
                      <ToggleButton
                        key={d}
                        value={d}
                        aria-label={label}
                        sx={{ px: 1.75, fontWeight: 700, textTransform: 'none', '&.Mui-selected, &.Mui-selected:hover': { bgcolor: GREEN, color: '#fff', borderColor: GREEN } }}
                      >
                        {label}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  <Typography variant="caption" color={errors.working_days ? 'error' : 'text.secondary'} sx={{ display: 'block', mt: 0.5, mb: 1.5 }}>
                    {errors.working_days || (form.working_days.length ? `${form.working_days.length} day(s) a week` : 'Select the days the store is open')}
                  </Typography>
                </Grid>

                <Grid item xs={12}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="body2" fontWeight={700}>Holidays</Typography>
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      onClick={() => set('holidays', [...form.holidays, { date: '', name: '' }])}
                      disabled={form.holidays.length >= 100}
                      sx={{ fontWeight: 700, color: GREEN }}
                    >
                      Add Holiday
                    </Button>
                  </Box>
                  {!form.holidays.length && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>No holidays configured.</Typography>
                  )}
                  <Stack spacing={1} sx={{ mb: form.holidays.length ? 1.5 : 0 }}>
                    {form.holidays.map((h, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                        <Box sx={{ width: { xs: 150, sm: 180 }, flexShrink: 0 }}>
                          {field(`holidays.${i}.date`, 'Date', { type: 'date', InputLabelProps: { shrink: true }, helper: ' ' })}
                        </Box>
                        <Box sx={{ flex: 1, minWidth: 0 }}>{field(`holidays.${i}.name`, 'Occasion', { inputProps: { maxLength: 80 } })}</Box>
                        <Tooltip title="Remove holiday">
                          <IconButton aria-label={`Remove holiday ${h.name || i + 1}`} onClick={() => set('holidays', form.holidays.filter((_, j) => j !== i))} sx={{ mt: 0.25 }}>
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ))}
                  </Stack>
                </Grid>

                <Grid item xs={12}>
                  <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderColor: form.provides_eye_exams ? GREEN : 'divider', bgcolor: form.provides_eye_exams ? GREEN_SOFT : 'transparent' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                      <Box>
                        <Typography id="sp-eye-exams-label" variant="subtitle2" fontWeight={800}>This location provides eye examinations</Typography>
                        <Typography id="sp-eye-exams-desc" variant="caption" color="text.secondary">
                          Turn on to set clinic hours and appointment defaults for eye tests.
                        </Typography>
                      </Box>
                      <Switch
                        checked={form.provides_eye_exams}
                        onChange={(e) => set('provides_eye_exams', e.target.checked)}
                        inputProps={{ 'aria-labelledby': 'sp-eye-exams-label', 'aria-describedby': 'sp-eye-exams-desc' }}
                        sx={{ '& .Mui-checked': { color: GREEN }, '& .Mui-checked + .MuiSwitch-track': { bgcolor: GREEN } }}
                      />
                    </Box>
                    <Collapse in={form.provides_eye_exams} unmountOnExit>
                      <Grid container columnSpacing={2} rowSpacing={1.25} sx={{ mt: 1.5 }}>
                        <Grid item xs={6} sm={4}>{field('clinic_settings.exam_start', 'Exams from', { type: 'time', InputLabelProps: { shrink: true } })}</Grid>
                        <Grid item xs={6} sm={4}>{field('clinic_settings.exam_end', 'Exams until', { type: 'time', InputLabelProps: { shrink: true } })}</Grid>
                        <Grid item xs={12} sm={4}>
                          {field('clinic_settings.slot_minutes', 'Slot length (min)', { type: 'number', inputProps: { min: 5, max: 240, step: 5 } })}
                        </Grid>
                        <Grid item xs={12}>
                          <FormControlLabel
                            control={(
                              <Switch
                                checked={!!form.clinic_settings.appointment_required}
                                onChange={(e) => set('clinic_settings.appointment_required', e.target.checked)}
                                sx={{ '& .Mui-checked': { color: GREEN }, '& .Mui-checked + .MuiSwitch-track': { bgcolor: GREEN } }}
                              />
                            )}
                            label={<Typography variant="body2">Eye examinations need an appointment</Typography>}
                          />
                        </Grid>
                      </Grid>
                    </Collapse>
                  </Paper>
                </Grid>
              </Grid>
            </SectionCard>
          </Stack>
        </Grid>

        {/* ---------------- RIGHT: preview + completeness ---------------- */}
        <Grid item xs={12} md={5} lg={4} sx={{ minWidth: 0, position: { md: 'sticky' }, top: { md: 16 } }}>
          <Stack spacing={3}>
            <BrandPreviewCard form={form} onPreviewInvoice={() => setPreviewOpen(true)} />
            <ProfileCompletenessCard completeness={saved?.completeness} dirty={dirty} onOpen={openSection} />
          </Stack>
        </Grid>
      </Grid>

      {previewOpen && (
        <InvoicePreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          form={form}
          currency={saved?.currency}
          onOpenDesigner={() => { setPreviewOpen(false); onOpenTab?.('bill-designer'); }}
        />
      )}

      <ConfirmActionDialog
        open={confirmReset}
        type="warning"
        title="Reset to saved values?"
        message="Your unsaved edits to the store profile will be discarded and the last saved values restored. The saved profile is not changed."
        confirmText="Reset"
        cancelText="Keep editing"
        onConfirm={() => { discard(); setConfirmReset(false); }}
        onClose={() => setConfirmReset(false)}
      />
    </>
  );
});

export default StoreProfileSettings;
