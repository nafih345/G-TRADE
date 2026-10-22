from django.urls import path
from .views import (CustomTokenObtainPairView, SessionTokenRefreshView, TwoFactorVerifyView, UserProfileView,
                    RegisterUserView, LogoutView)

urlpatterns = [
    path('login/', CustomTokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('two-factor/verify/', TwoFactorVerifyView.as_view(), name='two_factor_verify'),
    path('token/refresh/', SessionTokenRefreshView.as_view(), name='token_refresh'),
    path('profile/', UserProfileView.as_view(), name='user_profile'),
    path('register/', RegisterUserView.as_view(), name='user_register'),
    path('logout/', LogoutView.as_view(), name='user_logout'),
]
