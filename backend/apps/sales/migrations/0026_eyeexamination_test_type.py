from django.db import migrations, models


def _test_type_of(raw):
    if not isinstance(raw, dict):
        return ''
    for key in ('diagnosisData', 'diagnosis'):
        diag = raw.get(key)
        if isinstance(diag, dict) and diag.get('testType'):
            return str(diag['testType']).strip()[:50]
    return ''


def backfill_test_type(apps, schema_editor):
    EyeExamination = apps.get_model('sales', 'EyeExamination')
    # all rows, soft-deleted included — the historical manager has no soft-delete filter
    for exam in EyeExamination.objects.exclude(raw_data__isnull=True).only('id', 'raw_data').iterator():
        test_type = _test_type_of(exam.raw_data)
        if test_type:
            EyeExamination.objects.filter(pk=exam.pk).update(test_type=test_type)


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0025_invoice_salesman_test_no'),
    ]

    operations = [
        migrations.AddField(
            model_name='eyeexamination',
            name='test_type',
            field=models.CharField(blank=True, default='', max_length=50),
        ),
        migrations.RunPython(backfill_test_type, migrations.RunPython.noop),
    ]
