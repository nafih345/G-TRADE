"""Who is making the current request, for audit columns written deep inside services.

Stock movements are written by apps.inventory.stock_utils, several calls away from the view
that knows the user. BranchContextMiddleware sets the actor once per API request (from the
X-User-Name header the frontend attaches to every call — the same pragmatic identity the
branch context uses); views with a real authenticated user override it with set_actor().
Context-local, so concurrent requests on other threads / tasks never see each other's name.
"""
from contextvars import ContextVar

_actor = ContextVar('request_actor', default='')


def set_actor(name):
    """Set the actor for the rest of this request; returns a token for reset_actor."""
    return _actor.set((name or '').strip()[:150])


def reset_actor(token):
    try:
        _actor.reset(token)
    except (ValueError, RuntimeError):
        _actor.set('')


def get_actor():
    return _actor.get()


def actor_from_request(request):
    """Signed-in username, else the X-User-Name header, else ''."""
    user = getattr(request, 'user', None)
    if user is not None and getattr(user, 'is_authenticated', False):
        return getattr(user, 'username', '') or ''
    return (request.META.get('HTTP_X_USER_NAME') or '').strip()
