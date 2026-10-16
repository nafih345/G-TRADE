// Financial → Accounting Integration: module-to-COA mappings, the failed-posting queue,
// reconciliation + controlled backfill, journal preview, fiscal periods, policy and audit log.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid,
  LinearProgress, MenuItem, Paper, Stack, Switch, Tab, Tabs, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, TextField, Typography, FormControlLabel,
} from '@mui/material';
import { Refresh as RefreshIcon, CheckCircle as CheckIcon, Warning as WarningIcon } from '@mui/icons-material';
import { apiError, finGet, finPatch, finPost, inr, today } from './financialApi';

const head = { fontWeight: 700 };

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setData(await fn()); } catch (e) { setError(apiError(e)); }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load };
}

const Loading = ({ state }) => (<>
  {state.loading && <LinearProgress sx={{ mb: 2 }} />}
  {state.error && <Alert severity="error" sx={{ mb: 2 }}>{state.error}</Alert>}
</>);

// ---------------------------------------------------------------------------

function Overview({ status, onGo }) {
  const s = status.data;
  if (!s) return <Loading state={status} />;
  const tiles = [
    ['Ledger', s.ledger_balanced ? 'Balanced' : 'OUT OF BALANCE', s.ledger_balanced ? 'success.main' : 'error.main', `Dr ${inr(s.ledger_debits)} / Cr ${inr(s.ledger_credits)}`, null],
    ['Unmapped / invalid roles', s.unmapped_roles.length, s.unmapped_roles.length ? 'error.main' : 'success.main', 'Posting is refused until mapped', 1],
    ['Open posting failures', s.open_failures, s.open_failures ? 'error.main' : 'success.main', 'Documents not yet on the books', 2],
    ['Duplicate alerts', s.duplicate_live_entries.length + s.legacy_duplicate_entries, (s.duplicate_live_entries.length + s.legacy_duplicate_entries) ? 'warning.main' : 'success.main', 'Legacy double-postings to review', 3],
    ['Draft vouchers', s.draft_vouchers, 'text.primary', 'Not in the statements until posted', null],
  ];
  return (<>
    {!s.auto_posting_enabled && <Alert severity="warning" sx={{ mb: 2 }}>Automated posting is switched OFF — operational documents are not reaching the ledger.</Alert>}
    <Grid container spacing={2}>
      {tiles.map(([label, value, color, hint, tab]) => (
        <Grid item xs={12} sm={6} md={4} lg key={label}>
          <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, cursor: tab !== null ? 'pointer' : 'default', height: '100%' }} onClick={() => tab !== null && onGo(tab)}>
            <Typography variant="caption" fontWeight={700} color="text.secondary">{label.toUpperCase()}</Typography>
            <Typography variant="h5" fontWeight={850} sx={{ color }}>{value}</Typography>
            <Typography variant="caption" color="text.secondary">{hint}</Typography>
          </Paper>
        </Grid>
      ))}
    </Grid>
    {s.unmapped_roles.length > 0 && (
      <Alert severity="error" sx={{ mt: 2 }}>
        {s.unmapped_roles.map(r => `${r.label}: ${r.problems.join(' ')}`).join(' • ')}
      </Alert>
    )}
    {s.duplicate_live_entries.length > 0 && (
      <Alert severity="warning" sx={{ mt: 2 }}>
        {s.duplicate_live_entries.length} source document(s) have more than one live entry — reverse the extra ones from View All Vouchers.
      </Alert>
    )}
  </>);
}

// ---------------------------------------------------------------------------

