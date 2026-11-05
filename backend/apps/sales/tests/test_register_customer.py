"""Sales > Register Customer: address, notes and an optional lens power are saved on the
Customer row (no eye examination is created) and come back on the list the Sales screens read."""
from rest_framework.test import APITestCase

from apps.sales.models import Customer, EyeExamination


class RegisterCustomerTests(APITestCase):
    url = '/api/sales/customers/'

    def test_details_notes_and_lens_power_round_trip(self):
        res = self.client.post(self.url, {
            'name': 'Meera Nair', 'phone': '9000000201', 'email': 'meera@example.com',
            'age': '34', 'gender': 'Female', 'address': 'MG Road, Kochi',
            'notes': 'Prefers thin lenses',
            'prescription': {'sphRight': '-1.25', 'cylRight': '-0.50', 'axisRight': '180', 'sphLeft': '-1.00'},
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        cust = Customer.objects.get(id=res.data['id'])
        self.assertEqual(cust.address, 'MG Road, Kochi')
        self.assertEqual(cust.notes, 'Prefers thin lenses')
        self.assertEqual(cust.prescription['sphRight'], '-1.25')
        self.assertFalse(EyeExamination.objects.exists())

        row = next(r for r in self.client.get(self.url).data['results'] if r['id'] == str(cust.id))
        self.assertEqual(row['prescription']['axisRight'], '180')
        self.assertEqual(row['notes'], 'Prefers thin lenses')

    def test_lens_power_is_optional(self):
        res = self.client.post(self.url, {'name': 'Arun', 'phone': '9000000202'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data['prescription'], {})
        self.assertIsNone(res.data['notes'])
