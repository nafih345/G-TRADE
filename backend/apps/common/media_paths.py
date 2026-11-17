"""Where uploaded files are stored, and which of them the web server may hand out (P1 Task 2).

Every upload is written to  <visibility>/t<tenant id>/<kind>/<random uuid><ext>:

  * `private/...` — supplier bills (purchase attachments) and import spreadsheets. Never served
    by the /media/ route; only through an authenticated, object-checked endpoint (or a
    short-lived signed link minted by one).
  * `public/...`  — product images and company logos, which an <img src> must load without a
    bearer token. The random name means the URL cannot be guessed from the product.

The user's original file name is never part of the stored path (it is kept in a model field),
so a path can neither leak it nor be used for path tricks. The extension comes from an
allow-list. Files saved before this change keep their old relative path in FieldFile.name and
keep working through the authenticated endpoints; `manage.py relocate_media` moves them.
"""
import os
import uuid

from django.utils.deconstruct import deconstructible

PRIVATE_PREFIX = 'private/'
PUBLIC_PREFIX = 'public/'

# Legacy (pre-P1) folders. Images/logos stay publicly readable; the private ones never are.
LEGACY_PUBLIC_PREFIXES = ('product_images/', 'company_logos/')
LEGACY_PRIVATE_PREFIXES = ('purchase_attachments/', 'import_batches/')

DOCUMENT_EXTENSIONS = ('.pdf', '.png', '.jpg', '.jpeg', '.webp')
IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp', '.gif')
SPREADSHEET_EXTENSIONS = ('.xlsx', '.xls', '.csv')


def _tenant_of(instance):
    tenant_id = getattr(instance, 'tenant_id', None)
    if tenant_id is None:
        from apps.common import tenancy
        tenant_id = tenancy.current_tenant_id()
    return tenant_id if tenant_id is not None else 0


def safe_extension(filename, allowed):
    ext = os.path.splitext(str(filename or ''))[1].lower()
    return ext if ext in allowed else ''


@deconstructible
class TenantUploadPath:
    """upload_to callable: <visibility>/t<tenant>/<kind>/<uuid><ext>."""

    def __init__(self, kind, private=True, extensions=DOCUMENT_EXTENSIONS):
        self.kind = kind
        self.private = private
        self.extensions = tuple(extensions)

    def __call__(self, instance, filename):
        prefix = PRIVATE_PREFIX if self.private else PUBLIC_PREFIX
        ext = safe_extension(filename, self.extensions)
        return f'{prefix}t{_tenant_of(instance)}/{self.kind}/{uuid.uuid4().hex}{ext}'

    def __eq__(self, other):
        return (isinstance(other, TenantUploadPath) and self.kind == other.kind
                and self.private == other.private and self.extensions == other.extensions)

    def __hash__(self):
        return hash((self.kind, self.private, self.extensions))


purchase_attachment_path = TenantUploadPath('purchase_attachments', private=True, extensions=DOCUMENT_EXTENSIONS)
import_batch_path = TenantUploadPath('import_batches', private=True, extensions=SPREADSHEET_EXTENSIONS)
product_image_path = TenantUploadPath('product_images', private=False, extensions=IMAGE_EXTENSIONS)
company_logo_path = TenantUploadPath('company_logos', private=False, extensions=IMAGE_EXTENSIONS)


def is_publicly_servable(path):
    """May the plain /media/ route serve `path` (relative to MEDIA_ROOT)? Only public images:
    the new public/ tree and the two legacy public folders. Everything else — private/, the
    legacy private folders, anything unknown, any traversal attempt — is not."""
    p = str(path or '').replace('\\', '/').lstrip('/')
    if not p or '..' in p.split('/') or p.startswith(PRIVATE_PREFIX):
        return False
    if p.startswith(PUBLIC_PREFIX) or p.startswith(LEGACY_PUBLIC_PREFIXES):
        return safe_extension(p, IMAGE_EXTENSIONS) != ''
    return False


def public_media_view(request, path):
    """Replacement for django.views.static.serve on /media/: 404 for anything not public."""
    from django.conf import settings
    from django.http import Http404
    from django.views.static import serve
    if not is_publicly_servable(path):
        raise Http404('Not found.')
    response = serve(request, path, document_root=settings.MEDIA_ROOT)
    response['X-Content-Type-Options'] = 'nosniff'
    return response
