"""Server-assigned Patient ID (Customer.patient_code) for Eye Test / Appointments.

Regression for the hosted bug where several patients were all filed as P-1001: the browser
guessed the "next" code from a patient list that hadn't loaded yet, and that guess was saved.
"""
from django.test import TestCase

from apps.sales.models import Customer, EyeExamination, PatientCodeSequence
from apps.sales.patient_utils import peek_next_patient_code, reserve_patient_codes
from apps.sales.views import (
    CustomerSerializer, CustomerViewSet, EyeExaminationSerializer, EyeExaminationViewSet,
)


def _customer(data):
    s = CustomerSerializer(data=data)
    s.is_valid(raise_exception=True)
    CustomerViewSet().perform_create(s)
    return s.instance


def _exam(data):
    s = EyeExaminationSerializer(data=data)
    s.is_valid(raise_exception=True)
    EyeExaminationViewSet().perform_create(s)
    return s.instance


class PatientCodeNumberingTests(TestCase):
    def test_sequential_from_1001(self):
        codes = [_customer({'name': f'P{i}', 'phone': f'90000000{i}'}).patient_code for i in range(3)]
        self.assertEqual(codes, ['P-1001', 'P-1002', 'P-1003'])
        self.assertEqual(peek_next_patient_code(), 'P-1004')

    def test_stale_client_preview_is_ignored(self):
        for i in range(3):
            _customer({'name': f'P{i}', 'phone': f'90000000{i}'})
        # A browser whose patient list never loaded still shows P-1001.
        c = _customer({'name': 'New', 'phone': '9111111111', 'patient_code': 'P-1001'})
        self.assertEqual(c.patient_code, 'P-1004')
        # A preview that runs ahead of the series doesn't create a gap either.
        c = _customer({'name': 'Next', 'phone': '9222222222', 'patient_code': 'P-1050'})
        self.assertEqual(c.patient_code, 'P-1005')

    def test_lagging_counter_follows_codes_in_use(self):
        # Rows created outside the sequence (imports, old client-accepted codes) with the
        # counter still at its base — the next code must still be max + 1.
        for n in (1001, 1002, 1003):
            Customer.objects.create(name=f'Old {n}', patient_code=f'P-{n}')
        PatientCodeSequence.objects.update_or_create(prefix='P', defaults={'last_number': 1000})
        # Saving straight away collides on P-1001 and the retry heals the counter.
        self.assertEqual(_customer({'name': 'New', 'phone': '9000000009'}).patient_code, 'P-1004')
        # The preview also inspects codes in use (and lifts a lagging counter).
        PatientCodeSequence.objects.filter(prefix='P').update(last_number=1000)
        self.assertEqual(peek_next_patient_code(), 'P-1005')
        self.assertEqual(reserve_patient_codes()[0], 'P-1005')

    def test_soft_deleted_and_exam_only_codes_are_skipped(self):
        gone = Customer.objects.create(name='Gone', patient_code='P-1001')
        gone.delete()  # soft delete still holds the UNIQUE slot
        EyeExamination.objects.create(patient_id='P-1002', patient_name='Exam only')
        self.assertEqual(_customer({'name': 'A', 'phone': '9333333333'}).patient_code, 'P-1003')

    def test_custom_code_is_kept_when_free(self):
        c = _customer({'name': 'Legacy', 'phone': '9444444444', 'patient_code': 'CARD-77'})
        self.assertEqual(c.patient_code, 'CARD-77')

    def test_update_never_moves_code_onto_another_patient(self):
        a = _customer({'name': 'A', 'phone': '9555555551'})
        b = _customer({'name': 'B', 'phone': '9555555552'})
        s = CustomerSerializer(b, data={'patient_code': a.patient_code}, partial=True)
        s.is_valid(raise_exception=True)
        CustomerViewSet().perform_update(s)
        b.refresh_from_db()
        self.assertEqual(b.patient_code, 'P-1002')


class ExamPatientIdTests(TestCase):
    def test_exam_uses_linked_customers_code(self):
        c = _customer({'name': 'Asha', 'phone': '9666666666'})
        exam = _exam({'customer': c.pk, 'patient_id': 'P-1001-stale-guess', 'patient_name': 'Asha'})
        self.assertEqual(exam.patient_id, c.patient_code)

    def test_unlinked_guess_does_not_reuse_another_patients_code(self):
        _customer({'name': 'First', 'phone': '9777777771'})  # P-1001
        exam = _exam({'patient_id': 'P-1001', 'patient_name': 'Someone Else'})
        self.assertEqual(exam.patient_id, 'P-1002')

    def test_unlinked_code_of_same_patient_links_them(self):
        c = _customer({'name': 'Ravi', 'phone': '9888888888'})
        exam = _exam({'patient_id': c.patient_code, 'patient_name': 'ravi'})
        self.assertEqual(exam.patient_id, c.patient_code)
        self.assertEqual(exam.customer_id, c.pk)


class SequenceMigrationTests(TestCase):
    def test_migration_lifts_lagging_counter(self):
        import importlib
        from django.apps import apps as django_apps
        mig = importlib.import_module('apps.sales.migrations.0031_sync_patient_code_sequence')
        for n in (1001, 1002, 1003):
            Customer.objects.create(name=f'Old {n}', patient_code=f'P-{n}')
        EyeExamination.objects.create(patient_id='P-1007', patient_name='Orphan exam')
        mig.sync(django_apps, None)
        self.assertEqual(PatientCodeSequence.objects.get(prefix='P').last_number, 1007)
        self.assertEqual(_customer({'name': 'Next', 'phone': '9000000010'}).patient_code, 'P-1008')
