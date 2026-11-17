import { useEffect, useState } from 'react';
import { desktopBridge } from '../utils/edition';

// Connection state + app/server versions, shown only inside the G-TRADE desktop shell
// (windows/desktop). Browsers and the cloud edition render nothing.
const COLORS = { online: '#059669', degraded: '#d97706', offline: '#dc2626', checking: '#6b7280' };

export default function DesktopStatus() {
  const bridge = desktopBridge();
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState({ state: 'checking' });

  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    bridge.getInfo().then((i) => alive && setInfo(i)).catch(() => {});
    const off = bridge.onConnectionStatus((s) => alive && setStatus(s));
    return () => { alive = false; if (typeof off === 'function') off(); };
  }, [bridge]);

  if (!bridge) return null;
  const state = status?.state || 'checking';
  const label = { online: 'Connected', degraded: 'Server needs attention', offline: 'Server unreachable', checking: 'Connecting…' }[state] || state;
  return (
    <div
      role="status"
      aria-live="polite"
      title={[status?.detail, info?.serverUrl].filter(Boolean).join(' · ')}
      onDoubleClick={() => bridge.openConnectionSettings()}
      style={{
        position: 'fixed', right: 8, bottom: 6, zIndex: 1400, display: 'flex', alignItems: 'center', gap: 6,
        padding: '2px 8px', borderRadius: 10, fontSize: 11, background: 'rgba(17,24,39,0.78)', color: '#f9fafb',
        userSelect: 'none', pointerEvents: 'auto',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: COLORS[state] || COLORS.checking }} />
      <span>{label}</span>
      {info && <span style={{ opacity: 0.7 }}>· App {info.appVersion}{status?.serverVersion ? ` · Server ${status.serverVersion}` : ''}</span>}
    </div>
  );
}
