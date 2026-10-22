"""Business & Localization preferences (Settings → Business & Localization).

    GET  /api/company/localization/            {preferences, currency, catalog_version}
    PUT  /api/company/localization/            validated partial update (store-settings role)
    GET  /api/company/localization/catalog/    countries, regions, time zones, currencies, languages
    GET  /api/company/settings-audit/          latest settings changes

Storage (nothing kept twice):
  * BusinessSettings.preferences      everything below in DEFAULTS
  * Company.currency                  the currency *symbol* every document prints (the store
                                      profile has always owned it; this screen edits it there)

Server code reads preferences through get_preferences() (hot-cached, cleared on save).
"""
import datetime
from decimal import Decimal

from django.db import transaction
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common import hot_cache
from .models import BusinessSettings, SettingsAuditLog
from .store_profile import StoreSettingsPermission, get_company

# ---------------------------------------------------------------------------
# Catalogs (served to the UI so the server is the one list both sides validate against)
# ---------------------------------------------------------------------------

# code, name, suggested defaults: currency, time zone, date format, number format, language,
# fiscal-year start month
COUNTRIES = [
    ('IN', 'India', 'INR', 'Asia/Kolkata', 'DD-MM-YYYY', 'INDIAN', 'en', 4),
    ('AE', 'United Arab Emirates', 'AED', 'Asia/Dubai', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 1),
    ('SA', 'Saudi Arabia', 'SAR', 'Asia/Riyadh', 'DD/MM/YYYY', 'INTERNATIONAL', 'ar', 1),
    ('QA', 'Qatar', 'QAR', 'Asia/Qatar', 'DD/MM/YYYY', 'INTERNATIONAL', 'ar', 1),
    ('OM', 'Oman', 'OMR', 'Asia/Muscat', 'DD/MM/YYYY', 'INTERNATIONAL', 'ar', 1),
    ('KW', 'Kuwait', 'KWD', 'Asia/Kuwait', 'DD/MM/YYYY', 'INTERNATIONAL', 'ar', 4),
    ('BH', 'Bahrain', 'BHD', 'Asia/Bahrain', 'DD/MM/YYYY', 'INTERNATIONAL', 'ar', 1),
    ('BD', 'Bangladesh', 'BDT', 'Asia/Dhaka', 'DD-MM-YYYY', 'INDIAN', 'bn', 7),
    ('NP', 'Nepal', 'NPR', 'Asia/Kathmandu', 'YYYY-MM-DD', 'INDIAN', 'ne', 7),
    ('LK', 'Sri Lanka', 'LKR', 'Asia/Colombo', 'DD/MM/YYYY', 'INTERNATIONAL', 'si', 4),
    ('BT', 'Bhutan', 'BTN', 'Asia/Thimphu', 'DD/MM/YYYY', 'INTERNATIONAL', 'dz', 7),
    ('MV', 'Maldives', 'MVR', 'Indian/Maldives', 'DD/MM/YYYY', 'INTERNATIONAL', 'dv', 1),
    ('PK', 'Pakistan', 'PKR', 'Asia/Karachi', 'DD/MM/YYYY', 'INTERNATIONAL', 'ur', 7),
    ('SG', 'Singapore', 'SGD', 'Asia/Singapore', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 4),
    ('MY', 'Malaysia', 'MYR', 'Asia/Kuala_Lumpur', 'DD/MM/YYYY', 'INTERNATIONAL', 'ms', 1),
    ('ID', 'Indonesia', 'IDR', 'Asia/Jakarta', 'DD/MM/YYYY', 'EUROPEAN', 'id', 1),
    ('TH', 'Thailand', 'THB', 'Asia/Bangkok', 'DD/MM/YYYY', 'INTERNATIONAL', 'th', 10),
    ('PH', 'Philippines', 'PHP', 'Asia/Manila', 'MM/DD/YYYY', 'INTERNATIONAL', 'en', 1),
    ('CN', 'China', 'CNY', 'Asia/Shanghai', 'YYYY-MM-DD', 'INTERNATIONAL', 'zh', 1),
    ('JP', 'Japan', 'JPY', 'Asia/Tokyo', 'YYYY-MM-DD', 'INTERNATIONAL', 'ja', 4),
    ('KR', 'South Korea', 'KRW', 'Asia/Seoul', 'YYYY-MM-DD', 'INTERNATIONAL', 'ko', 1),
    ('HK', 'Hong Kong', 'HKD', 'Asia/Hong_Kong', 'DD/MM/YYYY', 'INTERNATIONAL', 'zh', 4),
    ('AU', 'Australia', 'AUD', 'Australia/Sydney', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 7),
    ('NZ', 'New Zealand', 'NZD', 'Pacific/Auckland', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 4),
    ('GB', 'United Kingdom', 'GBP', 'Europe/London', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 4),
    ('IE', 'Ireland', 'EUR', 'Europe/Dublin', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 1),
    ('DE', 'Germany', 'EUR', 'Europe/Berlin', 'DD/MM/YYYY', 'EUROPEAN', 'de', 1),
    ('FR', 'France', 'EUR', 'Europe/Paris', 'DD/MM/YYYY', 'SPACE', 'fr', 1),
    ('IT', 'Italy', 'EUR', 'Europe/Rome', 'DD/MM/YYYY', 'EUROPEAN', 'it', 1),
    ('ES', 'Spain', 'EUR', 'Europe/Madrid', 'DD/MM/YYYY', 'EUROPEAN', 'es', 1),
    ('NL', 'Netherlands', 'EUR', 'Europe/Amsterdam', 'DD-MM-YYYY', 'EUROPEAN', 'nl', 1),
    ('CH', 'Switzerland', 'CHF', 'Europe/Zurich', 'DD/MM/YYYY', 'SWISS', 'de', 1),
    ('US', 'United States', 'USD', 'America/New_York', 'MM/DD/YYYY', 'INTERNATIONAL', 'en', 1),
    ('CA', 'Canada', 'CAD', 'America/Toronto', 'YYYY-MM-DD', 'INTERNATIONAL', 'en', 4),
    ('MX', 'Mexico', 'MXN', 'America/Mexico_City', 'DD/MM/YYYY', 'INTERNATIONAL', 'es', 1),
    ('BR', 'Brazil', 'BRL', 'America/Sao_Paulo', 'DD/MM/YYYY', 'EUROPEAN', 'pt', 1),
    ('ZA', 'South Africa', 'ZAR', 'Africa/Johannesburg', 'YYYY-MM-DD', 'SPACE', 'en', 3),
    ('NG', 'Nigeria', 'NGN', 'Africa/Lagos', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 1),
    ('KE', 'Kenya', 'KES', 'Africa/Nairobi', 'DD/MM/YYYY', 'INTERNATIONAL', 'en', 7),
    ('EG', 'Egypt', 'EGP', 'Africa/Cairo', 'DD/MM/YYYY', 'INTERNATIONAL', 'ar', 7),
]
COUNTRY_CODES = {c[0] for c in COUNTRIES}

