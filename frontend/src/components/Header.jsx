import React from 'react';
import { 
  AppBar, Toolbar, IconButton, InputBase, Box, 
  Avatar, Menu, MenuItem, Typography, Badge, FormControl, Select
} from '@mui/material';
import {
  Search as SearchIcon,
  NotificationsNone as NotificationsIcon,
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
  Logout as LogoutIcon,
  Store as BranchIcon
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';

export default function Header({ toggleTheme, mode }) {
  const { user, logout } = useAuth();
  const [anchorEl, setAnchorEl] = React.useState(null);
  const [branch, setBranch] = React.useState('main');

  const handleMenu = (event) => setAnchorEl(event.currentTarget);
  const handleClose = () => setAnchorEl(null);

  const handleLogout = () => {
    handleClose();
    logout();
  };

  return (
    <AppBar 
      position="sticky" 
      elevation={0}
      sx={{ 
        backgroundColor: mode === 'dark' ? 'rgba(17, 24, 39, 0.7)' : 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(12px)',
        borderBottom: mode === 'dark' ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(0, 0, 0, 0.06)',
        color: 'inherit',
        zIndex: (theme) => theme.zIndex.drawer + 1
      }}
    >
      <Toolbar sx={{ justifyContent: 'space-between', px: 3 }}>
        {/* Global Search Bar */}
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
          px: 2, 
          py: 0.5,
          borderRadius: 3,
          width: { xs: 150, sm: 350 }
        }}>
          <SearchIcon sx={{ color: 'text.secondary', mr: 1, fontSize: 20 }} />
          <InputBase 
            placeholder="Search Patients, Products, Prescriptions, Invoices..." 
            sx={{ fontSize: '0.875rem', width: '100%' }}
          />
        </Box>

        {/* Right side controls */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {/* Branch Selector */}
          <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 1 }}>
            <BranchIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
            <Select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              size="small"
              variant="standard"
              disableUnderline
              sx={{ 
                fontSize: '0.875rem', 
                fontWeight: 600, 
                color: 'text.primary',
                '& .MuiSelect-select': { py: 0.5 }
              }}
            >
              <MenuItem value="main">Main Branch</MenuItem>
              <MenuItem value="downtown">Downtown Outlet</MenuItem>
              <MenuItem value="uptown">Uptown Eye Clinic</MenuItem>
            </Select>
          </Box>

          <IconButton onClick={toggleTheme} color="inherit">
            {mode === 'dark' ? <LightModeIcon sx={{ fontSize: 22 }} /> : <DarkModeIcon sx={{ fontSize: 22 }} />}
          </IconButton>

          <IconButton color="inherit">
            <Badge badgeContent={3} color="primary">
              <NotificationsIcon sx={{ fontSize: 22 }} />
            </Badge>
          </IconButton>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, ml: 1, cursor: 'pointer' }} onClick={handleMenu}>
            <Avatar 
              sx={{ 
                width: 36, 
                height: 36, 
                background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
                fontSize: '0.9rem',
                fontWeight: 700
              }}
            >
              {user?.username?.substring(0, 2).toUpperCase()}
            </Avatar>
            <Box sx={{ display: { xs: 'none', sm: 'block' }, textAlign: 'left' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, lineHeight: 1 }}>
                {user?.first_name} {user?.last_name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {user?.role_display}
              </Typography>
            </Box>
          </Box>

          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleClose}
            transformOrigin={{ horizontal: 'right', vertical: 'top' }}
            anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
            PaperProps={{
              sx: {
                mt: 1.5,
                width: 200,
                borderRadius: 3,
                boxShadow: '0 8px 30px rgba(0,0,0,0.15)'
              }
            }}
          >
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{user?.username}</Typography>
              <Typography variant="caption" color="text.secondary">{user?.email}</Typography>
            </Box>
            <MenuItem onClick={handleClose}>My Profile</MenuItem>
            <MenuItem onClick={handleClose}>Security Log</MenuItem>
            <MenuItem onClick={handleLogout} sx={{ color: 'error.main', gap: 1 }}>
              <LogoutIcon sx={{ fontSize: 18 }} /> Logout
            </MenuItem>
          </Menu>
        </Box>
      </Toolbar>
    </AppBar>
  );
}
