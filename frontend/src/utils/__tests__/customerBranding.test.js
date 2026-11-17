// Customer documents carry the CUSTOMER's identity (Store & Clinic Profile), never the software
// vendor's name, a sample shop, a sample phone number or a sample doctor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInvoiceWhatsAppMessage } from '../whatsappInvoice.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(SRC, rel), 'utf8');
const VENDOR_OR_SAMPLE = /greensol|sarah connor|sarah miller|98470\s?12345|greensol@bank/i;

const invoice = { invoiceNumber: 'INV-7', date: '2026-11-13', customerName: 'Ravi', phone: '9876501234',
  netTotal: 1200, paidAmount: 1200, items: [{ name: 'Frame A' }, { name: 'Lens B' }] };

test('WhatsApp receipt is signed with the store name and phone from the profile', () => {
  const { message } = buildInvoiceWhatsAppMessage(invoice, null, { name: 'Sunrise Opticals', phone: '+91 99000 11111' });
  assert.match(message, /SUNRISE OPTICALS - TAX INVOICE RECEIPT/);
  assert.match(message, /Thank you for choosing Sunrise Opticals!/);
  assert.match(message, /call \+91 99000 11111/);
  assert.match(message, /\*Sunrise Opticals\*$/);
  assert.doesNotMatch(message, VENDOR_OR_SAMPLE);
});

test('without a store profile the receipt names nobody and invents no phone number', () => {
  const { message } = buildInvoiceWhatsAppMessage(invoice, null, { name: '', phone: '' });
  assert.match(message, /^👓 \*TAX INVOICE RECEIPT\*/);
  assert.match(message, /visit our store\.\n/);
  assert.doesNotMatch(message, VENDOR_OR_SAMPLE);
  assert.doesNotMatch(message, /call /);
});

test('customer-facing screens and prints contain no vendor or sample identity', () => {
  // utils/whatsappInvoice.js is covered by the message tests above (its source keeps a filter that
  // discards the old sample phone number from legacy customer records).
  for (const rel of [
    'components/optical/PrintPrescriptionCard.jsx',
    'components/optical/PatientSearchModal.jsx',
    'pages/Appointments.jsx',
    'pages/OpticalServices.jsx',
    'pages/SalesInvoice.jsx',
    'pages/Administration.jsx',
    'components/sales/PaymentsManagerView.jsx',
    'components/settings/security/BackupRecoveryCard.jsx',
  ]) {
    assert.doesNotMatch(read(rel), VENDOR_OR_SAMPLE, rel);
  }
});

test('the prescription card makes no digital-signature claim', () => {
  assert.doesNotMatch(read('components/optical/PrintPrescriptionCard.jsx'), /Digitally Signed/i);
});

test('the Administration audit tab shows the real security audit log, not fixed sample rows', () => {
  const admin = read('pages/Administration.jsx');
  assert.match(admin, /<SecurityAuditPanel \/>/);
  assert.doesNotMatch(admin, /LOG-90\d/);
});
