from django.apps import AppConfig


class VendorLicensingConfig(AppConfig):
    """Vendor licence authority: plans, client licences, signed keys, online activation.
    Cloud console only (config.settings). config.settings_local removes it and the Windows build
    leaves the folder out, so a customer installation can never issue a licence."""
    name = 'apps.vendor_licensing'
    label = 'vendor_licensing'
    verbose_name = 'Vendor licensing'
    default_auto_field = 'django.db.models.BigAutoField'
