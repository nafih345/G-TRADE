"""Store & Clinic Profile — the single source of the store identity every document prints.

    GET   /api/company/store-profile/                    profile (+ ?include=completeness)
    PUT   /api/company/store-profile/                    full save from Settings
    PATCH /api/company/store-profile/                    partial save (e.g. currency from Billing)

Storage (nothing is kept twice):
  * company.Company (oldest row)      identity, contact, address, clinic details, currency
  * billing.BillingSettings           logo_data_url + business_info.tagline / .website — the same
                                      values the Bill Designer's Branding panel edits
  * company.Branch (default branch)   the Clinic / Branch Code

Reads are open (every screen prints, and an expired token must not break a reprint); writes need
a store-settings role, mirroring the billing designer endpoints.
"""
import datetime
import re

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import URLValidator, validate_email
from django.db import transaction
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.billing.views import user_role
from .models import Branch, Company

# Roles that may change the store profile. Matches accounts.User.ROLE_CHOICES (superusers count
# as SUPER_ADMIN).
STORE_SETTINGS_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR'}

STORE_TYPES = {k for k, _ in Company.STORE_TYPES}
CLINIC_TYPES = {'EYE_CLINIC', 'OPTICAL_AND_CLINIC'}
WEEKDAYS = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
ADDRESS_KINDS = ('registered', 'billing', 'shipping')
ADDRESS_KEYS = ('street', 'city', 'state', 'pin_code', 'country')
MAX_LOGO_CHARS = 1_500_000  # ~1.1 MB of image once base64-decoded
LOGO_RE = re.compile(r'^data:image/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=\s]+$')
GSTIN_RE = re.compile(r'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
TIME_RE = re.compile(r'^([01][0-9]|2[0-3]):[0-5][0-9]$')
CODE_RE = re.compile(r'^[A-Za-z0-9_-]{1,20}$')

# Text fields copied as-is (after trimming) between the payload and the Company row.
TEXT_FIELDS = {
    'name': 150, 'display_name': 150, 'business_reg_no': 60, 'address': 500, 'city': 100,
    'state': 100, 'country': 100, 'contact_person': 120, 'clinical_reg_no': 60, 'currency': 10,
}


class StoreSettingsPermission(permissions.BasePermission):
    message = 'Sign in as a Super Admin or Administrator to change the store profile.'

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return user_role(request.user) in STORE_SETTINGS_ROLES


def get_company():
    return Company.objects.order_by('created_at').first()


def _branding():
    from apps.billing.models import BillingSettings
    return BillingSettings.load()


def _is_india(country):
    return (country or '').strip().lower() in ('', 'india', 'in', 'bharat')


def normalize_phone(value, country=''):
    """'+91 98765 43210' for Indian mobile numbers, '+<digits>' / '<digits>' otherwise.
    Raises ValueError when it is not a plausible phone number."""
    raw = (value or '').strip()
    if not raw:
        return ''
    if re.search(r'[^0-9+()\-.\s]', raw) or raw.count('+') > 1 or ('+' in raw and not raw.startswith('+')):
        raise ValueError('Use digits only, optionally starting with +country code.')
    digits = re.sub(r'\D', '', raw)
    if _is_india(country):
        if len(digits) == 12 and digits.startswith('91'):
            digits = digits[2:]
        elif len(digits) == 11 and digits.startswith('0'):
            digits = digits[1:]
        if len(digits) == 10:
            return f'+91 {digits[:5]} {digits[5:]}'
    if not 7 <= len(digits) <= 15:
        raise ValueError('Enter a valid phone number (7–15 digits).')
    return f'+{digits}' if raw.startswith('+') else digits


def _valid_website(value):
    v = (value or '').strip()
    if not v:
        return ''
    candidate = v if re.match(r'^https?://', v, re.I) else f'https://{v}'
    URLValidator(schemes=['http', 'https'])(candidate)
    if '.' not in candidate.split('//', 1)[1].split('/')[0]:
        raise DjangoValidationError('Enter a valid website address.')
    return v


def _valid_pin(value, country):
    v = (value or '').strip().replace(' ', '')
    if not v:
        return ''
    if _is_india(country):
        if not re.match(r'^[1-9][0-9]{5}$', v):
            raise ValueError('Indian PIN codes are 6 digits and do not start with 0.')
    elif not re.match(r'^[A-Za-z0-9-]{3,10}$', v):
        raise ValueError('Enter a valid postal code.')
    return v.upper()


def _profile_payload(company, branding, branch):
    info = (branding.business_info or {}) if branding else {}
    c = company
    return {
        'id': str(c.id) if c else None,
        'exists': c is not None,
        'name': c.name if c else '',
        'display_name': c.display_name if c else '',
        'store_type': c.store_type if c else '',
        'gstin': (c.gstin or '') if c else '',
        'business_reg_no': c.business_reg_no if c else '',
        'phone': (c.phone or '') if c else '',
        'whatsapp': c.whatsapp if c else '',
        'email': (c.email or '') if c else '',
        'website': info.get('website', '') or '',
        'tagline': info.get('tagline', '') or '',
        'logo_data_url': (branding.logo_data_url or '') if branding else '',
        'address': (c.address or '') if c else '',
        'city': c.city if c else '',
        'state': c.state if c else '',
        'pin_code': c.pin_code if c else '',
        # A store that has never been saved defaults to India (Indian GST ERP).
        'country': (c.country if c else '') or ('' if c else 'India'),
        'extra_addresses': _clean_addresses((c.extra_addresses if c else {}) or {}),
        'currency': (c.currency if c else '') or '₹',
        'branch_code': branch.code if branch else '',
        'contact_person': c.contact_person if c else '',
        'clinical_reg_no': c.clinical_reg_no if c else '',
        'opening_time': c.opening_time if c else '',
        'closing_time': c.closing_time if c else '',
        'working_days': list((c.working_days if c else []) or []),
        'holidays': list((c.holidays if c else []) or []),
        'provides_eye_exams': bool(c.provides_eye_exams) if c else False,
        'clinic_settings': dict((c.clinic_settings if c else {}) or {}),
        'updated_at': c.updated_at.isoformat() if c else None,
    }


def _clean_addresses(raw):
    out = {}
    for kind in ADDRESS_KINDS:
        a = raw.get(kind) if isinstance(raw, dict) else None
        a = a if isinstance(a, dict) else {}
        out[kind] = {'same_as_store': a.get('same_as_store', True) is not False,
                     **{k: str(a.get(k) or '').strip()[:200] for k in ADDRESS_KEYS}}
    return out


def validate_profile(data, current, partial):
    """Return (clean, errors). `current` is the existing payload, so PATCH validates the merged
    result (e.g. a closing time against the stored opening time)."""
    merged = {**current, **{k: v for k, v in data.items() if k in current}} if partial else {**current, **data}
    errors, clean = {}, {}

    def err(field, msg):
        errors.setdefault(field, msg)

    def touched(field):
        return not partial or field in data

    for field, max_len in TEXT_FIELDS.items():
        if touched(field):
            value = str(merged.get(field) or '').strip()
            if len(value) > max_len:
                err(field, f'Keep this under {max_len} characters.')
            clean[field] = value

    if not str(merged.get('name') or '').strip():
        err('name', 'Store / Clinic name is required.')
    if touched('currency') and not clean.get('currency'):
        clean['currency'] = '₹'

    country = str(merged.get('country') or '').strip()

    if touched('store_type'):
        st = str(merged.get('store_type') or '').strip()
        if st and st not in STORE_TYPES:
            err('store_type', 'Choose a store type from the list.')
        clean['store_type'] = st

    if touched('gstin'):
        g = re.sub(r'\s', '', str(merged.get('gstin') or '')).upper()
        if g and not GSTIN_RE.match(g):
            err('gstin', 'GSTIN must be 15 characters, e.g. 32ABCDE1234F1Z5.')
        clean['gstin'] = g

    for field, required in (('phone', True), ('whatsapp', False)):
        if touched(field) or (field == 'phone' and touched('country')):
            try:
                clean[field] = normalize_phone(merged.get(field), country)
            except ValueError as exc:
                err(field, str(exc))
                continue
            if required and not clean[field]:
                err(field, 'Phone number is required.')
    if not partial and not str(merged.get('phone') or '').strip():
        err('phone', 'Phone number is required.')

    if touched('email'):
        e = str(merged.get('email') or '').strip()
        if e:
            try:
                validate_email(e)
            except DjangoValidationError:
                err('email', 'Enter a valid email address.')
        clean['email'] = e.lower()

    if touched('website'):
        try:
            clean['website'] = _valid_website(merged.get('website'))
        except DjangoValidationError:
            err('website', 'Enter a valid website, e.g. www.yourstore.com.')

    if touched('tagline'):
        t = str(merged.get('tagline') or '').strip()
        if len(t) > 120:
            err('tagline', 'Keep the tagline under 120 characters.')
        clean['tagline'] = t

    if touched('pin_code') or touched('country'):
        try:
            clean['pin_code'] = _valid_pin(merged.get('pin_code'), country)
        except ValueError as exc:
            err('pin_code', str(exc))

    if touched('extra_addresses'):
        raw = merged.get('extra_addresses') or {}
        if not isinstance(raw, dict):
            err('extra_addresses', 'Invalid address data.')
        else:
            addrs = _clean_addresses(raw)
            for kind, a in addrs.items():
                if not a['same_as_store'] and a['pin_code']:
                    try:
                        a['pin_code'] = _valid_pin(a['pin_code'], a['country'] or country)
                    except ValueError as exc:
                        err(f'extra_addresses.{kind}.pin_code', str(exc))
            clean['extra_addresses'] = addrs

    if touched('logo_data_url'):
        logo = str(merged.get('logo_data_url') or '').strip()
        if logo and not LOGO_RE.match(logo):
            err('logo_data_url', 'Logo must be a PNG, JPG or SVG image.')
        elif len(logo) > MAX_LOGO_CHARS:
            err('logo_data_url', 'Logo is too large — use an image under 1 MB.')
        clean['logo_data_url'] = logo

    for field in ('opening_time', 'closing_time'):
        if touched(field):
            v = str(merged.get(field) or '').strip()
            if v and not TIME_RE.match(v):
                err(field, 'Use HH:MM (24-hour).')
            clean[field] = v
    o, cl = str(merged.get('opening_time') or ''), str(merged.get('closing_time') or '')
    if TIME_RE.match(o) and TIME_RE.match(cl) and cl <= o:
        err('closing_time', 'Closing time must be after opening time.')

    if touched('working_days'):
        days = merged.get('working_days') or []
        if not isinstance(days, list) or any(d not in WEEKDAYS for d in days):
            err('working_days', 'Invalid working days.')
        else:
            clean['working_days'] = [d for d in WEEKDAYS if d in days]

    if touched('holidays'):
        hol = merged.get('holidays') or []
        out = []
        if not isinstance(hol, list) or len(hol) > 100:
            err('holidays', 'Up to 100 holidays can be configured.')
        else:
            for i, h in enumerate(hol):
                h = h if isinstance(h, dict) else {}
                try:
                    d = datetime.date.fromisoformat(str(h.get('date') or ''))
                except ValueError:
                    err(f'holidays.{i}.date', 'Pick a valid date.')
                    continue
                out.append({'date': d.isoformat(), 'name': str(h.get('name') or '').strip()[:80]})
            clean['holidays'] = sorted(out, key=lambda x: x['date'])

    if touched('provides_eye_exams'):
        clean['provides_eye_exams'] = bool(merged.get('provides_eye_exams'))

    if touched('clinic_settings'):
        cs = merged.get('clinic_settings') or {}
        cs = cs if isinstance(cs, dict) else {}
        out = {}
        for field in ('exam_start', 'exam_end'):
            v = str(cs.get(field) or '').strip()
            if v and not TIME_RE.match(v):
                err(f'clinic_settings.{field}', 'Use HH:MM (24-hour).')
            out[field] = v
        if out['exam_start'] and out['exam_end'] and TIME_RE.match(out['exam_start']) \
                and TIME_RE.match(out['exam_end']) and out['exam_end'] <= out['exam_start']:
            err('clinic_settings.exam_end', 'Exam hours must end after they start.')
        slot = cs.get('slot_minutes')
        if slot in (None, ''):
            out['slot_minutes'] = None
        else:
            try:
                out['slot_minutes'] = int(slot)
                if not 5 <= out['slot_minutes'] <= 240:
                    raise ValueError
            except (TypeError, ValueError):
                err('clinic_settings.slot_minutes', 'Slot length must be 5–240 minutes.')
        out['appointment_required'] = bool(cs.get('appointment_required'))
        clean['clinic_settings'] = out

    if touched('branch_code'):
        code = str(merged.get('branch_code') or '').strip().upper()
        if code and not CODE_RE.match(code):
            err('branch_code', 'Use up to 20 letters, digits, - or _.')
        clean['branch_code'] = code

    return clean, errors


def compute_completeness(profile):
    """Per-category checklist from saved data only (never the unsaved form)."""
    from apps.billing.models import BillingSettings, BillTemplate, DocumentTemplateAssignment

    clinic_required = profile['provides_eye_exams'] or profile['store_type'] in CLINIC_TYPES
    working = bool(profile['working_days'])
    hours = bool(profile['opening_time'] and profile['closing_time'])
    checks = {
        'identity': [('Store / clinic name', bool(profile['name'])),
                     ('Store type', bool(profile['store_type'])),
                     ('Display name', bool(profile['display_name']))],
        'contact': [('Phone number', bool(profile['phone'])),
                    ('Email address', bool(profile['email'])),
                    ('Street address', bool(profile['address'])),
                    ('City, state & PIN code', bool(profile['city'] and profile['state'] and profile['pin_code']))],
        'clinic': [('Clinic / branch code', bool(profile['branch_code'])),
                   ('Contact person', bool(profile['contact_person'])),
                   ('Opening hours', hours),
                   ('Working days', working)]
        + ([('Clinical registration number', bool(profile['clinical_reg_no']))] if clinic_required else []),
        'billing': [('GSTIN', bool(profile['gstin'])),
                    ('Currency', bool(profile['currency'])),
                    ('Sales invoice template assigned', _sales_template_assigned(BillingSettings, DocumentTemplateAssignment))],
        'branding': [('Store logo', bool(profile['logo_data_url'])),
                     ('Tagline', bool(profile['tagline'])),
                     ('Active invoice template', BillTemplate.objects.filter(is_active=True).exists())],
    }
    labels = {'identity': 'Store identity', 'contact': 'Contact information', 'clinic': 'Clinic details',
              'billing': 'Billing & tax configuration', 'branding': 'Invoice branding'}
    sections = []
    for key, items in checks.items():
        done = sum(1 for _, ok in items if ok)
        sections.append({'key': key, 'label': labels[key], 'done': done, 'total': len(items),
                         'complete': done == len(items), 'missing': [lbl for lbl, ok in items if not ok]})
    percent = round(100 * sum(s['done'] / s['total'] for s in sections) / len(sections))
    return {'percent': percent, 'sections': sections}


def _sales_template_assigned(BillingSettings, DocumentTemplateAssignment):
    b = BillingSettings.load()
    if b.use_single_template and b.single_template_id:
        return True
    return DocumentTemplateAssignment.objects.filter(
        document_type__in=('SALES_INVOICE', 'SALES_BILL'), template__isnull=False).exists()


def _default_branch():
    from .models import BusinessSettings
    try:
        return BusinessSettings.load().default_branch or Branch.get_default()
    except Exception:
        return Branch.get_default()


def build_profile(include_completeness=False):
    company = get_company()
    payload = _profile_payload(company, _branding(), _default_branch())
    if include_completeness:
        payload['completeness'] = compute_completeness(payload)
    return payload


class StoreProfileView(APIView):
    permission_classes = [StoreSettingsPermission]

    def perform_authentication(self, request):
        # Reads skip authentication entirely (printing must survive an expired token).
        if request.method not in permissions.SAFE_METHODS:
            request.user  # noqa: B018 — forces authentication

    def get(self, request):
        include = request.query_params.get('include') == 'completeness'
        return Response(build_profile(include_completeness=include))

    def put(self, request):
        return self._save(request, partial=False)

    def patch(self, request):
        return self._save(request, partial=True)

    def _save(self, request, partial):
        data = request.data if isinstance(request.data, dict) else {}
        current = build_profile()
        clean, errors = validate_profile(dict(data), current, partial)

        branch = _default_branch()
        code = clean.get('branch_code')
        if code and Branch.all_objects.filter(code__iexact=code).exclude(pk=getattr(branch, 'pk', None)).exists():
            errors.setdefault('branch_code', f'Branch code "{code}" is already used by another branch.')
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)

        user = request.user if getattr(request.user, 'is_authenticated', False) else None
        with transaction.atomic():
            company = Company.objects.select_for_update().order_by('created_at').first()
            if company is None:
                today = datetime.date.today()
                start_year = today.year if today.month >= 4 else today.year - 1
                company = Company(
                    fiscal_year_start=datetime.date(start_year, 4, 1),
                    fiscal_year_end=datetime.date(start_year + 1, 3, 31),
                    currency='₹', country=current['country'], created_by=user,
                )
            for field in TEXT_FIELDS:
                if field in clean:
                    setattr(company, field, clean[field])
            for field in ('store_type', 'whatsapp', 'pin_code', 'extra_addresses', 'opening_time',
                          'closing_time', 'working_days', 'holidays', 'provides_eye_exams',
                          'clinic_settings'):
                if field in clean:
                    setattr(company, field, clean[field])
            for field in ('gstin', 'phone', 'email'):
                if field in clean:
                    setattr(company, field, clean[field] or None)
            company.updated_by = user
            company.save()

            if any(k in clean for k in ('logo_data_url', 'website', 'tagline')):
                branding = _branding()
                info = dict(branding.business_info or {})
                for k in ('website', 'tagline'):
                    if k in clean:
                        info[k] = clean[k]
                branding.business_info = info
                if 'logo_data_url' in clean:
                    branding.logo_data_url = clean['logo_data_url']
                branding.save(update_fields=['business_info', 'logo_data_url', 'updated_at'])

            if code and (branch is None or branch.code != code):
                if branch is None:
                    branch = Branch.objects.create(company=company, name='Head Office', code=code,
                                                   is_default=True, is_active=True)
                else:
                    branch.code = code
                    branch.save(update_fields=['code', 'updated_at'])

        return Response(build_profile(include_completeness=True))
