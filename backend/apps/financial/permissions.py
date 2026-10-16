from rest_framework import permissions

# Matches authentication.User.ROLE_CHOICES (superusers count as SUPER_ADMIN).
FINANCE_VIEW_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'ACCOUNTANT'}
# Account management, voucher posting, reversals, mappings, period closing, retries, backfill.
FINANCE_ADMIN_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'ACCOUNTANT'}
# May post outside the backdating window.
FINANCE_OVERRIDE_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR'}


def user_role(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return ''
    if getattr(user, 'is_superuser', False):
        return 'SUPER_ADMIN'
    return (getattr(user, 'role', '') or '').upper()


class FinancePermission(permissions.BasePermission):
    """Reads: finance viewers. Writes: accounting admins."""
    message = 'Sign in with a finance role (Super Admin, Administrator or Accountant; Managers may view).'

    def has_permission(self, request, view):
        role = user_role(request.user)
        if request.method in permissions.SAFE_METHODS:
            return role in FINANCE_VIEW_ROLES
        return role in FINANCE_ADMIN_ROLES
