"""Lift every tenant's PatientCodeSequence past the highest "P-NNNN" code already in use.

Codes used to be accepted from the client without advancing the counter, so the counter could
lag the real data (and the Eye Test screen guessed P-1001 from an empty list). After this the
counter is trustworthy and reserve_patient_codes needs only one atomic UPDATE per save.
Data only, forward only — re-running it is harmless (never lowers a counter)."""
import re

from django.db import migrations

BASE = 1000
CODE = re.compile(r'P-?(\d+)', re.IGNORECASE)


def sync(apps, schema_editor):
    Customer = apps.get_model('sales', 'Customer')
    EyeExamination = apps.get_model('sales', 'EyeExamination')
    Seq = apps.get_model('sales', 'PatientCodeSequence')

    highest = {}
    rows = list(Customer.objects.filter(patient_code__istartswith='P')
                .values_list('tenant_id', 'patient_code'))
    rows += list(EyeExamination.objects.filter(patient_id__istartswith='P')
                 .values_list('tenant_id', 'patient_id').distinct())
    for tenant_id, code in rows:
        m = CODE.fullmatch(str(code or '').strip())
        if m:
            highest[tenant_id] = max(highest.get(tenant_id, BASE), int(m.group(1)))

    for tenant_id, top in highest.items():
        seq = Seq.objects.filter(tenant_id=tenant_id, prefix='P').first()
        if seq is None:
            Seq.objects.create(tenant_id=tenant_id, prefix='P', last_number=top)
        elif seq.last_number < top:
            Seq.objects.filter(pk=seq.pk).update(last_number=top)


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0030_customer_notes_prescription'),
    ]

    operations = [
        migrations.RunPython(sync, migrations.RunPython.noop),
    ]
