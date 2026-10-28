"""Configurable document numbering (Settings → Business & Localization → Numbering Sequences).

    GET /api/company/document-sequences/                  every type: config + next number + preview
    PUT /api/company/document-sequences/<doc_type>/       change one (store-settings role)
    GET /api/company/document-sequences/<doc_type>/peek/  the number the next document would get

Number = prefix + zero-padded counter + suffix. Prefix and suffix may contain the tokens
{YYYY} {YY} {MM} {FY} (fiscal year, e.g. 2026-27), resolved in the business's time zone.

Issuing (issue_number) bumps DocumentSequenceCounter with one atomic UPDATE … RETURNING
(apps.common.sequences.bump_sequence), so two tills never get the same counter value; numbers a
document already holds (legacy random numbers, a lowered "next number") are skipped, and the
document tables' UNIQUE columns remain the final guard.

Only the types in WIRED are issued by their modules today; the rest can be configured ahead of
the module adopting them and say so in the UI.
"""
import re

from django.db import IntegrityError, transaction
from rest_framework import status
from rest_framework.response import Response

from apps.common.sequences import bump_sequence
from .localization import OpenReadsSettingsView, audit, get_preference, tz_now
from .models import DocumentNumberClaim, DocumentSequence, DocumentSequenceCounter

# doc_type: (label, default prefix, default padding, where it is applied — None = not wired yet)
DOC_TYPES = {
    'SALES_INVOICE': ('Sales invoice', 'INV-{YYYY}-', 4, 'Sales → New Sale (Invoice)'),
    'SALES_ORDER': ('Sales order', 'ORD-{YYYY}-', 4, 'Sales → New Sale (Order)'),
    'QUOTATION': ('Quotation', 'QTN-{YYYY}-', 4, 'Sales → New Sale (Quotation)'),
    'PURCHASE_BILL': ('Purchase bill', 'PINV-{YYYY}-', 4, 'Purchase → Purchase Entry'),
    'PURCHASE_ORDER': ('Purchase order', 'PO-{YYYY}-', 4, 'Purchase → Purchase Orders'),
    'LENS_PO': ('Lens purchase order', 'LPO-{YYYY}-', 4, 'Purchase → Lens Purchase Order'),
    'SALES_BILL': ('Wholesale sales bill', 'WINV-', 5, None),
    'CREDIT_NOTE': ('Credit note', 'CN-', 4, None),
    'DEBIT_NOTE': ('Debit note', 'DN-', 4, None),
    'RECEIPT': ('Receipt', 'RCP-', 5, None),
    'PAYMENT': ('Payment voucher', 'PAY-', 5, None),
    'CUSTOMER_CODE': ('Customer / patient code', 'CUST-', 5, None),
    'SUPPLIER_CODE': ('Supplier code', 'SUP-', 4, None),
    'PRODUCT_CODE': ('Product code', 'PRD-', 5, None),
}
WIRED = {k for k, v in DOC_TYPES.items() if v[3]}
RESETS = {k for k, _ in DocumentSequence.RESET_CHOICES}
TOKEN_RE = re.compile(r'\{(YYYY|YY|MM|FY)\}')
AFFIX_RE = re.compile(r'^[A-Za-z0-9/_.\-#{}]*$')
MAX_NUMBER_LEN = 50  # document number columns are CharField(max_length=50)


def _fiscal_start_year(when, fy_month):
    return when.year if when.month >= fy_month else when.year - 1


def render_affix(text, when, fy_month):
    fy = _fiscal_start_year(when, fy_month)
    values = {'YYYY': f'{when.year:04d}', 'YY': f'{when.year % 100:02d}', 'MM': f'{when.month:02d}',
              'FY': f'{fy}-{(fy + 1) % 100:02d}' if fy_month != 1 else f'{fy}'}
    return TOKEN_RE.sub(lambda m: values[m.group(1)], text or '')


def period_key(reset, when, fy_month):
    if reset == 'MONTHLY':
        return f'M{when.year:04d}-{when.month:02d}'
    if reset == 'YEARLY':
        return f'Y{when.year:04d}'
    if reset == 'FISCAL_YEAR':
        return f'FY{_fiscal_start_year(when, fy_month)}'
    return 'ALL'


def format_number(cfg, n, when, fy_month):
    return (f"{render_affix(cfg['prefix'], when, fy_month)}{str(n).zfill(cfg['padding'])}"
            f"{render_affix(cfg['suffix'], when, fy_month)}")


