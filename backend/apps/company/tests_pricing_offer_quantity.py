"""Settings → Pricing Rules & Offers: partial offer quantities, the promotional offer barcode and
the offer bucket a tagged sale line takes from (apps/company/pricing_rules.py)."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.company.models import PricingOffer
from apps.masters.models import ProductCategory
from apps.products.models import Product
from apps.sales.models import Invoice, InvoiceItem


def user(role, name=None):
    return get_user_model().objects.create_user(username=name or role.lower(), password='pw-123', role=role)


class OfferQuantityTests(APITestCase):
    RULES = '/api/company/pricing-rules/'
    OFFERS = '/api/company/pricing-rules/offers/'
    LIVE = '/api/company/pricing-rules/offers/live/'
    INVOICES = '/api/sales/invoices/'

    def setUp(self):
        self.admin = user('ADMINISTRATOR')
        self.cashier = user('CASHIER')
        self.cat = ProductCategory.objects.create(name='Frames', code='FRM')
        self.frame = Product.objects.create(name='Offer Frame', sku='OF-1', barcode='1001', stock=20,
                                            cost_price=100, retail_price=150, category=self.cat)
        self.other = Product.objects.create(name='Other Frame', sku='OF-2', barcode='1002', stock=5,
                                            cost_price=100, retail_price=150)
        self._rules(offers_enabled=True)

    def _rules(self, **settings):
        self.client.force_authenticate(self.admin)
        res = self.client.put(self.RULES, settings, format='json')
        self.assertEqual(res.status_code, 200, res.content)

    def _offer(self, expect=201, **body):
        self.client.force_authenticate(self.admin)
        res = self.client.post(self.OFFERS, {'tag': 'Festival Offer', **body}, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def _partial(self, qty=3, price=120):
        return self._offer(products=[str(self.frame.id)], offer_price=price, apply_to_all=False,
                           offer_quantity=qty)[0]

    def _line(self, price, qty=1, offer=None, product=None):
        product = product or self.frame
        line = {'product': str(product.id), 'description': product.name, 'quantity': qty, 'unit_price': price,
                'discount': 0, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': qty * price}
        if offer:
            line['pricing_offer'] = offer
        return line

    def _sell(self, *lines, doc='INVOICE', status='PAID'):
        self.client.force_authenticate(self.cashier)
        total = sum(l['subtotal'] for l in lines)
        return self.client.post(self.INVOICES, {
            'document_type': doc, 'invoice_date': '2026-11-06', 'status': status, 'customer_name': 'Walk In',
            'total_amount': total, 'net_amount': total, 'paid_amount': 0, 'items': list(lines),
        }, format='json')

    def _live(self, offer_id):
        self.client.force_authenticate(self.cashier)
        res = self.client.get(self.LIVE)
        self.assertEqual(res.status_code, 200)
        return next(o for o in res.data['offers'] if o['id'] == offer_id)

    # --- setup ------------------------------------------------------------------------------

    def test_partial_quantity_validation(self):
        res = self._offer(expect=400, products=[str(self.frame.id)], offer_price=120, apply_to_all=False,
                          offer_quantity=21)
        self.assertIn('offer_quantity', res['errors'])
        res = self._offer(expect=400, products=[str(self.frame.id)], offer_price=120, apply_to_all=False)
        self.assertIn('offer_quantity', res['errors'])
        res = self._offer(expect=400, categories=[str(self.cat.id)], offer_price=120, apply_to_all=False,
                          offer_quantity=2)
        self.assertIn('offer_quantity', res['errors'])
        offer = self._partial(qty=10)
        self.assertFalse(offer['apply_to_all'])
        self.assertEqual((offer['offer_quantity'], offer['remaining'], offer['sold']), (10, 10, 0))
        # Back to all stock.
        res = self.client.patch(f"{self.OFFERS}{offer['id']}/", {'apply_to_all': True}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['apply_to_all'])
        self.assertIsNone(res.data['offer_quantity'])
        self.assertEqual(res.data['remaining'], 20)

    def test_offer_barcode_generated_unique_and_scannable(self):
        offer = self._partial()
        self.assertEqual(offer['offer_barcode'], '1001-0001')
        # No product may take that code, and the barcode resolver finds the item + its offer.
        self.client.force_authenticate(self.admin)
        res = self.client.get('/api/products/items/check_barcode/', {'barcode': '1001-0001'})
        self.assertTrue(res.data['exists'])
        res = self.client.get('/api/products/items/resolve_barcode/', {'code': '1001-0001'})
        self.assertTrue(res.data['found'])
        self.assertEqual(res.data['product']['id'], str(self.frame.id))
        self.assertEqual(res.data['offer']['offer_price'], 120.0)
        # Removing the offer keeps the code reserved; a new offer gets the next suffix.
        self.client.delete(f"{self.OFFERS}{offer['id']}/")
        again = self._partial()
        self.assertEqual(again['offer_barcode'], '1001-0002')
        res = self.client.get('/api/products/items/resolve_barcode/', {'code': '1001-0001'})
        self.assertTrue(res.data.get('offer_ended'))
        # Category offers carry no barcode; the barcode button refuses them.
        cat_offer = self._offer(categories=[str(self.cat.id)], offer_price=None)[0]
        self.assertEqual(cat_offer['offer_barcode'], '')
        res = self.client.post(f"{self.OFFERS}{cat_offer['id']}/barcode/")
        self.assertEqual(res.status_code, 400)

    def test_barcode_button_mints_for_old_offers(self):
        offer = PricingOffer.objects.create(scope='PRODUCT', product=self.other, offer_price=90, tag='Old')
        self.client.force_authenticate(self.admin)
        res = self.client.post(f'{self.OFFERS}{offer.id}/barcode/')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['offer_barcode'], '1002-0001')
        self.client.force_authenticate(self.cashier)
        self.assertEqual(self.client.post(f'{self.OFFERS}{offer.id}/barcode/').status_code, 403)

    # --- the offer bucket -------------------------------------------------------------------

    def test_tagged_lines_take_from_the_offer_quantity(self):
        offer = self._partial(qty=3)
        res = self._sell(self._line(120, qty=2, offer=offer['id']))
        self.assertEqual(res.status_code, 201, res.content)
        live = self._live(offer['id'])
        self.assertEqual((live['sold'], live['remaining']), (2, 1))
        # Untagged sales of the same product don't touch the bucket.
        self.assertEqual(self._sell(self._line(150)).status_code, 201)
        self.assertEqual(self._live(offer['id'])['remaining'], 1)
        res = self._sell(self._line(120, qty=2, offer=offer['id']))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data['code'], 'offer_exhausted')
        self.assertEqual(str(res.data['remaining']), '1')   # DRF sends error values as text
        self.assertEqual(Invoice.objects.count(), 2)   # refused bill rolled back
        self.assertEqual(self._sell(self._line(120, offer=offer['id'])).status_code, 201)
        self.assertEqual(self._live(offer['id'])['remaining'], 0)

    def test_quotations_and_cancelled_bills_do_not_use_offer_units(self):
        offer = self._partial(qty=2)
        self.assertEqual(self._sell(self._line(120, qty=5, offer=offer['id']), doc='QUOTATION',
                                    status='UNPAID').status_code, 201)
        res = self._sell(self._line(120, qty=2, offer=offer['id']))
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self._live(offer['id'])['remaining'], 0)
        self.client.force_authenticate(self.admin)
        res = self.client.patch(f"{self.INVOICES}{res.data['id']}/", {'status': 'CANCELLED'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._live(offer['id'])['remaining'], 2)

    def test_editing_an_old_bill_does_not_recheck_its_own_units(self):
        offer = self._partial(qty=2)
        res = self._sell(self._line(120, qty=2, offer=offer['id']))
        self.assertEqual(res.status_code, 201, res.content)
        inv = res.data
        # The offer is paused afterwards — re-saving the same bill still works…
        self.client.force_authenticate(self.admin)
        self.client.patch(f"{self.OFFERS}{offer['id']}/", {'is_active': False}, format='json')
        self.client.force_authenticate(self.cashier)
        same = {'items': [self._line(120, qty=2, offer=offer['id'])], 'net_amount': 240, 'total_amount': 240}
        res = self.client.patch(f"{self.INVOICES}{inv['id']}/", same, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        # …but adding offer units to it is refused: the offer is no longer running.
        more = {'items': [self._line(120, qty=3, offer=offer['id'])], 'net_amount': 360, 'total_amount': 360}
        res = self.client.patch(f"{self.INVOICES}{inv['id']}/", more, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data['code'], 'offer_ended')

    def test_tag_for_another_product_is_dropped(self):
        offer = self._partial(qty=2)
        res = self._sell(self._line(150, product=self.other, offer=offer['id']))
        self.assertEqual(res.status_code, 201, res.content)
        self.assertIsNone(InvoiceItem.objects.get(invoice_id=res.data['id']).pricing_offer_id)

    def test_partial_offer_lowers_the_floor_only_for_tagged_lines(self):
        self._rules(cost_lock_enabled=True)
        offer = self._partial(qty=2, price=80)   # below the ₹100 cost
        res = self._sell(self._line(80))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data['code'], 'below_cost')
        res = self._sell(self._line(80, offer=offer['id']))
        self.assertEqual(res.status_code, 201, res.content)
        # All-stock offers keep lowering the floor for every line, tagged or not.
        self._offer(products=[str(self.frame.id)], offer_price=80, apply_to_all=True)
        self.assertEqual(self._sell(self._line(80)).status_code, 201)

    # --- Stock Overview -----------------------------------------------------------------------

    def test_stock_overview_offer_columns_filter_and_search(self):
        offer = self._partial(qty=4)
        self._sell(self._line(120, offer=offer['id']))
        self.client.force_authenticate(self.admin)
        res = self.client.get('/api/inventory/stock-overview/', {'offer': '1'})
        self.assertEqual(res.status_code, 200, res.content)
        rows = res.data['results']
        self.assertEqual([r['id'] for r in rows], [str(self.frame.id)])
        self.assertEqual(rows[0]['offer']['offer_price'], 120.0)
        self.assertEqual((rows[0]['offer']['remaining'], rows[0]['offer']['offer_quantity']), (3, 4))
        res = self.client.get('/api/inventory/stock-overview/', {'offer': '0'})
        self.assertNotIn(str(self.frame.id), [r['id'] for r in res.data['results']])
        res = self.client.get('/api/inventory/stock-overview/', {'q': '1001-0001'})
        self.assertEqual([r['id'] for r in res.data['results']], [str(self.frame.id)])
        res = self.client.get('/api/inventory/stock-overview/lookup/', {'code': '1001-0001'})
        self.assertTrue(res.data['found'])
        # Offers module off → no offer shown anywhere.
        self._rules(offers_enabled=False)
        self.client.force_authenticate(self.admin)
        res = self.client.get('/api/inventory/stock-overview/', {'q': 'Offer Frame'})
        self.assertIsNone(res.data['results'][0]['offer'])
