from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError


class LenientJWTAuthentication(JWTAuthentication):
    """
    JWTAuthentication that treats a malformed/expired token as "no credentials supplied"
    instead of raising a hard 401.

    The frontend's demo/offline login mode (see AuthContext.jsx) issues a fake
    "mock_jwt_token_..." string and attaches it as a Bearer token on every request via
    axios.defaults.headers.common. Plain JWTAuthentication rejects that with 401 during
    authenticate() — which runs before permission_classes is even consulted — so every
    AllowAny endpoint in the app was unreachable for any user who logged in normally, not
    just ones actually requiring auth. Falling through to AnonymousUser here restores the
    intended behavior: AllowAny endpoints work regardless of the bogus header, while
    IsAuthenticated endpoints still correctly reject it (AnonymousUser fails that check).
    """

    def authenticate(self, request):
        try:
            return super().authenticate(request)
        except (InvalidToken, TokenError):
            return None

    def get_user(self, validated_token):
        # One user-table round trip per request otherwise — held briefly in-process (see
        # apps.common.hot_cache; saving the user clears it, so a deactivation applies at once in
        # this worker and within HOT_CACHE_SECONDS in the others). A refusal raises and is never
        # cached. Token revocation compares each token against the user row, so it is left
        # uncached when enabled.
        from apps.common import hot_cache
        from rest_framework_simplejwt.settings import api_settings

        user_id = validated_token.get(api_settings.USER_ID_CLAIM)
        if user_id is None or api_settings.CHECK_REVOKE_TOKEN:
            return super().get_user(validated_token)
        return hot_cache.get_or_load(f'auth:user:{user_id}',
                                     lambda: super(LenientJWTAuthentication, self).get_user(validated_token))
