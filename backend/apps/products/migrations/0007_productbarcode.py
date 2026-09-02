import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('products', '0006_product_hsn_code'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductBarcode',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('code', models.CharField(db_index=True, max_length=150, unique=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('product', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='extra_barcodes', to='products.product')),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
    ]
