"""Renumber EyeExamination rows that share a Test No.

The shared Test No sequence (TestNoSequence) could fall behind numbers that were assigned
directly — one carried over from an Appointment, or a client-side preview accepted as-is by
EyeExaminationViewSet.perform_create — so a later reservation handed out a number already in
use. Result: two different patients showing the same Test No (e.g. #1008).

The code paths are fixed going forward (reserve_unused_test_numbers + sync_test_no_sequence);
this one-off data migration cleans up rows already saved that way. The earliest exam for a
given number keeps it; every later duplicate gets the next genuinely-free number.
"""
from django.db import migrations


def _as_int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def dedupe_test_numbers(apps, schema_editor):
    EyeExamination = apps.get_model('sales', 'EyeExamination')
    Appointment = apps.get_model('sales', 'Appointment')
    TestNoSequence = apps.get_model('sales', 'TestNoSequence')

    used_numbers = set()
    for value in EyeExamination.objects.values_list('test_no', flat=True):
        n = _as_int(value)
        if n is not None:
            used_numbers.add(n)
    for value in Appointment.objects.values_list('test_no', flat=True):
        n = _as_int(value)
        if n is not None:
            used_numbers.add(n)

    seq_obj, _ = TestNoSequence.objects.get_or_create(prefix='', defaults={'last_number': 1000})
    next_number = max(list(used_numbers) + [seq_obj.last_number, 1000]) + 1

    seen = set()
    for exam in (
        EyeExamination.objects
        .exclude(test_no__isnull=True)
        .exclude(test_no='')
        .order_by('examination_date', 'id')
    ):
        key = str(exam.test_no).strip()
        if key not in seen:
            seen.add(key)
            continue

        while next_number in used_numbers:
            next_number += 1
        new_value = str(next_number)

        exam.test_no = new_value
        if isinstance(exam.raw_data, dict):
            exam.raw_data['testNo'] = new_value
            if isinstance(exam.raw_data.get('diagnosisData'), dict):
                exam.raw_data['diagnosisData']['testNo'] = new_value
            exam.save(update_fields=['test_no', 'raw_data'])
        else:
            exam.save(update_fields=['test_no'])

        used_numbers.add(next_number)
        seen.add(new_value)
        next_number += 1

    highest = max(list(used_numbers) + [seq_obj.last_number])
    if highest > seq_obj.last_number:
        seq_obj.last_number = highest
        seq_obj.save(update_fields=['last_number'])


def noop_reverse(apps, schema_editor):
    # Renumbering can't be meaningfully undone; nothing to do.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0014_invoice_delivery_fields'),
    ]

    operations = [
        migrations.RunPython(dedupe_test_numbers, noop_reverse),
    ]