# ISO 3166-2 style subdivisions where we have them; other countries take a typed region.
REGIONS = {
    'IN': ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
           'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
           'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
           'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
           'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim',
           'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'],
    'AE': ['Abu Dhabi', 'Ajman', 'Dubai', 'Fujairah', 'Ras Al Khaimah', 'Sharjah', 'Umm Al Quwain'],
    'SA': ['Al Bahah', 'Al Jawf', 'Al Madinah', 'Al Qassim', 'Asir', 'Eastern Province', 'Hail',
           'Jazan', 'Makkah', 'Najran', 'Northern Borders', 'Riyadh', 'Tabuk'],
    'QA': ['Ad Dawhah', 'Al Khor', 'Al Rayyan', 'Al Wakrah', 'Al Daayen', 'Al Shamal', 'Umm Salal', 'Al Shahaniya'],
    'OM': ['Ad Dakhiliyah', 'Ad Dhahirah', 'Al Batinah North', 'Al Batinah South', 'Al Buraimi',
           'Al Wusta', 'Ash Sharqiyah North', 'Ash Sharqiyah South', 'Dhofar', 'Muscat', 'Musandam'],
    'KW': ['Al Ahmadi', 'Al Asimah', 'Al Farwaniyah', 'Al Jahra', 'Hawalli', 'Mubarak Al-Kabeer'],
    'BH': ['Capital', 'Muharraq', 'Northern', 'Southern'],
    'LK': ['Central', 'Eastern', 'North Central', 'North Western', 'Northern', 'Sabaragamuwa',
           'Southern', 'Uva', 'Western'],
    'MY': ['Johor', 'Kedah', 'Kelantan', 'Kuala Lumpur', 'Labuan', 'Melaka', 'Negeri Sembilan', 'Pahang',
           'Penang', 'Perak', 'Perlis', 'Putrajaya', 'Sabah', 'Sarawak', 'Selangor', 'Terengganu'],
    'AU': ['Australian Capital Territory', 'New South Wales', 'Northern Territory', 'Queensland',
           'South Australia', 'Tasmania', 'Victoria', 'Western Australia'],
    'GB': ['England', 'Northern Ireland', 'Scotland', 'Wales'],
    'CA': ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
           'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island',
           'Quebec', 'Saskatchewan', 'Yukon'],
    'US': ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
           'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
           'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
           'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
           'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
           'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
           'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'],
}

