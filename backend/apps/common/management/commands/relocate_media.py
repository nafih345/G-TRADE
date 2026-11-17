"""P1 Task 2 — move files saved before private/public media paths into them.

    manage.py relocate_media                 # dry run (default): report what would move
    manage.py relocate_media --apply         # copy -> verify SHA-256 -> repoint the field
    manage.py relocate_media --apply --delete-old   # also remove the old copies (run later,
                                                    # separately, after checking the app)

Per tenant, for every purchase attachment, import spreadsheet, product image and company logo
whose stored path is outside private/ or public/. Idempotent: a file already relocated is
skipped. A file missing from storage (e.g. lost on an ephemeral host) is reported, never fatal.
Old files are kept unless --delete-old is given, so a code rollback keeps working.
"""
import hashlib

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand

from apps.common import tenancy
from apps.common.media_paths import (
    PRIVATE_PREFIX, PUBLIC_PREFIX, company_logo_path, import_batch_path, product_image_path, purchase_attachment_path,
)


def _targets():
    from apps.company.models import Company
    from apps.products.models import ImportBatch, Product
    from apps.purchasing.models import PurchaseInvoice
    return [
        (PurchaseInvoice, 'attachment', purchase_attachment_path),
        (ImportBatch, 'file', import_batch_path),
        (Product, 'image', product_image_path),
        (Company, 'logo', company_logo_path),
    ]


def _sha(data):
    return hashlib.sha256(data).hexdigest()


class Command(BaseCommand):
    help = 'Relocate legacy uploaded files into tenant-scoped private/public media paths.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--delete-old', action='store_true')

    def handle(self, *args, **opts):
        from apps.common.models import Tenant
        apply, delete_old = opts['apply'], opts['delete_old']
        totals = {'moved': 0, 'missing': 0, 'skipped': 0, 'would_move': 0, 'deleted_old': 0}
        for tenant_id in Tenant.objects.values_list('pk', flat=True):
            with tenancy.use_tenant(tenant_id):
                for model, field_name, upload_to in _targets():
                    manager = getattr(model, 'all_objects', model._default_manager)
                    for obj in manager.exclude(**{field_name: ''}).exclude(**{f'{field_name}__isnull': True}):
                        f = getattr(obj, field_name)
                        old = f.name or ''
                        if old.startswith((PRIVATE_PREFIX, PUBLIC_PREFIX)):
                            totals['skipped'] += 1
                            continue
                        storage = f.storage
                        if not storage.exists(old):
                            totals['missing'] += 1
                            self.stdout.write(f'  MISSING t{tenant_id} {model.__name__}.{field_name} {obj.pk}: {old}')
                            continue
                        if not apply:
                            totals['would_move'] += 1
                            self.stdout.write(f'  would move t{tenant_id} {model.__name__}.{field_name} {obj.pk}: {old}')
                            continue
                        with storage.open(old, 'rb') as fh:
                            data = fh.read()
                        new = storage.save(upload_to(obj, old), ContentFile(data))
                        with storage.open(new, 'rb') as fh:
                            if _sha(fh.read()) != _sha(data):
                                storage.delete(new)
                                self.stdout.write(self.style.ERROR(f'  CHECKSUM MISMATCH {old}; left in place'))
                                continue
                        model._base_manager.filter(pk=obj.pk).update(**{field_name: new})
                        totals['moved'] += 1
                        self.stdout.write(f'  moved t{tenant_id} {model.__name__}.{field_name} {obj.pk}: {old} -> {new}')
                        if delete_old:
                            storage.delete(old)
                            totals['deleted_old'] += 1
        self.stdout.write(self.style.SUCCESS(
            ('APPLIED ' if apply else 'DRY RUN ') + ', '.join(f'{k}={v}' for k, v in totals.items())))
