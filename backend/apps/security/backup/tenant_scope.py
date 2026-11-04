"""Which rows make up one client's (tenant's) backup, and how they split into sections.

A per-client backup is the same archive format as a whole-database one (archive.py) holding
only the rows of one tenant:

  * tables with a `tenant` FK                → rows of that tenant
  * common.Tenant                            → the tenant's own row
  * tables without one (M2M through tables,
    child rows such as ImportErrorLog)       → rows whose FK leads to a row of that tenant
  * tables with no path to a tenant          → left out (content types, permissions, …: global)

Sections let the platform admin export one area of the business on its own (Optical Services,
Inventory, Sales, Financial Accounts, …). A table belongs to one or more sections — patients
(sales.Customer) are both Optical and Sales data — and a section backup holds whole tables,
not a cross-section graph, so e.g. a Sales backup names products by id only. A full client
backup (no sections) holds every table above, mapped or not.
"""
from django.apps import apps

from . import archive

SECTIONS = (
    ('optical', 'Optical Services', 'Patients, eye examinations and prescriptions, appointments.'),
    ('sales', 'Sales', 'Bills, orders, quotations, bill lines, payments, customers, services.'),
    ('wholesale', 'Wholesale', 'Dealers, wholesale invoices, orders, challans, collections, returns.'),
    ('inventory', 'Inventory', 'Products, categories, brands, barcodes, stock levels, adjustments, transfers.'),
    ('purchase', 'Purchase', 'Suppliers, purchase entries, purchase and lens orders.'),
    ('financial', 'Financial Accounts', 'Chart of accounts, journals, ledger lines, cheques, bank entries.'),
    ('setup', 'Users, Branches & Settings', 'User accounts, company profile, branches, numbering, templates.'),
)
SECTION_KEYS = tuple(s[0] for s in SECTIONS)
SECTION_LABELS = {s[0]: s[1] for s in SECTIONS}

APP_SECTIONS = {
    'sales': ('sales',),
    'accounts': ('financial',),
    'financial': ('financial',),
    'inventory': ('inventory',),
    'masters': ('inventory',),
    'products': ('inventory',),
    'purchasing': ('purchase',),
}
MODEL_SECTIONS = {
    'sales.customer': ('optical', 'sales'),
    'sales.patientcodesequence': ('optical', 'sales'),
    'sales.eyeexamination': ('optical',),
    'sales.appointment': ('optical',),
    'sales.testnosequence': ('optical',),
    'sales.dealer': ('wholesale',),
    'company.warehouse': ('inventory',),
    'company.branchstock': ('inventory',),
    'company.stocktransfer': ('inventory',),
    'company.stocktransferitem': ('inventory',),
}


def sections_of(model):
    meta = model._meta
    if meta.auto_created:  # an M2M through table follows the model that declares the field
        return sections_of(meta.auto_created)
    label = meta.label_lower
    if label in MODEL_SECTIONS:
        return MODEL_SECTIONS[label]
    if label.startswith('sales.wholesale'):
        return ('wholesale',)
    return APP_SECTIONS.get(meta.app_label, ('setup',))


def _tenant_model():
    return apps.get_model('common', 'Tenant')


def _has_tenant_fk(model):
    field = next((f for f in model._meta.concrete_fields if f.name == 'tenant'), None)
    return field is not None and field.is_relation and field.related_model is _tenant_model()


def tenant_lookup(model):
    """The filter key that limits `model` to one tenant ('tenant_id', 'pk', '<fk>__tenant_id'),
    or None for a global table."""
    if model is _tenant_model():
        return 'pk'
    if _has_tenant_fk(model):
        return 'tenant_id'
    # Prefer a required FK: a row whose nullable FK is empty cannot be attributed to anyone.
    fks = sorted((f for f in model._meta.concrete_fields if f.many_to_one or f.one_to_one),
                 key=lambda f: f.null)
    for field in fks:
        target = field.related_model
        if target is _tenant_model():
            return f'{field.name}_id'
        if target is not None and _has_tenant_fk(target):
            return f'{field.name}__tenant_id'
    return None


def normalize_sections(values):
    """Validated, catalog-ordered section keys; [] means the full client backup."""
    chosen = {str(v) for v in (values or [])}
    unknown = chosen - set(SECTION_KEYS)
    if unknown:
        raise archive.BackupError(f'Unknown backup section: {sorted(unknown)[0]}.')
    if chosen == set(SECTION_KEYS):
        return []
    return [k for k in SECTION_KEYS if k in chosen]


def sections_label(sections):
    return 'Full client backup' if not sections else ', '.join(SECTION_LABELS[s] for s in sections)


class TenantScope:
    """Passed to archive.write_archive to dump one tenant (optionally some sections only)."""

    def __init__(self, tenant, sections=()):
        self.tenant = tenant
        self.sections = list(sections or [])

    def models(self):
        out = []
        for model in archive.backup_models():
            if tenant_lookup(model) is None:
                continue
            if self.sections and not set(sections_of(model)) & set(self.sections):
                continue
            out.append(model)
        return out

    def queryset(self, model, using):
        return model._base_manager.using(using).filter(**{tenant_lookup(model): self.tenant.pk})

    def manifest(self):
        return {'kind': 'tenant', 'tenant_id': self.tenant.pk, 'tenant_code': self.tenant.code,
                'tenant_name': self.tenant.name, 'sections': self.sections,
                'sections_label': sections_label(self.sections)}
