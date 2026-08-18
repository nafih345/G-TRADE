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
