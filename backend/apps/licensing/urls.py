from django.urls import path

from . import views

urlpatterns = [
    path('status/', views.StatusView.as_view()),
    path('activate/', views.ActivateView.as_view()),
    path('import/', views.ImportView.as_view()),
    path('checkin/', views.CheckinView.as_view()),
    path('request/', views.RequestView.as_view()),
    path('platform-owner/', views.PlatformOwnerView.as_view()),
]
