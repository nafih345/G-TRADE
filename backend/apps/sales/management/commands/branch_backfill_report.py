"""P1 Tasks 5 + 6 — report (default) or apply the evidence-only branch backfills, map leftover
exam/appointment branch texts by hand, and (opt-in) tag historic wholesale journals.

    manage.py branch_backfill_report                       # dry run, every tenant
    manage.py branch_backfill_report --apply               # same rules as migrations 0038/0039
    manage.py branch_backfill_report --tenant 3 --map-exam "City Clinic=<branch uuid>" [--apply]
    manage.py branch_backfill_report --wholesale-journals [--apply]

--wholesale-journals: a wholesale invoice / collection / return journal with no branch gets its
source document's branch, when that document has one. One FinancialAuditLog row per journal.
Nothing else on the journal changes; journals that already have a branch are never touched.
"""
from django.apps import apps as django_apps
from django.core.management.base import BaseCommand, CommandError

from apps.common import tenancy
from apps.sales.branch_backfill import _norm, backfill_exam_tenant, backfill_wholesale_tenant, tenant_ids

JOURNAL_SOURCES = {'wholesale_invoice': 'WholesaleInvoice', 'wholesale_collection': 'WholesalePaymentCollection',
                   'wholesale_return': 'WholesaleReturn'}


class Command(BaseCommand):
    help = 'Report or apply the P1 branch backfills (wholesale documents, eye exams, appointments).'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--tenant', type=int)
        parser.add_argument('--map-exam', action='append', default=[], metavar='TEXT=BRANCH_ID')
        parser.add_argument('--wholesale-journals', action='store_true')

    def handle(self, *args, **opts):
        apply = opts['apply']
        tenants = [opts['tenant']] if opts.get('tenant') else tenant_ids(django_apps.get_model)
        if opts['map_exam'] and not opts.get('tenant'):
            raise CommandError('--map-exam needs --tenant.')
        mode = 'APPLIED' if apply else 'DRY RUN'
        for tid in tenants:
            with tenancy.use_tenant(tid):
                if opts['map_exam']:
                    self._map_exams(tid, opts['map_exam'], apply)
                    continue
                if opts['wholesale_journals']:
                    self._journals(tid, apply)
                    continue
                w = backfill_wholesale_tenant(django_apps.get_model, tid, apply=apply)
                e = backfill_exam_tenant(django_apps.get_model, tid, apply=apply)
            self.stdout.write(f'{mode} tenant {tid}')
            for model, counts in w.items():
                total = self._count(model, tid)
                self.stdout.write(f'  {model}: total={total} ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())))
            for model, s in e.items():
                texts = ', '.join(f'"{t}"x{n}' for t, n in s['unmatched_texts'].most_common(20))
                self.stdout.write(f'  {model}: total={self._count(model, tid)} matched={s["matched"]} '
                                  f'unassigned={s["unassigned"]} blank_text={s["blank"]}'
                                  + (f'  unmatched: {texts}' if texts else ''))

    def _count(self, model, tid):
        return django_apps.get_model('sales', model)._base_manager.filter(tenant_id=tid).count()

    def _map_exams(self, tid, mappings, apply):
        Branch = django_apps.get_model('company', 'Branch')
        for item in mappings:
            text, _, branch_id = item.partition('=')
            branch = Branch._base_manager.filter(tenant_id=tid, pk=branch_id.strip()).first() if branch_id else None
            if branch is None:
                raise CommandError(f'"{branch_id}" is not a branch of tenant {tid}.')
            key = _norm(text)
            for name in ('EyeExamination', 'Appointment'):
                model = django_apps.get_model('sales', name)
                ids = [pk for pk, t in model._base_manager.filter(tenant_id=tid, branch_ref__isnull=True)
                       .values_list('pk', 'branch') if _norm(t) == key]
                if apply and ids:
                    model._base_manager.filter(pk__in=ids, branch_ref__isnull=True).update(branch_ref=branch)
                self.stdout.write(f'  {"mapped" if apply else "would map"} {len(ids)} {name} "{text}" -> {branch.name}')

    def _journals(self, tid, apply):
        from apps.financial.models import JournalEntry
        from apps.financial.services import audit
        changed = 0
        for event, model_name in JOURNAL_SOURCES.items():
            model = django_apps.get_model('sales', model_name)
            journals = JournalEntry.all_objects.filter(source_module='sales', source_event=event, branch__isnull=True,
                                                       reference_id__isnull=False)
            doc_branch = dict(model._base_manager.filter(tenant_id=tid, branch__isnull=False,
                                                         pk__in=journals.values('reference_id'))
                              .values_list('pk', 'branch_id'))
            for j in journals.filter(reference_id__in=list(doc_branch)):
                b = doc_branch[j.reference_id]
                changed += 1
                if apply:
                    JournalEntry.all_objects.filter(pk=j.pk, branch__isnull=True).update(branch_id=b)
                    audit('JOURNAL_BRANCH_BACKFILLED', 'journal_entry', j.pk,
                          f'{j.entry_number}: branch set from {model_name} (P1 Task 5)',
                          before={'branch': None}, after={'branch': str(b)})
        self.stdout.write(f'  tenant {tid}: {"tagged" if apply else "would tag"} {changed} wholesale journal(s)')
