import { useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, Card, CardContent, Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';

// Windows local edition: database + documents backups taken on the server (L2). Restoring is done
// on the server with Administrator rights (gtrade-ctl backup restore), never from the browser.
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDate = (s) => (s ? new Date(s).toLocaleString() : '—');
const errorText = (e) => e?.response?.data?.error || e?.response?.data?.detail || e?.message || 'Failed';

export default function ServerBackupsPage() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => axios.get('/api/local/backups/').then((r) => setData(r.data)).catch((e) => setMsg({ type: 'error', text: errorText(e) }));
  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await axios.post('/api/local/backups/', {}, { timeout: 30 * 60 * 1000 });
      setMsg({ type: 'success', text: `Backup ${r.data.name} completed and verified (${fmtBytes(r.data.bytes)}).` });
      load();
    } catch (e) { setMsg({ type: 'error', text: errorText(e) }); }
    setBusy(false);
  };

  const ageHours = data?.last_success ? (Date.now() - new Date(data.last_success).getTime()) / 36e5 : null;
  return (
    <Box p={3} maxWidth={1000}>
      <Typography variant="h5" gutterBottom>Server backups</Typography>
      {msg && <Alert severity={msg.type} sx={{ mb: 2 }}>{msg.text}</Alert>}
      {data && (
        <Card sx={{ mb: 2 }}><CardContent>
          {ageHours == null && <Alert severity="error" sx={{ mb: 1 }}>No database backup exists yet.</Alert>}
          {ageHours != null && ageHours > 48 && <Alert severity="warning" sx={{ mb: 1 }}>The last successful backup is more than 2 days old.</Alert>}
          {data.last_error && <Alert severity="error" sx={{ mb: 1 }}>Last error: {data.last_error}</Alert>}
          {!data.offsite_copy && <Alert severity="info" sx={{ mb: 1 }}>No copy has been made to a second location (USB disk / second drive) yet.</Alert>}
          <Typography>Last successful backup: <b>{fmtDate(data.last_success)}</b> · Daily at {data.schedule} · {data.count} backups ({fmtBytes(data.total_bytes || 0)})</Typography>
          {data.offsite_copy && <Typography variant="body2" color="text.secondary">Second copy: {data.offsite_copy.backup} ({data.offsite_copy.verified ? 'verified' : 'NOT verified'})</Typography>}
          <Button variant="contained" sx={{ mt: 1 }} disabled={busy || data.running} onClick={runNow}>{busy ? 'Backing up…' : 'Back up now'}</Button>
        </CardContent></Card>
      )}
      {data && (
        <Table size="small">
          <TableHead><TableRow><TableCell>Backup</TableCell><TableCell>Type</TableCell><TableCell>Taken</TableCell><TableCell>Version</TableCell><TableCell>Size</TableCell><TableCell>Check</TableCell></TableRow></TableHead>
          <TableBody>
            {(data.backups || []).map((b) => (
              <TableRow key={b.name}>
                <TableCell>{b.name}</TableCell><TableCell>{b.kind}</TableCell><TableCell>{fmtDate(b.created_at)}</TableCell>
                <TableCell>{b.app_version}</TableCell><TableCell>{fmtBytes(b.bytes)}</TableCell>
                <TableCell>{b.verified ? <Chip size="small" color="success" label="verified" /> : <Chip size="small" color="error" label="not verified" />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}
