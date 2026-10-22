from django.urls import path

from . import views

security_urlpatterns = [
    path('settings/', views.SecuritySettingsView.as_view(), name='security-settings'),
    path('policy/', views.SecurityPolicyView.as_view(), name='security-policy'),
    path('session/heartbeat/', views.SessionHeartbeatView.as_view(), name='security-heartbeat'),
    path('reauth/', views.ReauthView.as_view(), name='security-reauth'),
    path('two-factor/', views.TwoFactorStatusView.as_view(), name='two-factor-status'),
    path('two-factor/setup/', views.TwoFactorSetupView.as_view(), name='two-factor-setup'),
    path('two-factor/confirm/', views.TwoFactorConfirmView.as_view(), name='two-factor-confirm'),
    path('two-factor/disable/', views.TwoFactorDisableView.as_view(), name='two-factor-disable'),
    path('audit-log/', views.SecurityAuditLogView.as_view(), name='security-audit-log'),
]

backup_urlpatterns = [
    path('health/', views.BackupHealthView.as_view(), name='backup-health'),
    path('history/', views.BackupHistoryView.as_view(), name='backup-history'),
    path('create/', views.BackupCreateView.as_view(), name='backup-create'),
    path('upload/', views.BackupUploadView.as_view(), name='backup-upload'),
    path('schedule/', views.BackupScheduleView.as_view(), name='backup-schedule'),
    path('restore/', views.RestoreStartView.as_view(), name='backup-restore'),
    path('restore/<uuid:pk>/', views.RestoreStatusView.as_view(), name='backup-restore-status'),
    path('<uuid:pk>/', views.BackupDetailView.as_view(), name='backup-detail'),
    path('<uuid:pk>/download-link/', views.BackupDownloadLinkView.as_view(), name='backup-download-link'),
    path('<uuid:pk>/download/', views.BackupDownloadView.as_view(), name='backup-download'),
]
