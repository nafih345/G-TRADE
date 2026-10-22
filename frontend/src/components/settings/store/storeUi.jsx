import React from 'react';
import { Box, Card, Typography } from '@mui/material';

// Shared look for the Store & Clinic Profile page.
export const GREEN = '#16a34a';
export const GREEN_DARK = '#15803d';
export const GREEN_SOFT = 'rgba(22, 163, 74, 0.10)';

export const greenButtonSx = {
  bgcolor: GREEN, background: GREEN, fontWeight: 700, boxShadow: 'none',
  '&:hover': { bgcolor: GREEN_DARK, background: GREEN_DARK, boxShadow: 'none' },
};

export const focusRing = {
  '& .Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: GREEN, borderWidth: 2 },
  '& .MuiInputLabel-root.Mui-focused': { color: GREEN_DARK },
};

/** White card with an icon badge, title and subtitle. */
export function SectionCard({ id, icon, title, subtitle, action, children, sx }) {
  return (
    <Card
      id={id}
      component="section"
      aria-labelledby={id ? `${id}-title` : undefined}
      elevation={0}
      sx={{
        p: { xs: 2, sm: 3 }, borderRadius: 3, border: '1px solid', borderColor: 'divider',
        boxShadow: '0 1px 3px rgba(15, 23, 42, 0.05)', scrollMarginTop: 16, ...focusRing, ...sx,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 2.5 }}>
        <Box sx={{
          width: 40, height: 40, borderRadius: 2, bgcolor: GREEN_SOFT, color: GREEN,
          display: 'grid', placeItems: 'center', flexShrink: 0,
        }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={id ? `${id}-title` : undefined} variant="h6" component="h2" fontWeight={800} sx={{ fontSize: '1.05rem', lineHeight: 1.3 }}>
            {title}
          </Typography>
          {subtitle && <Typography variant="body2" color="text.secondary">{subtitle}</Typography>}
        </Box>
        {action}
      </Box>
      {children}
    </Card>
  );
}

// ---- logo files ----------------------------------------------------------------------------
const RASTER = ['image/png', 'image/jpeg'];
const MAX_RASTER_BYTES = 5 * 1024 * 1024;
const MAX_SVG_BYTES = 300 * 1024;
const MAX_DATA_URL = 1_500_000; // server limit (apps/company/store_profile.py)
export const LOGO_HINT = 'PNG, JPG or SVG · 512 × 512 px recommended · up to 5 MB (SVG 300 KB)';

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.onload = () => resolve(r.result);
  r.readAsDataURL(file);
});

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onerror = () => reject(new Error('The file is not a readable image.'));
  img.onload = () => resolve(img);
  img.src = src;
});

/** Validate + prepare an uploaded logo. Raster images are scaled to fit 512 px so the data URL
 *  stays small enough to embed in every printed document. Resolves {dataUrl, warning}. */
export async function prepareLogo(file) {
  const name = (file.name || '').toLowerCase();
  const isSvg = file.type === 'image/svg+xml' || name.endsWith('.svg');
  const isRaster = RASTER.includes(file.type) || /\.(png|jpe?g)$/.test(name);
  if (!isSvg && !isRaster) throw new Error('Unsupported file type — upload a PNG, JPG or SVG image.');

  if (isSvg) {
    if (file.size > MAX_SVG_BYTES) throw new Error('SVG logo is too large — keep it under 300 KB.');
    const text = await file.text();
    if (!/<svg[\s>]/i.test(text)) throw new Error('This SVG file is not a valid image.');
    if (/<script|\son\w+\s*=/i.test(text)) throw new Error('SVG logos may not contain scripts.');
    const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
    await loadImage(dataUrl);
    return { dataUrl, warning: '' };
  }

  if (file.size > MAX_RASTER_BYTES) throw new Error('Image is too large — use a file under 5 MB.');
  const img = await loadImage(await readAsDataUrl(file));
  const scale = Math.min(1, 512 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = file.type === 'image/jpeg' || /\.jpe?g$/.test(name);
  const dataUrl = canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.9);
  if (dataUrl.length > MAX_DATA_URL) throw new Error('Image is too detailed to store — try a simpler or smaller logo.');
  const warning = Math.max(img.width, img.height) < 200
    ? `Low resolution (${img.width} × ${img.height} px) — it may print blurry. 512 × 512 px is recommended.`
    : '';
  return { dataUrl, warning };
}