# ISO 4217: code, name, symbol, minor units
CURRENCIES = [
    ('INR', 'Indian Rupee', '₹', 2), ('USD', 'US Dollar', '$', 2), ('EUR', 'Euro', '€', 2),
    ('GBP', 'Pound Sterling', '£', 2), ('AED', 'UAE Dirham', 'AED', 2), ('SAR', 'Saudi Riyal', 'SAR', 2),
    ('QAR', 'Qatari Riyal', 'QAR', 2), ('OMR', 'Omani Rial', 'OMR', 3), ('KWD', 'Kuwaiti Dinar', 'KWD', 3),
    ('BHD', 'Bahraini Dinar', 'BHD', 3), ('BDT', 'Bangladeshi Taka', '৳', 2), ('NPR', 'Nepalese Rupee', 'Rs', 2),
    ('LKR', 'Sri Lankan Rupee', 'Rs', 2), ('BTN', 'Bhutanese Ngultrum', 'Nu.', 2),
    ('MVR', 'Maldivian Rufiyaa', 'Rf', 2), ('PKR', 'Pakistani Rupee', 'Rs', 2),
    ('SGD', 'Singapore Dollar', 'S$', 2), ('MYR', 'Malaysian Ringgit', 'RM', 2),
    ('IDR', 'Indonesian Rupiah', 'Rp', 2), ('THB', 'Thai Baht', '฿', 2), ('PHP', 'Philippine Peso', '₱', 2),
    ('CNY', 'Chinese Yuan', '¥', 2), ('JPY', 'Japanese Yen', '¥', 0), ('KRW', 'South Korean Won', '₩', 0),
    ('HKD', 'Hong Kong Dollar', 'HK$', 2), ('AUD', 'Australian Dollar', 'A$', 2),
    ('NZD', 'New Zealand Dollar', 'NZ$', 2), ('CAD', 'Canadian Dollar', 'C$', 2),
    ('CHF', 'Swiss Franc', 'CHF', 2), ('SEK', 'Swedish Krona', 'kr', 2), ('NOK', 'Norwegian Krone', 'kr', 2),
    ('DKK', 'Danish Krone', 'kr', 2), ('MXN', 'Mexican Peso', 'MX$', 2), ('BRL', 'Brazilian Real', 'R$', 2),
    ('ZAR', 'South African Rand', 'R', 2), ('NGN', 'Nigerian Naira', '₦', 2), ('KES', 'Kenyan Shilling', 'KSh', 2),
    ('EGP', 'Egyptian Pound', 'E£', 2), ('TRY', 'Turkish Lira', '₺', 2), ('RUB', 'Russian Ruble', '₽', 2),
]
CURRENCY_BY_CODE = {c[0]: c for c in CURRENCIES}

