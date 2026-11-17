import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import axios from 'axios';
import { IS_LOCAL_EDITION } from '../utils/edition';

// Windows local edition: a one-line banner whenever the licence needs attention. Cloud: nothing.
const SHOW = ['EVALUATION', 'GRACE', 'REVOKED', 'EXPIRED', 'EVALUATION_ENDED', 'INVALID'];

export default function LicenseBanner() {
  const [lic, setLic] = useState(null);
  useEffect(() => {
    if (!IS_LOCAL_EDITION) return undefined;
    const load = () => axios.get('/api/licensing/status/', { __silentError: true }).then((r) => setLic(r.data)).catch(() => {});
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  if (!IS_LOCAL_EDITION || !lic || !SHOW.includes(lic.status)) return null;
  const bad = lic.read_only;
  return (
    <div role="alert" style={{ padding: '6px 12px', fontSize: 13, background: bad ? '#fee2e2' : '#fef3c7', color: bad ? '#991b1b' : '#92400e',
      borderBottom: `1px solid ${bad ? '#fecaca' : '#fde68a'}` }}>
      {lic.message} <RouterLink to="/license">Licence details</RouterLink>
    </div>
  );
}
