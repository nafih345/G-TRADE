from django.urls import path
from .views import (CustomTokenObtainPairView, SessionTokenRefreshView, TwoFactorVerifyView, UserProfileView,
                    RegisterUserView, LogoutView)
from . import edit_permissions as ep
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
    # Direct Edit switches + admin-approved edit requests (apps/authentication/edit_permissions.py)
    path('edit-permissions/', ep.EditPermissionsView.as_view(), name='edit_permissions'),
    path('edit-permissions/<uuid:user_id>/', ep.EditPermissionsDetailView.as_view(), name='edit_permissions_detail'),
    path('edit-requests/', ep.EditRequestsView.as_view(), name='edit_requests'),
    path('edit-requests/access/', ep.EditAccessView.as_view(), name='edit_requests_access'),
    path('edit-requests/pending-count/', ep.EditPendingCountView.as_view(), name='edit_requests_pending_count'),
    path('edit-requests/<uuid:request_id>/approve/', ep.EditRequestApproveView.as_view(), name='edit_request_approve'),
    path('edit-requests/<uuid:request_id>/reject/', ep.EditRequestRejectView.as_view(), name='edit_request_reject'),
    path('edit-requests/<uuid:request_id>/cancel/', ep.EditRequestCancelView.as_view(), name='edit_request_cancel'),
]
