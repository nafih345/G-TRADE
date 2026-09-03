import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  AppBar, Toolbar, IconButton, InputBase, Box, 
  Avatar, Menu, MenuItem, Typography, Badge, Select,
  Popover, List, ListItem, ListItemText, ListItemIcon, 
  Divider, Button, Chip, Stack, Tooltip
} from '@mui/material';
import {
  Search as SearchIcon,
  Menu as MenuIcon,
  NotificationsNone as NotificationsIcon,
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
  Logout as LogoutIcon,
  Store as BranchIcon,
  Warning as WarningIcon,
  Error as ErrorIcon,
  Info as InfoIcon,
  CheckCircle as SuccessIcon,
  DoneAll as MarkReadIcon,
  DeleteSweep as ClearIcon,
  ChevronRight as ChevronRightIcon
} from '@mui/icons-material';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useBranch } from '../context/BranchContext';

export default function Header({ toggleTheme, mode, onMenuClick }) {
  const { user, logout } = useAuth();
  const { multiBranchEnabled, branches, activeBranch, setActiveBranch } = useBranch();
  const navigate = useNavigate();

  // User Profile Menu Anchor
  const [profileAnchorEl, setProfileAnchorEl] = useState(null);

  // Notifications Menu Popover Anchor
  const [notifAnchorEl, setNotifAnchorEl] = useState(null);
  const [notifications, setNotifications] = useState([]);

  // Branch switcher is driven by BranchContext (see useBranch above). Only the notification
  // feed is fetched here now.
  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const notifRes = await axios.get('/api/company/notifications/');
        if (notifRes.data && Array.isArray(notifRes.data) && notifRes.data.length > 0) {
          setNotifications(notifRes.data);
        }
      } catch (e) {
        // No notifications available — leave the list empty.
      }
    };
    fetchNotifications();
  }, []);


  // Calculate Unread Badge Count
  const unreadCount = notifications.filter(n => !n.is_read).length;

  // Handlers
  const handleProfileOpen = (event) => setProfileAnchorEl(event.currentTarget);
  const handleProfileClose = () => setProfileAnchorEl(null);

  const handleNotifOpen = (event) => setNotifAnchorEl(event.currentTarget);
  const handleNotifClose = () => setNotifAnchorEl(null);

  const handleLogout = () => {
    handleProfileClose();
    logout();
  };

  // Mark All Notifications as Read in Database & State
  const handleMarkAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    try {
      await axios.post('/api/company/notifications/mark-all-read/');
    } catch (e) {}
  };

  // Clear All Notifications
  const handleClearNotifications = () => {
    setNotifications([]);
  };

  // Click Individual Notification
  const handleNotificationClick = (notif) => {
    // Mark clicked as read
    setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: true } : n));
    handleNotifClose();
    if (notif.target_link) {
      navigate(notif.target_link);
    }
  };

  // Helper for notification type icon & color
  const getNotifIcon = (type) => {
    switch (type) {
      case 'ERROR':
        return <ErrorIcon color="error" fontSize="small" />;
      case 'WARNING':
        return <WarningIcon sx={{ color: '#f59e0b' }} fontSize="small" />;
      case 'SUCCESS':
        return <SuccessIcon color="success" fontSize="small" />;
      default:
        return <InfoIcon color="primary" fontSize="small" />;
    }
  };

  return (
    <AppBar 
      position="sticky" 
      elevation={0}
      sx={{ 
        backgroundColor: mode === 'dark' ? 'rgba(17, 24, 39, 0.85)' : 'rgba(255, 255, 255, 0.9)',
        backdropFilter: 'blur(12px)',
        borderBottom: mode === 'dark' ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(0, 0, 0, 0.06)',
        color: 'inherit',
        zIndex: (theme) => theme.zIndex.drawer + 1
      }}
    >
      <Toolbar sx={{ justifyContent: 'space-between', px: { xs: 1.5, sm: 3 }, gap: 1 }}>
        {/* Hamburger Menu — only rendered below `md`, where the Sidebar is an overlay closed
            by default rather than a permanent space-reserving drawer */}
        <IconButton
          onClick={onMenuClick}
          sx={{ display: { xs: 'inline-flex', md: 'none' }, color: 'text.primary' }}
        >
          <MenuIcon />
        </IconButton>

        {/* Global Search Bar */}
        <Box sx={{
          display: 'flex',
          alignItems: 'center',
          backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
          px: 2,
          py: 0.5,
          borderRadius: 3,
          flexGrow: { xs: 1, sm: 0 },
          minWidth: 0,
          width: { xs: 'auto', sm: 350 }
        }}>
          <SearchIcon sx={{ color: 'text.secondary', mr: 1, fontSize: 20 }} />
          <InputBase 
            placeholder="Search Patients, Products, Prescriptions, Invoices..." 
            sx={{ fontSize: '0.875rem', width: '100%' }}
          />
        </Box>

        {/* Right side controls */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          
          {/* 📌 BRANCH SWITCHER — only shown when Multi-Branch Mode is ON (spec section 4) */}
          {multiBranchEnabled && branches.length > 0 && (
            <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 1, bgcolor: mode === 'dark' ? 'rgba(255,255,255,0.04)' : '#f1f5f9', px: 1.5, py: 0.5, borderRadius: 2.5 }}>
              <BranchIcon sx={{ color: 'primary.main', fontSize: 18 }} />
              <Select
                value={activeBranch?.id || ''}
                onChange={(e) => {
                  setActiveBranch(e.target.value);
                  // Full reload so every open page re-fetches its data scoped to the new
                  // branch (the X-Branch-Id header is already updated by setActiveBranch).
                  window.location.reload();
                }}
                size="small"
                variant="standard"
                disableUnderline
                sx={{
                  fontSize: '0.875rem',
                  fontWeight: 800,
                  color: 'text.primary',
                  '& .MuiSelect-select': { py: 0.2 }
                }}
              >
                {branches.map((b) => (
                  <MenuItem key={b.id} value={b.id} sx={{ fontWeight: 700, fontSize: '0.875rem' }}>
                    {b.name}{b.is_default ? ' (Main)' : ''}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          )}

          {/* Theme Toggle Button */}
          <Tooltip title={mode === 'dark' ? "Switch to Light Mode" : "Switch to Dark Mode"}>
            <IconButton onClick={toggleTheme} color="inherit">
              {mode === 'dark' ? <LightModeIcon sx={{ fontSize: 22 }} /> : <DarkModeIcon sx={{ fontSize: 22 }} />}
            </IconButton>
          </Tooltip>

          {/* 🔔 NOTIFICATION BELL BUTTON WITH DYNAMIC UNREAD BADGE */}
          <Tooltip title="System Alerts & Issue Notifications">
            <IconButton color="inherit" onClick={handleNotifOpen}>
              <Badge badgeContent={unreadCount} color="primary">
                <NotificationsIcon sx={{ fontSize: 22 }} />
              </Badge>
            </IconButton>
          </Tooltip>

          {/* 🔔 NOTIFICATION SYSTEM POPOVER DRAWER */}
          <Popover
            open={Boolean(notifAnchorEl)}
            anchorEl={notifAnchorEl}
            onClose={handleNotifClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            PaperProps={{
              sx: {
                mt: 1.5,
                width: { xs: 320, sm: 380 },
                borderRadius: 3.5,
                boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
                overflow: 'hidden'
              }
            }}
          >
            {/* Notification Drawer Header */}
            <Box sx={{ p: 2, bgcolor: '#0f172a', color: '#ffffff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="subtitle1" fontWeight={850}>System Issues & Alerts</Typography>
                {unreadCount > 0 && (
                  <Chip label={`${unreadCount} New`} size="small" color="primary" sx={{ height: 20, fontSize: '0.7rem', fontWeight: 800 }} />
                )}
              </Box>

              <Stack direction="row" spacing={0.5}>
                {unreadCount > 0 && (
                  <Tooltip title="Mark All as Read">
                    <IconButton size="small" onClick={handleMarkAllRead} sx={{ color: '#94a3b8', '&:hover': { color: '#fff' } }}>
                      <MarkReadIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                {notifications.length > 0 && (
                  <Tooltip title="Clear All Notifications">
                    <IconButton size="small" onClick={handleClearNotifications} sx={{ color: '#94a3b8', '&:hover': { color: '#ef4444' } }}>
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            </Box>

            {/* Notification List */}
            <List sx={{ p: 0, maxHeight: 360, overflowY: 'auto' }}>
              {notifications.length === 0 ? (
                <Box sx={{ p: 4, textAlign: 'center' }}>
                  <SuccessIcon sx={{ fontSize: 44, color: 'success.main', mb: 1 }} />
                  <Typography variant="subtitle2" fontWeight={800}>All Systems Operational</Typography>
                  <Typography variant="caption" color="text.secondary">No active issues or unread alerts recorded.</Typography>
                </Box>
              ) : (
                notifications.map((notif) => (
                  <React.Fragment key={notif.id}>
                    <ListItem 
                      button 
                      onClick={() => handleNotificationClick(notif)}
                      sx={{ 
                        px: 2, py: 1.5,
                        bgcolor: notif.is_read ? 'transparent' : 'action.hover',
                        transition: 'background-color 0.2s',
                        alignItems: 'flex-start'
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>
                        {getNotifIcon(notif.notification_type)}
                      </ListItemIcon>

                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography 
                              variant="subtitle2" 
                              fontWeight={notif.is_read ? 700 : 850} 
                              color={notif.is_read ? 'text.primary' : 'primary.main'}
                              sx={{ fontSize: '0.85rem' }}
                            >
                              {notif.title}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
                              {notif.time_ago || 'Recent'}
                            </Typography>
                          </Box>
                        }
                        secondary={
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, lineHeight: 1.3 }}>
                            {notif.message}
                          </Typography>
                        }
                      />
                      <ChevronRightIcon fontSize="small" sx={{ color: 'text.disabled', ml: 0.5, mt: 1 }} />
                    </ListItem>
                    <Divider component="li" />
                  </React.Fragment>
                ))
              )}
            </List>
          </Popover>

          {/* User Profile Avatar Button */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, ml: 1, cursor: 'pointer' }} onClick={handleProfileOpen}>
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

          {/* User Profile Menu */}
          <Menu
            anchorEl={profileAnchorEl}
            open={Boolean(profileAnchorEl)}
            onClose={handleProfileClose}
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
            <Divider />
            <MenuItem onClick={handleProfileClose}>My Profile</MenuItem>
            <MenuItem onClick={handleProfileClose}>Security Log</MenuItem>
            <MenuItem onClick={handleLogout} sx={{ color: 'error.main', gap: 1 }}>
              <LogoutIcon sx={{ fontSize: 18 }} /> Logout
            </MenuItem>
          </Menu>
        </Box>
      </Toolbar>
    </AppBar>
  );
}
