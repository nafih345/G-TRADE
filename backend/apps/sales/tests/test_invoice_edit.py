"""Editing a saved Invoice / Order / Quotation from New Sale (PATCH with a new `items` list).

InvoiceViewSet.perform_update must move stock by the *difference* between the document before
and after the edit — never deduct the whole invoice again, never strand stock on removed lines.
"""
from rest_framework.test import APITestCase

from apps.products.models import Product
from apps.sales.models import Customer


class InvoiceEditStockTests(APITestCase):
    url = '/api/sales/invoices/'

    def setUp(self):
        self.frame = Product.objects.create(name='Edit Test Frame', sku='EDIT-FRM-1', stock=10)
        self.lens = Product.objects.create(name='Edit Test Lens', sku='EDIT-LNS-1', stock=5)

    def _line(self, product, qty, price=100):
        return {'product': str(product.id), 'item_type': 'PRODUCT', 'description': product.name,
                'quantity': qty, 'unit_price': price, 'tax_rate': 0, 'tax_amount': 0,
                'subtotal': qty * price}

    def _create(self, doc_type='INVOICE', items=None, customer=None):
        res = self.client.post(self.url, {
            'document_type': doc_type, 'invoice_date': '2026-09-11', 'status': 'PAID',
            'total_amount': 200, 'net_amount': 200, 'paid_amount': 200, 'customer': customer,
            'customer_name': 'Edit Test Patient',
            'items': items if items is not None else [self._line(self.frame, 2)],
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data['id']

    def _edit(self, inv_id, **body):
        res = self.client.patch(f'{self.url}{inv_id}/', body, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res

    def _stock(self, product):
        product.refresh_from_db()
        return product.stock

    def test_quantity_change_and_added_line_move_only_the_difference(self):
        inv = self._create()
        self.assertEqual(self._stock(self.frame), 8)

        res = self._edit(inv, items=[self._line(self.frame, 3), self._line(self.lens, 1)])
        self.assertEqual(self._stock(self.frame), 7)   # 2 -> 3: one more out, not three
        self.assertEqual(self._stock(self.lens), 4)
        self.assertEqual(len(res.data['items']), 2)

    def test_removed_line_goes_back_to_stock(self):
        inv = self._create(items=[self._line(self.frame, 2), self._line(self.lens, 1)])
        self._edit(inv, items=[self._line(self.lens, 1)])
        self.assertEqual(self._stock(self.frame), 10)
        self.assertEqual(self._stock(self.lens), 4)

    def test_invoice_saved_as_order_returns_its_stock(self):
        inv = self._create()
        self._edit(inv, document_type='ORDER', items=[self._line(self.frame, 2)])
        self.assertEqual(self._stock(self.frame), 10)

    def test_order_saved_as_invoice_takes_stock(self):
        order = self._create(doc_type='ORDER')
        self.assertEqual(self._stock(self.frame), 10)
        self._edit(order, document_type='INVOICE', items=[self._line(self.frame, 2)])
        self.assertEqual(self._stock(self.frame), 8)

    def test_status_only_patch_does_not_deduct_again(self):
        inv = self._create()
        self._edit(inv, status='PARTIAL', paid_amount=100)
        self._edit(inv, fulfillment_status='Delivered')
        self.assertEqual(self._stock(self.frame), 8)

    def test_edit_keeps_link_to_a_since_deleted_customer(self):
        # New Sale re-sends the document's own customer on every edit. A patient deleted (soft
        # delete) after the bill was made must not make the whole update fail.
        cust = Customer.objects.create(name='Gone Patient', phone='9000000001')
        inv = self._create(customer=str(cust.id))
        cust.delete()
        res = self._edit(inv, customer=str(cust.id), items=[self._line(self.frame, 1)])
        self.assertEqual(str(res.data['customer']), str(cust.id))
        self.assertEqual(self._stock(self.frame), 9)

    def test_deleted_customer_is_still_refused_as_a_new_link(self):
        cust = Customer.objects.create(name='Gone Patient', phone='9000000002')
        cust.delete()
        res = self.client.post(self.url, {
            'document_type': 'INVOICE', 'invoice_date': '2026-09-11', 'customer': str(cust.id),
            'items': [self._line(self.frame, 1)],
        }, format='json')
        self.assertEqual(res.status_code, 400, res.content)
        other = self._create()
        res = self.client.patch(f'{self.url}{other}/', {'customer': str(cust.id)}, format='json')
        self.assertEqual(res.status_code, 400, res.content)

    def test_status_only_patch_committing_a_draft_invoice_deducts_once(self):
        res = self.client.post(self.url, {
            'document_type': 'INVOICE', 'invoice_date': '2026-09-11', 'status': 'DRAFT',
            'customer_name': 'Edit Test Patient', 'items': [self._line(self.frame, 2)],
        }, format='json')
        self.assertEqual(self._stock(self.frame), 10)
        self._edit(res.data['id'], status='PAID')
        self.assertEqual(self._stock(self.frame), 8)
        self._edit(res.data['id'], fulfillment_status='Delivered')
        self.assertEqual(self._stock(self.frame), 8)