function Mappings({ accounts, showToast, onChanged }) {
  const roles = useLoad(() => finGet('integration/mappings/roles/'), []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ account: null, effective_from: '', notes: '' });

  const startEdit = (row) => {
    setEditing(row);
    setForm({ account: accounts.find(a => String(a.id) === String(row.account_id)) || null, effective_from: '', notes: '' });
  };

  const save = async () => {
    if (!form.account) { showToast('Choose an account.', 'warning'); return; }
    try {
      const check = await finPost('integration/mappings/validate/', { role: editing.role, account: form.account.id });
      if (!check.valid) { showToast(check.problems.join(' '), 'error'); return; }
      if (form.effective_from || !editing.mapping_id) {
        await finPost('integration/mappings/', { role: editing.role, account: form.account.id, effective_from: form.effective_from || null, notes: form.notes });
      } else {
        await finPatch(`integration/mappings/${editing.mapping_id}/`, { account: form.account.id, notes: form.notes });
      }
      showToast(`${editing.label} now posts to ${form.account.code} - ${form.account.name}.`, 'success');
      setEditing(null);
      roles.reload();
      onChanged?.();
    } catch (e) {
      showToast(apiError(e), 'error');
    }
  };

  const allowed = editing ? accounts.filter(a => editing.allowed_types.includes(a.backend_type) && a.status === 'Active') : [];

  return (<>
    <Alert severity="info" sx={{ mb: 2 }}>
      Posting rules ask for a <b>role</b>; this table decides which ledger account each role posts to. A change with an
      effective date applies only to documents dated on or after it — already-posted entries are never rewritten.
    </Alert>
    <Loading state={roles} />
    {roles.data && (
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 900 }}>
          <TableHead sx={{ bgcolor: '#f8fafc' }}>
            <TableRow>
              <TableCell sx={head}>Posting role</TableCell>
              <TableCell sx={head}>Used for</TableCell>
              <TableCell sx={head}>Mapped account</TableCell>
              <TableCell sx={head}>Effective</TableCell>
              <TableCell sx={head}>Status</TableCell>
              <TableCell sx={head} align="center">Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {roles.data.map(r => (
              <TableRow key={r.role} hover>
                <TableCell>
                  <Typography variant="body2" fontWeight={700}>{r.label}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{r.role}</Typography>
                </TableCell>
                <TableCell sx={{ maxWidth: 320 }}><Typography variant="caption">{r.description}</Typography></TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{r.account_code ? `${r.account_code} - ${r.account_name}` : '—'}</TableCell>
                <TableCell>{r.effective_from || 'Always'}</TableCell>
                <TableCell>
                  {r.valid ? <Chip size="small" color="success" icon={<CheckIcon />} label="Valid" />
                    : <Chip size="small" color="error" icon={<WarningIcon />} label={r.problems.join(' ')} sx={{ maxWidth: 260 }} />}
                </TableCell>
                <TableCell align="center"><Button size="small" variant="outlined" onClick={() => startEdit(r)}>Change</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    )}
    <Dialog open={!!editing} onClose={() => setEditing(null)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>Map “{editing?.label}”</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Allowed account types: {editing?.allowed_types.join(' / ')}. Inactive accounts can't be mapped.
        </Typography>
        <Stack spacing={2}>
          <Autocomplete options={allowed} value={form.account} onChange={(e, v) => setForm(f => ({ ...f, account: v }))}
            getOptionLabel={(a) => `${a.code} - ${a.name} (${a.account_group})`}
            isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
            renderInput={(p) => <TextField {...p} size="small" label="Account *" />} />
          <TextField type="date" size="small" label="Effective from (optional)" InputLabelProps={{ shrink: true }}
            helperText="Leave blank to change the current mapping. Set a date to switch accounts from that day onwards."
            value={form.effective_from} onChange={(e) => setForm(f => ({ ...f, effective_from: e.target.value }))} />
          <TextField size="small" label="Note" value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setEditing(null)}>Cancel</Button>
        <Button variant="contained" onClick={save}>Validate &amp; save</Button>
      </DialogActions>
    </Dialog>
  </>);
}

// ---------------------------------------------------------------------------

