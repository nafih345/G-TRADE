"""Branch authorization for financial reports (P1 / N1) and journals (P1 / N3).

Every request goes through the real stack — /api/auth/login/ → signed JWT → TenantContextMiddleware
→ BranchContextMiddleware → DRF — with TENANCY_ANONYMOUS_TENANT_ID off, as in production. Branch
identity therefore comes from the token, never from X-User-* headers.

Fixture (tenant "Client A", Multi-Branch ON):
    HO     branch: RV  Dr Cash 100  / Cr Retail Sales 100
    North  branch: RV  Dr Cash 30   / Cr Retail Sales 30
    (none)       : JV  Dr Cash 1000 / Cr Opening Equity 1000   (head-office opening, no branch)
Tenant "Client B" holds one RV of 7777 that Client A must never see.

Users: clienta (Super Admin, every branch) · nina (Accountant, North only) ·
nora (Accountant, North only, Direct Edit for Accounts switched OFF).
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.tenant_onboarding import onboard_tenant
from apps.financial.models import ChartOfAccount, JournalEntry
from apps.financial.services import create_journal

PW = 'Str0ng-pass-123'
D = Decimal
F = '/api/financial/'

ALL, NORTH, HO = D('1130.00'), D('30.00'), D('100.00')


def rows(data):
    if isinstance(data, dict):
        for key in ('results', 'rows'):
            if key in data:
                return data[key]
    return data


def _cash_row(data, key):
    return next((D(r[key]) for r in rows(data) if r['code'] == '1001'), D('0'))


# (name, url builder, params, figure) — the figure is what each report says about Cash (or, for
# income-only / register reports, about the total), so one number per branch scope:
# every branch = 1130, North = 30, HO = 100.
REPORTS = (
    ('trial_balance', lambda t: F + 'reports/trial-balance/', {}, lambda d: _cash_row(d, 'total_debit')),
    ('balance_sheet', lambda t: F + 'reports/balance-sheet/', {}, lambda d: D(d['total_assets'])),
    ('general_ledger', lambda t: F + 'reports/general-ledger/', 'account', lambda d: D(d['closing_balance'])),
    ('ledger_register', lambda t: F + 'reports/ledger-register/', {}, lambda d: D(d['total_amount'])),
    ('account_balances', lambda t: F + 'reports/account-balances/', {}, lambda d: _cash_row(d, 'balance')),
    ('account_ledger', lambda t: f"{F}accounts/{t.cash_id}/ledger/", {}, lambda d: D(d['closing_balance'])),
    ('coa_with_balances', lambda t: F + 'accounts/', {'with_balances': '1'}, lambda d: _cash_row(d, 'ledger_balance')),
    ('ledger_lines', lambda t: F + 'ledger/', {},
     lambda d: sum((D(r['debit']) for r in rows(d)), D('0'))),
    ('source_breakdown', lambda t: F + 'reports/source-breakdown/', {},
     lambda d: sum((D(r['posted_amount']) for r in d), D('0'))),
)
# Profit & Loss carries no Cash line: income is 100 (HO) + 30 (North); the opening has none.
PL = ('profit_loss', lambda t: F + 'reports/profit-loss/', {}, lambda d: D(d['total_income']))
PL_ALL, PL_NORTH = D('130.00'), D('30.00')


@override_settings(TENANCY_ANONYMOUS_TENANT_ID=None)
class BranchAuthorizationFixture(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.ta, _ = onboard_tenant(name='Client A', admin_username='clienta', password=PW)
        self.tb, _ = onboard_tenant(name='Client B', admin_username='clientb', password=PW)
        User.objects.create_user('nina', password=PW, role='ACCOUNTANT', tenant=self.ta)
        User.objects.create_user('nora', password=PW, role='ACCOUNTANT', tenant=self.ta, can_edit_accounts=False)

        from apps.company.models import Branch, BusinessSettings, UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            self.ho = Branch.objects.get(is_default=True)
            self.north = Branch.objects.create(company=self.ho.company, name='North', code='NTH', is_active=True)
            settings_obj = BusinessSettings.load()
            settings_obj.multi_branch_enabled = True
            settings_obj.save()
            for name in ('nina', 'nora'):
                access = UserBranchAccess.objects.create(username=name, default_branch=self.north)
                access.branches.set([self.north])
            cash, sales, equity = (ChartOfAccount.objects.get(code=c) for c in ('1001', '4001', '3001'))
            self.cash_id = str(cash.pk)
            self.j_ho = self._voucher(cash, sales, '100', self.ho, 'HO receipt')
            self.j_north = self._voucher(cash, sales, '30', self.north, 'North receipt')
            self.j_none = create_journal(lines=[{'account': cash, 'debit': D('1000')}, {'account': equity, 'credit': D('1000')}],
                                         date=self._date(), voucher_type_code='JV', narration='HO opening',
                                         source_module='financial', source_event='voucher', branch=None)
        with tenancy.use_tenant(self.tb.pk):
            b_cash, b_sales = (ChartOfAccount.objects.get(code=c) for c in ('1001', '4001'))
            self.tb_branch = Branch.objects.get(is_default=True)
            self.j_b = self._voucher(b_cash, b_sales, '7777', self.tb_branch, 'Client B receipt')

        self.admin = self.login('clienta')
        self.nina = self.login('nina')
        self.nora = self.login('nora')
        self.b_admin = self.login('clientb')

    # ---- helpers ------------------------------------------------------------------------------

    @staticmethod
    def _date():
        import datetime
        return datetime.date(2026, 1, 10)

    def _voucher(self, dr, cr, amount, branch, narration, status='POSTED'):
        return create_journal(lines=[{'account': dr, 'debit': D(amount)}, {'account': cr, 'credit': D(amount)}],
                              date=self._date(), voucher_type_code='RV', narration=narration, status=status,
                              source_module='financial', source_event='voucher', branch=branch)

    def login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PW}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        # Reversals / corrections may be "sensitive" under the security policy; confirm up front so a
        # re-auth prompt can never stand in for the branch refusal these tests are about.
        client.post('/api/security/reauth/', {'password': PW}, format='json')
        return client

    def figure(self, client, report, branch=None, expect=200):
        name, url, params, extract = report
        params = {'account': self.cash_id} if params == 'account' else dict(params)
        if branch is not None:
            params['branch'] = branch
        res = client.get(url(self), params)
        self.assertEqual(res.status_code, expect, f"{name}: {res.status_code} {getattr(res, 'data', res.content)}")
        return extract(res.data) if expect == 200 else None

    def journal(self, pk):
        with tenancy.use_tenant(self.ta.pk):
            return JournalEntry.all_objects.get(pk=pk)

    def reversals_of(self, entry):
        with tenancy.use_tenant(self.ta.pk):
            return JournalEntry.objects.filter(reversed_entry=entry).count()


# ---------------------------------------------------------------------------------------------
# N1 — financial reports
# ---------------------------------------------------------------------------------------------

class ReportBranchScopeTests(BranchAuthorizationFixture):
    def test_unrestricted_user_sees_every_branch_and_can_pick_one(self):
        for report in REPORTS:
            with self.subTest(report=report[0]):
                self.assertEqual(self.figure(self.admin, report), ALL)
                self.assertEqual(self.figure(self.admin, report, 'all'), ALL)
                self.assertEqual(self.figure(self.admin, report, str(self.north.pk)), NORTH)
                self.assertEqual(self.figure(self.admin, report, str(self.ho.pk)), HO)
        self.assertEqual(self.figure(self.admin, PL), PL_ALL)

    def test_missing_branch_parameter_is_limited_to_permitted_branches(self):
        for report in REPORTS:
            with self.subTest(report=report[0]):
                self.assertEqual(self.figure(self.nina, report), NORTH)
        self.assertEqual(self.figure(self.nina, PL), PL_NORTH)

    def test_all_and_own_branch_return_only_permitted_data(self):
        for report in REPORTS + (PL,):
            with self.subTest(report=report[0]):
                expected = PL_NORTH if report is PL else NORTH
                self.assertEqual(self.figure(self.nina, report, 'all'), expected)
                self.assertEqual(self.figure(self.nina, report, str(self.north.pk)), expected)

    def test_unauthorized_branch_is_rejected(self):
        for report in REPORTS + (PL,):
            with self.subTest(report=report[0]):
                self.figure(self.nina, report, str(self.ho.pk), expect=403)

    def test_unknown_or_foreign_branch_is_rejected_not_ignored(self):
        foreign = str(self.tb_branch.pk)  # a real branch, but Client B's
        for report in REPORTS + (PL,):
            with self.subTest(report=report[0]):
                for client in (self.admin, self.nina):
                    self.figure(client, report, foreign, expect=400)
                    self.figure(client, report, 'not-a-branch', expect=400)

    def test_report_labels_its_branch_scope(self):
        data = self.nina.get(F + 'reports/trial-balance/').data
        self.assertEqual(data['branch'], {'id': 'all', 'label': 'All permitted branches'})
        data = self.admin.get(F + 'reports/trial-balance/', {'branch': str(self.north.pk)}).data
        self.assertEqual(data['branch'], {'id': str(self.north.pk), 'label': 'North'})

    def test_restricted_user_with_no_branches_sees_nothing(self):
        from apps.company.models import UserBranchAccess
        with tenancy.use_tenant(self.ta.pk):
            UserBranchAccess.objects.get(username='nina').branches.clear()
        for report in REPORTS:
            with self.subTest(report=report[0]):
                self.assertEqual(self.figure(self.nina, report), D('0'))

    def test_company_wide_integration_monitoring_needs_every_branch(self):
        for url in ('integration/status/', 'integration/reconciliation/'):
            with self.subTest(url=url):
                self.assertEqual(self.nina.get(F + url).status_code, 403)
                self.assertEqual(self.admin.get(F + url).status_code, 200)

    def test_single_branch_mode_is_unchanged(self):
        """Multi-Branch OFF: no branch restriction applies (today's behaviour), and an explicit
        ?branch= still filters as before."""
        from apps.company.models import BusinessSettings
        with tenancy.use_tenant(self.ta.pk):
            settings_obj = BusinessSettings.load()
            settings_obj.multi_branch_enabled = False
            settings_obj.save()
        for report in REPORTS:
            with self.subTest(report=report[0]):
                self.assertEqual(self.figure(self.nina, report), ALL)
                self.assertEqual(self.figure(self.admin, report, str(self.north.pk)), NORTH)


# ---------------------------------------------------------------------------------------------
# N3 — journals
# ---------------------------------------------------------------------------------------------

class JournalBranchScopeTests(BranchAuthorizationFixture):
    def ids(self, client, **params):
        res = client.get(F + 'journals/', params)
        self.assertEqual(res.status_code, 200, res.data)
        return {r['id'] for r in rows(res.data)}

    def test_journal_list_is_branch_restricted(self):
        self.assertEqual(self.ids(self.admin), {str(self.j_ho.pk), str(self.j_north.pk), str(self.j_none.pk)})
        self.assertEqual(self.ids(self.nina), {str(self.j_north.pk)})
        self.assertEqual(self.ids(self.nina, branch='all'), {str(self.j_north.pk)})
        self.assertEqual(self.ids(self.admin, branch=str(self.north.pk)), {str(self.j_north.pk)})
        self.assertEqual(self.nina.get(F + 'journals/', {'branch': str(self.ho.pk)}).status_code, 403)
        self.assertEqual(self.nina.get(F + 'journals/', {'branch': 'not-a-branch'}).status_code, 400)

    def test_journal_detail_is_branch_restricted(self):
        self.assertEqual(self.nina.get(f"{F}journals/{self.j_north.pk}/").status_code, 200)
        for entry in (self.j_ho, self.j_none):
            with self.subTest(entry=entry.narration):
                self.assertEqual(self.nina.get(f"{F}journals/{entry.pk}/").status_code, 404)
                self.assertEqual(self.nina.get(f"{F}journals/{entry.pk}/correction/").status_code, 404)
        self.assertEqual(self.admin.get(f"{F}journals/{self.j_ho.pk}/").status_code, 200)

    def test_unauthorized_reversal_is_rejected_and_changes_nothing(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(f"{F}journals/{self.j_ho.pk}/reverse/", {'reason': 'try'}, format='json')
        self.assertEqual(res.status_code, 404, res.data)
        self.assertEqual(self.journal(self.j_ho.pk).status, 'POSTED')
        self.assertEqual(self.reversals_of(self.j_ho), 0)

    def test_authorized_reversal_still_works(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(f"{F}journals/{self.j_north.pk}/reverse/", {'reason': 'typo'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(self.journal(self.j_north.pk).status, 'REVERSED')
        with self.captureOnCommitCallbacks(execute=True):
            res = self.admin.post(f"{F}journals/{self.j_ho.pk}/reverse/", {'reason': 'admin'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)

    def test_unauthorized_correction_is_rejected_and_changes_nothing(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(f"{F}journals/{self.j_ho.pk}/correct/",
                                 {'mode': 'text', 'narration': 'hijacked'}, format='json')
        self.assertEqual(res.status_code, 404, res.data)
        self.assertEqual(self.journal(self.j_ho.pk).narration, 'HO receipt')

    def _correction_payload(self, **extra):
        return {'mode': 'voucher', 'reason': 'wrong amount', 'voucher_type_code': 'RV', 'date': '2026-01-10',
                'narration': 'North receipt (corrected)', 'status': 'POSTED',
                'lines': [{'account': self.cash_id, 'debit': '35'},
                          {'account': '4001', 'credit': '35'}], **extra}

    def test_correction_cannot_move_a_voucher_into_another_branch(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(f"{F}journals/{self.j_north.pk}/correct/",
                                 self._correction_payload(branch=str(self.ho.pk)), format='json')
        self.assertEqual(res.status_code, 403, res.data)
        self.assertEqual(self.journal(self.j_north.pk).status, 'POSTED')
        self.assertEqual(self.reversals_of(self.j_north), 0)

    def test_authorized_correction_keeps_its_branch(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.nina.post(f"{F}journals/{self.j_north.pk}/correct/", self._correction_payload(), format='json')
        self.assertEqual(res.status_code, 200, res.data)
        corrected = self.journal(res.data['corrected']['id'])
        self.assertEqual(corrected.branch_id, self.north.pk)
        self.assertEqual(self.journal(self.j_north.pk).status, 'REVERSED')

    def test_draft_actions_on_another_branch_are_rejected(self):
        with tenancy.use_tenant(self.ta.pk):
            cash, sales = (ChartOfAccount.objects.get(code=c) for c in ('1001', '4001'))
            draft = self._voucher(cash, sales, '5', self.ho, 'HO draft', status='DRAFT')
        body = {'voucher_type_code': 'RV', 'date': '2026-01-10', 'status': 'DRAFT', 'narration': 'hijacked',
                'lines': [{'account': self.cash_id, 'debit': '9'}, {'account': '4001', 'credit': '9'}]}
        self.assertEqual(self.nina.post(f"{F}journals/{draft.pk}/post/").status_code, 404)
        self.assertEqual(self.nina.put(f"{F}journals/{draft.pk}/", body, format='json').status_code, 404)
        self.assertEqual(self.nina.delete(f"{F}journals/{draft.pk}/").status_code, 404)
        fresh = self.journal(draft.pk)
        self.assertEqual((fresh.status, fresh.narration, fresh.is_deleted), ('DRAFT', 'HO draft', False))

    def test_edit_approval_does_not_reveal_another_branchs_journal(self):
        """A user whose Direct Edit is OFF used to get the approval prompt (naming the entry) for any
        journal id; another branch's journal must look the same as one that does not exist."""
        res = self.nora.post(f"{F}journals/{self.j_ho.pk}/reverse/", {'reason': 'x'}, format='json')
        self.assertEqual(res.status_code, 404, res.data)
        self.assertNotIn(self.j_ho.entry_number, str(res.data))
        # Her own branch's journal still goes through the approval workflow as before.
        res = self.nora.post(f"{F}journals/{self.j_north.pk}/reverse/", {'reason': 'x'}, format='json')
        self.assertEqual(res.status_code, 403, res.data)


# ---------------------------------------------------------------------------------------------
# Tenant isolation is intact
# ---------------------------------------------------------------------------------------------

class TenantIsolationTests(BranchAuthorizationFixture):
    def test_other_tenant_cannot_see_or_act_on_journals(self):
        self.assertNotIn(str(self.j_ho.pk), {r['id'] for r in rows(self.b_admin.get(F + 'journals/').data)})
        self.assertEqual(self.b_admin.get(f"{F}journals/{self.j_ho.pk}/").status_code, 404)
        res = self.b_admin.post(f"{F}journals/{self.j_ho.pk}/reverse/", {'reason': 'x'}, format='json')
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.journal(self.j_ho.pk).status, 'POSTED')
        self.assertEqual(self.admin.get(f"{F}journals/{self.j_b.pk}/").status_code, 404)

    def test_reports_never_mix_tenants(self):
        for report in REPORTS:
            with self.subTest(report=report[0]):
                self.assertEqual(self.figure(self.admin, report), ALL)  # no 7777 from Client B
        tb = self.b_admin.get(F + 'reports/trial-balance/').data
        self.assertEqual(_cash_row(tb, 'total_debit'), D('7777.00'))
        # Client A's cash account id means nothing inside Client B.
        self.assertEqual(self.b_admin.get(F + 'reports/general-ledger/', {'account': self.cash_id}).status_code, 404)

    def test_tenant_rows_stay_stamped(self):
        with tenancy.unscoped():
            self.assertEqual(JournalEntry.all_objects.get(pk=self.j_ho.pk).tenant_id, self.ta.pk)
            self.assertEqual(JournalEntry.all_objects.get(pk=self.j_b.pk).tenant_id, self.tb.pk)
            self.assertEqual(Tenant.objects.filter(pk__in=(self.ta.pk, self.tb.pk)).count(), 2)
