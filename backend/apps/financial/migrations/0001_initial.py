from django.db import migrations, models
import django.db.models.deletion
import uuid

class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('company', '__first__'),
        ('authentication', '__first__'),
    ]

    operations = [
        migrations.CreateModel(
            name='AccountGroup',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=100, unique=True)),
                ('account_type', models.CharField(choices=[('Asset', 'Asset'), ('Liability', 'Liability'), ('Equity', 'Equity'), ('Income', 'Income'), ('Expense', 'Expense')], max_length=20)),
            ],
            options={
                'ordering': ['name'],
            },
        ),
        migrations.CreateModel(
            name='ChartOfAccount',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('code', models.CharField(max_length=50, unique=True)),
                ('name', models.CharField(max_length=150, unique=True)),
                ('opening_balance', models.DecimalField(decimal_places=2, default=0.0, max_digits=15)),
                ('current_balance', models.DecimalField(decimal_places=2, default=0.0, max_digits=15)),
                ('status', models.CharField(choices=[('Active', 'Active'), ('Inactive', 'Inactive')], default='Active', max_length=20)),
                ('description', models.TextField(blank=True, null=True)),
                ('is_deleted', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('account_group', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='accounts', to='financial.accountgroup')),
                ('branch', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='financial_accounts', to='company.branch')),
                ('parent_account', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='children', to='financial.chartofaccount')),
            ],
            options={
                'ordering': ['code'],
            },
        ),
        migrations.CreateModel(
            name='JournalEntry',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('entry_number', models.CharField(max_length=50, unique=True)),
                ('date', models.DateField()),
                ('narration', models.TextField(blank=True, null=True)),
                ('reference_type', models.CharField(blank=True, max_length=50, null=True)),
                ('reference_id', models.IntegerField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='financial_journal_entries', to='authentication.user')),
            ],
            options={
                'ordering': ['-date', '-created_at'],
            },
        ),
        migrations.CreateModel(
            name='LedgerEntry',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('debit', models.DecimalField(decimal_places=2, default=0.0, max_digits=15)),
                ('credit', models.DecimalField(decimal_places=2, default=0.0, max_digits=15)),
                ('account', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='ledger_entries', to='financial.chartofaccount')),
                ('journal_entry', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='lines', to='financial.journalentry')),
            ],
        ),
    ]
