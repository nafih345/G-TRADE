"""Label templates get a label type (standard / optical / jewellery) and a hidden flag.

Existing rows: the type is inferred from the starter preset / name, and every template
that is neither the default nor assigned to a print workflow is hidden — the designer
and print dialogs then show only the templates in use ("Show all barcode templates"
reveals the rest)."""
import re

from django.db import migrations, models

JEWELLERY = re.compile(r'jewel|rat.?tail|dumbbell', re.I)
OPTICAL = re.compile(r'optical|frame|spectacle', re.I)
PRESET_TYPES = {
    'jewel_card_38x25': 'jewellery', 'rattail_90x13': 'jewellery', 'a4_dumbbell_92x14': 'jewellery',
    'optical_frame_50x30': 'optical',
}


def infer(apps, schema_editor):
    Template = apps.get_model('products', 'LabelTemplate')
    Settings = apps.get_model('products', 'LabelPrintSettings')
    in_use = set()
    for s in Settings.objects.all():
        in_use.update(filter(None, (s.inventory_template_id, s.purchase_template_id, s.barcode_printing_template_id)))
    for t in Template.objects.all():
        kind = PRESET_TYPES.get(t.preset_key or '')
        if not kind:
            text = f'{t.name} {t.preset_key}'
            kind = 'jewellery' if JEWELLERY.search(text) else 'optical' if OPTICAL.search(text) else 'standard'
        hidden = not t.is_default and t.pk not in in_use
        Template.objects.filter(pk=t.pk).update(label_type=kind, is_hidden=hidden)


class Migration(migrations.Migration):

    dependencies = [
        ('products', '0024_returns_modules'),
    ]

    operations = [
        migrations.AddField(
            model_name='labeltemplate',
            name='label_type',
            field=models.CharField(choices=[('standard', 'Standard'), ('optical', 'Optical'), ('jewellery', 'Jewellery')], default='standard', max_length=20),
        ),
        migrations.AddField(
            model_name='labeltemplate',
            name='is_hidden',
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(infer, migrations.RunPython.noop),
    ]
