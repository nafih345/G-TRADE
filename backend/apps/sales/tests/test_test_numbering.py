"""Centralised, server-assigned Test Numbering for Eye Test.

Covers the guarantees in EyeExaminationViewSet.perform_create + migration 0016:
  * every new exam gets its number from the shared atomic sequence, in order;
  * a number the client puts in the request is ignored (walk-in exam);
  * a number that genuinely belongs to the originating Appointment is carried over;
  * a collision on the number re-rolls instead of persisting a duplicate;
  * the DB itself refuses a duplicate test_no.
"""
from django.db import IntegrityError, connection, transaction
from django.test import TestCase, TransactionTestCase

from apps.sales.models import Appointment, EyeExamination, TestNoSequence
from apps.sales.views import EyeExaminationSerializer, EyeExaminationViewSet


def _create(data):
    s = EyeExaminationSerializer(data=data)
    s.is_valid(raise_exception=True)
    EyeExaminationViewSet().perform_create(s)
    return s.instance


class TestNumberAssignmentTests(TestCase):
    def setUp(self):
        TestNoSequence.objects.update_or_create(prefix='', defaults={'last_number': 2000})

    def test_numbers_are_sequential_and_server_assigned(self):
        nums = [_create({'patient_id': 'P-1', 'patient_name': f'Walk-in {i}'}).test_no
                for i in range(4)]
        self.assertEqual(nums, ['2001', '2002', '2003', '2004'])

    def test_client_supplied_number_is_ignored_for_walk_in(self):
        exam = _create({'patient_id': 'P-1', 'patient_name': 'Sneaky', 'test_no': '999999'})
        self.assertEqual(exam.test_no, '2001')

    def test_appointment_number_is_carried_over(self):
        Appointment.objects.create(patient_name='Booked', appointment_date='2026-09-09',
                                   test_no='2001')
        # sequence still at 2000; the exam started from that appointment keeps 2001
        exam = _create({'patient_id': 'P-1', 'patient_name': 'Booked', 'test_no': '2001'})
        self.assertEqual(exam.test_no, '2001')
        # and the shared counter is pushed past it so the next walk-in can't reuse it
        nxt = _create({'patient_id': 'P-2', 'patient_name': 'After'}).test_no
        self.assertEqual(nxt, '2002')

    def test_collision_rerolls_instead_of_duplicating(self):
        first = _create({'patient_id': 'P-1', 'patient_name': 'First'})
        # A second exam pointed at the same number (no matching appointment) must not collide.
        second = _create({'patient_id': 'P-2', 'patient_name': 'Second', 'test_no': first.test_no})
        self.assertNotEqual(second.test_no, first.test_no)
        self.assertEqual(EyeExamination.objects.filter(test_no=first.test_no).count(), 1)

    def test_db_constraint_rejects_a_direct_duplicate(self):
        exam = _create({'patient_id': 'P-1', 'patient_name': 'First'})
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                EyeExamination.objects.create(patient_id='P-2', patient_name='Dup',
                                              test_no=exam.test_no)

    def test_blank_test_no_rows_do_not_collide(self):
        EyeExamination.objects.create(patient_id='P-1', patient_name='A', test_no='')
        EyeExamination.objects.create(patient_id='P-2', patient_name='B', test_no='')
        EyeExamination.objects.create(patient_id='P-3', patient_name='C', test_no=None)
        # no IntegrityError -> partial constraint correctly excludes blank/NULL


class TestNumberConcurrencyTests(TransactionTestCase):
    def setUp(self):
        TestNoSequence.objects.update_or_create(prefix='', defaults={'last_number': 5000})

    def test_parallel_submissions_never_duplicate(self):
        import threading

        results = []
        errors = []
        barrier = threading.Barrier(8)

        def worker(i):
            try:
                barrier.wait()
                results.append(_create({'patient_id': f'P-{i}', 'patient_name': f'C{i}'}).test_no)
            except Exception as exc:  # pragma: no cover - surfaced via assert below
                errors.append(repr(exc))
            finally:
                connection.close()  # each thread opens its own connection; don't leak it

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 8)
        self.assertEqual(len(set(results)), 8, f'duplicate test numbers issued: {results}')