function Failures({ showToast, onChanged }) {
  const [filter, setFilter] = useState('OPEN');
  const list = useLoad(() => finGet('integration/failures/', { status: filter }), [filter]);
  const retry = async (f) => {
    try {
      const res = await finPost(`integration/failures/${f.id}/retry/`);
      showToast(res.result.outcome === 'failed' ? `Still failing: ${res.result.error}` : `${f.source_number || f.source_label} posted.`,
        res.result.outcome === 'failed' ? 'error' : 'success');
      list.reload(); onChanged?.();
    } catch (e) { showToast(apiError(e), 'error'); }
  };
  const retryAll = async () => {
    try {
      const res = await finPost('integration/failures/retry-all/');
      showToast(`${res.succeeded} of ${res.retried} posted.`, res.succeeded === res.retried ? 'success' : 'warning');
      list.reload(); onChanged?.();
    } catch (e) { showToast(apiError(e), 'error'); }
  };
  const ignore = async (f) => {
    const reason = window.prompt('Why should this document stay off the books?');
    if (!reason) return;
    try { await finPost(`integration/failures/${f.id}/ignore/`, { reason }); list.reload(); onChanged?.(); } catch (e) { showToast(apiError(e), 'error'); }
  };
  const rows = Array.isArray(list.data) ? list.data : (list.data?.results || []);
  return (<>
    <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} alignItems="center" flexWrap="wrap" gap={1}>
      <TextField select size="small" label="Status" value={filter} onChange={(e) => setFilter(e.target.value)} sx={{ width: 160 }}>
        <MenuItem value="OPEN">Open</MenuItem><MenuItem value="RESOLVED">Resolved</MenuItem>
        <MenuItem value="IGNORED">Ignored</MenuItem><MenuItem value="ALL">All</MenuItem>
      </TextField>
      <Button variant="contained" disabled={filter !== 'OPEN' || rows.length === 0} onClick={retryAll}>Retry all open</Button>
      <Button startIcon={<RefreshIcon />} onClick={list.reload}>Refresh</Button>
    </Stack>
    <Loading state={list} />
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" sx={{ minWidth: 900 }}>
        <TableHead sx={{ bgcolor: '#f8fafc' }}>
          <TableRow>
            <TableCell sx={head}>Document</TableCell><TableCell sx={head}>Problem</TableCell>
            <TableCell sx={head}>Error</TableCell><TableCell sx={head} align="right">Attempts</TableCell>
            <TableCell sx={head}>Last failed</TableCell><TableCell sx={head} align="center">Action</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 5, color: 'text.secondary' }}>No {filter.toLowerCase()} failures. 🎉</TableCell></TableRow>}
          {rows.map(f => (
            <TableRow key={f.id} hover>
              <TableCell><Typography variant="body2" fontWeight={700}>{f.source_label}</Typography><Typography variant="caption">{f.source_number}</Typography></TableCell>
              <TableCell><Chip size="small" label={f.kind} color={f.kind === 'MAPPING' ? 'warning' : 'error'} /></TableCell>
              <TableCell sx={{ maxWidth: 420 }}><Typography variant="caption">{f.error}</Typography></TableCell>
              <TableCell align="right">{f.attempts}</TableCell>
              <TableCell>{new Date(f.last_failed_at).toLocaleString()}</TableCell>
              <TableCell align="center">
                {f.status === 'OPEN' ? (
                  <Stack direction="row" spacing={1} justifyContent="center">
                    <Button size="small" variant="outlined" onClick={() => retry(f)}>Retry</Button>
                    <Button size="small" color="inherit" onClick={() => ignore(f)}>Ignore</Button>
                  </Stack>
                ) : <Chip size="small" label={f.status} />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  </>);
}

// ---------------------------------------------------------------------------

function Reconciliation({ catalog, showToast, onChanged }) {
  const [range, setRange] = useState({ date_from: '', date_to: '' });
  const recon = useLoad(() => finGet('integration/reconciliation/', range), [range.date_from, range.date_to]);
  const [backfill, setBackfill] = useState(null);

  const runBackfill = async (sourceKey, dryRun) => {
    try {
      const res = await finPost('integration/backfill/', { source_key: sourceKey, dry_run: dryRun, ...range });
      if (dryRun) setBackfill(res);
      else {
        const failed = res.rows.filter(r => r.outcome === 'failed' || r.outcome === 'error').length;
        showToast(`${res.rows.length - failed} document(s) posted${failed ? `, ${failed} failed (see Failed postings)` : ''}.`, failed ? 'warning' : 'success');
        setBackfill(null); recon.reload(); onChanged?.();
      }
    } catch (e) { showToast(apiError(e), 'error'); }
  };

  return (<>
    <Alert severity="info" sx={{ mb: 2 }}>
      Documents dated before a source's go-live date are <b>historical</b>: they are never posted automatically. Review the
      dry run, then post them here in a controlled way (or record the history as an opening balance instead).
    </Alert>
    <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
      <TextField type="date" size="small" label="From" InputLabelProps={{ shrink: true }} value={range.date_from} onChange={(e) => setRange(r => ({ ...r, date_from: e.target.value }))} />
      <TextField type="date" size="small" label="To" InputLabelProps={{ shrink: true }} value={range.date_to} onChange={(e) => setRange(r => ({ ...r, date_to: e.target.value }))} />
      <Button startIcon={<RefreshIcon />} onClick={recon.reload}>Re-run</Button>
    </Stack>
    <Loading state={recon} />
    {recon.data && (
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 1000 }}>
          <TableHead sx={{ bgcolor: '#f8fafc' }}>
            <TableRow>
              <TableCell sx={head}>Source</TableCell><TableCell sx={head}>Go-live</TableCell>
              <TableCell sx={head} align="right">Docs</TableCell><TableCell sx={head} align="right">Posted</TableCell>
              <TableCell sx={head}>Issues</TableCell><TableCell sx={head} align="right">Historical</TableCell>
              <TableCell sx={head} align="center">Backfill</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {recon.data.sources.map(s => (
              <TableRow key={s.source_key} hover>
                <TableCell sx={{ fontWeight: 700 }}>{s.label}</TableCell>
                <TableCell>{s.start_date || 'All dates'}</TableCell>
                <TableCell align="right">{s.documents}</TableCell>
                <TableCell align="right">{s.posted}</TableCell>
                <TableCell sx={{ maxWidth: 380 }}>
                  {[['missing', s.missing, 'error'], ['mismatched', s.mismatched, 'warning'], ['stale', s.stale, 'warning'], ['errors', s.errors, 'error']]
                    .filter(([, list]) => list.length).map(([name, list, color]) => (
                      <Chip key={name} size="small" color={color} sx={{ mr: 0.5, mb: 0.5 }}
                        label={`${list.length} ${name}: ${list.slice(0, 3).map(d => d.number).join(', ')}${list.length > 3 ? '…' : ''}`} />
                    ))}
                  {!s.missing.length && !s.mismatched.length && !s.stale.length && !s.errors.length && <Chip size="small" color="success" label="In step" />}
                </TableCell>
                <TableCell align="right">{s.historical_unposted}</TableCell>
                <TableCell align="center">
                  <Button size="small" variant="outlined" disabled={!s.historical_unposted && !s.missing.length} onClick={() => runBackfill(s.source_key, true)}>Dry run</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    )}
    <Dialog open={!!backfill} onClose={() => setBackfill(null)} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>Backfill preview — {catalog?.sources?.find(s => s.key === backfill?.source_key)?.label}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>{backfill?.rows.length || 0} document(s) would be posted, each on its own document date. Closed periods will refuse them.</Typography>
        <Table size="small">
          <TableHead><TableRow><TableCell sx={head}>Document</TableCell><TableCell sx={head}>Date</TableCell><TableCell sx={head} align="right">Amount</TableCell><TableCell sx={head}>Note</TableCell></TableRow></TableHead>
          <TableBody>
            {(backfill?.rows || []).slice(0, 200).map(r => (
              <TableRow key={r.id}><TableCell>{r.number}</TableCell><TableCell>{r.date}</TableCell>
                <TableCell align="right">{r.amount ? inr(r.amount) : ''}</TableCell><TableCell>{r.error || ''}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setBackfill(null)}>Close</Button>
        <Button variant="contained" color="warning" disabled={!backfill?.rows.length}
          onClick={() => window.confirm('Post these historical documents to the ledger now?') && runBackfill(backfill.source_key, false)}>
          Post {backfill?.rows.length || 0} document(s)
        </Button>
      </DialogActions>
    </Dialog>
  </>);
}

// ---------------------------------------------------------------------------

function Preview({ catalog }) {
  const [sourceKey, setSourceKey] = useState('sales.invoice');
  const [docId, setDocId] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const run = async () => {
    setError(''); setResult(null);
    try { setResult(await finGet('integration/preview/', { source_key: sourceKey, id: docId.trim() })); } catch (e) { setError(apiError(e)); }
  };
  return (<>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
      See exactly what the engine would post for a document right now — nothing is written. Paste the document's ID (shown in its URL or API record).
    </Typography>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
      <TextField select size="small" label="Source" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} sx={{ minWidth: 240 }}>
        {(catalog?.sources || []).map(s => <MenuItem key={s.key} value={s.key}>{s.label}</MenuItem>)}
      </TextField>
      <TextField size="small" label="Document ID" value={docId} onChange={(e) => setDocId(e.target.value)} sx={{ minWidth: 320 }} />
      <Button variant="contained" onClick={run} disabled={!docId.trim()}>Preview journal</Button>
    </Stack>
    {catalog && <Typography variant="caption" color="text.secondary">Rule: {catalog.sources.find(s => s.key === sourceKey)?.rule}</Typography>}
    {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    {result && (
      <Paper variant="outlined" sx={{ mt: 2, p: 2, borderRadius: 3 }}>
        <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" gap={1}>
          <Chip label={result.source_number || 'document'} />
          <Chip label={`Dated ${result.document_date}`} />
          {result.posted_entry && <Chip color="info" label={`Currently posted as ${result.posted_entry}`} />}
          {result.historical && <Chip color="warning" label="Historical — not auto-posted" />}
          {result.postable === false && <Chip label="Not a posting document in its current state" />}
        </Stack>
        {result.error && <Alert severity="error" sx={{ mb: 1 }}>{result.error}</Alert>}
        {result.lines?.length > 0 && (
          <Table size="small">
            <TableHead><TableRow><TableCell sx={head}>Account</TableCell><TableCell sx={head}>Role</TableCell><TableCell sx={head}>Memo</TableCell>
              <TableCell sx={head} align="right">Debit</TableCell><TableCell sx={head} align="right">Credit</TableCell></TableRow></TableHead>
            <TableBody>
              {result.lines.map((l, i) => (
                <TableRow key={i}><TableCell>{l.account_code} - {l.account_name}</TableCell><TableCell sx={{ fontFamily: 'monospace' }}>{l.role || 'party ledger'}</TableCell>
                  <TableCell>{l.memo}</TableCell><TableCell align="right">{parseFloat(l.debit) ? inr(l.debit) : ''}</TableCell>
                  <TableCell align="right">{parseFloat(l.credit) ? inr(l.credit) : ''}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
    )}
  </>);
}

// ---------------------------------------------------------------------------

function Periods({ showToast, onChanged }) {
  const list = useLoad(() => finGet('integration/periods/'), []);
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '' });
  const rows = Array.isArray(list.data) ? list.data : (list.data?.results || []);
  const call = async (fn, ok) => { try { await fn(); showToast(ok, 'success'); list.reload(); onChanged?.(); } catch (e) { showToast(apiError(e), 'error'); } };
  const close = (p) => call(async () => {
    try { await finPost(`integration/periods/${p.id}/close/`); }
    catch (e) {
      if (e?.response?.status === 409 && window.confirm(`${apiError(e)}\n\nClose anyway?`)) await finPost(`integration/periods/${p.id}/close/`, { force: true });
      else throw e;
    }
  }, `${p.name} closed — postings dated in it are now refused.`);
  return (<>
    <Alert severity="info" sx={{ mb: 2 }}>
      A closed period refuses every new posting dated inside it (vouchers, automated postings, backfill). Corrections to a
      closed period are posted as reversals dated today. Only an Administrator can re-open a period.
    </Alert>
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
      <TextField size="small" label="Name" placeholder="e.g. FY 2026-27 Q1" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} />
      <TextField type="date" size="small" label="Start" InputLabelProps={{ shrink: true }} value={form.start_date} onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))} />
      <TextField type="date" size="small" label="End" InputLabelProps={{ shrink: true }} value={form.end_date} onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))} />
      <Button variant="contained" disabled={!form.name || !form.start_date || !form.end_date}
        onClick={() => call(() => finPost('integration/periods/', form), 'Period added.').then(() => setForm({ name: '', start_date: '', end_date: '' }))}>Add period</Button>
    </Stack>
    <Loading state={list} />
    <Table size="small">
      <TableHead sx={{ bgcolor: '#f8fafc' }}><TableRow><TableCell sx={head}>Period</TableCell><TableCell sx={head}>From</TableCell><TableCell sx={head}>To</TableCell>
        <TableCell sx={head}>Status</TableCell><TableCell sx={head} align="center">Action</TableCell></TableRow></TableHead>
      <TableBody>
        {rows.length === 0 && <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>No fiscal periods defined — every date is open.</TableCell></TableRow>}
        {rows.map(p => (
          <TableRow key={p.id} hover>
            <TableCell sx={{ fontWeight: 700 }}>{p.name}</TableCell><TableCell>{p.start_date}</TableCell><TableCell>{p.end_date}</TableCell>
            <TableCell><Chip size="small" color={p.status === 'CLOSED' ? 'default' : 'success'} label={p.status === 'CLOSED' ? `Closed${p.closed_by_name ? ` by ${p.closed_by_name}` : ''}` : 'Open'} /></TableCell>
            <TableCell align="center">
              {p.status === 'OPEN'
                ? <Button size="small" variant="outlined" color="warning" onClick={() => window.confirm(`Close ${p.name}?`) && close(p)}>Close period</Button>
                : <Button size="small" onClick={() => call(() => finPost(`integration/periods/${p.id}/reopen/`), `${p.name} re-opened.`)}>Re-open</Button>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </>);
}

// ---------------------------------------------------------------------------

function Policy({ catalog, showToast, onChanged }) {
  const policy = useLoad(() => finGet('integration/policy/'), []);
  const [draft, setDraft] = useState(null);
  useEffect(() => { if (policy.data) setDraft(policy.data); }, [policy.data]);
  const save = async () => {
    try {
      await finPatch('integration/policy/', {
        auto_posting_enabled: draft.auto_posting_enabled, source_enabled: draft.source_enabled,
        source_start_dates: draft.source_start_dates, backdate_limit_days: parseInt(draft.backdate_limit_days || 0, 10),
      });
      showToast('Accounting policy saved.', 'success');
      policy.reload(); onChanged?.();
    } catch (e) { showToast(apiError(e), 'error'); }
  };
  const tools = async (path, body, label) => {
    try {
      const res = await finPost(path, body);
      showToast(label(res), 'success'); onChanged?.();
    } catch (e) { showToast(apiError(e), 'error'); }
  };
  if (!draft) return <Loading state={policy} />;
  return (<>
    <FormControlLabel control={<Switch checked={draft.auto_posting_enabled} onChange={(e) => setDraft(d => ({ ...d, auto_posting_enabled: e.target.checked }))} />}
      label={<Typography fontWeight={700}>Automated posting from operational modules</Typography>} />
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
      Inventory valuation: {draft.inventory_valuation === 'LAST_PURCHASE_COST' ? 'last purchase cost (Product cost price, refreshed by every Purchase Entry)' : draft.inventory_valuation}.
    </Typography>
    <Table size="small" sx={{ mb: 3 }}>
      <TableHead sx={{ bgcolor: '#f8fafc' }}><TableRow><TableCell sx={head}>Source</TableCell><TableCell sx={head}>Posting</TableCell>
        <TableCell sx={head}>Go-live date (earlier documents are historical)</TableCell></TableRow></TableHead>
      <TableBody>
        {(catalog?.sources || []).map(s => (
          <TableRow key={s.key}>
            <TableCell><Typography variant="body2" fontWeight={700}>{s.label}</Typography><Typography variant="caption" color="text.secondary">{s.rule}</Typography></TableCell>
            <TableCell>
              <Switch checked={draft.source_enabled?.[s.key] !== false}
                onChange={(e) => setDraft(d => ({ ...d, source_enabled: { ...(d.source_enabled || {}), [s.key]: e.target.checked } }))} />
            </TableCell>
            <TableCell>
              <TextField type="date" size="small" InputLabelProps={{ shrink: true }} value={draft.source_start_dates?.[s.key] || ''}
                onChange={(e) => setDraft(d => ({ ...d, source_start_dates: { ...(d.source_start_dates || {}), [s.key]: e.target.value || null } }))} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    <TextField type="number" size="small" label="Backdating limit for manual vouchers (days, 0 = none)" sx={{ width: 360, mb: 2 }}
      value={draft.backdate_limit_days} onChange={(e) => setDraft(d => ({ ...d, backdate_limit_days: e.target.value }))}
      helperText="Older vouchers then need an Administrator." />
    <Box><Button variant="contained" onClick={save}>Save policy</Button></Box>

    <Typography variant="subtitle1" fontWeight={850} sx={{ mt: 4, mb: 1 }}>Maintenance</Typography>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
      <Button variant="outlined" onClick={() => window.confirm('Post every account\'s typed opening balance against Opening Balance Equity? Already-posted openings are only re-booked if they changed.')
        && tools('integration/opening-balances/', { as_of: today() }, (r) => `${r.results.length} opening balance(s) processed.`)}>
        Post opening balances
      </Button>
      <Button variant="outlined" onClick={() => tools('integration/recompute-balances/', {}, (r) => `${r.corrected} cached balance(s) corrected.`)}>
        Rebuild balance cache from ledger
      </Button>
    </Stack>
  </>);
}

// ---------------------------------------------------------------------------

function AuditLog() {
  const log = useLoad(() => finGet('integration/audit-log/'), []);
  const rows = Array.isArray(log.data) ? log.data : (log.data?.results || []);
  return (<>
    <Loading state={log} />
    <TableContainer sx={{ maxHeight: 560, overflowX: 'auto' }}>
      <Table size="small" stickyHeader sx={{ minWidth: 800 }}>
        <TableHead><TableRow><TableCell sx={head}>When</TableCell><TableCell sx={head}>Who</TableCell><TableCell sx={head}>Action</TableCell><TableCell sx={head}>Details</TableCell></TableRow></TableHead>
        <TableBody>
          {rows.length === 0 && <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary' }}>No audit records yet.</TableCell></TableRow>}
          {rows.map(r => (
            <TableRow key={r.id} hover>
              <TableCell>{new Date(r.created_at).toLocaleString()}</TableCell>
              <TableCell>{r.actor_name || 'system'}</TableCell>
              <TableCell><Chip size="small" label={r.action} /></TableCell>
              <TableCell>
                <Typography variant="body2">{r.summary}</Typography>
                {r.before && r.after && r.object_type === 'mapping' && (
                  <Typography variant="caption" color="text.secondary">{r.before.account} → {r.after.account}</Typography>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  </>);
}

// ---------------------------------------------------------------------------

export default function AccountingIntegrationPanel({ accounts, showToast, onChanged }) {
  const [tab, setTab] = useState(0);
  const status = useLoad(() => finGet('integration/status/'), []);
  const catalog = useLoad(() => finGet('integration/catalog/'), []);
  const changed = () => { status.reload(); onChanged?.(); };
  const s = status.data;
  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h6" fontWeight={850}>Accounting Integration</Typography>
          <Typography variant="body2" color="text.secondary">How sales, purchases and inventory reach the ledger — and what still needs attention.</Typography>
        </Box>
        <Button size="small" startIcon={<RefreshIcon />} onClick={status.reload}>Refresh status</Button>
      </Stack>
      <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ mb: 3, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { fontWeight: 700 } }}>
        <Tab label="Overview" />
        <Tab label={`Mappings${s?.unmapped_roles?.length ? ` (${s.unmapped_roles.length}!)` : ''}`} />
        <Tab label={`Failed postings${s?.open_failures ? ` (${s.open_failures})` : ''}`} />
        <Tab label="Reconciliation & backfill" />
        <Tab label="Journal preview" />
        <Tab label="Fiscal periods" />
        <Tab label="Policy & tools" />
        <Tab label="Audit log" />
      </Tabs>
      {tab === 0 && <Overview status={status} onGo={setTab} />}
      {tab === 1 && <Mappings accounts={accounts} showToast={showToast} onChanged={changed} />}
      {tab === 2 && <Failures showToast={showToast} onChanged={changed} />}
      {tab === 3 && <Reconciliation catalog={catalog.data} showToast={showToast} onChanged={changed} />}
      {tab === 4 && <Preview catalog={catalog.data} />}
      {tab === 5 && <Periods showToast={showToast} onChanged={changed} />}
      {tab === 6 && <Policy catalog={catalog.data} showToast={showToast} onChanged={changed} />}
      {tab === 7 && <AuditLog />}
    </Card>
  );
}
