from django.db import models


class LicenseState(models.Model):
    """The installation's licence and its trust state (one row, pk=1). Global: not tenant-owned,
    because the licence covers the whole installation (all companies of its organization).

    Limits are NEVER read from here: they are re-read from the signed licence on every check. These
    columns only remember facts the signature cannot carry (when we last saw the clock, when the
    vendor revoked it, when the evaluation started)."""
    license_blob = models.TextField(blank=True, default='')
    lic_id = models.CharField(max_length=64, blank=True, default='')
    # Vendor client this installation is licensed to (set by the first vendor licence; a licence
    # for another client is refused) and the installed licence revision.
    client_id = models.CharField(max_length=40, blank=True, default='')
    lic_rev = models.PositiveIntegerField(default=0)
    activation_id = models.CharField(max_length=64, blank=True, default='')
    installed_at = models.DateTimeField(auto_now_add=True)
    activated_at = models.DateTimeField(null=True, blank=True)
    # Highest wall-clock time ever observed: a clock set back cannot extend expiry or grace.
    last_seen_utc = models.DateTimeField(null=True, blank=True)
    # Replay guard: an older licence (issued before this) is refused after a newer one was seen.
    max_issued_at = models.DateTimeField(null=True, blank=True)
    last_checkin_at = models.DateTimeField(null=True, blank=True)
    last_checkin_error = models.CharField(max_length=300, blank=True, default='')
    revoked_at = models.DateTimeField(null=True, blank=True)
    revocation_reason = models.CharField(max_length=200, blank=True, default='')
    crl_issued_at = models.DateTimeField(null=True, blank=True)
    fp_mismatch_since = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'licence state'

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class LicenseEvent(models.Model):
    """Audit trail: activation, import, renewal, check-in, revocation, limit refusals."""
    at = models.DateTimeField(auto_now_add=True)
    event = models.CharField(max_length=40)
    actor = models.CharField(max_length=150, blank=True, default='')
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ['-at']