# code, English name, native name. Only English UI text exists today — the rest are stored as
# the business's document / communication language and for future translations.
LANGUAGES = [
    ('en', 'English', 'English'), ('ml', 'Malayalam', 'മലയാളം'), ('hi', 'Hindi', 'हिन्दी'),
    ('ar', 'Arabic', 'العربية'), ('ta', 'Tamil', 'தமிழ்'), ('te', 'Telugu', 'తెలుగు'),
    ('kn', 'Kannada', 'ಕನ್ನಡ'), ('mr', 'Marathi', 'मराठी'), ('gu', 'Gujarati', 'ગુજરાતી'),
    ('bn', 'Bengali', 'বাংলা'), ('pa', 'Punjabi', 'ਪੰਜਾਬੀ'), ('ur', 'Urdu', 'اردو'),
    ('ne', 'Nepali', 'नेपाली'), ('si', 'Sinhala', 'සිංහල'), ('dz', 'Dzongkha', 'རྫོང་ཁ'),
    ('dv', 'Dhivehi', 'ދިވެހި'), ('ms', 'Malay', 'Bahasa Melayu'), ('id', 'Indonesian', 'Bahasa Indonesia'),
    ('th', 'Thai', 'ไทย'), ('zh', 'Chinese', '中文'), ('ja', 'Japanese', '日本語'), ('ko', 'Korean', '한국어'),
    ('fr', 'French', 'Français'), ('de', 'German', 'Deutsch'), ('es', 'Spanish', 'Español'),
    ('it', 'Italian', 'Italiano'), ('nl', 'Dutch', 'Nederlands'), ('pt', 'Portuguese', 'Português'),
]
LANGUAGE_CODES = {lang[0] for lang in LANGUAGES}
UI_LANGUAGES = {'en'}  # languages the interface actually has translations for
# Languages bills can print in (fixed wording only) — mirrors frontend src/billing/billI18n.js.
BILL_LANGUAGES = {'ar', 'hi', 'ml', 'ta'}
BILL_LANGUAGE_MODES = ['EN', 'LOCAL', 'BILINGUAL']  # English / local only / English + local

DATE_FORMATS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY', 'DD MMM YYYY']
TIME_FORMATS = ['12H', '24H']
# key -> (group separator, decimal separator, Indian lakh grouping)
NUMBER_FORMATS = {
    'INDIAN': (',', '.', True),        # 1,23,456.78
    'INTERNATIONAL': (',', '.', False),  # 123,456.78
    'EUROPEAN': ('.', ',', False),     # 123.456,78
    'SPACE': (' ', ',', False),        # 123 456,78
    'SWISS': ("'", '.', False),        # 123'456.78
}
ROUNDING_METHODS = ['NONE', 'NEAREST_0_05', 'NEAREST_0_10', 'NEAREST_0_50', 'NEAREST_1', 'UP_1', 'DOWN_1']
DOC_STATUSES = ['UNPAID', 'DRAFT']
DISCOUNT_MODES = ['PERCENT', 'AMOUNT']
SERVICE_CHARGE_ON = ['NONE', 'SUBTOTAL', 'TOTAL']

DEFAULTS = {
    # Regional defaults
    'country': 'IN', 'region': 'Kerala', 'time_zone': 'Asia/Kolkata', 'date_format': 'DD-MM-YYYY',
    'time_format': '12H', 'fiscal_year_start_month': 4, 'number_format': 'INDIAN', 'language': 'en',
    'bill_language_mode': 'EN',
    # Document & transaction preferences
    'show_currency_symbol': True,
    'allow_negative_stock': True,  # what the system has always done; switch off to enforce
    'auto_generate_numbers': True,
    'multi_currency_enabled': False,
    'confirm_before_posting': False,
    # Currency & language
    'base_currency': 'INR', 'currency_decimals': 2,
    'enabled_currencies': [],      # extra ISO codes allowed for transactions
    'exchange_rates': {},          # {code: units of base per 1 unit of code}
    'enabled_languages': ['en'],
    # Other settings
    'rounding_method': 'NONE', 'quantity_decimals': 0, 'default_payment_terms_days': 0,
    'default_sale_status': 'UNPAID', 'default_discount_mode': 'PERCENT', 'max_discount_percent': 100,
    'service_charge_percent': 0, 'service_charge_on': 'NONE', 'default_customer_city': '',
}
BOOL_KEYS = {k for k, v in DEFAULTS.items() if isinstance(v, bool)}

