import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Badge, Box, Button, Card, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, Stack, Switch, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs,
  TextField, Tooltip, Typography,
} from '@mui/material';
import {
  CheckCircle as ApproveIcon, Cancel as RejectIcon, Refresh as RefreshIcon, Lock as LockIcon,
} from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { EDIT_MODULES } from '../../utils/editPermissions';

const STATUS_COLORS = {
  PENDING: 'warning', APPROVED: 'success', REJECTED: 'error', COMPLETED: 'default', CANCELLED: 'default', EXPIRED: 'default',
};
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const apiError = (e, fallback) => e?.response?.data?.detail || fallback;

// Administration → Edit Permissions & Requests.
//  * Direct Edit matrix: one switch per user per module (User.can_edit_<module>). OFF means a saved
//    record of that module opens only after an approved edit request.
//  * Approval queue: pending requests with requester, role, module, record, time and reason;
//    Approve unlocks that record for one save, Reject sends optional feedback.
// Server: backend/apps/authentication/edit_permissions.py.
export default function EditPermissionsManager({ onPendingCountChange }) {
  const [view, setView] = useState('requests');
  const [matrix, setMatrix] = useState(null);
  const [matrixError, setMatrixError] = useState('');
  const [saving, setSaving] = useState({});
  const [requests, setRequests] = useState([]);
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState(null); // { request, decision }
  const [note, setNote] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const loadMatrix = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/auth/edit-permissions/', { __silentError: true });
      setMatrix(data);
      setMatrixError('');
    } catch (e) {
      setMatrixError(apiError(e, 'Could not load users.'));
    }
  }, []);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter === 'ALL' ? {} : { status: statusFilter };
      const { data } = await axios.get('/api/auth/edit-requests/', { params, __silentError: true });
      setRequests(data.results || []);
      const count = data.pending_count || 0;
      setPendingCount(count);
      onPendingCountChange?.(count);
    } catch (e) {
      notify(apiError(e, 'Could not load edit requests.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, onPendingCountChange]);

  useEffect(() => { loadMatrix(); }, [loadMatrix]);
  useEffect(() => { loadRequests(); }, [loadRequests]);

  const toggle = async (user, moduleKey, value) => {
    const key = `${user.id}:${moduleKey}`;
    setSaving(s => ({ ...s, [key]: true }));
    setMatrix(m => ({ ...m, users: m.users.map(u => (u.id === user.id ? { ...u, permissions: { ...u.permissions, [moduleKey]: value } } : u)) }));
    try {
      await axios.patch(`/api/auth/edit-permissions/${user.id}/`, { [`can_edit_${moduleKey}`]: value });
      const label = EDIT_MODULES.find(m => m.key === moduleKey)?.label || moduleKey;
      notify(`${user.name}: ${label} direct edit ${value ? 'ON' : 'OFF'}.`, 'success');
    } catch (e) {
      notify(apiError(e, 'The change was not saved.'), 'error');
      loadMatrix();
    } finally {
      setSaving(s => ({ ...s, [key]: false }));
    }
  };

  const openReview = (request, decision) => { setReview({ request, decision }); setNote(''); };

  const submitReview = async () => {
    const { request, decision } = review;
    setReviewing(true);
    try {
      await axios.post(`/api/auth/edit-requests/${request.id}/${decision}/`, { note: note.trim() });
      notify(decision === 'approve'
        ? `Approved — ${request.requested_by_name} can now edit ${request.record_ref || 'the record'} once.`
        : `Request from ${request.requested_by_name} rejected.`, 'success');
      setReview(null);
      loadRequests();
    } catch (e) {
      notify(apiError(e, 'The decision was not saved.'), 'error');
      if (e?.response?.status === 409) { setReview(null); loadRequests(); }
    } finally {
      setReviewing(false);
    }
  };

  return (
    <Card sx={{ borderRadius: 3 }}>
      <Box sx={{ p: 2.5, pb: 0 }}>
        <Typography variant="h6" fontWeight={800}>Edit Permissions & Requests</Typography>
        <Typography variant="body2" color="text.secondary">
          With a module's Direct Edit OFF, the user must ask before changing a saved record of it. An approval unlocks
          that one record for a single save, then it locks again (unused approvals expire after 24 hours).
          A record the user created in the last 30 minutes, drafts, and payment / delivery status updates don't need approval.
        </Typography>
      </Box>
      <Tabs value={view} onChange={(_, v) => setView(v)} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="requests" sx={{ fontWeight: 700 }} label={
          <Badge color="error" badgeContent={pendingCount} max={99} sx={{ '& .MuiBadge-badge': { right: -12 } }}>
            Edit Requests
          </Badge>
        } />
        <Tab value="matrix" label="User Direct Edit Matrix" sx={{ fontWeight: 700 }} />
      </Tabs>

      {view === 'requests' && (
        <Box sx={{ p: 2.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
            {['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'ALL'].map(s => (
              <Chip key={s} label={s === 'PENDING' ? `Pending (${pendingCount})` : s.charAt(0) + s.slice(1).toLowerCase()}
                color={statusFilter === s ? 'primary' : 'default'} variant={statusFilter === s ? 'filled' : 'outlined'}
                onClick={() => setStatusFilter(s)} sx={{ fontWeight: 700 }} />
            ))}
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Refresh"><IconButton onClick={loadRequests}><RefreshIcon /></IconButton></Tooltip>
          </Stack>
          <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: '#f8fafc' } }}>
                  <TableCell>Requested</TableCell>
                  <TableCell>Requester</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Module</TableCell>
                  <TableCell>Record</TableCell>
                  <TableCell sx={{ minWidth: 220 }}>Reason</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="center">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading && (
                  <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>
                )}
                {!loading && requests.length === 0 && (
                  <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    {statusFilter === 'PENDING' ? 'No edit requests are waiting.' : 'No requests match this filter.'}
                  </TableCell></TableRow>
                )}
                {!loading && requests.map(r => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>
                      {r.requested_by_name}
                      <Typography variant="caption" display="block" color="text.secondary">{r.requested_by_username}</Typography>
                    </TableCell>
                    <TableCell>{r.requester_role_label}</TableCell>
                    <TableCell><Chip size="small" label={r.module_label} variant="outlined" sx={{ fontWeight: 700 }} /></TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{r.record_ref || r.record_id}</TableCell>
                    <TableCell sx={{ whiteSpace: 'pre-line' }}>
                      {r.reason}
                      {r.review_note && (
                        <Typography variant="caption" display="block" color="text.secondary">
                          {r.reviewed_by_name ? `${r.reviewed_by_name}: ` : ''}{r.review_note}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" color={STATUS_COLORS[r.status] || 'default'} label={r.status} sx={{ fontWeight: 800 }} />
                      {r.status === 'APPROVED' && r.expires_at && (
                        <Typography variant="caption" display="block" color="text.secondary">until {fmt(r.expires_at)}</Typography>
                      )}
                    </TableCell>
                    <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                      {r.can_review ? (
                        <Stack direction="row" spacing={1} justifyContent="center">
                          <Button size="small" variant="contained" color="success" startIcon={<ApproveIcon />}
                            onClick={() => openReview(r, 'approve')} sx={{ fontWeight: 700 }}>Approve</Button>
                          <Button size="small" variant="outlined" color="error" startIcon={<RejectIcon />}
                            onClick={() => openReview(r, 'reject')} sx={{ fontWeight: 700 }}>Reject</Button>
                        </Stack>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          {r.status === 'PENDING' ? 'Not yours to review' : (r.reviewed_by_name ? `by ${r.reviewed_by_name}` : '—')}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}

      {view === 'matrix' && (
        <Box sx={{ p: 2.5 }}>
          {matrixError && <Alert severity="error" sx={{ mb: 2 }}>{matrixError}</Alert>}
          {!matrix && !matrixError && <CircularProgress size={24} />}
          {matrix && (
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: '#f8fafc' } }}>
                    <TableCell>User</TableCell>
                    <TableCell>Role</TableCell>
                    {matrix.modules.map(m => (
                      <TableCell key={m.key} align="center">
                        {m.label}
                        <Typography variant="caption" display="block" color="text.secondary">{m.field}</Typography>
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {matrix.users.map(u => (
                    <TableRow key={u.id} hover sx={{ opacity: u.is_active ? 1 : 0.55 }}>
                      <TableCell sx={{ fontWeight: 700 }}>
                        {u.name}
                        <Typography variant="caption" display="block" color="text.secondary">
                          {u.username}{u.is_active ? '' : ' · inactive'}
                        </Typography>
                      </TableCell>
                      <TableCell>{u.role_label}</TableCell>
                      {matrix.modules.map(m => {
                        const on = Boolean(u.permissions[m.key]);
                        const control = (
                          <Switch size="small" checked={on} color="success"
                            disabled={!u.can_manage || Boolean(saving[`${u.id}:${m.key}`])}
                            onChange={(e) => toggle(u, m.key, e.target.checked)} />
                        );
                        return (
                          <TableCell key={m.key} align="center">
                            {u.can_manage ? control : (
                              <Tooltip title={u.always_direct ? 'Owners always edit directly' : 'You cannot change this account'}>
                                <span>{control}</span>
                              </Tooltip>
                            )}
                            <Typography variant="caption" display="block" sx={{ fontWeight: 700, color: on ? 'success.main' : 'warning.main' }}>
                              {on ? 'Direct' : <><LockIcon sx={{ fontSize: 11, verticalAlign: 'middle' }} /> Approval</>}
                            </Typography>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>
      )}

      <Dialog open={Boolean(review)} onClose={() => !reviewing && setReview(null)} maxWidth="sm" fullWidth>
        {review && (
          <>
            <DialogTitle sx={{ fontWeight: 800 }}>
              {review.decision === 'approve' ? 'Approve edit request' : 'Reject edit request'}
            </DialogTitle>
            <DialogContent dividers>
              <Typography variant="body2" sx={{ mb: 1 }}>
                <b>{review.request.requested_by_name}</b> ({review.request.requester_role_label}) wants to edit{' '}
                <b>{review.request.module_label} · {review.request.record_ref || review.request.record_id}</b>.
              </Typography>
              <Alert severity="info" sx={{ mb: 2, whiteSpace: 'pre-line' }}>{review.request.reason}</Alert>
              <TextField fullWidth multiline minRows={2} value={note} onChange={(e) => setNote(e.target.value)}
                label={review.decision === 'approve' ? 'Note (optional)' : 'Feedback for the requester (optional)'}
                inputProps={{ maxLength: 2000 }} />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setReview(null)} disabled={reviewing}>Cancel</Button>
              <Button variant="contained" color={review.decision === 'approve' ? 'success' : 'error'}
                onClick={submitReview} disabled={reviewing} sx={{ fontWeight: 800 }}>
                {review.decision === 'approve' ? 'Approve' : 'Reject'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Card>
  );
}
