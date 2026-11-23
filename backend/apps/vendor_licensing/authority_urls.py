from django.urls import path

from . import authority_views as v

urlpatterns = [
    path('v1/activate', v.ActivateView.as_view()),
    path('v1/checkin', v.CheckinView.as_view()),
    path('v1/deactivate', v.DeactivateView.as_view()),
    path('v1/crl', v.CrlView.as_view()),
    path('v1/health', v.HealthView.as_view()),
]