CACHE_KEY = 'company:preferences'


def _time_zones():
    try:
        import zoneinfo
        names = sorted(n for n in zoneinfo.available_timezones()
                       if '/' in n and not n.startswith(('Etc/', 'SystemV/', 'US/', 'posix/', 'right/')))
    except Exception:
        names = []
    return names or sorted({c[3] for c in COUNTRIES} | {'UTC'})


def _utc_offset(name, now=None):
    try:
        import zoneinfo
        off = (now or datetime.datetime.now(datetime.timezone.utc)).astimezone(zoneinfo.ZoneInfo(name)).utcoffset()
    except Exception:
        return ''
    minutes = int(off.total_seconds() // 60)
    sign = '+' if minutes >= 0 else '-'
    minutes = abs(minutes)
    return f'UTC{sign}{minutes // 60:02d}:{minutes % 60:02d}'


def catalog():
    now = datetime.datetime.now(datetime.timezone.utc)
    return {
        'countries': [{'code': c[0], 'name': c[1], 'currency': c[2], 'time_zone': c[3], 'date_format': c[4],
                       'number_format': c[5], 'language': c[6], 'fiscal_year_start_month': c[7]}
                      for c in COUNTRIES],
        'regions': REGIONS,
        'time_zones': [{'name': n, 'offset': _utc_offset(n, now)} for n in _time_zones()],
        'currencies': [{'code': c[0], 'name': c[1], 'symbol': c[2], 'decimals': c[3]} for c in CURRENCIES],
        'languages': [{'code': lang[0], 'name': lang[1], 'native': lang[2], 'ui_translated': lang[0] in UI_LANGUAGES,
                       'bill_translated': lang[0] in BILL_LANGUAGES}
                      for lang in LANGUAGES],
        'date_formats': DATE_FORMATS, 'time_formats': TIME_FORMATS, 'number_formats': list(NUMBER_FORMATS),
        'rounding_methods': ROUNDING_METHODS,
    }


# ---------------------------------------------------------------------------
# Read / validate / save
# ---------------------------------------------------------------------------

def get_preferences():
    """The effective preferences (stored values over DEFAULTS). Hot-cached; saving clears it."""
    def load():
        stored = BusinessSettings.load().preferences or {}
        return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}
    return dict(hot_cache.get_or_load(CACHE_KEY, load))


def get_preference(key):
    return get_preferences().get(key, DEFAULTS.get(key))


def _int_in(value, lo, hi):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        raise ValueError(f'Enter a whole number between {lo} and {hi}.')
    if not lo <= n <= hi:
        raise ValueError(f'Must be between {lo} and {hi}.')
    return n


def _bool(value):
    if not isinstance(value, bool):
        raise ValueError('Must be on or off.')
    return value


def _choice(value, allowed, what):
    if value not in allowed:
        raise ValueError(f'Choose a supported {what}.')
    return value


