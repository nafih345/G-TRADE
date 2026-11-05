"""GET /api/sales/dashboard-summary/ — the Dashboard's numbers, computed in the database.

The Dashboard used to download every invoice, eye examination, product and purchase order
(all pages, full serializers) to count a handful of KPIs in the browser: several megabytes and
dozens of cross-region queries on every visit, growing with the business. This answers the same
cards with a fixed number of aggregate queries, scoped like the lists themselves (tenant by the
ORM, branch by BranchScopedViewSetMixin).

?date=YYYY-MM-DD is the browser's "today" (the server runs in UTC; a shop in IST would otherwise
see yesterday's numbers until 05:30).
"""
import datetime
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.db.models.functions import TruncMonth
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from apps.common.branch_mixins import BranchScopedViewSetMixin

READY_STATUSES = ('Ready', 'Ready for Pickup', 'Ready for Delivery', 'Ready for Collection')
LOW_STOCK_THRESHOLD = 5


def _scoped(request, qs):
    """`qs` limited by the same branch rules the list viewsets apply (403 for an off-limits branch)."""
    class Base:
        def get_queryset(self_inner):
            return qs

    class Scoper(BranchScopedViewSetMixin, Base):
        def __init__(self):
            self.request = request

    return Scoper().get_queryset()


def _money(value):
    return str((value or Decimal('0')).quantize(Decimal('0.01')))


def _month_starts(today, count=6):
    first = today.replace(day=1)
    months = []
    for _ in range(count):
        months.append(first)
        first = (first - datetime.timedelta(days=1)).replace(day=1)
    return list(reversed(months))


class DashboardSummaryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from apps.products.models import Product
        from apps.purchasing.models import PurchaseInvoice
        from apps.sales.models import Appointment, EyeExamination, Invoice

        try:
            today = datetime.date.fromisoformat(request.query_params.get('date') or '')
        except ValueError:
            today = datetime.date.today()

        invoices = _scoped(request, Invoice.objects.filter(document_type='INVOICE').exclude(status='CANCELLED'))
        today_sales = invoices.filter(invoice_date=today).aggregate(count=Count('id'), revenue=Sum('net_amount'))
        ready = _scoped(request, Invoice.objects.exclude(status='CANCELLED')) \
            .filter(fulfillment_status__in=READY_STATUSES).count()

        exams = _scoped(request, EyeExamination.objects.all())
        today_exams = exams.filter(examination_date__date=today).count()
        appointments = _scoped(request, Appointment.objects.filter(appointment_date=today)) \
            .exclude(status__iexact='Cancelled').count()

        low = Product.objects.filter(is_active=True, stock__lt=LOW_STOCK_THRESHOLD)
        low_first = low.order_by('stock', 'name').values('id', 'name', 'stock').first()

        months = _month_starts(today)
        start = months[0]
        sales_by_month = dict(invoices.filter(invoice_date__gte=start, invoice_date__lte=today)
                              .annotate(m=TruncMonth('invoice_date')).values('m')
                              .annotate(total=Sum('net_amount')).values_list('m', 'total'))
        purchases = _scoped(request, PurchaseInvoice.objects.exclude(status__in=('DRAFT', 'CANCELLED')))
        purchases_by_month = dict(purchases.filter(purchase_date__gte=start, purchase_date__lte=today)
                                  .annotate(m=TruncMonth('purchase_date')).values('m')
                                  .annotate(total=Sum('grand_total')).values_list('m', 'total'))

        def month_value(table, month):
            for key, total in table.items():
                key_date = key.date() if isinstance(key, datetime.datetime) else key
                if key_date == month:
                    return float(total or 0)
            return 0.0

        recent_invoices = list(invoices.order_by('-invoice_date', '-created_at')
                               .values('id', 'invoice_number', 'customer_name', 'net_amount', 'invoice_date')[:5])
        recent_exams = list(exams.order_by('-examination_date', '-created_at')
                            .values('id', 'patient_name', 'optometrist', 'sub_sph_od', 'ar_sph_od',
                                    'examination_date')[:5])

        return Response({
            'date': today.isoformat(),
            'today': {
                'sales_count': today_sales['count'] or 0,
                'revenue': _money(today_sales['revenue']),
                'eye_tests': today_exams,
                'appointments': appointments,
            },
            'ready_for_pickup': ready,
            'low_stock': {'threshold': LOW_STOCK_THRESHOLD, 'count': low.count(), 'first': low_first},
            'monthly': [{'month': m.isoformat(), 'label': m.strftime('%b'),
                         'sales': round(month_value(sales_by_month, m)),
                         'purchases': round(month_value(purchases_by_month, m))} for m in months],
            'recent_invoices': [{**r, 'net_amount': _money(r['net_amount'])} for r in recent_invoices],
            'recent_eye_tests': [{
                'id': r['id'], 'patient_name': r['patient_name'], 'optometrist': r['optometrist'],
                'sph_od': r['sub_sph_od'] or r['ar_sph_od'] or '', 'examination_date': r['examination_date'],
            } for r in recent_exams],
        })
