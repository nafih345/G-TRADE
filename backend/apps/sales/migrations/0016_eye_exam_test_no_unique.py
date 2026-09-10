"""Give EyeExamination.test_no a real database-level uniqueness guarantee.

Test No is meant to be an unbroken sequential series shared by every device on the
common database (see patient_utils.reserve_test_numbers / views.EyeExaminationViewSet).
Until now nothing at the DB level stopped two rows sharing a number — the application
checks were the only defence, and a close-enough race between two clients could still
slip a duplicate through. This adds a partial UNIQUE constraint (non-null, non-blank
test_no only) so the database itself rejects the second writer; perform_create catches
that and re-rolls.

A dedupe pass runs first so the constraint can be added even if 0015 missed a row
(e.g. one created after 0015 ran on an older deploy, or a soft-deleted row colliding
with a live one — the constraint spans all rows, soft-deleted included).
"""
from django.db import migrations, models


def _as_int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def dedupe_test_numbers(apps, schema_editor):
    EyeExamination = apps.get_model('sales', 'EyeExamination')
    Appointment = apps.get_model('sales', 'Appointment')
    TestNoSequence = apps.get_model('sales', 'TestNoSequence')

    used = set()
    for value in EyeExamination.objects.values_list('test_no', flat=True):
        n = _as_int(value)
        if n is not None:
            used.add(n)
    for value in Appointment.objects.values_list('test_no', flat=True):
        n = _as_int(value)
        if n is not None:
            used.add(n)

    seq_obj, _ = TestNoSequence.objects.get_or_create(prefix='', defaults={'last_number': 1000})
    next_number = max(list(used) + [seq_obj.last_number, 1000]) + 1

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

        while next_number in used:
            next_number += 1
        new_value = str(next_number)

        exam.test_no = new_value
        update_fields = ['test_no']
        if isinstance(exam.raw_data, dict):
            exam.raw_data['testNo'] = new_value
            if isinstance(exam.raw_data.get('diagnosisData'), dict):
                exam.raw_data['diagnosisData']['testNo'] = new_value
            update_fields.append('raw_data')
        exam.save(update_fields=update_fields)

        used.add(next_number)
        seen.add(new_value)
        next_number += 1

    highest = max(list(used) + [seq_obj.last_number])
    if highest > seq_obj.last_number:
        seq_obj.last_number = highest
        seq_obj.save(update_fields=['last_number'])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0015_dedupe_eye_exam_test_no'),
    ]

    operations = [
        migrations.RunPython(dedupe_test_numbers, noop_reverse),
        migrations.AddConstraint(
            model_name='eyeexamination',
            constraint=models.UniqueConstraint(
                fields=['test_no'],
                condition=models.Q(test_no__isnull=False) & ~models.Q(test_no=''),
                name='uniq_eyeexamination_test_no',
            ),
        ),
    ]
