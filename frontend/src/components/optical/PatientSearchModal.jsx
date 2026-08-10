import React, { useState } from 'react';
import { 
  Dialog, DialogTitle, DialogContent, DialogActions, 
  Button, Box, TextField, Typography, Grid, Card, CardContent, 
  Avatar, InputAdornment, IconButton, Chip, Divider, Stack,
  MenuItem, FormControlLabel, Checkbox
} from '@mui/material';
import { 
  Search as SearchIcon, 
  PersonAdd as AddPersonIcon,
  Phone as PhoneIcon,
  Badge as IDIcon,
  Close as CloseIcon,
  Check as CheckIcon,
  History as HistoryIcon
} from '@mui/icons-material';

export default function PatientSearchModal({
  open,
  onClose,
  onSelectPatient,
  onRegisterNewPatient,
  dbPatients = []
}) {
  const [activeTab, setActiveTab] = useState('search'); // 'search' or 'register'
  const [searchQuery, setSearchQuery] = useState('');
  
  // Registration form fields
  const [newPatient, setNewPatient] = useState({
    name: '',
    phone: '',
    email: '',
    age: '',
    gender: 'Male',
    address: '',
    occupation: '',
    branch: 'Main Branch',
    assignedOptometrist: 'Dr. Sarah Connor'
  });

  const searchPool = dbPatients;

  const filteredPatients = searchPool.filter(p => 
    (p.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.phone || '').includes(searchQuery) ||
    (p.id || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleRegisterSubmit = (e) => {
    e.preventDefault();
    if (!newPatient.name || !newPatient.phone) {
      alert("Patient Name and Mobile Number are required!");
      return;
    }

    const registered = {
      id: `P-${Math.floor(1000 + Math.random() * 9000)}`,
      ...newPatient,
      age: newPatient.age || '30',
      lastVisitDate: new Date().toISOString().split('T')[0],
      previousPrescription: 'Fresh Examination Initialized',
      visitHistory: []
    };

    onRegisterNewPatient?.(registered);
    onSelectPatient?.(registered);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SearchIcon color="primary" />
          <Typography variant="h6" fontWeight={800}>Patient Search & Clinical Registration</Typography>
        </Box>
        <IconButton onClick={onClose} size="small"><CloseIcon /></IconButton>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ py: 3 }}>
        {/* Toggle Mode Bar */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
          <Button 
            variant={activeTab === 'search' ? 'contained' : 'outlined'} 
            color="primary" 
            startIcon={<SearchIcon />}
            onClick={() => setActiveTab('search')}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
          >
            Search Registered Patients ({searchPool.length})
          </Button>

          <Button 
            variant={activeTab === 'register' ? 'contained' : 'outlined'} 
            color="success" 
            startIcon={<AddPersonIcon />}
            onClick={() => setActiveTab('register')}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
          >
            + Register New Clinical Patient
          </Button>
        </Box>

        {activeTab === 'search' ? (
          <Box>
            <TextField 
              fullWidth
              autoFocus
              placeholder="Search by Patient Name, Phone Number (+91...), or Patient ID (P-1002)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start"><SearchIcon color="action" /></InputAdornment>,
                sx: { borderRadius: 2.5 }
              }}
              sx={{ mb: 3 }}
            />

            <Grid container spacing={2} sx={{ maxH: 340, overflowY: 'auto', pr: 0.5 }}>
              {filteredPatients.length === 0 ? (
                <Grid item xs={12}>
                  <Box sx={{ p: 4, textAlign: 'center', bgcolor: 'action.hover', borderRadius: 2.5, border: '1px dashed', borderColor: 'divider' }}>
                    <Typography variant="subtitle2" fontWeight={700} color="text.secondary">No matching patient records found.</Typography>
                    <Button size="small" variant="contained" color="success" onClick={() => setActiveTab('register')} sx={{ mt: 1.5 }}>
                      + Register Patient Now
                    </Button>
                  </Box>
                </Grid>
              ) : (
                filteredPatients.map(p => (
                  <Grid item xs={12} sm={6} key={p.id}>
                    <Card 
                      variant="outlined" 
                      onClick={() => { onSelectPatient?.(p); onClose(); }}
                      sx={{ 
                        p: 2, 
                        borderRadius: 2.5, 
                        cursor: 'pointer', 
                        transition: 'all 0.2s ease',
                        '&:hover': { borderColor: 'primary.main', bgcolor: 'rgba(37, 99, 235, 0.04)' } 
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Avatar sx={{ bgcolor: 'primary.main', fontWeight: 700 }}>{p.name ? p.name.charAt(0) : 'P'}</Avatar>
                        <Box sx={{ flexGrow: 1 }}>
                          <Typography variant="subtitle2" fontWeight={800}>{p.name} ({p.id})</Typography>
                          <Typography variant="caption" color="text.secondary" display="block">📞 {p.phone || 'No Phone'}</Typography>
                          <Typography variant="caption" color="text.secondary" display="block">{p.age || '30'} Yrs • {p.gender || 'Male'}</Typography>
                        </Box>
                      </Box>
                    </Card>
                  </Grid>
                ))
              )}
            </Grid>
          </Box>
        ) : (
          <Box component="form" onSubmit={handleRegisterSubmit}>
            <Grid container spacing= {2}>
              <Grid item xs={12} sm={6}>
                <TextField required fullWidth label="Full Patient Name" value={newPatient.name} onChange={(e) => setNewPatient({ ...newPatient, name: e.target.value })} size="small" />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField required fullWidth label="Mobile Phone Number" value={newPatient.phone} onChange={(e) => setNewPatient({ ...newPatient, phone: e.target.value })} size="small" />
              </Grid>
              <Grid item xs={6} sm={3}>
                <TextField fullWidth label="Age" type="number" value={newPatient.age} onChange={(e) => setNewPatient({ ...newPatient, age: e.target.value })} size="small" />
              </Grid>
              <Grid item xs={6} sm={3}>
                <TextField select fullWidth label="Gender" value={newPatient.gender} onChange={(e) => setNewPatient({ ...newPatient, gender: e.target.value })} size="small">
                  <MenuItem value="Male">Male</MenuItem>
                  <MenuItem value="Female">Female</MenuItem>
                  <MenuItem value="Other">Other</MenuItem>
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField fullWidth label="Email Address" value={newPatient.email} onChange={(e) => setNewPatient({ ...newPatient, email: e.target.value })} size="small" />
              </Grid>
              <Grid item xs={12}>
                <TextField fullWidth multiline rows={2} label="Residential Address" value={newPatient.address} onChange={(e) => setNewPatient({ ...newPatient, address: e.target.value })} size="small" />
              </Grid>
            </Grid>
            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button onClick={() => setActiveTab('search')}>Cancel</Button>
              <Button type="submit" variant="contained" color="success">Register & Begin Exam</Button>
            </Box>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
