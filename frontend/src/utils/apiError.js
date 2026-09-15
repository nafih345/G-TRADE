// A readable reason from a failed axios call: DRF's {"field": ["message"]} / {"detail": "..."}
// bodies, or the fact that the server couldn't be reached at all.
export const apiErrorMessage = (err, fallback = 'The server did not accept the request.') => {
  if (!err?.response) return 'Could not reach the server — check the connection.';
  const data = err.response.data;
  if (typeof data === 'string') return data && data.length < 300 && !/<html/i.test(data) ? data : fallback;
  if (!data || typeof data !== 'object') return fallback;
  const parts = Object.entries(data).map(([field, value]) => {
    const msg = Array.isArray(value) ? value.join(' ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const label = field.replace(/_/g, ' ');
    // Messages that already name their field (or aren't about one) read fine on their own.
    return field === 'detail' || field === 'non_field_errors' || msg.toLowerCase().includes(label)
      ? msg
      : `${label}: ${msg}`;
  });
  return parts.join(' ') || fallback;
};
