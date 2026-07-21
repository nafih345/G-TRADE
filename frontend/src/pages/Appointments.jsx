import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Button, Grid, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Chip, Dialog, DialogTitle, DialogContent, 
  DialogActions, TextField, MenuItem, Stack, IconButton
} from '@mui/material';
import {
  Add as AddIcon,
  CalendarMonth as CalendarIcon,
  NotificationsActive as AlarmIcon,
  Edit as EditIcon,
  Close as CancelIcon,
  Visibility as ViewIcon
} from '@mui/icons-material';

const initialAppointments = [];

export default function Appointments() {
  const navigate = useNavigate();
  const [appointments, setAppointments] = useState(initialAppointments);
  const [registeredDoctors, setRegisteredDoctors] = useState([]);
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewingApt, setViewingApt] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedAptId, setSelectedAptId] = useState(null);
  const [newApt, setNewApt] = useState({
    patient: '', phone: '', doctor: '', date: '', time: '', type: 'Comprehensive Eye Exam', status: 'Booked'
  });

  useEffect(() => {
    const fetchRegisteredDoctors = async () => {
      let docList = [];
      try {
        const savedUsers = JSON.parse(localStorage.getItem('optical_users_db') || '[]');
        savedUsers.forEach(u => {
          if (u.name) docList.push(u.name);
        });
      } catch (e) {}

      const uniqueDocs = Array.from(new Set(docList));
      setRegisteredDoctors(uniqueDocs);
      if (uniqueDocs.length > 0 && !newApt.doctor) {
        setNewApt(prev => ({ ...prev, doctor: uniqueDocs[0] }));
      }
    };
    fetchRegisteredDoctors();
  }, [open]);

  const handleOpen = () => {
    setIsEditing(false);
    setSelectedAptId(null);
    setNewApt({
      patient: '', phone: '', doctor: 'Dr. Sarah Connor', date: '', time: '', type: 'Comprehensive Eye Exam', status: 'Booked'
    });
    setOpen(true);
  };
  const handleClose = () => setOpen(false);

  const handleSave = () => {
    if (isEditing) {
      setAppointments(appointments.map(apt => 
        apt.id === selectedAptId ? { ...apt, ...newApt } : apt
      ));
    } else {
      const nextTokenNum = 100 + appointments.length + 1;
      const toAdd = {
        id: `APT-${Math.floor(1000 + Math.random() * 9000)}`,
        token: `T-${nextTokenNum}`,
        ...newApt
      };
      setAppointments([...appointments, toAdd]);
    }
    setNewApt({
      patient: '', phone: '', doctor: 'Dr. Sarah Connor', date: '', time: '', type: 'Comprehensive Eye Exam', status: 'Booked'
    });
    handleClose();
  };

  const handleEdit = (apt) => {
    setNewApt({
      patient: apt.patient,
      phone: apt.phone || '',
      doctor: apt.doctor,
      date: apt.date,
      time: apt.time,
      type: apt.type,
      status: apt.status
    });
    setSelectedAptId(apt.id);
    setIsEditing(true);
    setOpen(true);
  };

  const handleCancelApt = (aptId) => {
    if (confirm("Are you sure you want to cancel this appointment?")) {
      setAppointments(appointments.map(apt => 
        apt.id === aptId ? { ...apt, status: 'Cancelled' } : apt
      ));
    }
  };

  const handleView = (apt) => {
    setViewingApt(apt);
    setViewOpen(true);
  };

  return (
    <Box sx={{ p: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>Clinic Schedules & Bookings</Typography>
          <Typography variant="body2" color="text.secondary">Coordinate doctor availability, reschedule eye exams, and issue automated reminders</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpen} sx={{ backgroundColor: '#2563EB' }}>
          Book Appointment
        </Button>
      </Box>

      {/* Appointment table */}
      <Card sx={{ mb: 4 }}>
        <CardContent sx={{ p: 0 }}>
          <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
            <Table size="medium">
              <TableHead sx={{ backgroundColor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }}>Appointment ID</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }} align="center">Token</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }}>Patient Details</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }}>Optometrist</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }}>Schedule Date & Time</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }}>Exam Type</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }} align="center">Status</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 1.5 }} align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {appointments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} align="center" sx={{ py: 8 }}>
                      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                        <Typography variant="h6" color="text.secondary" fontWeight={700}>No Appointments Scheduled</Typography>
                        <Typography variant="body2" color="text.secondary">All details are blank. Click "Book Appointment" to add patients to the list.</Typography>
                      </Box>
                    </TableCell>
                  </TableRow>
                ) : (
                  appointments.map((row) => (
                    <TableRow key={row.id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                      <TableCell sx={{ fontWeight: 700, color: 'primary.main', py: 2 }}>{row.id}</TableCell>
                      <TableCell align="center" sx={{ py: 2 }}>
                        <Chip 
                          label={row.token || 'N/A'} 
                          size="small" 
                          color="secondary" 
                          variant="outlined" 
                          sx={{ fontWeight: 700, borderRadius: 2 }}
                        />
                      </TableCell>
                      <TableCell sx={{ py: 2 }}>
                        <Box>
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{row.patient || 'N/A'}</Typography>
                          <Typography variant="caption" color="text.secondary">{row.phone || 'No phone'}</Typography>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ py: 2, fontWeight: 500 }}>{row.doctor}</TableCell>
                      <TableCell sx={{ py: 2 }}>
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>{row.date}</Typography>
                          <Typography variant="caption" color="text.secondary">{row.time}</Typography>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ py: 2, color: 'text.secondary', fontSize: '0.875rem' }}>{row.type}</TableCell>
                      <TableCell align="center" sx={{ py: 2 }}>
                        <Chip 
                          label={row.status} 
                          size="small" 
                          color={row.status === 'Completed' ? 'success' : row.status === 'Cancelled' ? 'error' : row.status === 'Checked In' ? 'info' : 'primary'}
                          sx={{ fontWeight: 700, borderRadius: 1.5, minWidth: 90 }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ py: 2 }}>
                        <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
                          {row.status !== 'Completed' && row.status !== 'Cancelled' && (
                            <Button 
                              variant="contained" 
                              size="small" 
                              sx={{ textTransform: 'none', borderRadius: 2, fontSize: '0.75rem', px: 1.5, py: 0.5, backgroundColor: '#2563EB', '&:hover': { backgroundColor: '#1d4ed8' } }}
                              onClick={() => {
                                navigate('/optical/eyetest', {
                                  state: {
                                    appointment: {
                                      id: row.id,
                                      name: row.patient,
                                      phone: row.phone,
                                      optometrist: row.doctor,
                                      date: row.date,
                                      type: row.type
                                    }
                                  }
                                });
                              }}
                            >
                              Start Eye Test
                            </Button>
                          )}
                          <IconButton size="small" color="info" title="View details" onClick={() => handleView(row)}>
                            <ViewIcon fontSize="small" />
                          </IconButton>
                          {row.status !== 'Completed' && row.status !== 'Cancelled' && (
                            <>
                              <IconButton size="small" color="primary" title="Edit appointment" onClick={() => handleEdit(row)}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                              <IconButton size="small" color="error" title="Cancel appointment" onClick={() => handleCancelApt(row.id)}>
                                <CancelIcon fontSize="small" />
                              </IconButton>
                            </>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>



      {/* Book Appointment Dialog */}
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>{isEditing ? "Edit Appointment Booking" : "New Appointment Booking"}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ py: 1 }}>
            <TextField label="Patient Name" fullWidth value={newApt.patient} onChange={(e) => setNewApt({...newApt, patient: e.target.value})} />
            <TextField label="Phone Number" fullWidth value={newApt.phone} onChange={(e) => setNewApt({...newApt, phone: e.target.value})} />
            <TextField select label="Doctor" fullWidth value={newApt.doctor} onChange={(e) => setNewApt({...newApt, doctor: e.target.value})}>
              {registeredDoctors.length === 0 ? (
                <MenuItem value="" disabled>-- No Doctors Added Yet (Add in Admin -&gt; Users) --</MenuItem>
              ) : (
                registeredDoctors.map(doc => <MenuItem key={doc} value={doc}>{doc}</MenuItem>)
              )}
            </TextField>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField label="Date" type="date" InputLabelProps={{ shrink: true }} fullWidth value={newApt.date} onChange={(e) => setNewApt({...newApt, date: e.target.value})} />
              </Grid>
              <Grid item xs={6}>
                <TextField label="Time (e.g. 10:00 AM)" fullWidth value={newApt.time} onChange={(e) => setNewApt({...newApt, time: e.target.value})} />
              </Grid>
            </Grid>
            <TextField select label="Examination Type" fullWidth value={newApt.type} onChange={(e) => setNewApt({...newApt, type: e.target.value})}>
              <MenuItem value="Comprehensive Eye Exam">Comprehensive Eye Exam</MenuItem>
              <MenuItem value="Contact Lens Fit">Contact Lens Fit</MenuItem>
              <MenuItem value="Routine Follow-up">Routine Follow-up</MenuItem>
              <MenuItem value="Vision Assessment">Vision Assessment</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} sx={{ backgroundColor: '#2563EB' }}>
            {isEditing ? "Save Changes" : "Confirm Booking"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* View Appointment Dialog */}
      <Dialog open={viewOpen} onClose={() => setViewOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Appointment Details</DialogTitle>
        <DialogContent dividers>
          {viewingApt && (
            <Stack spacing={2}>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">TOKEN NUMBER</Typography>
                <Typography variant="body1" fontWeight={700} color="secondary.main">{viewingApt.token || 'N/A'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">APPOINTMENT ID</Typography>
                <Typography variant="body1" fontWeight={700} color="primary.main">{viewingApt.id}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">PATIENT NAME</Typography>
                <Typography variant="body1" fontWeight={600}>{viewingApt.patient}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">PHONE NUMBER</Typography>
                <Typography variant="body1">{viewingApt.phone || 'N/A'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">OPTOMETRIST</Typography>
                <Typography variant="body1">{viewingApt.doctor}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">SCHEDULED TIME</Typography>
                <Typography variant="body1">{viewingApt.date} @ {viewingApt.time}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">EXAMINATION TYPE</Typography>
                <Typography variant="body1">{viewingApt.type}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">STATUS</Typography>
                <Chip 
                  label={viewingApt.status} 
                  size="small" 
                  color={viewingApt.status === 'Completed' ? 'success' : viewingApt.status === 'Cancelled' ? 'error' : viewingApt.status === 'Checked In' ? 'info' : 'primary'}
                  sx={{ fontWeight: 600, mt: 0.5 }}
                />
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setViewOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
