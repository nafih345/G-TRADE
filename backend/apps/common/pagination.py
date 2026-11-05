from rest_framework.pagination import PageNumberPagination


class PageSizePagination(PageNumberPagination):
    """The site default (settings PAGE_SIZE = 20) unless the client asks for more with
    ?page_size= (up to 1000).

    Plain PageNumberPagination ignores ?page_size=, so screens that read a whole list
    (utils/fetchAllPages.js asks for 500 a page) were walking it 20 rows per request, one
    request after another — each a few hundred milliseconds on the hosted stack."""
    page_size_query_param = 'page_size'
    max_page_size = 1000

    def paginate_queryset(self, queryset, request, view=None):
        return super().paginate_queryset(stable_order(queryset), request, view)


def stable_order(queryset):
    """A queryset the database returns in the same order on every page request.

    Without ORDER BY, Postgres may hand back rows in a different order per query, so
    page 2 can repeat rows from page 1 and skip others; fetchAllPages.js fetches pages in
    parallel, so a list could show duplicates and silently miss records. An explicit
    ordering is kept; a partial one gets the primary key as tie-breaker (rows sharing a
    timestamp were the same hazard)."""
    if not hasattr(queryset, 'ordered') or not hasattr(queryset, 'model'):
        return queryset  # a plain list
    if getattr(queryset.query, 'combinator', None):
        return queryset  # union()/intersection(): ordering is restricted to selected columns
    if getattr(queryset.query, 'is_sliced', False):
        return queryset  # already cut to a window (e.g. "latest N"); can't be re-ordered
    if not queryset.ordered:
        fields = {f.name for f in queryset.model._meta.get_fields()}
        return queryset.order_by(*(['-created_at'] if 'created_at' in fields else []), 'pk')
    ordering = list(queryset.query.order_by or queryset.model._meta.ordering or [])
    if ordering and not any(str(o).lstrip('-') in ('pk', 'id') for o in ordering):
        if queryset.query.distinct_fields:
            return queryset  # DISTINCT ON fixes the leading columns; leave it alone
        return queryset.order_by(*ordering, 'pk')
    return queryset