def _config(doc_type, row=None):
    label, prefix, padding, applied = DOC_TYPES[doc_type]
    row = row if row is not None else DocumentSequence.objects.filter(doc_type=doc_type).first()
    base = {'doc_type': doc_type, 'label': label, 'applied_in': applied, 'wired': doc_type in WIRED,
            'configured': row is not None}
    if row is None:
        return {**base, 'prefix': prefix, 'suffix': '', 'padding': padding, 'start_number': 1,
                'reset_frequency': 'NEVER', 'is_active': True, 'updated_at': None, 'updated_by': ''}
    return {**base, 'prefix': row.prefix, 'suffix': row.suffix, 'padding': row.padding,
            'start_number': row.start_number, 'reset_frequency': row.reset_frequency,
            'is_active': row.is_active, 'updated_at': row.updated_at.isoformat() if row.updated_at else None,
            'updated_by': row.updated_by}


def _next_counter(cfg, key):
    counter = DocumentSequenceCounter.objects.filter(doc_type=cfg['doc_type'], period_key=key).first()
    return (counter.last_number + 1) if counter else cfg['start_number'], counter


def describe(doc_type, row=None, when=None):
    cfg = _config(doc_type, row)
    when = when or tz_now()
    fy = get_preference('fiscal_year_start_month')
    key = period_key(cfg['reset_frequency'], when, fy)
    nxt, counter = _next_counter(cfg, key)
    return {**cfg, 'period_key': key, 'next_number': nxt, 'issued_in_period': bool(counter and counter.last_number),
            'preview': format_number(cfg, nxt, when, fy)}


class DuplicateSubmission(Exception):
    def __init__(self, number):
        super().__init__(number)
        self.number = number


def issue_number(doc_type, is_taken, client_token=None):
    """The next number for `doc_type`, or None when this type is not system-numbered right now
    (auto-generation switched off, or the sequence deactivated) — the caller then keeps its own
    behaviour. `is_taken(candidate)` says whether a document already holds a number.

    client_token: the number the screen generated for this entry. Screens re-send the same one
    when a save is retried / double-submitted; raises DuplicateSubmission(number already issued)
    for a token seen before. Call inside the document's transaction."""
    if doc_type not in DOC_TYPES or not get_preference('auto_generate_numbers'):
        return None
    cfg = _config(doc_type)
    if not cfg['is_active']:
        return None
    token = (client_token or '').strip()[:100]
    if token:
        claimed = DocumentNumberClaim.objects.filter(doc_type=doc_type, client_token=token).first()
        if claimed:
            raise DuplicateSubmission(claimed.number)
    when = tz_now()
    fy = get_preference('fiscal_year_start_month')
    key = period_key(cfg['reset_frequency'], when, fy)
    lookup = {'doc_type': doc_type, 'period_key': key}
    for _ in range(200):
        n = bump_sequence(DocumentSequenceCounter, lookup, defaults={'last_number': cfg['start_number'] - 1})
        candidate = format_number(cfg, n, when, fy)
        if not is_taken(candidate):
            if token:
                try:
                    with transaction.atomic():
                        DocumentNumberClaim.objects.create(doc_type=doc_type, client_token=token, number=candidate)
                except IntegrityError:  # the same entry is being saved concurrently
                    raise DuplicateSubmission(candidate)
            return candidate
    return None  # 200 numbers in a row already used — let the caller's own fallback mint one


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def _validate(data, current):
    clean, errors = {}, {}
    for key in ('prefix', 'suffix'):
        if key in data:
            v = str(data[key] or '').strip()
            if len(v) > (30 if key == 'prefix' else 20):
                errors[key] = 'Too long.'
            elif not AFFIX_RE.match(v):
                errors[key] = 'Use letters, digits, - / _ . # and the {YYYY} {YY} {MM} {FY} tokens.'
            elif re.search(r'\{(?!(?:YYYY|YY|MM|FY)\})', v):
                errors[key] = 'Unknown token — use {YYYY}, {YY}, {MM} or {FY}.'
            else:
                clean[key] = v
    for key, lo, hi in (('padding', 1, 10), ('start_number', 1, 999_999_999), ('next_number', 1, 999_999_999)):
        if key in data and data[key] not in (None, ''):
            try:
                n = int(str(data[key]).strip())
            except ValueError:
                errors[key] = 'Enter a whole number.'
                continue
            if not lo <= n <= hi:
                errors[key] = f'Must be between {lo} and {hi}.'
            else:
                clean[key] = n
    if 'reset_frequency' in data:
        if data['reset_frequency'] not in RESETS:
            errors['reset_frequency'] = 'Choose never, monthly, yearly or fiscal year.'
        else:
            clean['reset_frequency'] = data['reset_frequency']
    if 'is_active' in data:
        if not isinstance(data['is_active'], bool):
            errors['is_active'] = 'Must be on or off.'
        else:
            clean['is_active'] = data['is_active']
    merged = {**current, **{k: v for k, v in clean.items() if k != 'next_number'}}
    if not (merged['prefix'] or merged['suffix']):
        errors.setdefault('prefix', 'Give the sequence a prefix or suffix so its numbers are recognisable.')
    sample = format_number(merged, 10 ** merged['padding'], tz_now(), 4)
    if len(sample) > MAX_NUMBER_LEN:
        errors.setdefault('prefix', f'Numbers would exceed {MAX_NUMBER_LEN} characters.')
    return clean, errors