def validate_preferences(data, current):
    """(clean partial dict, errors). Only keys present in `data` are validated/returned."""
    clean, errors = {}, {}

    def put(key, fn):
        if key not in data:
            return
        try:
            clean[key] = fn(data[key])
        except ValueError as exc:
            errors[key] = str(exc)

    for key in BOOL_KEYS:
        put(key, _bool)
    put('country', lambda v: _choice(str(v or '').upper(), COUNTRY_CODES, 'country'))
    put('region', lambda v: str(v or '').strip()[:100])
    zones = set(_time_zones())
    put('time_zone', lambda v: _choice(v, zones, 'time zone'))
    put('date_format', lambda v: _choice(v, DATE_FORMATS, 'date format'))
    put('time_format', lambda v: _choice(v, TIME_FORMATS, 'time format'))
    put('fiscal_year_start_month', lambda v: _int_in(v, 1, 12))
    put('number_format', lambda v: _choice(v, NUMBER_FORMATS, 'number format'))
    put('language', lambda v: _choice(v, LANGUAGE_CODES, 'language'))
    put('bill_language_mode', lambda v: _choice(v, BILL_LANGUAGE_MODES, 'bill language option'))
    put('base_currency', lambda v: _choice(str(v or '').upper(), CURRENCY_BY_CODE, 'currency'))
    put('currency_decimals', lambda v: _int_in(v, 0, 4))
    put('quantity_decimals', lambda v: _int_in(v, 0, 3))
    put('default_payment_terms_days', lambda v: _int_in(v, 0, 365))
    put('max_discount_percent', lambda v: _int_in(v, 0, 100))
    put('rounding_method', lambda v: _choice(v, ROUNDING_METHODS, 'rounding method'))
    put('default_sale_status', lambda v: _choice(v, DOC_STATUSES, 'document status'))
    put('default_discount_mode', lambda v: _choice(v, DISCOUNT_MODES, 'discount mode'))
    put('service_charge_on', lambda v: _choice(v, SERVICE_CHARGE_ON, 'service charge basis'))
    put('default_customer_city', lambda v: str(v or '').strip()[:100])

    def pct(v):
        try:
            d = Decimal(str(v).strip() or '0')
        except Exception:
            raise ValueError('Enter a percentage.')
        if not Decimal('0') <= d <= Decimal('100'):
            raise ValueError('Must be between 0 and 100.')
        return float(d.quantize(Decimal('0.01')))
    put('service_charge_percent', pct)

    def lang_list(v):
        if not isinstance(v, list):
            raise ValueError('Expected a list of languages.')
        out = []
        for code in v:
            _choice(code, LANGUAGE_CODES, 'language')
            if code not in out:
                out.append(code)
        return out
    put('enabled_languages', lang_list)

    def cur_list(v):
        if not isinstance(v, list):
            raise ValueError('Expected a list of currencies.')
        out = []
        for code in v:
            code = str(code or '').upper()
            _choice(code, CURRENCY_BY_CODE, 'currency')
            if code not in out:
                out.append(code)
        return out
    put('enabled_currencies', cur_list)

    if 'exchange_rates' in data:
        rates, bad = {}, {}
        raw = data['exchange_rates'] if isinstance(data['exchange_rates'], dict) else None
        if raw is None:
            errors['exchange_rates'] = 'Expected rates keyed by currency code.'
        else:
            for code, rate in raw.items():
                code = str(code).upper()
                if code not in CURRENCY_BY_CODE:
                    bad[code] = 'Unsupported currency.'
                    continue
                if rate in ('', None):
                    continue
                try:
                    r = Decimal(str(rate))
                except Exception:
                    bad[code] = 'Enter a number.'
                    continue
                if r <= 0:
                    bad[code] = 'Rate must be greater than 0.'
                    continue
                rates[code] = str(r.normalize())
            if bad:
                errors['exchange_rates'] = bad
            else:
                clean['exchange_rates'] = rates

    if 'currency_symbol' in data:
        sym = str(data['currency_symbol'] or '').strip()
        if not sym:
            errors['currency_symbol'] = 'Enter the symbol printed with amounts.'
        elif len(sym) > 10:
            errors['currency_symbol'] = 'Use at most 10 characters.'
        else:
            clean['currency_symbol'] = sym

    # Cross-field rules on the merged result
    merged = {**current, **clean}
    base = merged['base_currency']
    if 'enabled_currencies' in clean:
        clean['enabled_currencies'] = [c for c in clean['enabled_currencies'] if c != base]
        merged['enabled_currencies'] = clean['enabled_currencies']
    if merged['multi_currency_enabled'] and not merged['enabled_currencies'] \
            and ('multi_currency_enabled' in data or 'enabled_currencies' in data):
        errors.setdefault('multi_currency_enabled',
                          'Add at least one additional currency (Currency & Language) before enabling multi-currency transactions.')
    if merged['multi_currency_enabled'] and ('exchange_rates' in data or 'enabled_currencies' in data
                                              or 'multi_currency_enabled' in data):
        rates = merged.get('exchange_rates') or {}
        missing = [c for c in merged['enabled_currencies'] if c not in rates]
        if missing:
            errors.setdefault('exchange_rates', {m: 'Enter the exchange rate.' for m in missing})
    if merged['language'] not in merged['enabled_languages']:
        if 'enabled_languages' in data:
            errors.setdefault('enabled_languages', 'The default language must be one of the enabled languages.')
        else:
            clean['enabled_languages'] = [merged['language'], *merged['enabled_languages']]
    # Bills can only print in a language that has bill wording; English always works.
    if merged['bill_language_mode'] != 'EN' and merged['language'] not in BILL_LANGUAGES:
        if 'bill_language_mode' in data:
            errors.setdefault('bill_language_mode',
                              'Bills can print in Arabic, Hindi, Malayalam or Tamil — choose one of those as the '
                              'default language, or print bills in English.')
        else:
            clean['bill_language_mode'] = 'EN'  # language changed to one without bill wording
    region_list = REGIONS.get(merged['country'])
    if 'region' in clean and region_list and clean['region'] and clean['region'] not in region_list:
        errors['region'] = 'Choose a state / region of the selected country.'
    return clean, errors


