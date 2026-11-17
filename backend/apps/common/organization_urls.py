from django.urls import path

from . import organization_views as v

urlpatterns = [
    path('', v.OrganizationView.as_view(), name='organization'),
    path('companies/', v.CompaniesAdminView.as_view(), name='organization_companies'),
    path('companies/<int:tenant_id>/', v.CompanyAdminView.as_view(), name='organization_company'),
    path('companies/<int:tenant_id>/members/', v.CompanyMembersView.as_view(), name='organization_members'),
    path('companies/<int:tenant_id>/branches/', v.CompanyBranchesView.as_view(), name='organization_branches'),
    path('companies/<int:tenant_id>/copy-masters/', v.CopyMastersView.as_view(), name='organization_copy_masters'),
    path('users/', v.OrganizationUsersView.as_view(), name='organization_users'),
    path('reports/sales-summary/', v.SalesSummaryView.as_view(), name='organization_sales_summary'),
    path('reports/stock-summary/', v.StockSummaryView.as_view(), name='organization_stock_summary'),
]
