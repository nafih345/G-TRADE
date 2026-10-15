// Left panel of the label designer. Advanced mode: drag (or click) elements and product
// fields onto the canvas. Beginner mode: tick the fields you want and generate a balanced
// layout for the label size — no positioning needed.
import React, { useState } from 'react';
import {
  Box, Typography, Stack, Tooltip, Chip, ToggleButtonGroup, ToggleButton, Checkbox,
  FormControlLabel, Button, Divider, Alert,
} from '@mui/material';
import {
  TextFields, QrCode2, ViewWeek, HorizontalRule, CropSquare, Image as ImageIcon,
  Lock as LockIcon, AutoFixHigh,
} from '@mui/icons-material';
import { FIELD_GROUPS, LABEL_FIELDS } from '../../../labels/labelFields';

const SHAPES = [
  { type: 'barcode', label: 'Barcode', icon: <ViewWeek fontSize="small" />, tip: 'Barcode bars generated from the product barcode (or SKU).' },
  { type: 'qr', label: 'QR code', icon: <QrCode2 fontSize="small" />, tip: 'QR code of the barcode, SKU or name.' },
  { type: 'text', label: 'Static text', icon: <TextFields fontSize="small" />, tip: 'Fixed wording such as “MRP incl. of all taxes”.' },
  { type: 'line', label: 'Line', icon: <HorizontalRule fontSize="small" />, tip: 'Divider line.' },
  { type: 'rect', label: 'Box', icon: <CropSquare fontSize="small" />, tip: 'Border or filled box.' },
  { type: 'logo', label: 'Store logo', icon: <ImageIcon fontSize="small" />, tip: 'Logo from Bill & Invoice Designer → Branding.' },
];

const QUICK_FIELDS = [
  ['store_name', 'Store name'], ['product_name', 'Product name'], ['brand', 'Brand'], ['model_number', 'Model no.'],
  ['selling_price', 'Selling price'], ['mrp', 'MRP'], ['colour', 'Colour'], ['size', 'Size'], ['sku', 'SKU'],
  ['barcode_text', 'Barcode number under bars'],
];

function DragItem({ payload, label, icon, tip, onAdd, disabled }) {
  return (
    <Tooltip title={disabled ? 'Restricted pricing — only administrators, managers and accountants can place this.' : `${tip || ''} Drag onto the label or click to add.`} placement="right">
      <Box
        draggable={!disabled}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-label-element', JSON.stringify(payload));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => !disabled && onAdd(payload)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.6, borderRadius: 1.5,
          border: '1px solid', borderColor: 'divider', fontSize: 13, userSelect: 'none',
          cursor: disabled ? 'not-allowed' : 'grab', opacity: disabled ? 0.5 : 1, bgcolor: 'background.paper',
          '&:hover': disabled ? {} : { borderColor: 'primary.main', bgcolor: 'action.hover' },
        }}
      >
        {icon}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {disabled && <LockIcon sx={{ fontSize: 14 }} />}
      </Box>
    </Tooltip>
  );
}

export default function ElementPalette({ mode, onModeChange, onAdd, allowedFields, onAutoLayout, readOnly }) {
  const [quick, setQuick] = useState(['store_name', 'product_name', 'selling_price', 'colour', 'size', 'barcode_text']);
  const [style, setStyle] = useState('card');
  const toggle = (id) => setQuick((q) => (q.includes(id) ? q.filter((x) => x !== id) : [...q, id]));

  return (
    <Box>
      <ToggleButtonGroup exclusive fullWidth size="small" value={mode} onChange={(e, v) => v && onModeChange(v)} sx={{ mb: 1.5 }}>
        <ToggleButton value="beginner">Quick setup</ToggleButton>
        <ToggleButton value="advanced">Advanced</ToggleButton>
      </ToggleButtonGroup>

      {mode === 'beginner' ? (
        <Stack spacing={1}>
          <Typography variant="caption" color="text.secondary">
            Tick what should print. Values come from each product automatically — you never type prices or names here.
          </Typography>
          <Box>
            {QUICK_FIELDS.map(([id, label]) => (
              <FormControlLabel
                key={id}
                sx={{ display: 'flex', mr: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
                control={<Checkbox size="small" checked={quick.includes(id)} onChange={() => toggle(id)} sx={{ py: 0.3 }} />}
                label={label}
              />
            ))}
          </Box>
          <ToggleButtonGroup exclusive size="small" value={style} onChange={(e, v) => v && setStyle(v)} fullWidth>
            <ToggleButton value="card">Left aligned</ToggleButton>
            <ToggleButton value="stacked">Centred</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" startIcon={<AutoFixHigh />} disabled={readOnly} onClick={() => onAutoLayout(quick, style)}>
            Arrange label
          </Button>
          <Alert severity="info" sx={{ py: 0, fontSize: 12 }}>
            Replaces the current elements (Undo brings them back). Switch to <b>Advanced</b> to fine-tune.
          </Alert>
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="overline" color="text.secondary">Elements</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
              {SHAPES.map((s) => (
                <DragItem key={s.type} payload={{ type: s.type }} label={s.label} icon={s.icon} tip={s.tip} onAdd={onAdd} disabled={readOnly} />
              ))}
            </Box>
          </Box>
          <Divider />
          {FIELD_GROUPS.map((g) => (
            <Box key={g.id}>
              <Typography variant="overline" color="text.secondary">{g.label} fields</Typography>
              <Stack spacing={0.6}>
                {LABEL_FIELDS.filter((f) => f.group === g.id).map((f) => (
                  <DragItem
                    key={f.id}
                    payload={{ type: 'field', field: f.id }}
                    label={f.label}
                    icon={<Chip label={f.kind === 'price' ? '₹' : f.kind === 'date' ? 'D' : 'Aa'} size="small" sx={{ height: 18, fontSize: 10, minWidth: 26 }} />}
                    tip={f.job ? 'Typed per print batch (e.g. from the purchase row) — hidden when not given.' : 'Filled from the product record.'}
                    onAdd={onAdd}
                    disabled={readOnly || !allowedFields.has(f.id)}
                  />
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}
