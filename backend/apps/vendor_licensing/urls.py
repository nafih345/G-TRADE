from django.urls import path

from . import views

urlpatterns = [
    path('catalog/', views.CatalogView.as_view()),
    path('plans/', views.PlanListView.as_view()),
    path('plans/<uuid:pk>/', views.PlanDetailView.as_view()),
    path('plans/<uuid:pk>/activate/', views.PlanStateView.as_view(active=True)),
    path('plans/<uuid:pk>/deactivate/', views.PlanStateView.as_view(active=False)),
    path('preview/', views.PreviewView.as_view()),
    path('clients/', views.ClientListView.as_view()),
    path('clients/overview/', views.ClientOverviewView.as_view()),
    path('clients/<uuid:pk>/', views.ClientDetailView.as_view()),
    path('licences/', views.LicenceListView.as_view()),
    path('licences/<uuid:pk>/', views.LicenceDetailView.as_view()),
    path('licences/<uuid:pk>/key/', views.LicenceKeyView.as_view()),
    path('licences/<uuid:pk>/renew/', views.RenewView.as_view()),
    path('licences/<uuid:pk>/change-plan/', views.ChangePlanView.as_view()),
    path('licences/<uuid:pk>/suspend/', views.SuspendView.as_view()),
    path('licences/<uuid:pk>/reactivate/', views.ReactivateView.as_view()),
    path('licences/<uuid:pk>/revoke/', views.RevokeView.as_view()),
    path('licences/<uuid:pk>/replace-key/', views.ReplaceKeyView.as_view()),
    path('licences/<uuid:pk>/bind/', views.BindInstallationView.as_view()),
    path('licences/<uuid:pk>/record-activation/', views.RecordActivationView.as_view()),
    path('licences/<uuid:pk>/change-start/', views.ChangeStartView.as_view()),
    path('tenants/<int:tenant_id>/subscriptions/', views.TenantSubscriptionsView.as_view()),
    path('audit/', views.AuditView.as_view()),
]
