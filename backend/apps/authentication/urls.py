from django.urls import path
from .views import (CustomTokenObtainPairView, SessionTokenRefreshView, TwoFactorVerifyView, UserProfileView,
                    RegisterUserView, LogoutView)
from .user_admin import StaffUserDetailView, StaffUserPasswordView, StaffUsersView

urlpatterns = [
    path('login/', CustomTokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('two-factor/verify/', TwoFactorVerifyView.as_view(), name='two_factor_verify'),
    path('token/refresh/', SessionTokenRefreshView.as_view(), name='token_refresh'),
    path('profile/', UserProfileView.as_view(), name='user_profile'),
    path('register/', RegisterUserView.as_view(), name='user_register'),
    path('logout/', LogoutView.as_view(), name='user_logout'),
    # Administration → Users (admin staff of the business)
    path('users/', StaffUsersView.as_view(), name='staff_users'),
    path('users/<uuid:user_id>/', StaffUserDetailView.as_view(), name='staff_user_detail'),
    path('users/<uuid:user_id>/reset-password/', StaffUserPasswordView.as_view(), name='staff_user_password'),
]
