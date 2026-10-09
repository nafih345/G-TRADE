from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend
from django.db.models import Q


class UsernameOrEmailBackend(ModelBackend):
    """Sign in with the username *or* the email address, case-insensitively.

    The login form says "Username or email", but Django's ModelBackend only matches the
    exact, case-sensitive username — so "Nafih" or "nafihnafp@gmail.com" were rejected as
    invalid credentials for the account `nafih`.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        User = get_user_model()
        if username is None:
            username = kwargs.get(User.USERNAME_FIELD)
        if not username or password is None:
            return None
        username = username.strip()
        candidates = User.objects.filter(Q(username__iexact=username) | Q(email__iexact=username))
        # An exact username match wins over a case-insensitive / email match.
        for user in sorted(candidates, key=lambda u: u.username != username):
            if user.check_password(password) and self.user_can_authenticate(user):
                return user
        # Same timing as a real check when nobody matched (ModelBackend does this too).
        if not candidates:
            User().set_password(password)
        return None
