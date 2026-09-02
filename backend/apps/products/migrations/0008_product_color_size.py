from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('products', '0007_productbarcode'),
    ]

    operations = [
        migrations.AddField(
            model_name='product',
            name='color',
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
        migrations.AddField(
            model_name='product',
            name='size',
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
    ]
