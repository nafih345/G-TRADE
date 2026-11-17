'use strict';
const api = window.gtradeDesktop;
const params = new URLSearchParams(location.search);
document.getElementById('detail').textContent = params.get('detail') || '';
document.getElementById('retry').addEventListener('click', async () => {
  document.getElementById('status').textContent = 'Retrying…';
  try {
    const s = await api.connection.retry();
    document.getElementById('status').textContent = s && s.state === 'offline' ? (s.detail || 'Still unavailable.') : '';
  } catch (e) {
    document.getElementById('status').textContent = e.message;
  }
});
document.getElementById('settings').addEventListener('click', () => api.openConnectionSettings());
// Reconnect automatically when the shell reports the server is back.
let reconnecting = false;
api.onConnectionStatus((s) => {
  if (reconnecting || !s || s.state === 'offline' || s.state === 'checking') return;
  reconnecting = true;
  api.connection.retry().finally(() => { setTimeout(() => { reconnecting = false; }, 5000); });
});
