from django.db import migrations, models


class Migration(migrations.Migration):
    """Vendor console licences (payload v2): remember which client the installation is licensed to
    and the installed revision (replay guard + per-revision revocation). Additive; existing
    evaluation and licence rows keep working (blank / 0 = not known yet)."""

    dependencies = [
        ('licensing', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='licensestate',
            name='client_id',
            field=models.CharField(blank=True, default='', max_length=40),
        ),
        migrations.AddField(
            model_name='licensestate',
            name='lic_rev',
            field=models.PositiveIntegerField(default=0),
        ),
    ]
