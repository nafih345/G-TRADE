"""Purchase → Stock Overview API: real rows, filters, summary, ledgered adjustments,
optimistic locks, idempotency, permissions, history and export."""
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.company.models import BranchStock
from apps.financial.tests.helpers import TODAY, make_warehouse
from apps.inventory.models import StockAdjustment, StockLedger
from apps.products.models import Product, ProductBarcode
from apps.purchasing.models import Supplier

URL = '/api/inventory/stock-overview/'


def product(name, **kw):
    kw.setdefault('sku', f'SKU-{name}')
    return Product.objects.create(name=name, **kw)


class StockOverviewTests(APITestCase):
    def setUp(self):
        self.wh = make_warehouse()
        User = get_user_model()
        self.admin = User.objects.create_user(username='boss', password='x', role='SUPER_ADMIN')
        self.cashier = User.objects.create_user(username='till', password='x', role='CASHIER')
        self.client.force_authenticate(self.admin)
        self.frame = product('Aviator', barcode='2000000000017', secondary_barcode='EAN-AV', brand_name='RayBan',
                             category_name='Frames', rack_location='R1', stock=10, minimum_stock=3,
                             cost_price=Decimal('400'), retail_price=Decimal('900'), wholesale_price=Decimal('1000'),
                             color='Gold', extra_data={'mrp': 1000, 'model_no': 'RB3025'})
        self.low = product('Wayfarer', brand_name='RayBan', category_name='Frames', rack_location='R2',
                           stock=2, minimum_stock=5, cost_price=Decimal('300'), retail_price=Decimal('700'))
        self.out = product('Lens Cloth', category_name='Accessories', stock=0, cost_price=Decimal('10'),
                           retail_price=Decimal('50'))
        product('Retired', stock=99, is_active=False)

    # -- list / search / filters -----------------------------------------------------------------
    def ids(self, **params):
        res = self.client.get(URL, {'page_size': 100, **params})
        self.assertEqual(res.status_code, 200, res.content)
        return [r['name'] for r in res.data['results']]

    def test_list_is_real_active_products_with_status(self):
        res = self.client.get(URL)
        rows = {r['name']: r for r in res.data['results']}
        self.assertEqual(set(rows), {'Aviator', 'Wayfarer', 'Lens Cloth'})
        self.assertEqual([rows[n]['status'] for n in ('Aviator', 'Wayfarer', 'Lens Cloth')], ['in', 'low', 'out'])
        av = rows['Aviator']
        self.assertEqual((av['mrp'], av['cost_price'], av['variant']), ('1000.00', '400.00', 'RB3025 / Gold'))

    def test_search_and_scan(self):
        self.assertEqual(self.ids(q='rb3025'), ['Aviator'])
        self.assertEqual(self.ids(q='rayban way'), ['Wayfarer'])
        self.assertEqual(self.ids(q='R2'), ['Wayfarer'])
        ProductBarcode.objects.create(product=self.low, code='2000000000999')
        for code in ('2000000000017', 'EAN-AV', 'sku-aviator'):
            self.assertEqual(self.ids(code=code), ['Aviator'], code)
        res = self.client.get(URL + 'lookup/', {'code': '2000000000999'})
        self.assertEqual([r['name'] for r in res.data['results']], ['Wayfarer'])
        self.assertFalse(self.client.get(URL + 'lookup/', {'code': 'nope'}).data['found'])

    def test_filters_combine(self):
        self.assertEqual(self.ids(brand='rayban', status='low'), ['Wayfarer'])
        self.assertEqual(self.ids(status='out'), ['Lens Cloth'])
        self.assertEqual(self.ids(category='Frames', rack='R1'), ['Aviator'])
        sup = Supplier.objects.create(name='Luxottica', supplier_code='S1')
        self.out.supplier_name = 'Luxottica'
        self.out.save()
        self.assertEqual(self.ids(supplier=str(sup.pk)), ['Lens Cloth'])
        self.assertEqual(self.ids(ordering='-stock'), ['Aviator', 'Wayfarer', 'Lens Cloth'])

    def test_summary(self):
        s = self.client.get(URL + 'summary/').data
        self.assertEqual((s['total_products'], s['total_quantity'], s['low_stock'], s['out_of_stock']), (3, 12, 1, 1))
        self.assertEqual(s['purchase_value'], '4600.00')   # 10*400 + 2*300
        self.assertEqual(s['selling_value'], '10400.00')   # 10*900 + 2*700

    # -- adjustments -----------------------------------------------------------------------------
    def adjust(self, p, **body):
        return self.client.post(f'{URL}{p.pk}/adjust/', body, format='json')

    def test_adjustment_goes_through_ledger(self):
        res = self.adjust(self.frame, new_quantity=7, expected_stock=10, reason='Physical stock count',
                          reference='COUNT-1', client_token='tok-1')
        self.assertEqual(res.status_code, 201, res.content)
        self.frame.refresh_from_db()
        self.assertEqual(self.frame.stock, 7)
        self.assertEqual(BranchStock.objects.get(product=self.frame).quantity, 7)
        adj = StockAdjustment.objects.get()
        self.assertEqual((adj.previous_quantity, adj.new_quantity, adj.quantity, adj.adjustment_type),
                         (10, 7, 3, 'SUB'))
        self.assertEqual(adj.performed_by, 'boss')
        self.assertTrue(adj.adjustment_number.startswith('ADJ-'))
        led = StockLedger.objects.get(reference_id=adj.pk)
        self.assertEqual((led.quantity, led.balance_after, led.performed_by, led.transaction_type),
                         (-3, 7, 'boss', 'ADJ_SUB'))

        # Same token again (double click / retry): applied once.
        again = self.adjust(self.frame, new_quantity=7, expected_stock=10, reason='x', client_token='tok-1')
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.data['replayed'])
        self.assertEqual(StockAdjustment.objects.count(), 1)

        hist = self.client.get(f'{URL}{self.frame.pk}/history/').data['results']
        self.assertEqual(hist[0]['type_label'], 'Manual Adjustment')
        self.assertEqual((hist[0]['previous_stock'], hist[0]['new_stock'], hist[0]['quantity_out']), (10, 7, 3))
        self.assertIn('COUNT-1', hist[0]['remarks'])

    def test_adjustment_rejects_stale_and_invalid(self):
        stale = self.adjust(self.frame, new_quantity=4, expected_stock=9, reason='count')
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data['current_stock'], 10)
        self.assertEqual(self.adjust(self.frame, new_quantity=-1, reason='x').status_code, 400)
        self.assertEqual(self.adjust(self.frame, new_quantity=2.5, reason='x').status_code, 400)
        self.assertEqual(self.adjust(self.frame, new_quantity=4).status_code, 400)  # reason required
        self.assertEqual(self.adjust(self.frame, new_quantity=10, reason='x').status_code, 400)  # no change
        self.frame.refresh_from_db()
        self.assertEqual(self.frame.stock, 10)
        self.assertFalse(StockLedger.objects.exists())

    # -- field edits -----------------------------------------------------------------------------
    def patch(self, p, changes, original=None):
        return self.client.patch(f'{URL}{p.pk}/', {'changes': changes, 'original': original or {}}, format='json')

    def test_field_edit_never_moves_stock(self):
        res = self.patch(self.frame, {'retail_price': '950', 'mrp': '1200', 'rack_location': 'R9',
                                      'bin_location': 'B3', 'minimum_stock': 4},
                         {'retail_price': '900.00', 'mrp': '1000.00'})
        self.assertEqual(res.status_code, 200, res.content)
        self.frame.refresh_from_db()
        self.assertEqual((self.frame.retail_price, self.frame.wholesale_price, self.frame.extra_data['mrp']),
                         (Decimal('950'), Decimal('1200'), 1200.0))
        self.assertEqual((self.frame.rack_location, self.frame.bin_location, self.frame.minimum_stock, self.frame.stock),
                         ('R9', 'B3', 4, 10))
        self.assertEqual(self.patch(self.frame, {'stock': 50}).status_code, 400)
        self.assertEqual(self.patch(self.frame, {'retail_price': '-5'}).status_code, 400)
        self.assertEqual(self.patch(self.frame, {'retail_price': '5000'}).status_code, 400)  # above MRP
        self.frame.refresh_from_db()
        self.assertEqual(self.frame.stock, 10)

    def test_detail_fields_edit(self):
        from apps.masters.models import Brand
        from apps.products.models import BarcodeHistory
        oakley = Brand.objects.create(name='Oakley')
        res = self.patch(self.frame, {
            'sku': 'AV-01', 'barcode': '2000000000024', 'secondary_barcode': '', 'name': 'Aviator Gold',
            'brand': 'oakley', 'category': 'Sunglasses', 'model_no': 'OK100', 'color': 'Black', 'size': '58',
            'supplier_name': 'Hoya',
        }, {'sku': 'SKU-Aviator', 'model_no': 'RB3025', 'color': 'Gold', 'supplier_name': ''})
        self.assertEqual(res.status_code, 200, res.content)
        row = res.data
        self.assertEqual((row['sku'], row['barcode'], row['secondary_barcode'], row['name']),
                         ('AV-01', '2000000000024', '', 'Aviator Gold'))
        self.assertEqual((row['brand'], row['category'], row['model_no'], row['color'], row['size'], row['supplier_name']),
                         ('oakley', 'Sunglasses', 'OK100', 'Black', '58', 'Hoya'))
        self.frame.refresh_from_db()
        self.assertEqual((self.frame.brand_id, self.frame.stock), (oakley.pk, 10))
        self.assertEqual(BarcodeHistory.objects.filter(product=self.frame).count(), 2)
        # Codes stay unique and the name / item code can't be blanked.
        bad = self.patch(self.low, {'sku': 'av-01', 'barcode': '2000000000024', 'name': ' '})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(set(bad.data['errors']), {'name'})
        bad = self.patch(self.low, {'sku': 'av-01', 'barcode': '2000000000024'})
        self.assertEqual(set(bad.data['errors']), {'sku', 'barcode'})
        self.assertEqual(self.patch(self.low, {'barcode': 'X1', 'secondary_barcode': 'X1'}).status_code, 400)
        self.client.force_authenticate(self.cashier)
        self.assertEqual(self.patch(self.low, {'name': 'Renamed'}).status_code, 403)

    def test_field_edit_conflict(self):
        res = self.patch(self.frame, {'retail_price': '800'}, {'retail_price': '850.00'})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.data['conflicts']['retail_price'], '900.00')
        # A different field changing meanwhile (e.g. stock from a sale) is not a conflict.
        self.assertEqual(self.patch(self.frame, {'rack_location': 'R5'}, {'rack_location': 'R1'}).status_code, 200)

    # -- permissions -----------------------------------------------------------------------------
    def test_permissions(self):
        self.client.force_authenticate(self.cashier)
        rows = self.client.get(URL).data['results']
        self.assertTrue(all(r['cost_price'] is None for r in rows))
        self.assertIsNone(self.client.get(URL + 'summary/').data['purchase_value'])
        self.assertEqual(self.adjust(self.frame, new_quantity=1, reason='x').status_code, 403)
        self.assertEqual(self.patch(self.frame, {'retail_price': '1'}).status_code, 403)
        self.assertEqual(self.client.get(URL + 'export/').status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(URL).status_code, (401, 403))

    # -- purchases keep feeding the same ledger --------------------------------------------------
    def test_purchase_entry_movement_in_history(self):
        sup = Supplier.objects.create(name='Hoya', supplier_code='S2')
        body = {'invoice_number': 'PE-77', 'supplier': str(sup.pk), 'purchase_date': TODAY.isoformat(),
                'purchase_type': 'CASH', 'payment_method': 'CASH', 'status': 'CONFIRMED', 'grand_total': 1200,
                'items': [{'product': str(self.low.pk), 'quantity': 4, 'purchase_rate': 300, 'selling_price': 700,
                           'line_total': 1200}]}
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/purchase/invoices/', body, format='json')
            self.assertEqual(res.status_code, 201)
        number = res.data['invoice_number']  # system-assigned by the Purchase bill sequence
        self.assertTrue(number.startswith('PINV-'))
        row = self.client.get(URL, {'code': 'SKU-Wayfarer'}).data['results'][0]
        self.assertEqual((row['stock'], row['status'], row['supplier_name'], row['last_purchase_date']),
                         (6, 'in', 'Hoya', TODAY.isoformat()))
        h = self.client.get(f'{URL}{self.low.pk}/history/', {'type': 'PURCHASE'}).data['results']
        self.assertEqual(len(h), 1)
        self.assertEqual((h[0]['type_label'], h[0]['reference_number'], h[0]['party'], h[0]['quantity_in'],
                          h[0]['previous_stock'], h[0]['new_stock'], h[0]['unit_cost']),
                         ('Purchase Entry', number, 'Hoya', 4, 2, 6, '300.00'))

    def test_export(self):
        res = self.client.get(URL + 'export/', {'export_format': 'csv', 'brand': 'RayBan'})
        self.assertEqual(res.status_code, 200)
        text = res.content.decode('utf-8-sig')
        self.assertIn('Item Code / SKU', text)
        self.assertIn('Aviator', text)
        self.assertNotIn('Lens Cloth', text)
        xlsx = self.client.get(URL + 'export/')
        self.assertEqual(xlsx.status_code, 200)
        self.assertTrue(xlsx.content.startswith(b'PK'))
