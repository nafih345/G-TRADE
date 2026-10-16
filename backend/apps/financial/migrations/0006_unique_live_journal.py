from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('financial', '0005_seed_accounting_integration'),
    ]

    operations = [
        migrations.AddConstraint(
            model_name='journalentry',
            constraint=models.UniqueConstraint(condition=models.Q(('is_reversal', False), ('reference_id__isnull', False), ('status', 'POSTED'), models.Q(('source_module', ''), _negated=True)), fields=('source_module', 'source_event', 'reference_id'), name='uniq_live_journal_per_source'),
        ),
    ]
