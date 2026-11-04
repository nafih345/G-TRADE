"""Purchase Entry → Barcode Printing: label progress per line, resumable after a job stops
part-way, one unconfirmed PRINT job at a time, reprints logged without moving counters, and
progress surviving an edit that recreates the lines."""
from rest_framework.test import APITestCase

from apps.financial.tests.helpers import TODAY, make_product, make_warehouse
from apps.purchasing.models import PurchaseInvoiceItem, PurchaseLabelPrintJob, Supplier


class LabelPrintingTests(APITestCase):
    def setUp(self):
        self.wh = make_warehouse()
        self.supplier = Supplier.objects.create(name='Hoya', supplier_code='SUP-LBL')
        self.products = [make_product(name=f'Frame {i}') for i in range(1, 11)]
        self.invoice_id = self.save([self.line(p, 100) for p in self.products])

    def line(self, product, qty, free=0, batch=None):
        return {'product': str(product.pk), 'quantity': qty, 'free_quantity': free, 'purchase_rate': 10,
                'selling_price': 20, 'line_total': qty * 10, 'batch_number': batch}

    def body(self, items):
        return {'invoice_number': 'PE-LBL', 'supplier': str(self.supplier.pk), 'purchase_date': TODAY.isoformat(),
                'purchase_type': 'CASH', 'payment_method': 'CASH', 'status': 'CONFIRMED', 'grand_total': 0,
                'paid_amount': 0, 'balance_amount': 0, 'items': items}

    def save(self, items, invoice_id=None):
        with self.captureOnCommitCallbacks(execute=True):
            if invoice_id:
                res = self.client.put(f'/api/purchase/invoices/{invoice_id}/', self.body(items), format='json')
            else:
                res = self.client.post('/api/purchase/invoices/', self.body(items), format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        return res.data['id']

    def status(self):
        res = self.client.get(f'/api/purchase/invoices/{self.invoice_id}/label-status/')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def start(self, lines, kind='PRINT', expect=201):
        res = self.client.post(f'/api/purchase/invoices/{self.invoice_id}/label-jobs/', {'kind': kind, 'lines': lines}, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def confirm(self, job_id, outcome, count=None, expect=200):
        res = self.client.post(f'/api/purchase/invoices/{self.invoice_id}/label-jobs/{job_id}/confirm/',
                               {'outcome': outcome, 'printed_count': count}, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def pending_lines(self, items):
        return [{'item': r['id'], 'from_unit': r['next_unit'], 'to_unit': r['total']} for r in items if r['pending']]

    def test_stopped_mid_item_resumes_from_next_unit(self):
        st = self.status()
        self.assertEqual(st['totals'], {'labels': 1000, 'printed': 0, 'pending': 1000})
        job = self.start(self.pending_lines(st['items']))
        self.assertEqual((job['status'], job['labels_sent']), ('SENT', 1000))

        # Printer ran out after 50 labels of the 5th item: 4 × 100 + 50.
        res = self.confirm(job['id'], 'PARTIAL', 450)
        self.assertEqual(res['job']['status'], 'PARTIAL')
        items = res['status']['items']
        self.assertEqual([r['printed'] for r in items], [100] * 4 + [50] + [0] * 5)
        self.assertEqual(items[4]['next_unit'], 51)
        self.assertEqual(items[4]['pending'], 50)
        self.assertEqual(res['status']['totals']['pending'], 550)
        self.assertIsNone(res['status']['open_job'])

        # Resuming from anything but unit 51 is refused: it would repeat or skip labels.
        self.start([{'item': items[4]['id'], 'from_unit': 1, 'to_unit': 100}], expect=409)
        job2 = self.start(self.pending_lines(items))
        self.assertEqual(job2['labels_sent'], 550)
        self.assertEqual(job2['lines'][0]['from_unit'], 51)
        self.confirm(job2['id'], 'ALL')
        self.assertEqual(self.status()['totals'], {'labels': 1000, 'printed': 1000, 'pending': 0})

    def test_one_unconfirmed_print_job_at_a_time(self):
        items = self.status()['items']
        job = self.start(self.pending_lines(items[:1]))
        self.assertEqual(self.status()['open_job']['id'], job['id'])
        self.start(self.pending_lines(items[1:2]), expect=409)
        self.confirm(job['id'], 'NONE')
        self.confirm(job['id'], 'ALL', expect=409)  # already confirmed
        self.assertEqual(self.status()['totals']['printed'], 0)
        self.start(self.pending_lines(items[1:2]))

    def test_print_part_of_a_line_then_continue(self):
        item = self.status()['items'][0]
        self.confirm(self.start([{'item': item['id'], 'from_unit': 1, 'to_unit': 30}])['id'], 'ALL')
        item = self.status()['items'][0]
        self.assertEqual((item['printed'], item['next_unit']), (30, 31))
        self.start([{'item': item['id'], 'from_unit': 31, 'to_unit': 101}], expect=400)  # past the line's qty

    def test_reprint_is_logged_without_moving_counters(self):
        item = self.status()['items'][0]
        self.start([{'item': item['id'], 'from_unit': 1, 'to_unit': 5}], kind='REPRINT', expect=400)  # nothing printed yet
        self.confirm(self.start([{'item': item['id'], 'from_unit': 1, 'to_unit': 20}])['id'], 'ALL')
        job = self.start([{'item': item['id'], 'from_unit': 3, 'to_unit': 7}], kind='REPRINT')
        self.assertEqual((job['status'], job['labels_sent']), ('COMPLETED', 5))
        # A reprint doesn't block printing the rest, and the line still shows 20 printed.
        st = self.status()
        self.assertEqual(st['items'][0]['printed'], 20)
        self.assertIsNone(st['open_job'])
        self.assertEqual([h['kind'] for h in st['history']][:2], ['REPRINT', 'PRINT'])

    def test_progress_survives_an_edit(self):
        items = self.status()['items']
        self.confirm(self.start(self.pending_lines(items[:2]))['id'], 'PARTIAL', 130)
        open_job = self.start(self.pending_lines(items[2:3]))

        # Edit: drop the last line and raise line 2's quantity. Lines are recreated with new ids.
        lines = [self.line(p, 100) for p in self.products[:9]]
        lines[1] = self.line(self.products[1], 120)
        self.save(lines, self.invoice_id)
        st = self.status()
        self.assertNotEqual(st['items'][0]['id'], items[0]['id'])
        self.assertEqual([r['printed'] for r in st['items'][:3]], [100, 30, 0])
        self.assertEqual(st['items'][1]['pending'], 90)
        self.assertEqual(st['totals']['labels'], 920)

        # The job sent before the edit still confirms against the recreated line.
        self.assertEqual(st['open_job']['lines'][0]['item'], st['items'][2]['id'])
        res = self.confirm(open_job['id'], 'ALL')
        self.assertEqual(res['status']['items'][2]['printed'], 100)

    def test_quantity_reduced_below_printed(self):
        item = self.status()['items'][0]
        self.confirm(self.start([{'item': item['id'], 'from_unit': 1, 'to_unit': 80}])['id'], 'ALL')
        self.save([self.line(self.products[0], 50)] + [self.line(p, 100) for p in self.products[1:]], self.invoice_id)
        row = self.status()['items'][0]
        self.assertEqual((row['printed'], row['pending'], row['over_printed'], row['next_unit']), (50, 0, 30, None))
        self.assertEqual(PurchaseInvoiceItem.objects.get(pk=row['id']).labels_printed, 80)
        self.assertEqual(PurchaseLabelPrintJob.objects.count(), 1)

    def queue(self):
        res = self.client.get('/api/purchase/invoices/label-queue/')
        self.assertEqual(res.status_code, 200, res.content)
        return {row['id']: row for row in res.data}

    def test_queue_lists_entries_with_labels_left(self):
        # Saved, nothing printed: all 10 items are waiting.
        row = self.queue()[str(self.invoice_id)]
        self.assertEqual((row['pending_items'], row['pending_labels'], row['resume'], row['awaiting_confirmation']),
                         (10, 1000, False, False))

        job = self.start(self.pending_lines(self.status()['items']))
        self.assertTrue(self.queue()[str(self.invoice_id)]['awaiting_confirmation'])

        # Stopped part-way through item 5: items 5–10 remain, resuming mid-line.
        self.confirm(job['id'], 'PARTIAL', 450)
        row = self.queue()[str(self.invoice_id)]
        self.assertEqual((row['pending_items'], row['pending_labels'], row['resume'], row['awaiting_confirmation']),
                         (6, 550, True, False))

        # Fully printed entries drop out of the queue.
        self.confirm(self.start(self.pending_lines(self.status()['items']))['id'], 'ALL')
        self.assertNotIn(str(self.invoice_id), self.queue())