def _clashing_prefix(doc_type, cfg):
    """Another active type rendering the same prefix+suffix would hand out look-alike numbers."""
    when = tz_now()
    mine = (render_affix(cfg['prefix'], when, 4), render_affix(cfg['suffix'], when, 4))
    for other in DOC_TYPES:
        if other == doc_type:
            continue
        o = _config(other)
        if o['is_active'] and (render_affix(o['prefix'], when, 4), render_affix(o['suffix'], when, 4)) == mine:
            return o['label']
    return None


class DocumentSequenceListView(OpenReadsSettingsView):
    def get(self, request):
        rows = {r.doc_type: r for r in DocumentSequence.objects.all()}
        when = tz_now()
        return Response([describe(t, rows.get(t), when) for t in DOC_TYPES])


class DocumentSequenceDetailView(OpenReadsSettingsView):
    def get(self, request, doc_type):
        if doc_type not in DOC_TYPES:
            return Response({'detail': 'Unknown document type.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(describe(doc_type))

    def put(self, request, doc_type):
        if doc_type not in DOC_TYPES:
            return Response({'detail': 'Unknown document type.'}, status=status.HTTP_404_NOT_FOUND)
        data = request.data if isinstance(request.data, dict) else {}
        before = describe(doc_type)
        clean, errors = _validate(data, before)
        merged = {**before, **{k: v for k, v in clean.items() if k != 'next_number'}}
        if not errors and merged['is_active']:
            clash = _clashing_prefix(doc_type, merged)
            if clash:
                errors['prefix'] = f'"{clash}" already uses this prefix and suffix — numbers would look alike.'
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)

        next_number = clean.pop('next_number', None)
        # Disruptive: re-using numbers already issued this period, or changing the look of a
        # sequence that has issued numbers. The UI asks first and then sends confirm=true.
        lowering = next_number is not None and before['issued_in_period'] and next_number < before['next_number']
        reshaping = before['issued_in_period'] and any(
            k in clean and clean[k] != before[k] for k in ('prefix', 'suffix', 'padding', 'reset_frequency'))
        if (lowering or reshaping) and data.get('confirm') is not True:
            return Response({
                'detail': ('Lowering the next number re-enters a range already issued; numbers still in use '
                           'will be skipped.' if lowering else
                           'This sequence has already issued numbers; new documents will be numbered in the new format.'),
                'requires_confirmation': True,
            }, status=status.HTTP_409_CONFLICT)

        with transaction.atomic():
            row, _ = DocumentSequence.objects.select_for_update().get_or_create(
                doc_type=doc_type, defaults={k: before[k] for k in
                                             ('prefix', 'suffix', 'padding', 'start_number', 'reset_frequency', 'is_active')})
            for k, v in clean.items():
                setattr(row, k, v)
            row.updated_by = (getattr(request.user, 'username', '') or '')[:150]
            row.save()
            if next_number is not None and next_number != before['next_number']:
                after = describe(doc_type, row)
                DocumentSequenceCounter.objects.update_or_create(
                    doc_type=doc_type, period_key=after['period_key'], defaults={'last_number': next_number - 1})
        after = describe(doc_type)
        changes = {k: [before[k], after[k]] for k in ('prefix', 'suffix', 'padding', 'start_number',
                                                       'reset_frequency', 'is_active', 'next_number')
                   if before[k] != after[k]}
        if changes:
            audit(request, 'NUMBERING', 'UPDATE', f"{after['label']} sequence: {', '.join(sorted(changes))}", changes)
        return Response(after)


class DocumentSequencePeekView(OpenReadsSettingsView):
    def get(self, request, doc_type):
        if doc_type not in DOC_TYPES:
            return Response({'detail': 'Unknown document type.'}, status=status.HTTP_404_NOT_FOUND)
        d = describe(doc_type)
        system = bool(get_preference('auto_generate_numbers') and d['is_active'] and d['wired'])
        return Response({'doc_type': doc_type, 'preview': d['preview'], 'system_numbered': system})
