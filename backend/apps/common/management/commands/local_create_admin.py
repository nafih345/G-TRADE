"""Windows local edition: create the customer's first company and its administrator.

Run by the installer through ``gtrade-ctl create-org``. Input is a JSON object on **stdin**
(never argv, so the password is not visible in process listings or logs)::

    {"company_name": "...", "branch_name": "...", "admin_username": "...", "admin_password": "...",
     "admin_full_name": "...", "admin_email": "...", "admin_phone": ""}

Rules:
* Only in the local edition, and only on a database that has **no users yet**. An existing
  installation (upgrade, repair, reinstall over kept data) is never touched.
* The company is tenant #1 (seeded by migration common 0002) inside its single organization.
* The administrator is the company's SUPER_ADMIN and organization admin. It is never a Django
  superuser: the platform-owner role on an installation belongs only to the separate Local Super
  Admin (``local_superadmin`` / ``gtrade-ctl create-superadmin``), which runs Client Management.
* The password must pass Django's validators (AUTH_PASSWORD_VALIDATORS).
"""

import json
import sys

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.text import slugify


# Placeholders seeded for tenant #1 by migration company 0003 (and tenant_onboarding.HEAD_OFFICE).
SEED_COMPANY_NAMES = {'', 'Main Company'}
SEED_BRANCH_NAMES = {'', 'Head Office'}


def _apply_customer_names(company_name: str, branch_name: str, email: str) -> None:
    """A new installation's store profile and default branch carry the names the customer typed
    in the wizard, never the migration's "Main Company" / "Head Office" placeholders (they print on
    every bill). Only untouched seed values are replaced; a name someone already set is kept."""
    from apps.company.models import Branch, Company

    company = Company.objects.order_by('created_at').first()
    if company is not None and (company.name or '').strip() in SEED_COMPANY_NAMES:
        company.name = company_name[:150]
        fields = ['name', 'updated_at']
        if email and not company.email:
            company.email = email
            fields.append('email')
        company.save(update_fields=fields)
    if branch_name:
        default = Branch.objects.filter(is_default=True, is_active=True).order_by('created_at').first()
        if default is not None and (default.name or '').strip() in SEED_BRANCH_NAMES:
            default.name = branch_name[:100]
            default.save(update_fields=['name', 'updated_at'])


class Command(BaseCommand):
    help = 'Create the first company and administrator of a new G-TRADE Windows installation (JSON on stdin).'

    def add_arguments(self, parser):
        parser.add_argument('--validate-only', action='store_true', help='check the input and password; change nothing')

    def handle(self, *args, **options):
        from apps.common.edition import is_local
        if not is_local():
            raise CommandError('local_create_admin is only available in the G-TRADE Windows edition.')
        try:
            data = json.loads(sys.stdin.read() or '{}')
        except json.JSONDecodeError:
            raise CommandError('expected a JSON object on stdin')

        company = (data.get('company_name') or '').strip()
        username = (data.get('admin_username') or '').strip()
        password = data.get('admin_password') or ''
        full_name = (data.get('admin_full_name') or '').strip()
        email = (data.get('admin_email') or '').strip()
        branch_given = (data.get('branch_name') or '').strip()
        branch = branch_given or 'Main Branch'
        errors = {}
        if not company:
            errors['company_name'] = 'Enter the company name.'
        if not username:
            errors['admin_username'] = 'Enter a user name for the administrator.'
        User = get_user_model()
        first, _, last = full_name.partition(' ')
        candidate = User(username=username, email=email or None, first_name=first, last_name=last)
        try:
            validate_password(password, user=candidate)
        except ValidationError as exc:
            errors['admin_password'] = ' '.join(exc.messages)
        if errors:
            self.stdout.write(json.dumps({'ok': False, 'errors': errors}))
            raise CommandError('invalid input')
        if options['validate_only']:
            self.stdout.write(json.dumps({'ok': True, 'validated': True}))
            return

        # The Local Super Admin (local_superadmin) may be created before the company is set up; it
        # runs the installation and does not count as "existing company users".
        from apps.common.tenancy import DEFAULT_TENANT_ID
        if User.objects.exclude(is_superuser=True, tenant_id=DEFAULT_TENANT_ID).exists():
            raise CommandError('This database already has users; the initial administrator is created only on a new installation.')

        from apps.common.models import Tenant
        from apps.common.organizations import ensure_organization, grant_default_org_admins
        from apps.common.tenancy import use_tenant
        from apps.common.tenant_onboarding import ensure_tenant_defaults

        with transaction.atomic():
            tenant = Tenant.objects.select_for_update().get(pk=DEFAULT_TENANT_ID)
            tenant.name = company[:150]
            tenant.code = (slugify(company)[:40] or 'company')
            tenant.contact_email = email
            tenant.max_users = max(tenant.max_users or 1, 1)
            tenant.save()
            org = ensure_organization(tenant)
            org.name = company[:150]
            org.save(update_fields=['name', 'updated_at'])
            with use_tenant(tenant.pk):
                admin = User.objects.create_user(username=username, email=email or None, password=password,
                                                 role='SUPER_ADMIN', tenant=tenant, first_name=first, last_name=last,
                                                 phone=(data.get('admin_phone') or None))
                ensure_tenant_defaults(tenant, branch_name=branch, fresh=True)
                _apply_customer_names(company, branch_given, email)
            grant_default_org_admins(tenant, org)
        self.stdout.write(json.dumps({'ok': True, 'company': tenant.name, 'tenant_id': tenant.pk,
                                      'organization_id': org.pk, 'admin_username': admin.username}))
