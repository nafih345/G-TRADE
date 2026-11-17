"""Purchase Entry attachments: private storage, validation and download (P1 Task 2).

  * Upload: 10 MB cap; PDF / PNG / JPEG / WebP only, checked by extension AND file signature
    (an .pdf that is really HTML is refused). Stored at private/t<tenant>/purchase_attachments/
    <uuid><ext> (apps.common.media_paths); the user's file name goes to attachment_name.
  * Read: the API never returns a /media/ URL. `attachment` / `attachment_url` point to
    GET /api/purchase/invoices/<id>/attachment/ — signed-in, tenant-scoped and branch-scoped
    exactly like opening the purchase entry (another client's or branch's entry is 404).
  * Browser viewing: GET /api/purchase/invoices/<id>/attachment-link/ returns a signed URL
    valid for LINK_TTL seconds, bound to tenant + invoice + user. The token-blind download view
    re-checks that the user is still active, belongs to that tenant, and may use the entry's branch.
Existing attachments (legacy purchase_attachments/<name> paths) are served by the same endpoints.
"""
import mimetypes
import os

from django.core import signing
from django.http import FileResponse
from rest_framework import permissions, serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.media_paths import DOCUMENT_EXTENSIONS

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
LINK_TTL = 60
LINK_SALT = 'purchase-attachment-download'

_SIGNATURES = {
    '.pdf': (b'%PDF-',),
    '.png': (b'\x89PNG\r\n\x1a\n',),
    '.jpg': (b'\xff\xd8\xff',),
    '.jpeg': (b'\xff\xd8\xff',),
    '.webp': (b'RIFF',),
}
_CONTENT_TYPES = {'.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                  '.webp': 'image/webp'}


def validate_attachment(upload):
    """Refuse anything but a real PDF / PNG / JPEG / WebP of at most 10 MB."""
    if upload is None:
        return upload
    name = os.path.basename(str(getattr(upload, 'name', '') or ''))
    ext = os.path.splitext(name)[1].lower()
    if ext not in DOCUMENT_EXTENSIONS:
        raise serializers.ValidationError('Attach a PDF, PNG, JPEG or WebP file.')
    size = getattr(upload, 'size', None)
    if size is not None and size > MAX_ATTACHMENT_BYTES:
        raise serializers.ValidationError('The attachment is larger than 10 MB.')
    try:
        pos = upload.tell()
    except Exception:
        pos = 0
    head = upload.read(16)
    try:
        upload.seek(pos)
    except Exception:
        pass
    if not any(head.startswith(sig) for sig in _SIGNATURES[ext]) or (ext == '.webp' and head[8:12] != b'WEBP'):
        raise serializers.ValidationError("The file's contents do not match its type (PDF, PNG, JPEG or WebP).")
    return upload


def clean_display_name(upload):
    name = os.path.basename(str(getattr(upload, 'name', '') or 'attachment')).replace('"', '').replace('\r', '') \
        .replace('\n', '')
    return name[:255] or 'attachment'


def attachment_api_url(invoice):
    return f'/api/purchase/invoices/{invoice.pk}/attachment/' if invoice.attachment else None


def file_response(invoice):
    """Stream the invoice's attachment, or a 404/410 Response."""
    if not invoice.attachment:
        return Response({'detail': 'This purchase entry has no attachment.'}, status=status.HTTP_404_NOT_FOUND)
    try:
        handle = invoice.attachment.open('rb')
    except (FileNotFoundError, OSError, ValueError):
        return Response({'detail': 'The attached file is no longer in storage.'}, status=status.HTTP_410_GONE)
    stored = invoice.attachment.name or ''
    ext = os.path.splitext(stored)[1].lower()
    display = invoice.attachment_name or os.path.basename(stored) or 'attachment'
    content_type = _CONTENT_TYPES.get(ext) or mimetypes.guess_type(stored)[0] or 'application/octet-stream'
    safe_inline = ext in _CONTENT_TYPES
    response = FileResponse(handle, content_type=content_type if safe_inline else 'application/octet-stream',
                            as_attachment=not safe_inline, filename=display)
    if safe_inline:
        from django.utils.http import content_disposition_header
        response['Content-Disposition'] = content_disposition_header(False, display)
    response['X-Content-Type-Options'] = 'nosniff'
    response['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
    response['Cache-Control'] = 'private, no-store'
    return response


def make_link(invoice, user):
    token = signing.dumps({'t': invoice.tenant_id, 'i': str(invoice.pk), 'u': str(user.pk)}, salt=LINK_SALT, compress=True)
    return {'url': f'/api/purchase/attachments/download/?token={token}', 'expires_in': LINK_TTL,
            'filename': invoice.attachment_name or os.path.basename(invoice.attachment.name or '')}


class AttachmentDownloadView(APIView):
    """GET /api/purchase/attachments/download/?token=... — the signed, short-lived link."""
    authentication_classes = []
    token_authentication = False  # token-blind by design (see tenant_context.install_drf_hook)
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        from django.contrib.auth import get_user_model
        from apps.common import tenancy
        from apps.common.branch_context import user_branch_permitted
        from .models import PurchaseInvoice
        try:
            claims = signing.loads(request.query_params.get('token') or '', salt=LINK_SALT, max_age=LINK_TTL)
        except signing.SignatureExpired:
            return Response({'detail': 'This link has expired. Open the attachment again.'}, status=status.HTTP_403_FORBIDDEN)
        except signing.BadSignature:
            return Response({'detail': 'Invalid link.'}, status=status.HTTP_403_FORBIDDEN)
        tenant_id = claims.get('t')
        user = get_user_model().objects.filter(pk=claims.get('u'), is_active=True).first()
        # Phase 2: the user must still have access to the link's company — their home company or an
        # active membership — and branch rights are those of their role IN that company.
        from apps.common.organizations import company_user
        user = company_user(user, tenant_id) if user is not None and tenant_id is not None else None
        if user is None:
            return Response({'detail': 'Invalid link.'}, status=status.HTTP_403_FORBIDDEN)
        with tenancy.use_tenant(tenant_id):
            invoice = PurchaseInvoice.objects.filter(pk=claims.get('i')).first()
            if invoice is None:
                return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
            if not user_branch_permitted(user, invoice.branch_id):
                return Response({'detail': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)
            return file_response(invoice)