def actor_name(request):
    u = getattr(request, 'user', None)
    return (getattr(u, 'username', '') or '') if u and getattr(u, 'is_authenticated', False) else ''


def audit(request, section, action, summary, changes=None):
    SettingsAuditLog.objects.create(section=section, action=action, summary=summary[:255],
                                    changes=changes or {}, performed_by=actor_name(request)[:150])


def _payload():
    company = get_company()
    return {
        'preferences': get_preferences(),
        'currency_symbol': (company.currency if company else '') or '₹',
        'company_exists': company is not None,
        'ui_languages': sorted(UI_LANGUAGES),
    }


class OpenReadsSettingsView(APIView):
    """Reads skip authentication (every screen formats with these); writes need a store-settings role."""
    permission_classes = [StoreSettingsPermission]

    def perform_authentication(self, request):
        if request.method not in permissions.SAFE_METHODS:
            request.user  # noqa: B018 — forces authentication


class LocalizationSettingsView(OpenReadsSettingsView):
    def get(self, request):
        return Response(_payload())

    def put(self, request):
        return self._save(request)

    def patch(self, request):
        return self._save(request)

    def _save(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        current = get_preferences()
        clean, errors = validate_preferences(data, current)
        company = get_company()
        if 'currency_symbol' in clean and company is None:
            errors['currency_symbol'] = 'Fill in the Store & Clinic Profile first — the symbol is stored on the store.'
        if errors:
            return Response({'detail': 'Please fix the highlighted fields.', 'errors': errors},
                            status=status.HTTP_400_BAD_REQUEST)

        symbol = clean.pop('currency_symbol', None)
        changes = {k: [current.get(k), v] for k, v in clean.items() if current.get(k) != v}
        with transaction.atomic():
            obj = BusinessSettings.objects.select_for_update().get(pk=BusinessSettings.load().pk)
            stored = dict(obj.preferences or {})
            stored.update(clean)
            obj.preferences = stored
            obj.save(update_fields=['preferences', 'updated_at'])
            if symbol is not None and company.currency != symbol:
                changes['currency_symbol'] = [company.currency, symbol]
                company.currency = symbol
                company.save(update_fields=['currency', 'updated_at'])
            if changes:
                audit(request, 'LOCALIZATION', 'UPDATE', f"Updated {', '.join(sorted(changes))}", changes)
        return Response(_payload())


class LocalizationCatalogView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response(catalog())


class SettingsAuditView(APIView):
    permission_classes = [StoreSettingsPermission]

    def get(self, request):
        if not request.user or not request.user.is_authenticated:
            return Response({'detail': 'Sign in to view the settings history.'}, status=status.HTTP_401_UNAUTHORIZED)
        rows = SettingsAuditLog.objects.all()[:50]
        return Response([{'id': r.pk, 'section': r.section, 'action': r.action, 'summary': r.summary,
                          'changes': r.changes, 'performed_by': r.performed_by,
                          'created_at': r.created_at.isoformat()} for r in rows])


def tz_now():
    """Now in the business's configured time zone (document-number tokens, fiscal periods)."""
    try:
        import zoneinfo
        return datetime.datetime.now(zoneinfo.ZoneInfo(get_preference('time_zone')))
    except Exception:
        return datetime.datetime.now()

